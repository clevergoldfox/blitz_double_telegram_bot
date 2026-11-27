import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRolls, normalizeExpr, parsePattern, PatternSyntaxError } from '../src/engine/grammar';
import { matchAtEnd } from '../src/engine/matcher';
import { colorOfRoll, Color, RoundView } from '../src/types';

/** Historico com as pedras; a cor sai da propria pedra, como na roleta real. */
const pedras = (...ns: number[]): RoundView[] => ns.map((n) => ({ color: colorOfRoll(n), roll: n }));

/** Historico so com cor, como vem de uma fonte que nao informa o numero. */
const cores = (s: string): RoundView[] => [...s].map((c) => ({ color: c as Color, roll: null }));

// --- leitura da sintaxe ---

test('pedra unica', () => {
  const p = parsePattern('5');
  assert.deepEqual(p.tokens[0].atom, { kind: 'roll', rolls: [5] });
  assert.equal(p.normalized, '5');
  assert.equal(p.usesRolls, true);
});

test('conjunto de pedras', () => {
  assert.deepEqual(parsePattern('[1,5,9]').tokens[0].atom, { kind: 'roll', rolls: [1, 5, 9] });
});

test('faixa de pedras', () => {
  const p = parsePattern('8-14');
  assert.deepEqual((p.tokens[0].atom as { rolls: number[] }).rolls, [8, 9, 10, 11, 12, 13, 14]);
  // a forma canonica volta a ser faixa, nao a lista inteira
  assert.equal(p.normalized, '[8-14]');
});

test('faixa com espacos ao redor do tracinho', () => {
  assert.equal(parsePattern('8 - 14').normalized, '[8-14]');
});

test('tracinho entre cores continua sendo separador', () => {
  assert.equal(parsePattern('P-P-A').normalized, 'P P A');
});

test('negacao de pedra', () => {
  assert.deepEqual(parsePattern('!0').tokens[0].atom, { kind: 'notRoll', rolls: [0] });
  assert.equal(parsePattern('!0').normalized, '!0');
});

test('pedra e cor no mesmo padrao', () => {
  const p = parsePattern('0 P P');
  assert.equal(p.tokens.length, 3);
  assert.equal(p.tokens[0].atom.kind, 'roll');
  assert.equal(p.tokens[1].atom.kind, 'color');
  assert.equal(p.normalized, '0 P P');
});

test('quantificador vale para pedra tambem', () => {
  const p = parsePattern('8-14{3}');
  assert.equal(p.minLength, 3);
  assert.equal(p.maxLength, 3);
  assert.equal(p.normalized, '[8-14]{3}');
});

test('padrao so de cor nao se declara como padrao de numero', () => {
  assert.equal(parsePattern('P P A P A').usesRolls, false);
});

test('formatRolls colapsa sequencias', () => {
  assert.equal(formatRolls([5]), '5');
  assert.equal(formatRolls([1, 5, 9]), '[1,5,9]');
  assert.equal(formatRolls([8, 9, 10, 11, 12, 13, 14]), '[8-14]');
  assert.equal(formatRolls([1, 2, 3, 7, 9, 10]), '[1-3,7,9-10]');
});

// --- "apos N casas", que e como o cliente fala ---

test('"apos 5 casas" vira quatro curingas: a entrada cai na quinta rodada', () => {
  assert.equal(normalizeExpr('5 apos 5 casas'), '5 *{4}');
  assert.equal(parsePattern('5 apos 5 casas').normalized, '5 *{4}');
  // gatilho + 4 rodadas no meio = o padrao fecha na 4a, e o motor entra na 5a
  assert.equal(parsePattern('5 apos 5 casas').maxLength, 5);
});

test('"apos 1 casa" e a entrada imediata, sem curinga nenhum', () => {
  assert.equal(parsePattern('5 apos 1 casa').normalized, '5');
});

test('aceita as outras formas de dizer a mesma coisa', () => {
  for (const txt of ['5 depois de 3 casas', '5 espera 3 rodadas', '5 pular 3 casas']) {
    assert.equal(parsePattern(txt).normalized, '5 *{2}', txt);
  }
});

test('com acento e maiuscula, do jeito que se digita', () => {
  assert.equal(parsePattern('5 após 5 casas').normalized, '5 *{4}');
});

// --- casamento ---

test('a estrategia do cliente casa no historico', () => {
  const p = parsePattern('5 apos 5 casas');
  // saiu o 5 e passaram quatro rodadas: o padrao fecha agora
  assert.equal(matchAtEnd(p, pedras(5, 11, 2, 9, 14)), 5);
  // se a pedra do inicio nao for 5, nao casa
  assert.equal(matchAtEnd(p, pedras(6, 11, 2, 9, 14)), null);
});

test('conjunto e faixa casam a pedra certa', () => {
  assert.equal(matchAtEnd(parsePattern('[1,5,9]'), pedras(5)), 1);
  assert.equal(matchAtEnd(parsePattern('[1,5,9]'), pedras(6)), null);
  assert.equal(matchAtEnd(parsePattern('8-14'), pedras(14)), 1);
  assert.equal(matchAtEnd(parsePattern('8-14'), pedras(7)), null);
});

test('negacao de pedra exclui so aquela pedra', () => {
  assert.equal(matchAtEnd(parsePattern('!0'), pedras(9)), 1);
  assert.equal(matchAtEnd(parsePattern('!0'), pedras(0)), null);
});

test('pedra e cor combinam no mesmo casamento', () => {
  // 0 = branco, depois dois pretos
  assert.equal(matchAtEnd(parsePattern('0 P P'), pedras(0, 9, 13)), 3);
  assert.equal(matchAtEnd(parsePattern('0 P P'), pedras(0, 9, 3)), null);
});

test('sem o numero na fonte, padrao por pedra nao dispara (nem na negacao)', () => {
  // Melhor nao avisar do que avisar errado: sem saber a pedra, nao da para
  // afirmar nem "saiu o 5" nem "nao saiu o 5".
  assert.equal(matchAtEnd(parsePattern('5'), cores('A')), null);
  assert.equal(matchAtEnd(parsePattern('!5'), cores('A')), null);
  // padrao de cor continua funcionando normalmente nessa mesma fonte
  assert.equal(matchAtEnd(parsePattern('A'), cores('A')), 1);
});

// --- erros com mensagem util ---

test('recusa pedra fora da roleta', () => {
  assert.throws(() => parsePattern('15'), PatternSyntaxError);
  assert.throws(() => parsePattern('55'), (e: Error) => /0 a 14/.test(e.message));
  assert.throws(() => parsePattern('[1,99]'), PatternSyntaxError);
});

test('recusa faixa invertida dizendo como escrever', () => {
  assert.throws(() => parsePattern('14-8'), (e: Error) => /8-14/.test(e.message));
});

test('recusa colchete sem fechar', () => {
  assert.throws(() => parsePattern('[1,5'), (e: Error) => /\]/.test(e.message));
});

// --- como o cliente realmente escreve ---

test('aceita a frase do cliente palavra por palavra', () => {
  // "ao sair a pedra 5 apos 5 casas entrar na cor amarela"
  assert.equal(parsePattern('ao sair a pedra 5 apos 5 casas').normalized, '5 *{4}');
  assert.equal(parsePattern('pedra 5').normalized, '5');
  assert.equal(parsePattern('numero 5').normalized, '5');
});

test('remover o artigo nao pode engolir o amarelo', () => {
  // "a" sozinho e amarelo; so cai quando vem grudado em "pedra"/"numero"
  assert.equal(parsePattern('P A P').normalized, 'P A P');
  assert.equal(parsePattern('A A A').normalized, 'A A A');
  assert.equal(parsePattern('5 A 5').normalized, '5 A 5');
});
