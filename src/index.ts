import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { Engine, EngineEvent } from './engine/engine';
import { createSource } from './sources/index';
import { Notifier } from './notifier/index';
import { createBot } from './bot/index';
import { Auth } from './web/auth';
import { createPanel } from './web/server';
import * as F from './bot/format';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.log.level, file: cfg.log.file });

  log.info({ fonte: cfg.source.kind, db: cfg.dbPath, tz: cfg.timezone }, 'subindo o robo');

  const db = openDb(cfg.dbPath);
  const repos = makeRepos(db, cfg.telegram.alertMode);
  const engine = new Engine(repos);
  engine.primeFromHistory();

  const source = createSource(cfg, log);
  const bot = createBot({ cfg, repos, engine, source, log: log.child({ mod: 'bot' }) });
  const notifier = new Notifier(bot.api, cfg.telegram.chatId, log.child({ mod: 'notifier' }));

  /**
   * Traduz um evento do motor na mensagem que o cliente le.
   * O modo e lido a cada evento, nao uma vez no boot: o /modo troca em
   * operacao e o alerta seguinte ja precisa sair no formato novo.
   */
  const render = (ev: EngineEvent): string | null => {
    const modo = repos.settings.alertMode;
    switch (ev.kind) {
      case 'entry':
        return F.entryAlert(
          ev.pattern,
          ev.triggerRounds,
          repos.signals.scoreboard(ev.pattern.id, ev.pattern.name),
          modo,
        );
      case 'gale':
        return F.galeAlert(ev.pattern, ev.gale, ev.round.color, modo);
      case 'resolved':
        return F.resolvedAlert(
          ev.pattern,
          ev.status,
          ev.round.color,
          ev.signal.resolvedGale,
          ev.signal.wonOnWhite,
          ev.scoreboard,
          modo,
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
  if (!cfg.telegram.chatId) {
    log.warn(
      'TELEGRAM_CHAT_ID nao configurado. O robo sobe e responde comandos, mas os '
      + 'alertas ficam na fila. Mande /id para @' + bot.botInfo.username
      + ' no chat de destino, copie o id para o .env e reinicie.',
    );
  }
  void bot.start({ onStart: () => log.info('escutando comandos no Telegram') });

  await source.start();
  log.info('coletor iniciado');

  // O painel sobe depois da fonte: assim a primeira tela ja mostra conexao real.
  let painel: import('node:http').Server | null = null;
  if (cfg.web.enabled) {
    const auth = new Auth(db, cfg.web.password);
    painel = createPanel({ cfg, db, repos, engine, source, auth, log: log.child({ mod: 'painel' }) });
    await new Promise<void>((resolve, reject) => {
      painel!.once('error', reject);
      painel!.listen(cfg.web.port, cfg.web.host, () => {
        log.info({ url: `http://${cfg.web.host}:${cfg.web.port}` }, 'painel no ar');
        resolve();
      });
    });
  } else {
    log.info('painel desligado (defina WEB_PASSWORD no .env para ligar)');
  }

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
      if (painel) await new Promise<void>((r) => painel!.close(() => r()));
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
