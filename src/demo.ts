/**
 * Demonstracao no terminal, sem Telegram e sem Blitz.
 *
 *   node dist/src/demo.js                      # padrao do cliente, giros aleatorios
 *   node dist/src/demo.js "P P A P A" P 1 gale # padrao, entrada, gales, regra do branco
 *
 * Mostra exatamente as mensagens que sairiam no Telegram, so que impressas aqui.
 * Serve para validar a logica de gatilho, gale e placar antes de ligar o feed real.
 */
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { Engine } from './engine/engine';
import { SimulatorSource } from './sources/simulator';
import { parsePattern } from './engine/grammar';
import { backtest } from './engine/backtest';
import { Color, WHITE_RULE_LABEL, WhiteRule } from './types';
import * as F from './bot/format';
import { readWhiteRule } from './bot/parse-novo';

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function main(): Promise<void> {
  const expr = process.argv[2] ?? 'P P A P A';
  const entry = (process.argv[3] ?? 'P').toUpperCase() as Color;
  const gales = Number(process.argv[4] ?? 1);
  // Passa pelo mesmo leitor do /novo, para aceitar "protege", "sem", "red" etc.
  const whiteRule: WhiteRule = readWhiteRule(process.argv[5] ?? 'gale');
  const intervalMs = Number(process.env.DEMO_INTERVAL_MS ?? 250);
  const rodadas = Number(process.env.DEMO_ROUNDS ?? 400);

  const parsed = parsePattern(expr);

  const db = openDb(':memory:');
  const repos = makeRepos(db);
  const pattern = repos.patterns.create({
    name: 'Padrao de demonstracao',
    expr: parsed.normalized,
    entryColor: entry,
    gales,
    whiteRule,
    active: true,
  });

  console.log('='.repeat(64));
  console.log('DEMONSTRACAO — robo de padroes do Double');
  console.log('='.repeat(64));
  console.log(`Gatilho : ${F.patternExprPretty(pattern.expr)}  (${pattern.expr})`);
  console.log(`Entrada : ${plain(F.colorChip(pattern.entryColor))}`);
  console.log(`Gales   : ${F.galeLabel(pattern.gales)}`);
  console.log(`Branco  : ${WHITE_RULE_LABEL[pattern.whiteRule]}`);
  console.log(`Giros   : ${rodadas}, um a cada ${intervalMs}ms`);
  console.log('(giros simulados: 15 casas, 7 pretas, 7 amarelas, 1 branca)');
  console.log('='.repeat(64) + '\n');

  const engine = new Engine(repos);
  engine.primeFromHistory();

  const source = new SimulatorSource(intervalMs);
  let n = 0;
  const linha: Color[] = [];

  await new Promise<void>((resolve) => {
    source.onResult((r) => {
      n++;
      linha.push(r.color);
      const eventos = engine.onResult(r);

      for (const ev of eventos) {
        if (ev.kind === 'entry') {
          console.log(`\n[giro ${n}] ultimas: ${F.seqPretty(linha.slice(-8))}`);
          console.log(plain(F.entryAlert(ev.pattern, ev.triggerColors, repos.signals.scoreboard(ev.pattern.id, ev.pattern.name))));
        } else if (ev.kind === 'gale') {
          console.log(plain(F.galeAlert(ev.pattern, ev.gale, ev.round.color)));
        } else if (ev.kind === 'resolved') {
          console.log(
            plain(F.resolvedAlert(ev.pattern, ev.status, ev.round.color, ev.signal.resolvedGale, ev.signal.wonOnWhite, ev.scoreboard)),
          );
          console.log('-'.repeat(50));
        }
      }

      if (n >= rodadas) {
        void source.stop().then(resolve);
      }
    });
    void source.start();
  });

  const sb = repos.signals.scoreboard(pattern.id, pattern.name);
  console.log('\n' + '='.repeat(64));
  console.log(plain(F.scoreboardBlock(sb, 'PLACAR FINAL')));

  const bt = backtest(repos.results.allAsc(), {
    parsed,
    entryColor: pattern.entryColor,
    gales: pattern.gales,
    whiteRule: pattern.whiteRule,
  });
  console.log('\n' + plain(F.backtestBlock(pattern, bt)));
  console.log('='.repeat(64));
  db.close();
}

main().catch((err) => {
  console.error('erro na demonstracao:', err instanceof Error ? err.message : err);
  process.exit(1);
});
