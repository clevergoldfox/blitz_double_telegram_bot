import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index';
import { makeRepos, Repos } from '../src/db/repos';
import { Engine, EngineEvent } from '../src/engine/engine';
import { Color, GameResult, WhiteRule } from '../src/types';

let seq = 0;
function round(color: Color): GameResult {
  seq++;
  return {
    roundId: 'r' + String(seq).padStart(5, '0'),
    color,
    roll: null,
    // createdAt crescente: a ordenacao do historico depende dele
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    live: true,
  };
}

function setup(opts: { expr: string; entry: Color; gales: number; whiteRule: WhiteRule }) {
  const db = openDb(':memory:');
  const repos: Repos = makeRepos(db);
  const pattern = repos.patterns.create({
    name: 'teste',
    expr: opts.expr,
    entryColor: opts.entry,
    gales: opts.gales,
    whiteRule: opts.whiteRule,
    active: true,
  });
  const engine = new Engine(repos);
  engine.primeFromHistory();
  return { db, repos, pattern, engine };
}

/** Alimenta o motor com uma sequencia e devolve todos os eventos gerados. */
function feed(engine: Engine, colors: string): EngineEvent[] {
  const all: EngineEvent[] = [];
  for (const c of colors) all.push(...engine.onResult(round(c as Color)));
  return all;
}

const kinds = (evs: EngineEvent[]) => evs.map((e) => e.kind);

test('padrao do cliente dispara entrada e fecha GREEN no G0', () => {
  const { engine, repos, pattern } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  // precisa de 5 rodadas confiaveis antes de armar; o gatilho ocupa exatamente 5
  const evs = feed(engine, 'PPAPA');
  assert.deepEqual(kinds(evs), ['entry']);

  const after = feed(engine, 'P'); // entrada no preto, acertou de primeira
  assert.deepEqual(kinds(after), ['resolved']);
  const ev = after[0];
  assert.equal(ev.kind === 'resolved' && ev.status, 'green');
  assert.equal(ev.kind === 'resolved' && ev.signal.resolvedGale, 0);

  const sb = repos.signals.scoreboard(pattern.id, 'teste');
  assert.equal(sb.greens, 1);
  assert.equal(sb.greenG0, 1);
  assert.equal(sb.reds, 0);
  assert.equal(sb.hitRate, 1);
});

test('erra a entrada, avisa o G1 e fecha GREEN no G1', () => {
  const { engine, repos, pattern } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  feed(engine, 'PPAPA');

  const g = feed(engine, 'A'); // perdeu a entrada
  assert.deepEqual(kinds(g), ['gale']);
  assert.equal(g[0].kind === 'gale' && g[0].gale, 1);

  const r = feed(engine, 'P'); // bateu no G1
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'green');
  assert.equal(r[0].kind === 'resolved' && r[0].signal.resolvedGale, 1);
  assert.equal(repos.signals.scoreboard(pattern.id, 't').greenG1, 1);
});

test('erra entrada e G1, fecha RED', () => {
  const { engine, repos, pattern } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  feed(engine, 'PPAPA');
  assert.deepEqual(kinds(feed(engine, 'A')), ['gale']);
  const r = feed(engine, 'A');
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'red');
  const sb = repos.signals.scoreboard(pattern.id, 't');
  assert.equal(sb.reds, 1);
  assert.equal(sb.greens, 0);
});

test('sem gale nenhum: um tiro so', () => {
  const { engine } = setup({ expr: 'P P A P A', entry: 'P', gales: 0, whiteRule: 'gale' });
  feed(engine, 'PPAPA');
  const r = feed(engine, 'A');
  assert.deepEqual(kinds(r), ['resolved']);
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'red');
});

// --- as tres leituras possiveis de "sem protecao no branco" ---

test('branco com regra gale: consome a tentativa e vai pro G1', () => {
  const { engine } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  feed(engine, 'PPAPA');
  const g = feed(engine, 'B');
  assert.deepEqual(kinds(g), ['gale'], 'branco deve mandar pro gale, nao encerrar');
  const r = feed(engine, 'P');
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'green');
});

test('branco com regra red: encerra na hora como RED mesmo tendo gale sobrando', () => {
  const { engine } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'red' });
  feed(engine, 'PPAPA');
  const r = feed(engine, 'B');
  assert.deepEqual(kinds(r), ['resolved']);
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'red');
});

test('branco com protecao: conta GREEN', () => {
  const { engine, repos, pattern } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'protect' });
  feed(engine, 'PPAPA');
  const r = feed(engine, 'B');
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'green');
  assert.equal(r[0].kind === 'resolved' && r[0].signal.wonOnWhite, true);
  assert.equal(repos.signals.scoreboard(pattern.id, 't').greenWhite, 1);
});

test('entrada no proprio branco vence quando sai branco', () => {
  const { engine } = setup({ expr: 'P P A P A', entry: 'B', gales: 0, whiteRule: 'gale' });
  feed(engine, 'PPAPA');
  const r = feed(engine, 'B');
  assert.equal(r[0].kind === 'resolved' && r[0].status, 'green');
  assert.equal(r[0].kind === 'resolved' && r[0].signal.wonOnWhite, false, 'foi acerto da entrada, nao branco protegido');
});

// --- trava de reentrancia ---

test('padrao com sinal aberto nao dispara de novo', () => {
  // Entrada no branco com 2 gales: qualquer cor normal perde a tentativa, entao
  // o sinal fica aberto tempo suficiente para o padrao casar outra vez.
  const { engine, repos, pattern } = setup({ expr: 'P A', entry: 'B', gales: 2, whiteRule: 'gale' });
  feed(engine, 'PA');
  assert.equal(repos.signals.hasOpen(pattern.id), true);

  assert.deepEqual(kinds(feed(engine, 'P')), ['gale']);

  // Agora o historico termina em ...P A, ou seja "P A" casa de novo, mas o sinal
  // anterior continua aberto: nao pode sair uma segunda entrada.
  const evs = feed(engine, 'A');
  assert.ok(!kinds(evs).includes('entry'), 'nao deveria abrir um segundo sinal: ' + kinds(evs).join(','));
  assert.equal(repos.signals.hasOpen(pattern.id), true);
  const abertos = repos.signals.openSignals().filter((s) => s.patternId === pattern.id);
  assert.equal(abertos.length, 1, 'no maximo um sinal aberto por padrao');
});

test('sequencia que se sobrepoe a si mesma nao gera alertas em cascata', () => {
  const { engine } = setup({ expr: 'P P', entry: 'A', gales: 0, whiteRule: 'gale' });
  const evs = feed(engine, 'PPPPPP');
  const entradas = evs.filter((e) => e.kind === 'entry').length;
  const resolvidos = evs.filter((e) => e.kind === 'resolved').length;
  // Cada entrada precisa ser resolvida antes da proxima: nunca mais entradas que resolucoes + 1
  assert.ok(entradas <= resolvidos + 1, `entradas=${entradas} resolvidos=${resolvidos}`);
});

// --- seguranca de historico ---

test('nao dispara enquanto o historico nao for confiavel', () => {
  const { engine } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  engine.markGap('teste de reconexao');
  // as 4 primeiras rodadas nao bastam para rearmar um padrao de 5
  const evs = feed(engine, 'PPAP');
  assert.deepEqual(kinds(evs), []);
  assert.equal(engine.armed, false);
  // a quinta completa a janela confiavel E o gatilho
  const ok = feed(engine, 'A');
  assert.equal(engine.armed, true);
  assert.deepEqual(kinds(ok), ['entry']);
});

test('markGap informa quantas rodadas faltam para rearmar', () => {
  const { engine } = setup({ expr: 'P{7}', entry: 'P', gales: 0, whiteRule: 'gale' });
  const ev = engine.markGap('reconexao');
  assert.equal(ev.kind, 'gap');
  assert.equal(ev.kind === 'gap' && ev.roundsToRearm, 7);
});

test('round repetido e ignorado (deduplicacao por round_id)', () => {
  const { engine, repos } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  const r = round('P');
  assert.deepEqual(engine.onResult(r), []);
  assert.deepEqual(engine.onResult(r), [], 'o mesmo round nao pode ser processado duas vezes');
  assert.equal(repos.results.count(), 1);
});

test('padrao desativado nao dispara', () => {
  const { engine, repos, pattern } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  repos.patterns.update(pattern.id, { active: false });
  assert.deepEqual(kinds(feed(engine, 'PPAPA')), []);
});

test('dois padroes diferentes disparam de forma independente', () => {
  const { engine, repos } = setup({ expr: 'P P A P A', entry: 'P', gales: 1, whiteRule: 'gale' });
  repos.patterns.create({
    name: 'segundo', expr: 'P A', entryColor: 'A', gales: 0, whiteRule: 'gale', active: true,
  });
  const evs = feed(engine, 'PPAPA');
  const entradas = evs.filter((e) => e.kind === 'entry');
  assert.equal(entradas.length, 2, 'os dois padroes terminam em ...P A e devem disparar juntos');
});
