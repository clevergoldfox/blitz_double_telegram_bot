import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { Engine, EngineEvent } from './engine/engine';
import { createSource } from './sources/index';
import { Notifier } from './notifier/index';
import { createBot } from './bot/index';
import * as F from './bot/format';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.log.level, file: cfg.log.file });

  log.info({ fonte: cfg.source.kind, db: cfg.dbPath, tz: cfg.timezone }, 'subindo o robo');

  const db = openDb(cfg.dbPath);
  const repos = makeRepos(db);
  const engine = new Engine(repos);
  engine.primeFromHistory();

  const source = createSource(cfg, log);
  const bot = createBot({ cfg, repos, engine, source, log: log.child({ mod: 'bot' }) });
  const notifier = new Notifier(bot.api, cfg.telegram.chatId, log.child({ mod: 'notifier' }));

  /** Traduz um evento do motor na mensagem que o cliente le. */
  const render = (ev: EngineEvent): string | null => {
    switch (ev.kind) {
      case 'entry':
        return F.entryAlert(ev.pattern, ev.triggerColors, repos.signals.scoreboard(ev.pattern.id, ev.pattern.name));
      case 'gale':
        return F.galeAlert(ev.pattern, ev.gale, ev.round.color);
      case 'resolved':
        return F.resolvedAlert(
          ev.pattern,
          ev.status,
          ev.round.color,
          ev.signal.resolvedGale,
          ev.signal.wonOnWhite,
          ev.scoreboard,
        );
      case 'gap':
        return F.gapAlert(ev.reason, ev.roundsToRearm);
    }
  };

  source.onResult((result) => {
    try {
      const eventos = engine.onResult(result);
      for (const ev of eventos) {
        log.info({ tipo: ev.kind, padrao: ev.kind === 'gap' ? null : ev.pattern.id }, 'evento do motor');
        const msg = render(ev);
        if (msg) notifier.send(msg);
      }
    } catch (err) {
      // Uma falha ao processar uma rodada nao pode derrubar o coletor.
      log.error({ err: err instanceof Error ? err.message : String(err), round: result.roundId }, 'falha ao processar resultado');
    }
  });

  source.onGap((reason) => {
    const ev = engine.markGap(reason);
    log.warn({ reason }, 'historico marcado como descontinuo');
    const msg = render(ev);
    if (msg) notifier.send(msg);
  });

  // O bot sobe primeiro: se o token estiver errado, falhamos antes de conectar na fonte.
  await bot.init();
  log.info({ bot: bot.botInfo.username }, 'bot do Telegram autenticado');
  void bot.start({ onStart: () => log.info('escutando comandos no Telegram') });

  await source.start();
  log.info('coletor iniciado');

  notifier.send(
    [
      '\u{1F916} <b>Robo online</b>',
      `Fonte: ${source.status().mode.toUpperCase()}`,
      `Padroes ativos: ${repos.patterns.list({ activeOnly: true }).length}`,
      `Rodadas no historico: ${repos.results.count()}`,
      '',
      'Use /ajuda para ver os comandos.',
    ].join('\n'),
  );

  let encerrando = false;
  const shutdown = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    log.info({ sinal }, 'encerrando');
    try {
      await source.stop();
      await bot.stop();
      db.close();
    } catch (err) {
      log.error({ err: String(err) }, 'falha ao encerrar');
    }
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'promessa rejeitada sem tratamento');
  });
}

main().catch((err) => {
  console.error('falha fatal na inicializacao:', err instanceof Error ? err.message : err);
  process.exit(1);
});
