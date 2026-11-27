import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index';
import { makeRepos } from '../src/db/repos';
import * as F from '../src/bot/format';
import { Color, Pattern, RoundView, Scoreboard } from '../src/types';

/**
 * O modo publico existe para quem revende o sinal. O teste que importa aqui
 * nao e "o texto mudou", e sim "a estrategia nao vaza": nem o nome do padrao,
 * nem a sequencia do gatilho podem sobrar em nenhum dos tres alertas.
 */

const PADRAO: Pattern = {
  id: 7,
  // Pior caso de propósito: o /novo usa a sequencia como nome quando o cliente
  // nao informa um, entao o nome carrega a estrategia inteira.
  name: 'P P A P A',
  expr: 'P P A P A',
  entryColor: 'P',
  gales: 1,
  whiteRule: 'gale',
  active: true,
  createdAt: '2026-11-03T00:00:00.000Z',
};

const GATILHO: RoundView[] = ([['P', 10], ['P', 12], ['A', 3], ['P', 9], ['A', 5]] as const)
  .map(([color, roll]) => ({ color: color as Color, roll }));

const PLACAR: Scoreboard = {
  patternId: 7,
  patternName: 'P P A P A',
  total: 10,
  greens: 7,
  greenG0: 5,
  greenG1: 2,
  greenG2: 0,
  greenWhite: 0,
  reds: 3,
  open: 0,
  hitRate: 0.7,
  currentStreak: 2,
  streakKind: 'green',
  bestGreenStreak: 4,
  worstRedStreak: 2,
};

/** Os tres alertas que o assinante recebe, no modo pedido. */
function todosOsAlertas(mode: F.AlertMode): string[] {
  return [
    F.entryAlert(PADRAO, GATILHO, PLACAR, mode),
    F.galeAlert(PADRAO, 1, 'A', mode),
    F.resolvedAlert(PADRAO, 'green', 'P', 1, false, PLACAR, mode),
    F.resolvedAlert(PADRAO, 'red', 'A', null, false, PLACAR, mode),
  ];
}

test('modo publico nao vaza o nome nem a sequencia do gatilho', () => {
  for (const texto of todosOsAlertas('publico')) {
    assert.ok(!texto.includes(PADRAO.name), `vazou o nome em: ${texto}`);
    assert.ok(!texto.includes('Gatilho'), `vazou o rotulo do gatilho em: ${texto}`);
    // a sequencia em emoji e a outra forma de vazar
    assert.ok(!texto.includes(F.seqPretty(GATILHO)), `vazou a sequencia em: ${texto}`);
  }
});

test('modo publico ainda diz o que o assinante precisa para apostar', () => {
  const entrada = F.entryAlert(PADRAO, GATILHO, PLACAR, 'publico');
  assert.match(entrada, /ENTRADA CONFIRMADA/);
  assert.match(entrada, /Sinal #7/);
  assert.match(entrada, /PRETO/);        // a cor da entrada
  assert.match(entrada, /ate G1/);       // quantos gales
  assert.match(entrada, /7V \/ 3D/);     // o placar continua visivel
  // e nao sobra linha em branco dupla no lugar do gatilho removido
  assert.ok(!entrada.includes('\n\n\n'), 'ficou buraco no texto');
});

test('modo completo continua mostrando nome e gatilho', () => {
  const entrada = F.entryAlert(PADRAO, GATILHO, PLACAR, 'completo');
  assert.match(entrada, /Padrao #7/);
  assert.ok(entrada.includes(PADRAO.name));
  assert.ok(entrada.includes(F.seqPretty(GATILHO)));
  assert.match(F.galeAlert(PADRAO, 1, 'A', 'completo'), /Padrao #7/);
});

test('o padrao de fabrica e o modo completo', () => {
  assert.equal(F.entryAlert(PADRAO, GATILHO, PLACAR), F.entryAlert(PADRAO, GATILHO, PLACAR, 'completo'));
  assert.equal(F.galeAlert(PADRAO, 1, 'A'), F.galeAlert(PADRAO, 1, 'A', 'completo'));
});

test('o modo escolhido sobrevive a reinicializacao do robo', () => {
  const db = openDb(':memory:');

  const repos = makeRepos(db, 'completo');
  assert.equal(repos.settings.alertMode, 'completo');
  repos.settings.alertMode = 'publico';

  // Reabrir os repositorios simula o restart: o valor vem do banco, e o
  // fallback do .env nao pode reabrir a estrategia que o dono fechou.
  const depoisDoRestart = makeRepos(db, 'completo');
  assert.equal(depoisDoRestart.settings.alertMode, 'publico');
});
