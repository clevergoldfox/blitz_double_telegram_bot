import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern, normalizeExpr, PatternSyntaxError, MAX_PATTERN_LENGTH } from '../src/engine/grammar';

test('padrao do cliente em letras', () => {
  const p = parsePattern('P P A P A');
  assert.equal(p.tokens.length, 5);
  assert.equal(p.minLength, 5);
  assert.equal(p.maxLength, 5);
  assert.equal(p.normalized, 'P P A P A');
});

test('padrao do cliente exatamente como ele escreveu, com erro de digitacao', () => {
  // Mensagem original: "Preto + Preto + amarelho+preto+amarelo"
  assert.equal(normalizeExpr('Preto + Preto + amarelho+preto+amarelo'), 'P P A P A');
  assert.equal(parsePattern('Preto + Preto + amarelho+preto+amarelo').normalized, 'P P A P A');
});

test('aceita emoji', () => {
  assert.equal(normalizeExpr('\u26AB\u26AB\u{1F7E1}\u26AB\u{1F7E1}'), 'PPAPA');
  assert.equal(parsePattern('\u26AB\u26AB\u{1F7E1}\u26AB\u{1F7E1}').normalized, 'P P A P A');
});

test('aceita vermelho como apelido de amarelo', () => {
  assert.equal(normalizeExpr('vermelho preto'), 'A P');
});

test('quantificador fixo', () => {
  const p = parsePattern('P{3}');
  assert.equal(p.minLength, 3);
  assert.equal(p.maxLength, 3);
  assert.equal(p.normalized, 'P{3}');
});

test('quantificador em faixa', () => {
  const p = parsePattern('P{2,4} A');
  assert.equal(p.minLength, 3);
  assert.equal(p.maxLength, 5);
  assert.equal(p.normalized, 'P{2,4} A');
});

test('negacao: dez rodadas sem branco', () => {
  const p = parsePattern('!B{10}');
  assert.equal(p.minLength, 10);
  assert.deepEqual(p.tokens[0].atom, { kind: 'not', colors: ['B'] });
});

test('coringa', () => {
  const p = parsePattern('P * P');
  assert.deepEqual(p.tokens[1].atom, { kind: 'any' });
});

test('erros de sintaxe', () => {
  const ruins = ['', '   ', 'X', 'Z Z', '!', '!PAB', 'P{0}', 'P{3,2}', 'P{', 'P{a}'];
  for (const r of ruins) {
    assert.throws(() => parsePattern(r), PatternSyntaxError, `deveria recusar: ${JSON.stringify(r)}`);
  }
});

test('recusa padrao maior que o teto', () => {
  assert.throws(() => parsePattern(`P{${MAX_PATTERN_LENGTH + 1}}`), PatternSyntaxError);
  assert.doesNotThrow(() => parsePattern(`P{${MAX_PATTERN_LENGTH}}`));
});
