import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../src/engine/grammar';
import { matchAtEnd } from '../src/engine/matcher';
import { Color, colorOfRoll, RoundView } from '../src/types';

/** Historico so de cores: a pedra nao foi informada pela fonte. */
const seq = (s: string): RoundView[] => [...s].map((c) => ({ color: c as Color, roll: null }));

/** Historico com as pedras; a cor sai da propria pedra. */
const pedras = (...ns: number[]): RoundView[] => ns.map((n) => ({ color: colorOfRoll(n), roll: n }));

test('o padrao do cliente casa com a sequencia exata', () => {
  assert.equal(matchAtEnd(parsePattern('P P A P A'), seq('PPAPA')), 5);
});

test('nao casa com sequencia diferente', () => {
  assert.equal(matchAtEnd(parsePattern('P P A P A'), seq('PAAPA')), null);
});

test('ancora no fim do historico, ignorando o que vem antes', () => {
  assert.equal(matchAtEnd(parsePattern('P P A P A'), seq('ABPPPAPA')), 5);
});

test('precisa terminar na ultima rodada', () => {
  // a sequencia PPAPA aconteceu, mas ja passou uma rodada: nao e gatilho agora
  assert.equal(matchAtEnd(parsePattern('P P A P A'), seq('PPAPAP')), null);
});

test('historico curto nao casa', () => {
  assert.equal(matchAtEnd(parsePattern('P P A P A'), seq('PAPA')), null);
  assert.equal(matchAtEnd(parsePattern('P P A P A'), []), null);
});

test('quantificador fixo', () => {
  assert.equal(matchAtEnd(parsePattern('P{3}'), seq('APPP')), 3);
  assert.equal(matchAtEnd(parsePattern('P{3}'), seq('APP')), null);
});

test('negacao de branco', () => {
  assert.equal(matchAtEnd(parsePattern('!B{3}'), seq('PAP')), 3);
  assert.equal(matchAtEnd(parsePattern('!B{3}'), seq('PBP')), null);
});

test('faixa casa o maior comprimento possivel', () => {
  assert.equal(matchAtEnd(parsePattern('P{2,4} A'), seq('PPPA')), 4);
  assert.equal(matchAtEnd(parsePattern('P{2,4} A'), seq('PPA')), 3);
  assert.equal(matchAtEnd(parsePattern('P{2,4} A'), seq('PA')), null);
});

test('coringa aceita qualquer cor, inclusive branco', () => {
  assert.equal(matchAtEnd(parsePattern('P * P'), seq('PAP')), 3);
  assert.equal(matchAtEnd(parsePattern('P * P'), seq('PBP')), 3);
  assert.equal(matchAtEnd(parsePattern('P * P'), seq('PPP')), 3);
});

test('alternancia', () => {
  assert.equal(matchAtEnd(parsePattern('P A P A P'), seq('BPAPAP')), 5);
  assert.equal(matchAtEnd(parsePattern('P A P A P'), seq('BPAPPP')), null);
});

test('padrao longo com faixa nao explode', () => {
  const p = parsePattern('!B{1,20} P{1,20} A{1,20}');
  const hist = seq('P'.repeat(20) + 'P'.repeat(10) + 'A'.repeat(10));
  const started = Date.now();
  assert.notEqual(matchAtEnd(p, hist), null);
  assert.ok(Date.now() - started < 500, 'matcher deve resolver rapido');
});
