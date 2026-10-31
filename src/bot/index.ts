import { Bot, Context } from 'grammy';
import { Config } from '../config';
import { Logger } from '../logger';
import { Repos } from '../db/repos';
import { Engine } from '../engine/engine';
import { ResultSource } from '../sources/types';
import { backtest } from '../engine/backtest';
import { parsePattern, PatternSyntaxError } from '../engine/grammar';
import { CommandError, parseNovo, readColor, readWhiteRule } from './parse-novo';
import { Color, Pattern, WHITE_RULE_LABEL } from '../types';
import * as F from './format';

export interface BotDeps {
  cfg: Config;
  repos: Repos;
  engine: Engine;
  source: ResultSource;
  log: Logger;
}

/** Instante UTC da meia-noite local do fuso informado, opcionalmente N dias atras. */
export function zonedMidnightUtc(tz: string, daysAgo = 0): Date {
  const now = new Date(Date.now() - daysAgo * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);

  const wallMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offset = wallMs - Math.floor(now.getTime() / 1000) * 1000;
  const midnightWall = Date.UTC(get('year'), get('month') - 1, get('day'));
  return new Date(midnightWall - offset);
}

export function createBot(deps: BotDeps): Bot {
  const { cfg, repos, engine, source, log } = deps;
  const bot = new Bot(cfg.telegram.token);

  const reply = (ctx: Context, text: string) =>
    ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

  // --- autorizacao ---
  // /id fica sempre liberado: e como o cliente descobre o proprio id na instalacao.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text ?? '';
    if (/^\/id\b/.test(text)) return next();

    const owners = cfg.telegram.ownerIds;
    if (owners.length === 0) {
      log.warn('TELEGRAM_OWNER_IDS esta vazio: qualquer pessoa pode configurar o robo');
      return next();
    }
    const uid = ctx.from?.id;
    if (uid === undefined || !owners.includes(uid)) {
      log.warn({ uid, chat: ctx.chat?.id }, 'comando recusado: usuario nao autorizado');
      return;
    }
    return next();
  });

  const idArg = (raw: string | undefined, ctx: Context): number | null => {
    const n = Number((raw ?? '').trim());
    if (!Number.isInteger(n) || n <= 0) {
      void reply(ctx, 'Informe o numero do padrao. Exemplo: <code>/testar 1</code>\nVeja os numeros em /padroes');
      return null;
    }
    return n;
  };

  const mustGet = (id: number, ctx: Context): Pattern | null => {
    const p = repos.patterns.get(id);
    if (!p) {
      void reply(ctx, `Nao existe padrao #${id}. Veja /padroes`);
      return null;
    }
    return p;
  };

  const confirm = (p: Pattern): string =>
    [
      '✅ <b>Padrao salvo</b>',
      '',
      F.patternHeadline(p),
      `Gatilho: ${F.patternExprPretty(p.expr)}`,
      `Entrada: ${F.colorChip(p.entryColor)}`,
      `Gales: ${F.galeLabel(p.gales)}`,
      `Branco: ${WHITE_RULE_LABEL[p.whiteRule]}`,
      '',
      `Use <code>/testar ${p.id}</code> para ver como ele se comportou no historico.`,
    ].join('\n');

  // --- comandos ---

  bot.command(['start', 'ajuda', 'help'], (ctx) => reply(ctx, F.HELP));

  bot.command('id', (ctx) =>
    reply(
      ctx,
      [
        `Seu id de usuario: <code>${ctx.from?.id}</code>`,
        `Id deste chat: <code>${ctx.chat?.id}</code>`,
        '',
        'Coloque o primeiro em <code>TELEGRAM_OWNER_IDS</code> e o segundo em <code>TELEGRAM_CHAT_ID</code> no .env',
      ].join('\n'),
    ),
  );

  bot.command('novo', async (ctx) => {
    try {
      const input = parseNovo(ctx.match ?? '');
      const p = repos.patterns.create(input);
      log.info({ id: p.id, expr: p.expr }, 'padrao cadastrado');
      await reply(ctx, confirm(p));
    } catch (err) {
      if (err instanceof CommandError || err instanceof PatternSyntaxError) {
        await reply(ctx, `⚠️ ${F.esc(err.message)}`);
        return;
      }
      throw err;
    }
  });

  bot.command(['padroes', 'lista'], async (ctx) => {
    const all = repos.patterns.list();
    if (all.length === 0) {
      await reply(ctx, 'Nenhum padrao cadastrado ainda.\nComece com <code>/novo P P A P A = P G1</code>');
      return;
    }
    const blocos = all.map((p) => F.patternLine(p, repos.signals.scoreboard(p.id, p.name)));
    await reply(ctx, [`<b>Padroes cadastrados (${all.length})</b>`, '', ...blocos].join('\n'));
  });

  bot.command('editar', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const id = idArg(args[0], ctx);
    if (id === null) return;
    const p = mustGet(id, ctx);
    if (!p) return;

    const campo = args[1]?.toLowerCase();
    const valor = args.slice(2).join(' ').trim();
    if (!campo || !valor) {
      await reply(
        ctx,
        [
          'Use: <code>/editar &lt;id&gt; &lt;campo&gt; &lt;valor&gt;</code>',
          'Campos: <b>nome</b>, <b>seq</b>, <b>entrada</b>, <b>gales</b>, <b>branco</b>',
          'Exemplos:',
          `<code>/editar ${id} gales 2</code>`,
          `<code>/editar ${id} seq P P A P A</code>`,
          `<code>/editar ${id} branco protege</code>`,
        ].join('\n'),
      );
      return;
    }

    try {
      switch (campo) {
        case 'nome':
          repos.patterns.update(id, { name: valor.slice(0, 60) });
          break;
        case 'seq':
        case 'sequencia':
        case 'gatilho':
          repos.patterns.update(id, { expr: parsePattern(valor).normalized });
          break;
        case 'entrada':
        case 'cor': {
          const c = readColor(valor);
          if (c === null) throw new CommandError(`Cor invalida "${valor}". Use P, A ou B.`);
          repos.patterns.update(id, { entryColor: c });
          break;
        }
        case 'gales':
        case 'gale': {
          const g = Number(valor.replace(/^g/i, ''));
          if (![0, 1, 2].includes(g)) throw new CommandError('Gales precisa ser 0, 1 ou 2.');
          repos.patterns.update(id, { gales: g });
          break;
        }
        case 'branco':
          repos.patterns.update(id, { whiteRule: readWhiteRule(valor) });
          break;
        default:
          throw new CommandError(`Campo "${campo}" nao existe. Use nome, seq, entrada, gales ou branco.`);
      }
    } catch (err) {
      if (err instanceof CommandError || err instanceof PatternSyntaxError) {
        await reply(ctx, `⚠️ ${F.esc(err.message)}`);
        return;
      }
      throw err;
    }

    await reply(ctx, confirm(repos.patterns.get(id)!));
  });

  bot.command(['ativar', 'desativar'], async (ctx) => {
    const ativar = (ctx.message?.text ?? '').startsWith('/ativar');
    const id = idArg((ctx.match ?? '').trim(), ctx);
    if (id === null) return;
    if (!mustGet(id, ctx)) return;
    const p = repos.patterns.update(id, { active: ativar })!;
    await reply(ctx, `${ativar ? '\u{1F7E2} Ativado' : '⚫ Desativado'}: ${F.patternHeadline(p)}`);
  });

  bot.command('excluir', async (ctx) => {
    const id = idArg((ctx.match ?? '').trim(), ctx);
    if (id === null) return;
    const p = mustGet(id, ctx);
    if (!p) return;
    repos.patterns.remove(id);
    log.info({ id }, 'padrao excluido');
    await reply(ctx, `\u{1F5D1} Excluido: padrao #${id} <b>${F.esc(p.name)}</b>`);
  });

  bot.command(['placar', 'stats'], async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const periodos = ['hoje', 'semana', 'total'];
    const periodo = args.find((a) => periodos.includes(a.toLowerCase()))?.toLowerCase() ?? 'total';
    const idRaw = args.find((a) => /^\d+$/.test(a));

    let since: string | undefined;
    let sufixo = 'desde o inicio';
    if (periodo === 'hoje') {
      since = zonedMidnightUtc(cfg.timezone).toISOString();
      sufixo = 'hoje';
    } else if (periodo === 'semana') {
      since = zonedMidnightUtc(cfg.timezone, 6).toISOString();
      sufixo = 'ultimos 7 dias';
    }

    if (idRaw) {
      const id = Number(idRaw);
      const p = mustGet(id, ctx);
      if (!p) return;
      const sb = repos.signals.scoreboard(p.id, p.name, since);
      await reply(ctx, F.scoreboardBlock(sb, `Padrao #${p.id} ${p.name} — ${sufixo}`));
      return;
    }

    const all = repos.patterns.list();
    const geral = repos.signals.scoreboard(null, 'Geral', since);
    const blocos = [F.scoreboardBlock(geral, `Placar geral — ${sufixo}`)];
    for (const p of all) {
      const sb = repos.signals.scoreboard(p.id, p.name, since);
      if (sb.total === 0 && sb.open === 0) continue;
      blocos.push('', F.scoreboardBlock(sb, `#${p.id} ${p.name}`));
    }
    await reply(ctx, blocos.join('\n'));
  });

  bot.command(['testar', 'backtest'], async (ctx) => {
    const id = idArg((ctx.match ?? '').trim(), ctx);
    if (id === null) return;
    const p = mustGet(id, ctx);
    if (!p) return;

    const history = repos.results.allAsc();
    if (history.length === 0) {
      await reply(ctx, 'Ainda nao ha historico guardado para testar. Deixe o robo rodando um pouco.');
      return;
    }

    const bt = backtest(history, {
      parsed: parsePattern(p.expr),
      entryColor: p.entryColor,
      gales: p.gales,
      whiteRule: p.whiteRule,
    });
    await reply(ctx, F.backtestBlock(p, bt));
  });

  bot.command(['ultimos', 'historico'], async (ctx) => {
    const n = Math.min(60, Math.max(1, Number((ctx.match ?? '').trim()) || 20));
    const rows = repos.results.recent(n);
    if (rows.length === 0) {
      await reply(ctx, 'Nenhum resultado capturado ainda.');
      return;
    }
    await reply(
      ctx,
      [
        `<b>Ultimas ${rows.length} rodadas</b> (antiga → recente)`,
        '',
        F.seqPretty(rows.map((r) => r.color)),
      ].join('\n'),
    );
  });

  bot.command('status', async (ctx) => {
    await reply(
      ctx,
      F.statusBlock(
        source.status(),
        repos.results.recent(15),
        repos.results.count(),
        repos.patterns.list({ activeOnly: true }).length,
        engine.armed,
        cfg.timezone,
      ),
    );
  });

  bot.catch((err) => {
    log.error({ err: err.message, stack: err.error }, 'erro nao tratado no bot');
  });

  return bot;
}

export type { Color };
