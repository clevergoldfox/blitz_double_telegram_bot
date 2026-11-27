import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Db, openDb } from '../src/db/index';
import { makeRepos, Repos } from '../src/db/repos';
import { Engine } from '../src/engine/engine';
import { Auth } from '../src/web/auth';
import { createPanel } from '../src/web/server';
import { Config } from '../src/config';
import { createLogger } from '../src/logger';
import { ResultSource, SourceMode, SourceStatus } from '../src/sources/types';
import { colorOfRoll, GameResult } from '../src/types';

const SENHA = 'senha-de-teste-123';

class FonteParada extends ResultSource {
  readonly mode: SourceMode = 'sim';
  async start(): Promise<void> { /* nada */ }
  async stop(): Promise<void> { /* nada */ }
  status(): SourceStatus {
    return { mode: 'sim', connected: true, lastResultAt: null, lastLatencyMs: 120, reconnects: 0, detail: 'teste' };
  }
}

/** Historico deterministico com pedra, para os padroes por numero terem o que casar. */
function historico(n: number): GameResult[] {
  const out: GameResult[] = [];
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const roll = seed % 15;
    out.push({
      roundId: 'r' + i,
      color: colorOfRoll(roll),
      roll,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 30_000).toISOString(),
      live: true,
    });
  }
  return out;
}

interface Ambiente {
  base: string;
  repos: Repos;
  server: Server;
  cookie: string;
  /** Pasta temporaria do banco, quando o teste pediu banco em arquivo. */
  pasta: string | null;
  db: Db;
}

/**
 * Sobe um painel de teste.
 *
 * `emArquivo` existe por causa do simulador: ele le o historico de dentro de
 * uma worker thread, e um banco `:memory:` so existe para a conexao que o
 * abriu — a segunda thread acharia um banco vazio. Quem precisa exercitar o
 * caminho de producao pede arquivo.
 */
async function subir(opts: { emArquivo?: boolean } = {}): Promise<Ambiente> {
  const pasta = opts.emArquivo ? mkdtempSync(join(tmpdir(), 'painel-teste-')) : null;
  const caminho = pasta ? join(pasta, 'bot.db') : ':memory:';
  const db = openDb(caminho);
  const repos = makeRepos(db, 'completo');
  for (const r of historico(3000)) repos.results.insert(r);

  const cfg = {
    timezone: 'America/Sao_Paulo',
    dbPath: caminho,
    web: { enabled: true, port: 0, host: '127.0.0.1', password: SENHA, seguro: false },
  } as unknown as Config;

  const server = createPanel({
    cfg,
    db,
    repos,
    engine: new Engine(repos),
    source: new FonteParada(),
    auth: new Auth(db, SENHA),
    log: createLogger({ level: 'error' }),
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, repos, server, cookie: '', pasta, db };
}

/** Fecha o servidor e apaga o banco temporario, se houver. */
function derrubar(amb: Ambiente): void {
  amb.server.close();
  // O Windows nao deixa apagar arquivo com handle aberto, e o banco fica
  // aberto enquanto o painel vive.
  amb.db.close();
  if (!amb.pasta) return;
  try {
    rmSync(amb.pasta, { recursive: true, force: true });
  } catch {
    // Arquivo temporario preso nao e motivo para reprovar o teste.
  }
}

async function pedir(
  amb: Ambiente,
  caminho: string,
  opts: { method?: string; body?: unknown; semCookie?: boolean } = {},
): Promise<{ status: number; dados: any }> {
  const r = await fetch(amb.base + caminho, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(amb.cookie && !opts.semCookie ? { Cookie: amb.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const set = r.headers.get('set-cookie');
  if (set) amb.cookie = set.split(';')[0];
  let dados: any = null;
  try { dados = await r.json(); } catch { /* resposta sem json */ }
  return { status: r.status, dados };
}

async function logar(amb: Ambiente): Promise<void> {
  const r = await pedir(amb, '/api/login', { method: 'POST', body: { senha: SENHA } });
  assert.equal(r.status, 200);
}

test('painel: sem sessao, a API nao entrega nada', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  assert.equal((await pedir(amb, '/api/estado')).status, 401);
  assert.equal((await pedir(amb, '/api/padroes', { method: 'POST', body: {} })).status, 401);
  assert.equal((await pedir(amb, '/api/testar', { method: 'POST', body: {} })).status, 401);
  assert.equal((await pedir(amb, '/api/modo', { method: 'POST', body: { modo: 'publico' } })).status, 401);
  assert.equal((await pedir(amb, '/api/previa', { method: 'POST', body: { expr: 'P P' } })).status, 401);
  assert.equal(amb.repos.settings.alertMode, 'completo', 'a requisicao recusada nao pode ter efeito');
});

test('painel: senha errada e recusada e a certa abre sessao', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  const errada = await pedir(amb, '/api/login', { method: 'POST', body: { senha: 'chute' } });
  assert.equal(errada.status, 401);

  // Um erro de digitacao nao pode travar quem acerta em seguida.
  await logar(amb);
  const estado = await pedir(amb, '/api/estado');
  assert.equal(estado.status, 200);
  assert.equal(estado.dados.totalRodadas, 3000);
});

test('painel: cookie adulterado nao vale', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const original = amb.cookie;
  amb.cookie = original.slice(0, -2) + 'xy';
  const r = await pedir(amb, '/api/estado');
  assert.equal(r.status, 401);

  amb.cookie = original;
  assert.equal((await pedir(amb, '/api/estado')).status, 200);
});

test('painel: cria, edita, pausa e exclui padrao', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const criado = await pedir(amb, '/api/padroes', {
    method: 'POST',
    body: { expr: 'pedra 5 apos 5 casas', entryColor: 'A', gales: 1, whiteRule: 'protect' },
  });
  assert.equal(criado.status, 200);
  // a expressao volta normalizada, nao como foi digitada
  assert.equal(criado.dados.expr, '5 *{4}');
  assert.equal(criado.dados.usesRolls, true);
  const id = criado.dados.id;

  const editado = await pedir(amb, `/api/padroes/${id}`, { method: 'PUT', body: { gales: 2, name: 'Pedra 5' } });
  assert.equal(editado.dados.gales, 2);
  assert.equal(editado.dados.name, 'Pedra 5');

  const pausado = await pedir(amb, `/api/padroes/${id}`, { method: 'PUT', body: { active: false } });
  assert.equal(pausado.dados.active, false);

  assert.equal((await pedir(amb, `/api/padroes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(amb.repos.patterns.get(id), null);
});

test('painel: gatilho invalido volta 400 com a mensagem do parser', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const r = await pedir(amb, '/api/padroes', {
    method: 'POST',
    body: { expr: '99', entryColor: 'A', gales: 1, whiteRule: 'gale' },
  });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /0 a 14/);

  const semCor = await pedir(amb, '/api/padroes', {
    method: 'POST',
    body: { expr: 'P P', entryColor: 'Z', gales: 1, whiteRule: 'gale' },
  });
  assert.equal(semCor.status, 400);
});

test('painel: testar nao salva nada e devolve a linha de base junto', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const antes = amb.repos.patterns.list().length;
  const r = await pedir(amb, '/api/testar', {
    method: 'POST',
    body: { expr: '5 apos 5 casas', entryColor: 'A', gales: 1, whiteRule: 'protect' },
  });

  assert.equal(r.status, 200);
  assert.equal(amb.repos.patterns.list().length, antes, 'testar nao pode criar padrao');
  assert.ok(r.dados.signals > 0, 'o padrao precisa ter aparecido no historico');
  assert.equal(r.dados.roundsScanned, 3000);
  assert.equal(r.dados.expr, '5 *{4}');
  // 78,22% e o que a entrada no amarelo com 1 gale e branco protegido da sozinha
  assert.ok(Math.abs(r.dados.linhaDeBase - 0.7822) < 0.001, String(r.dados.linhaDeBase));
});

test('painel: troca o modo de alerta e isso chega ao banco', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  assert.equal(amb.repos.settings.alertMode, 'completo');
  const r = await pedir(amb, '/api/modo', { method: 'POST', body: { modo: 'publico' } });
  assert.equal(r.status, 200);
  assert.equal(amb.repos.settings.alertMode, 'publico');

  assert.equal((await pedir(amb, '/api/modo', { method: 'POST', body: { modo: 'xpto' } })).status, 400);
});

test('painel: nao serve arquivo de fora da pasta publica', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  for (const alvo of ['/../../.env', '/..%2f..%2f.env', '/../package.json']) {
    const r = await fetch(amb.base + alvo);
    assert.ok(r.status === 403 || r.status === 404, `${alvo} devolveu ${r.status}`);
    const corpo = await r.text();
    assert.ok(!corpo.includes('TELEGRAM_BOT_TOKEN'), `vazou .env em ${alvo}`);
  }
});

test('painel: a tela de login e servida sem sessao', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  const r = await fetch(amb.base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Painel de padr/);
});

test('painel: insistir na senha errada passa a ser barrado', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  // As primeiras tentativas erradas respondem 401 na hora; a espera so comeca
  // depois de estourar a franquia, e por isso vamos uma alem dela.
  for (let i = 0; i <= Auth.TENTATIVAS_LIVRES; i++) {
    const r = await pedir(amb, '/api/login', { method: 'POST', body: { senha: 'chute' } });
    assert.equal(r.status, 401, `tentativa ${i + 1}`);
  }

  // Daqui em diante vira 429, mesmo que a senha agora seja a certa.
  const barrado = await pedir(amb, '/api/login', { method: 'POST', body: { senha: SENHA } });
  assert.equal(barrado.status, 429);
  assert.match(barrado.dados.erro, /Tente de novo/);
});

test('painel: a previa traduz o gatilho em bolinhas sem salvar nada', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const antes = amb.repos.patterns.list().length;
  const r = await pedir(amb, '/api/previa', { method: 'POST', body: { expr: 'ao sair a pedra 5 apos 5 casas' } });

  assert.equal(r.status, 200);
  assert.equal(r.dados.expr, '5 *{4}');
  assert.equal(r.dados.usesRolls, true);
  // o que o cliente le no painel: a pedra ja com a cor dela, depois 4 casas livres
  assert.equal(r.dados.pretty, '\u{1F7E1}5 \u2753x4');
  assert.equal(amb.repos.patterns.list().length, antes, 'previa nao pode criar padrao');

  const cores = await pedir(amb, '/api/previa', { method: 'POST', body: { expr: 'P A P' } });
  assert.equal(cores.dados.pretty, '\u26AB \u{1F7E1} \u26AB');
  assert.equal(cores.dados.usesRolls, false);
});

test('painel: previa invalida volta 400 com a mensagem do parser', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const r = await pedir(amb, '/api/previa', { method: 'POST', body: { expr: '99' } });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /0 a 14/);
});

test('painel: nenhum seletor de atributo com valor sem aspas no app.js', async () => {
  // [value=1] nao e seletor valido — um identificador CSS nao comeca com digito
  // — e o querySelector lanca em vez de devolver null. Foi assim que o botao
  // Editar quebrou para o cliente em todo padrao com "ate G1" (gales = 1).
  const app = await readFile(join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
  const soltos = app.match(/\[[a-zA-Z-]+=\$\{[^}]*\}\]/g) ?? [];
  assert.deepEqual(soltos, [], `valores de seletor sem aspas: ${soltos.join(', ')}`);
});

/** A tabela de 6 niveis do cliente, como ela chega do painel. */
const TABELA: Array<{ entrada: number; branco: number }> = [
  { entrada: 0.76, branco: 0.1 },
  { entrada: 1.73, branco: 0.2 },
  { entrada: 3.97, branco: 0.52 },
  { entrada: 9.22, branco: 1.27 },
  { entrada: 21.45, branco: 3.02 },
  { entrada: 50.0, branco: 7.1 },
];

test('painel: o simulador tambem exige sessao', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());

  const r = await pedir(amb, '/api/simular', {
    method: 'POST',
    body: { escada: TABELA, bancaInicial: 100, meta: 50 },
  });
  assert.equal(r.status, 401);
});

test('painel: simular devolve teoria, historico real e controle', async (t) => {
  // Banco em arquivo: a worker thread precisa conseguir abrir o mesmo banco.
  const amb = await subir({ emArquivo: true });
  t.after(() => derrubar(amb));
  await logar(amb);

  const p = await pedir(amb, '/api/padroes', {
    method: 'POST',
    body: { name: 'T1', expr: 'A P A A A', entryColor: 'P', gales: 2, whiteRule: 'protect' },
  });
  assert.equal(p.status, 200);

  const r = await pedir(amb, '/api/simular', {
    method: 'POST',
    body: {
      escada: TABELA, bancaInicial: 100, meta: 50,
      padroes: [p.dados.id], diasControle: 10, seed: 3,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.dados));

  // A teoria nao depende de historico: e a tabela resolvida no papel, e e ela
  // que da ao cliente a frase curta sobre o plano dele.
  const t6 = r.dados.teoria;
  assert.equal(t6.degraus, 6);
  assert.ok(Math.abs(t6.acumulado - 99.34) < 0.005);
  assert.ok(Math.abs(t6.margem + 1 / 15) < 1e-9, 'a margem e sempre -1/15');
  assert.ok(t6.chanceDePerder > 0.009 && t6.chanceDePerder < 0.012);
  assert.ok(t6.ciclosParaMeta > 1, 'a meta exige muitas escadas ganhas seguidas');

  assert.equal(r.dados.real.giros, 3000);
  assert.ok(r.dados.real.resumo.dias > 0);
  assert.ok(r.dados.real.curva.length <= 401, 'a curva vem afinada para o grafico');
  assert.ok(r.dados.real.extrato.length <= 300, 'o extrato vem cortado');

  assert.equal(r.dados.controle.dias, 10);
  assert.equal(r.dados.controle.seed, 3);
  assert.ok(r.dados.controle.giros > 25_000, 'dez dias de roda a 30s por rodada');
  // O controle e resposta a uma pergunta de dinheiro, entao a margem dele tem
  // de ficar perto de -6,67%; longe disso, a simulacao esta medindo outra coisa.
  assert.ok(r.dados.controle.margemDaCasa < 0, 'o controle nao pode dar lucro');
});

test('painel: simular recusa tabela sem sentido', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);
  await pedir(amb, '/api/padroes', {
    method: 'POST',
    body: { name: 'T1', expr: 'A P A A A', entryColor: 'P', gales: 2, whiteRule: 'protect' },
  });

  const casos: Array<[string, unknown]> = [
    ['tabela vazia', { escada: [], bancaInicial: 100, meta: 50 }],
    ['sem tabela', { bancaInicial: 100, meta: 50 }],
    ['degrau de valor zero', { escada: [{ entrada: 0, branco: 0 }], bancaInicial: 100, meta: 50 }],
    ['degrau nao numerico', { escada: [{ entrada: 'dez', branco: 0 }], bancaInicial: 100, meta: 50 }],
    ['banca negativa', { escada: TABELA, bancaInicial: -5, meta: 50 }],
    ['hora fora do dia', { escada: TABELA, bancaInicial: 100, meta: 50, horarioInicio: 99 }],
    ['tabela gigante', {
      escada: new Array(13).fill({ entrada: 1, branco: 0 }), bancaInicial: 100, meta: 50,
    }],
  ];
  for (const [nome, body] of casos) {
    const r = await pedir(amb, '/api/simular', { method: 'POST', body, });
    assert.equal(r.status, 400, `${nome} deveria ser recusado`);
    assert.ok(typeof r.dados.erro === 'string' && r.dados.erro.length > 0, `${nome} sem mensagem`);
  }
});

test('painel: simular sem padrao escolhido explica em vez de simular vazio', async (t) => {
  const amb = await subir();
  t.after(() => amb.server.close());
  await logar(amb);

  const r = await pedir(amb, '/api/simular', {
    method: 'POST',
    body: { escada: TABELA, bancaInicial: 100, meta: 50, diasControle: 0 },
  });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /padrao/i);
});

test('painel: todo id que o app.js procura existe no index.html', async () => {
  // O painel nao tem framework: um id digitado errado nao da erro de build nem
  // de teste, so devolve null e estoura na cara do cliente quando ele clica.
  // Esta checagem e o compilador que o painel nao tem.
  const pasta = join(__dirname, '..', 'src', 'web', 'public');
  const app = await readFile(join(pasta, 'app.js'), 'utf8');
  const html = await readFile(join(pasta, 'index.html'), 'utf8');

  const idsNoHtml = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
  );
  const procurados = [...app.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]);
  assert.ok(procurados.length > 20, 'a varredura deveria achar os seletores do painel');

  const faltando = [...new Set(procurados)].filter((id) => !idsNoHtml.has(id));
  assert.deepEqual(faltando, [], `ids que o app.js procura e o html nao tem: ${faltando.join(', ')}`);
});

test('painel: as classes que o app.js pinta existem no styles.css', async () => {
  // Mesma ideia: uma classe sem regra de estilo nao quebra, so nao pinta — e o
  // cliente ve um numero cinza onde deveria ler "acima da base" em verde.
  const pasta = join(__dirname, '..', 'src', 'web', 'public');
  const css = await readFile(join(pasta, 'styles.css'), 'utf8');

  const essenciais = [
    'aba', 'aba--ativa', 'nota', 'neutro', 'rotulo', 'rotulo--acima', 'rotulo--dentro',
    'rotulo--abaixo', 'tabela', 'tabela-rolagem', 'mini', 'teoria__lista', 'grafico__svg',
    'grafico__eixo', 'curva__linha', 'curva__area', 'curva__base', 'barra--verde',
    'barra--vermelha', 'placar-duplo', 'selo--neutro', 'vazio', 'verde', 'vermelho',
  ];
  const faltando = essenciais.filter((c) => !css.includes('.' + c));
  assert.deepEqual(faltando, [], `classes sem estilo: ${faltando.join(', ')}`);
});
