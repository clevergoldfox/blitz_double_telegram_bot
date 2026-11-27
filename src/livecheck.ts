/**
 * Verificacao ao vivo contra o feed real da Blitz, sem Telegram.
 *
 *   npm run ao-vivo                            # usa o .env, padrao do cliente
 *   npm run ao-vivo -- 300                     # roda por 300 segundos
 *   npm run ao-vivo -- 120 "!0" A 1 protect    # testa outro padrao ao vivo
 *
 * Liga o coletor real no motor de padroes e imprime no terminal exatamente os
 * alertas que sairiam no Telegram, alem do atraso de cada rodada. E a forma de
 * conferir o feed e a latencia antes de apontar o robo para o chat do cliente.
 */
import 'dotenv/config';
import { createLogger } from './logger';
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { Engine } from './engine/engine';
import { BlitzSource } from './sources/blitz';
import { DEFAULT_COLOR_MAP, parseColorMapSpec } from './sources/parsing';
import { parsePattern } from './engine/grammar';
import { COLOR_EMOJI, COLOR_NAME } from './types';
import * as F from './bot/format';
import { readColor, readWhiteRule } from './bot/parse-novo';

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function main(): Promise<void> {
  const segundos = Number(process.argv[2] ?? 180);
  const env = process.env;

  if (!env.BLITZ_WS_URL && !env.BLITZ_REST_RECENT_URL) {
    console.error('Configure BLITZ_WS_URL e/ou BLITZ_REST_RECENT_URL no .env antes de rodar.');
    process.exit(1);
  }

  const log = createLogger({ level: (env.LOG_LEVEL as 'info') ?? 'info' });

  const source = new BlitzSource(
    {
      wsUrl: env.BLITZ_WS_URL,
      wsProtocol: env.BLITZ_WS_PROTOCOL === 'raw' ? 'raw' : 'socketio',
      wsRooms: (env.BLITZ_WS_ROOMS ?? 'double_room_1').split(',').map((s) => s.trim()).filter(Boolean),
      wsSubscribe: env.BLITZ_WS_SUBSCRIBE,
      restRecentUrl: env.BLITZ_REST_RECENT_URL,
      pollMs: Number(env.BLITZ_POLL_MS ?? 3000),
      origin: env.BLITZ_ORIGIN,
      referer: env.BLITZ_REFERER,
      userAgent:
        env.BLITZ_USER_AGENT ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      colorMap: env.BLITZ_COLOR_MAP
        ? { ...DEFAULT_COLOR_MAP, ...parseColorMapSpec(env.BLITZ_COLOR_MAP) }
        : DEFAULT_COLOR_MAP,
      fields: {},
      requireComplete: (env.BLITZ_REQUIRE_COMPLETE ?? 'true') !== 'false',
      staleAfterMs: Number(env.BLITZ_STALE_AFTER_MS ?? 120_000),
      backfillLimit: Number(env.BLITZ_BACKFILL_LIMIT ?? 50),
    },
    log.child({ mod: 'coletor' }),
  );

  // Banco em memoria: a verificacao nao suja o banco de producao.
  const db = openDb(':memory:');
  const repos = makeRepos(db);
  const pattern = repos.patterns.create({
    name: 'Padrao em verificacao',
    expr: parsePattern(process.argv[3] ?? 'P P A P A').normalized,
    entryColor: readColor(process.argv[4] ?? 'P') ?? 'P',
    gales: Number(process.argv[5] ?? 1),
    whiteRule: readWhiteRule(process.argv[6] ?? 'gale'),
    active: true,
  });
  const engine = new Engine(repos);
  engine.primeFromHistory();

  console.log('='.repeat(68));
  console.log('VERIFICACAO AO VIVO — feed real da Blitz');
  console.log('='.repeat(68));
  console.log('WS   :', env.BLITZ_WS_URL ?? '(nao configurado)');
  console.log('REST :', env.BLITZ_REST_RECENT_URL ?? '(nao configurado)');
  console.log('Padrao monitorado:', F.patternExprPretty(pattern.expr), '-> entrada no', COLOR_NAME[pattern.entryColor], '(ate G1)');
  console.log(`Rodando por ${segundos}s. Ctrl+C para sair.`);
  console.log('='.repeat(68) + '\n');

  /** Atrasos medidos so nas rodadas que chegaram ao vivo. */
  const atrasos: number[] = [];

  source.onResult((r) => {
    // A cor e revelada em updated_at (~15s depois da abertura do round), entao
    // e dali que se mede atraso de verdade.
    const atraso = Date.now() - new Date(r.revealedAt ?? r.createdAt).getTime();
    if (r.live) atrasos.push(atraso);
    const marca = r.live ? 'ao vivo ' : 'historico';
    console.log(
      `${new Date().toISOString().slice(11, 19)}  ${marca}  ${COLOR_EMOJI[r.color]} ${COLOR_NAME[r.color].padEnd(8)}` +
        ` roll=${String(r.roll ?? '-').padEnd(3)} atraso=${(atraso / 1000).toFixed(1)}s  round=${r.roundId}`,
    );

    for (const ev of engine.onResult(r)) {
      if (ev.kind === 'entry') {
        console.log('\n' + plain(F.entryAlert(ev.pattern, ev.triggerRounds, repos.signals.scoreboard(ev.pattern.id, ev.pattern.name))) + '\n');
      } else if (ev.kind === 'gale') {
        console.log('\n' + plain(F.galeAlert(ev.pattern, ev.gale, ev.round.color)) + '\n');
      } else if (ev.kind === 'resolved') {
        console.log('\n' + plain(F.resolvedAlert(ev.pattern, ev.status, ev.round.color, ev.signal.resolvedGale, ev.signal.wonOnWhite, ev.scoreboard)) + '\n');
      } else if (ev.kind === 'gap') {
        console.log('\n' + plain(F.gapAlert(ev.reason, ev.roundsToRearm)) + '\n');
      }
    }
  });

  source.onGap((reason) => {
    const ev = engine.markGap(reason);
    console.log('\n' + plain(F.gapAlert(reason, ev.kind === 'gap' ? ev.roundsToRearm : 0)) + '\n');
  });

  await source.start();

  const encerrar = async () => {
    await source.stop();
    const aoVivo = atrasos;
    console.log('\n' + '='.repeat(68));
    console.log('RESUMO');
    console.log('Rodadas ao vivo   :', atrasos.length);
    console.log('Historico guardado:', repos.results.count());
    if (aoVivo.length) {
      const med = aoVivo.reduce((a, b) => a + b, 0) / aoVivo.length;
      console.log('Atraso medio      :', (med / 1000).toFixed(1) + 's');
      console.log('Atraso maximo     :', (Math.max(...aoVivo) / 1000).toFixed(1) + 's');
    }
    console.log(plain(F.scoreboardBlock(repos.signals.scoreboard(pattern.id, pattern.name), 'Placar do padrao')));
    console.log('='.repeat(68));
    db.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void encerrar());
  setTimeout(() => void encerrar(), segundos * 1000);
}

main().catch((err) => {
  console.error('erro na verificacao:', err instanceof Error ? err.message : err);
  process.exit(1);
});
