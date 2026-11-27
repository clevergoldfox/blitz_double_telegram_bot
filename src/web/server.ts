import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Worker } from 'node:worker_threads';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Config } from '../config';
import { Logger } from '../logger';
import { Db } from '../db/index';
import { Repos } from '../db/repos';
import { Engine } from '../engine/engine';
import { ResultSource } from '../sources/types';
import { backtest } from '../engine/backtest';
import { BancaConfig, Degrau, teoriaDaEscada } from '../engine/banca';
import { PedidoSimulacao, SaidaSimulacao } from '../engine/simrun';
import { baselineHitRate, compararComBase } from '../engine/rules';
import { formatTokensPretty, parsePattern, PatternSyntaxError } from '../engine/grammar';
import { AlertMode, Color, isColor, NewPattern, WhiteRule } from '../types';

export interface PanelDeps {
  cfg: Config;
  db: Db;
  repos: Repos;
  engine: Engine;
  source: ResultSource;
  log: Logger;
  auth: import('./auth').Auth;
}

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

const RAIZ_PUBLICA = join(__dirname, 'public');

function corpoJson(req: IncomingMessage, limite = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limite) {
        reject(new HttpError(413, 'Corpo grande demais'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => {
      const txt = Buffer.concat(partes).toString('utf8');
      if (!txt.trim()) return resolve({});
      try {
        resolve(JSON.parse(txt));
      } catch {
        reject(new HttpError(400, 'JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

function texto(v: unknown, campo: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `Informe ${campo}`);
  return v.trim().slice(0, max);
}

function cor(v: unknown, campo: string): Color {
  if (!isColor(v)) throw new HttpError(400, `${campo} precisa ser P, A ou B`);
  return v;
}

function gales(v: unknown): number {
  const n = Number(v);
  if (![0, 1, 2].includes(n)) throw new HttpError(400, 'Gales precisa ser 0, 1 ou 2');
  return n;
}

function regraBranco(v: unknown): WhiteRule {
  if (v !== 'gale' && v !== 'red' && v !== 'protect') {
    throw new HttpError(400, 'Regra do branco invalida');
  }
  return v;
}

/** Le a expressao e devolve ja normalizada, traduzindo o erro de sintaxe. */
function expressao(v: unknown): { expr: string; pretty: string; usesRolls: boolean } {
  const bruto = texto(v, 'a sequencia do gatilho', 400);
  try {
    const p = parsePattern(bruto);
    return { expr: p.normalized, pretty: formatTokensPretty(p.tokens), usesRolls: p.usesRolls };
  } catch (err) {
    if (err instanceof PatternSyntaxError) throw new HttpError(400, err.message);
    throw err;
  }
}

/** Numero obrigatorio dentro de uma faixa, com mensagem que o painel mostra. */
function num(v: unknown, campo: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${campo} precisa ser um numero.`);
  if (n < min || n > max) {
    throw new HttpError(400, `${campo} precisa estar entre ${min} e ${max}.`);
  }
  return n;
}

function numOuNulo(v: unknown, campo: string, min: number, max: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  return num(v, campo, min, max);
}

/**
 * Le a tabela de degraus do corpo da requisicao.
 *
 * O limite de 12 degraus nao e burocracia: cada degrau mais que dobra a aposta,
 * e uma tabela de 12 degraus partindo da entrada minima ja pede uma banca de
 * cinco digitos. Acima disso o pedido e sempre erro de digitacao.
 */
function escadaDoCorpo(v: unknown): Degrau[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new HttpError(400, 'Monte a tabela com pelo menos um degrau.');
  }
  if (v.length > 12) throw new HttpError(400, 'A tabela aceita no maximo 12 degraus.');
  return v.map((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>;
    const entrada = num(o.entrada, `A entrada do degrau ${i + 1}`, 0.01, 100000);
    const branco = o.branco === undefined || o.branco === null || o.branco === ''
      ? 0
      : num(o.branco, `A protecao do degrau ${i + 1}`, 0, 100000);
    return { entrada, branco };
  });
}

/**
 * Teto de tempo da simulacao.
 *
 * Mil dias de controle levam cerca de doze segundos de CPU. O teto nao esta
 * aqui para o caso normal: esta para o pedido que, por um erro de tabela,
 * entrar em alguma combinacao patologica e nunca terminar — sem ele, a worker
 * ficaria viva comendo um nucleo do VPS para sempre.
 */
const LIMITE_SIMULACAO_MS = 45_000;

/**
 * Roda a simulacao numa worker thread.
 *
 * O painel divide o processo com o motor de alertas. Uma simulacao de mil dias
 * na thread principal bloquearia o event loop por doze segundos, e um alerta do
 * Double atrasado em doze segundos chega depois da rodada que ele anunciava —
 * ou seja, o recurso novo estragaria o recurso que o cliente ja paga.
 */
function simularEmWorker(pedido: PedidoSimulacao): Promise<SaidaSimulacao> {
  return new Promise((resolve, reject) => {
    const w = new Worker(join(__dirname, '..', 'engine', 'simworker.js'), { workerData: pedido });
    let encerrado = false;
    const fim = (fn: () => void) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      fim(() => reject(new HttpError(504, 'A simulacao passou do tempo. Reduza os dias de controle.')));
    }, LIMITE_SIMULACAO_MS);

    w.once('message', (m: { ok?: boolean; dados?: SaidaSimulacao; erro?: string }) => {
      fim(() => {
        if (m?.ok && m.dados) resolve(m.dados);
        else reject(new HttpError(400, m?.erro ?? 'A simulacao falhou sem dizer por que.'));
      });
    });
    w.once('error', (e) => fim(() => reject(new HttpError(500, e.message))));
  });
}

export function createPanel(deps: PanelDeps): Server {
  const { cfg, repos, engine, source, log, auth } = deps;

  // ---------- leitura de estado ----------

  const padraoComPlacar = (p: ReturnType<Repos['patterns']['list']>[number]) => {
    let pretty = p.expr;
    let usesRolls = false;
    try {
      const parsed = parsePattern(p.expr);
      pretty = formatTokensPretty(parsed.tokens);
      usesRolls = parsed.usesRolls;
    } catch {
      /* padrao gravado por uma versao anterior: mostra cru em vez de quebrar */
    }
    const placar = repos.signals.scoreboard(p.id, p.name);
    const linhaDeBase = baselineHitRate(p.entryColor, p.gales, p.whiteRule);
    return {
      ...p,
      pretty,
      usesRolls,
      placar,
      linhaDeBase,
      // O veredito sai daqui, e nao do navegador, porque e uma conta de
      // estatistica: comparar as duas taxas cruas na tela faz um padrao de 13
      // sinais parecer melhor que um de 1.552.
      ...compararComBase(placar.greens, placar.greens + placar.reds, linhaDeBase),
    };
  };

  const estado = () => ({
    padroes: repos.patterns.list().map(padraoComPlacar),
    rodadas: repos.results.recent(40).reverse(),
    totalRodadas: repos.results.count(),
    placarGeral: repos.signals.scoreboard(null, 'Geral'),
    modo: repos.settings.alertMode,
    armado: engine.armed,
    fonte: source.status(),
    fuso: cfg.timezone,
  });

  // ---------- rotas ----------

  type Handler = (req: IncomingMessage, body: unknown, id: number | null) => unknown;

  const rotas: Array<{ metodo: string; re: RegExp; publica?: boolean; fn: Handler }> = [
    {
      metodo: 'POST',
      re: /^\/api\/login$/,
      publica: true,
      fn: (req, body) => {
        const ip = req.socket.remoteAddress ?? 'desconhecido';
        const espera = auth.esperaDe(ip);
        if (espera > 0) {
          throw new HttpError(429, `Muitas tentativas. Tente de novo em ${espera}s.`);
        }
        const senha = typeof (body as { senha?: unknown }).senha === 'string'
          ? (body as { senha: string }).senha
          : '';
        if (!auth.confere(ip, senha)) {
          log.warn({ ip }, 'painel: senha incorreta');
          throw new HttpError(401, 'Senha incorreta');
        }
        log.info({ ip }, 'painel: login');
        return { ok: true, _cookie: auth.cookieDeLogin(auth.criaToken(), cfg.web.seguro) };
      },
    },
    {
      metodo: 'POST',
      re: /^\/api\/logout$/,
      publica: true,
      fn: () => ({ ok: true, _cookie: auth.cookieDeSaida() }),
    },
    { metodo: 'GET', re: /^\/api\/estado$/, fn: () => estado() },

    // Previa do gatilho enquanto o cliente digita. Existe para o painel nunca
    // desenhar a sequencia por conta propria: quem le a expressao e o motor.
    {
      metodo: 'POST',
      re: /^\/api\/previa$/,
      fn: (_req, body) => expressao((body as { expr?: unknown }).expr),
    },

    {
      metodo: 'POST',
      re: /^\/api\/padroes$/,
      fn: (_req, body) => {
        const b = body as Record<string, unknown>;
        const { expr } = expressao(b.expr);
        const novo: NewPattern = {
          name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : expr,
          expr,
          entryColor: cor(b.entryColor, 'A cor de entrada'),
          gales: gales(b.gales),
          whiteRule: regraBranco(b.whiteRule),
          active: b.active !== false,
        };
        const p = repos.patterns.create(novo);
        log.info({ id: p.id, expr: p.expr }, 'painel: padrao criado');
        return padraoComPlacar(p);
      },
    },
    {
      metodo: 'PUT',
      re: /^\/api\/padroes\/(\d+)$/,
      fn: (_req, body, id) => {
        const b = body as Record<string, unknown>;
        const patch: Partial<NewPattern> = {};
        if (b.name !== undefined) patch.name = texto(b.name, 'o nome', 60);
        if (b.expr !== undefined) patch.expr = expressao(b.expr).expr;
        if (b.entryColor !== undefined) patch.entryColor = cor(b.entryColor, 'A cor de entrada');
        if (b.gales !== undefined) patch.gales = gales(b.gales);
        if (b.whiteRule !== undefined) patch.whiteRule = regraBranco(b.whiteRule);
        if (b.active !== undefined) patch.active = Boolean(b.active);

        const p = repos.patterns.update(id!, patch);
        if (!p) throw new HttpError(404, `Padrao #${id} nao existe`);
        log.info({ id, campos: Object.keys(patch) }, 'painel: padrao alterado');
        return padraoComPlacar(p);
      },
    },
    {
      metodo: 'DELETE',
      re: /^\/api\/padroes\/(\d+)$/,
      fn: (_req, _body, id) => {
        if (!repos.patterns.remove(id!)) throw new HttpError(404, `Padrao #${id} nao existe`);
        log.info({ id }, 'painel: padrao excluido');
        return { ok: true };
      },
    },
    {
      // Testa sem salvar: e o que permite iterar rapido sobre ideias de padrao.
      metodo: 'POST',
      re: /^\/api\/testar$/,
      fn: (_req, body) => {
        const b = body as Record<string, unknown>;
        const bruto = texto(b.expr, 'a sequencia do gatilho', 400);
        let parsed;
        try {
          parsed = parsePattern(bruto);
        } catch (err) {
          if (err instanceof PatternSyntaxError) throw new HttpError(400, err.message);
          throw err;
        }
        const entryColor = cor(b.entryColor, 'A cor de entrada');
        const g = gales(b.gales);
        const whiteRule = regraBranco(b.whiteRule);

        // Teto de seguranca: o teste carrega o historico inteiro na memoria, e
        // sem limite ele cresceria para sempre (sao ~2.880 rodadas por dia).
        // 200 mil rodadas sao uns dois meses, bem mais do que basta para decidir.
        const historico = repos.results.recent(Math.min(repos.results.count(), 200_000));
        const r = backtest(historico, { parsed, entryColor, gales: g, whiteRule });

        return {
          ...r,
          expr: parsed.normalized,
          pretty: formatTokensPretty(parsed.tokens),
          // A regua ao lado do resultado: sem ela o cliente nao tem como saber
          // se 78% e bom ou se e so o que qualquer entrada ja daria.
          linhaDeBase: baselineHitRate(entryColor, g, whiteRule),
        };
      },
    },
    {
      /**
       * Simulador de banca: roda a tabela de apostas no historico real E numa
       * roleta honesta, lado a lado.
       *
       * As duas colunas sao o ponto do recurso. Historico real sozinho engana:
       * as primeiras semanas gravadas correram a -1,8% quando a margem da casa
       * e -6,7%, e qualquer tabela medida ali pareceria boa. A coluna de
       * controle responde "isso foi a estrategia ou foi o periodo?".
       */
      metodo: 'POST',
      re: /^\/api\/simular$/,
      fn: async (_req, body) => {
        const b = body as Record<string, unknown>;
        const escada = escadaDoCorpo(b.escada);
        const bancaInicial = num(b.bancaInicial, 'A banca inicial', 1, 1000000);
        const meta = numOuNulo(b.meta, 'A meta do dia', 0.01, 1000000);
        const stopLoss = numOuNulo(b.stopLoss, 'O limite de perda', 0.01, 1000000);
        const horarioInicio = numOuNulo(b.horarioInicio, 'A hora de inicio', 0, 23);
        const horarioFim = numOuNulo(b.horarioFim, 'A hora de fim', 0, 23);
        const diasControle = Math.round(num(b.diasControle ?? 365, 'Os dias de controle', 0, 1000));
        const seed = Math.round(num(b.seed ?? 1, 'A semente', 0, 2147483647));

        const ids = Array.isArray(b.padroes)
          ? b.padroes.map(Number).filter((n) => Number.isInteger(n))
          : null;
        const escolhidos = repos.patterns.list().filter((p) => (ids ? ids.includes(p.id) : p.active));
        if (escolhidos.length === 0) {
          throw new HttpError(400, 'Escolha pelo menos um padrao para simular.');
        }

        const cfgBanca: BancaConfig = {
          bancaInicial,
          entrada: escada[0].entrada,
          escada,
          stopWin: meta,
          stopLoss,
          horarioInicio,
          horarioFim,
          timezone: cfg.timezone,
          resetarNoBranco: b.resetarNoBranco === true,
          umaEscadaPorVez: b.umaEscadaPorVez !== false,
          pararNoPrimeiroRed: b.pararNoPrimeiroRed !== false,
          sessaoPorDia: true,
          reiniciar: true,
          entradaMinima: 0.1,
        };

        // A teoria nao depende de historico nenhum: e a tabela resolvida no
        // papel. Serve de conferencia das duas simulacoes — se elas nao
        // chegarem perto dela, alguma das tres contas esta errada.
        //
        // Ela descreve UM padrao, porque a chance de cada degrau depende da
        // regra do branco e de a entrada ser numa cor ou no proprio branco.
        // Com padroes de regras diferentes operando juntos o numero do papel
        // vale para o primeiro deles e nao para o conjunto — e isso vai dito
        // na resposta, porque um numero exato e errado e pior que nenhum.
        const referencia = escolhidos[0];
        const teoria = teoriaDaEscada(escada, referencia, meta ?? bancaInicial);
        const teoriaVale = escolhidos.every(
          (p) => p.whiteRule === referencia.whiteRule
            && (p.entryColor === 'B') === (referencia.entryColor === 'B'),
        );

        const saida = await simularEmWorker({
          // O caminho do banco, nao o historico: a worker le sozinha. Serializar
          // 75 mil rodadas para atravessar a fronteira da thread travava a thread
          // principal por mais de um segundo, bem no caminho dos alertas.
          banco: { caminho: cfg.dbPath, limite: 200000 },
          diasControle,
          seed,
          padroes: escolhidos.map((p) => ({
            id: p.id,
            name: p.name,
            expr: p.expr,
            entryColor: p.entryColor,
            gales: p.gales,
            whiteRule: p.whiteRule,
          })),
          cfg: cfgBanca,
        });

        log.info(
          { degraus: escada.length, meta, dias: diasControle, padroes: escolhidos.length },
          'painel: simulacao de banca',
        );
        return {
          teoria,
          teoriaVale,
          teoriaDe: { id: referencia.id, name: referencia.name },
          escada,
          padroes: escolhidos.map((p) => ({ id: p.id, name: p.name, entryColor: p.entryColor })),
          real: saida.real,
          controle: saida.controle,
        };
      },
    },
    {
      metodo: 'POST',
      re: /^\/api\/modo$/,
      fn: (_req, body) => {
        const m = (body as { modo?: unknown }).modo;
        if (m !== 'publico' && m !== 'completo') throw new HttpError(400, 'Modo invalido');
        repos.settings.alertMode = m as AlertMode;
        log.info({ modo: m }, 'painel: modo de alerta alterado');
        return { modo: m };
      },
    },
  ];

  // ---------- servidor ----------

  const responde = (res: ServerResponse, status: number, dados: unknown, cookie?: string) => {
    const corpo = JSON.stringify(dados);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (cookie) headers['Set-Cookie'] = cookie;
    res.writeHead(status, headers);
    res.end(corpo);
  };

  const estatico = (res: ServerResponse, caminho: string) => {
    const rel = caminho === '/' ? 'index.html' : caminho.replace(/^\/+/, '');
    // normalize + prefixo: impede ../ escapar da pasta publica
    const destino = normalize(join(RAIZ_PUBLICA, rel));
    if (!destino.startsWith(RAIZ_PUBLICA + sep) && destino !== RAIZ_PUBLICA) {
      res.writeHead(403).end('Proibido');
      return;
    }
    if (!existsSync(destino) || !statSync(destino).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nao encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[extname(destino)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(destino).pipe(res);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://painel.local');
      const caminho = url.pathname;

      if (!caminho.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end('Metodo nao permitido');
          return;
        }
        estatico(res, caminho);
        return;
      }

      const rota = rotas.find((r) => r.metodo === req.method && r.re.test(caminho));
      if (!rota) {
        responde(res, 404, { erro: 'Rota nao encontrada' });
        return;
      }

      try {
        if (!rota.publica && !auth.tokenValido(auth.leCookie(req.headers.cookie))) {
          responde(res, 401, { erro: 'Sessao expirada. Entre de novo.' });
          return;
        }

        const body = req.method === 'GET' ? {} : await corpoJson(req);
        const m = rota.re.exec(caminho);
        const id = m && m[1] !== undefined ? Number(m[1]) : null;

        const saida = (await rota.fn(req, body, id)) as Record<string, unknown>;
        const cookie = typeof saida?._cookie === 'string' ? saida._cookie : undefined;
        if (cookie) delete saida._cookie;
        responde(res, 200, saida, cookie);
      } catch (err) {
        if (err instanceof HttpError) {
          responde(res, err.status, { erro: err.message });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, caminho }, 'painel: falha na requisicao');
        responde(res, 500, { erro: 'Falha interna. Veja o log do servidor.' });
      }
    })();
  });

  return server;
}
