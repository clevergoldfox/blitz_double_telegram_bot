import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index';
import { makeRepos } from '../src/db/repos';
import { Engine, EngineEvent } from '../src/engine/engine';
import { SimulatorSource } from '../src/sources/simulator';
import { backtest } from '../src/engine/backtest';
import { parsePattern } from '../src/engine/grammar';
import { Color, GameResult, WhiteRule } from '../src/types';
import * as F from '../src/bot/format';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('ponta a ponta: simulador -> motor -> mensagem formatada', async () => {
  const db = openDb(':memory:');
  const repos = makeRepos(db);
  repos.patterns.create({
    name: 'Padrao do cliente',
    expr: parsePattern('Preto + Preto + amarelho+preto+amarelo').normalized,
    entryColor: 'P',
    gales: 1,
    whiteRule: 'gale',
    active: true,
  });

  const engine = new Engine(repos);
  engine.primeFromHistory();

  const mensagens: string[] = [];
  // sequencia roteirizada: o gatilho, depois um preto (GREEN no G0)
  const source = new SimulatorSource(5, [...'PPAPAP'] as Color[]);

  source.onResult((r: GameResult) => {
    for (const ev of engine.onResult(r)) {
      const sb = ev.kind === 'gap' ? null : repos.signals.scoreboard(ev.pattern.id, ev.pattern.name);
      if (ev.kind === 'entry') mensagens.push(F.entryAlert(ev.pattern, ev.triggerColors, sb!));
      if (ev.kind === 'gale') mensagens.push(F.galeAlert(ev.pattern, ev.gale, ev.round.color));
      if (ev.kind === 'resolved') {
        mensagens.push(
          F.resolvedAlert(ev.pattern, ev.status, ev.round.color, ev.signal.resolvedGale, ev.signal.wonOnWhite, ev.scoreboard),
        );
      }
    }
  });

  await source.start();
  await sleep(120);
  await source.stop();

  const entrada = mensagens.find((m) => m.includes('ENTRADA CONFIRMADA'));
  const green = mensagens.find((m) => m.includes('GREEN'));

  assert.ok(entrada, 'deveria ter saido um alerta de entrada:\n' + mensagens.join('\n--\n'));
  assert.match(entrada!, /Entrar no/);
  assert.match(entrada!, /ate G1/);
  assert.ok(green, 'deveria ter fechado GREEN');
  assert.match(green!, /GREEN no G0/);

  // o HTML enviado ao Telegram precisa ter tags balanceadas
  for (const m of mensagens) {
    const abre = (m.match(/<b>/g) ?? []).length;
    const fecha = (m.match(/<\/b>/g) ?? []).length;
    assert.equal(abre, fecha, 'tags <b> desbalanceadas em:\n' + m);
  }
});

/**
 * Propriedade central: o backtest tem de concordar com o motor ao vivo sobre o
 * mesmo historico. Se divergirem, o placar que o cliente usa para decidir esta
 * mentindo em algum dos dois lugares.
 */
test('backtest e motor ao vivo chegam ao mesmo placar', () => {
  const casos: Array<{ expr: string; entry: Color; gales: number; white: WhiteRule }> = [
    { expr: 'P P A P A', entry: 'P', gales: 1, white: 'gale' },
    { expr: 'P P', entry: 'A', gales: 0, white: 'red' },
    { expr: '!B{3}', entry: 'B', gales: 2, white: 'protect' },
    { expr: 'P{2,3} A', entry: 'P', gales: 1, white: 'gale' },
    { expr: 'A * P', entry: 'A', gales: 2, white: 'gale' },
  ];

  // historico fixo e razoavelmente longo, com branco espalhado
  const colors: Color[] = [];
  let seed = 12345;
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const roll = seed % 15;
    colors.push(roll === 0 ? 'B' : roll <= 7 ? 'A' : 'P');
  }
  const history: GameResult[] = colors.map((color, i) => ({
    roundId: 'h' + i,
    color,
    roll: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 20_000).toISOString(),
    live: true,
  }));

  for (const caso of casos) {
    // --- ao vivo ---
    const db = openDb(':memory:');
    const repos = makeRepos(db);
    const p = repos.patterns.create({
      name: caso.expr, expr: caso.expr, entryColor: caso.entry,
      gales: caso.gales, whiteRule: caso.white, active: true,
    });
    const engine = new Engine(repos);
    engine.primeFromHistory();
    for (const r of history) engine.onResult(r);
    const live = repos.signals.scoreboard(p.id, p.name);

    // --- backtest ---
    const bt = backtest(history, {
      parsed: parsePattern(caso.expr),
      entryColor: caso.entry,
      gales: caso.gales,
      whiteRule: caso.white,
    });

    const rotulo = `${caso.expr} -> ${caso.entry} G${caso.gales} ${caso.white}`;
    assert.equal(bt.greens, live.greens, `greens divergiram em ${rotulo}`);
    assert.equal(bt.reds, live.reds, `reds divergiram em ${rotulo}`);
    assert.equal(bt.signals, live.total + live.open, `total de sinais divergiu em ${rotulo}`);
    assert.equal(bt.greenWhite, live.greenWhite, `greens no branco divergiram em ${rotulo}`);
    assert.equal(bt.bestGreenStreak, live.bestGreenStreak, `melhor sequencia divergiu em ${rotulo}`);
    assert.ok(bt.signals > 20, `${rotulo} precisa de amostra relevante, veio ${bt.signals}`);
    db.close();
  }
});

test('composicao da roleta: 7 pretos, 7 amarelos, 1 branco em 15 casas', () => {
  const contagem: Record<Color, number> = { P: 0, A: 0, B: 0 };
  for (let roll = 0; roll < SimulatorSource.SLOTS; roll++) {
    contagem[SimulatorSource.colorForRoll(roll)]++;
  }
  assert.deepEqual(contagem, { P: 7, A: 7, B: 1 });

  // Consequencia direta dessa composicao, e o numero que o cliente precisa
  // conhecer: entrada em cor com 1 gale tende a ~71,6% no longo prazo,
  // qualquer que seja o gatilho, porque os giros sao independentes.
  const pCor = 7 / 15;
  const esperado = pCor + (1 - pCor) * pCor;
  assert.ok(Math.abs(esperado - 0.7156) < 0.001, `base teorica mudou: ${esperado}`);
});

test('simulador emite resultados com round_id unico', async () => {
  const source = new SimulatorSource(5);
  const ids = new Set<string>();
  let n = 0;
  source.onResult((r) => { ids.add(r.roundId); n++; });
  await source.start();
  await sleep(120);
  await source.stop();

  assert.ok(n >= 3, `esperava alguns giros, veio ${n}`);
  assert.equal(ids.size, n, 'round_id repetido no simulador');
});
