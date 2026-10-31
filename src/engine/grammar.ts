import { Color, COLOR_EMOJI, isColor } from '../types';

/**
 * Gramatica de padroes do Double.
 *
 *   expr       := token+
 *   token      := atom quantificador?
 *   atom       := 'P' | 'A' | 'B' | '*' | '!' cor+
 *   quantificador := '{' n '}' | '{' n ',' m '}'
 *
 * Exemplos:
 *   "P P A P A"   -> preto, preto, amarelo, preto, amarelo  (o padrao do cliente)
 *   "P{3}"        -> tres pretos seguidos
 *   "!B{10}"      -> dez rodadas sem branco
 *   "P A P A P"   -> alternancia preto/amarelo
 *   "P * P"       -> preto, qualquer cor, preto
 *   "P{2,4} A"    -> de dois a quatro pretos, depois um amarelo
 */

export type Atom =
  | { kind: 'color'; color: Color }
  | { kind: 'any' }
  | { kind: 'not'; colors: Color[] };

export interface Token {
  atom: Atom;
  min: number;
  max: number;
}

export interface ParsedPattern {
  tokens: Token[];
  /** Menor numero de rodadas que o padrao pode casar. */
  minLength: number;
  /** Maior numero de rodadas que o padrao pode casar. */
  maxLength: number;
  /** Expressao normalizada, do jeito que guardamos no banco. */
  normalized: string;
}

export class PatternSyntaxError extends Error {}

/** Teto de rodadas por padrao: evita padrao absurdo travar o motor. */
export const MAX_PATTERN_LENGTH = 60;

// Sufixo livre ([a-z]*) de proposito: o cliente escreve "amarelho", "pretos",
// "amarela". Tolerar a variacao evita erro de sintaxe por causa de digitacao.
const WORD_ALIASES: Array<[RegExp, string]> = [
  [/pret[a-z]*/g, 'P'],
  [/amarel[a-z]*/g, 'A'],
  [/branc[a-z]*/g, 'B'],
  // "vermelho" e aceito como apelido de amarelo: quem vem da Blaze usa esse termo.
  [/vermelh[a-z]*/g, 'A'],
];

const CHAR_ALIASES: Record<string, string> = {
  // emojis de cor
  '\u26AB': 'P', '\u2B1B': 'P', '\u{1F5A4}': 'P', '\u{1F311}': 'P',
  '\u{1F7E1}': 'A', '\u{1F7E8}': 'A', '\u{1F49B}': 'A',
  '\u26AA': 'B', '\u2B1C': 'B', '\u{1F90D}': 'B',
  // apelidos de letra
  V: 'A', N: 'P',
};

/**
 * Deixa a entrada do usuario num formato canonico antes de tokenizar.
 * Aceita emoji, nome da cor em portugues e separadores livres ("+", ",", "-").
 */
export function normalizeExpr(raw: string): string {
  let s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, rep] of WORD_ALIASES) s = s.replace(re, rep);
  s = s.toUpperCase();
  let out = '';
  // A virgula tem dois papeis: separador entre cores ("P,P,A") e parte do
  // quantificador ("{2,4}"). So vira espaco fora das chaves.
  let inBrace = false;
  for (const ch of s) {
    if (ch === '{') inBrace = true;
    else if (ch === '}') inBrace = false;

    if (CHAR_ALIASES[ch]) out += CHAR_ALIASES[ch];
    else if (!inBrace && '+,-/>'.includes(ch)) out += ' ';
    else out += ch;
  }
  return out.replace(/[^\S]+/g, ' ').replace(/\s*([{,}])\s*/g, '$1').trim();
}

export function parsePattern(raw: string): ParsedPattern {
  const src = normalizeExpr(raw);
  if (!src) throw new PatternSyntaxError('Padrao vazio. Exemplo: P P A P A');

  const tokens: Token[] = [];
  let i = 0;

  const fail = (msg: string): never => {
    throw new PatternSyntaxError(`${msg} (posicao ${i + 1} de "${src}")`);
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ') { i++; continue; }

    let atom: Atom;
    if (ch === '*') {
      atom = { kind: 'any' };
      i++;
    } else if (ch === '!') {
      i++;
      const colors: Color[] = [];
      while (i < src.length && isColor(src[i])) {
        const c = src[i] as Color;
        if (!colors.includes(c)) colors.push(c);
        i++;
      }
      if (colors.length === 0) fail('Depois de "!" informe ao menos uma cor, ex. !B');
      if (colors.length === 3) fail('"!PAB" nunca casa: exclui todas as cores');
      atom = { kind: 'not', colors };
    } else if (isColor(ch)) {
      atom = { kind: 'color', color: ch };
      i++;
    } else {
      return fail(`Caractere invalido "${ch}". Use P, A, B, *, ! ou {n}`);
    }

    // quantificador opcional
    let min = 1;
    let max = 1;
    if (src[i] === '{') {
      const close = src.indexOf('}', i);
      if (close === -1) fail('Falta fechar "}"');
      const body = src.slice(i + 1, close).trim();
      const m = /^(\d+)(?:\s*,\s*(\d+))?$/.exec(body);
      if (!m) fail(`Quantificador invalido "{${body}}". Use {3} ou {2,4}`);
      min = Number(m![1]);
      max = m![2] === undefined ? min : Number(m![2]);
      if (min < 1) fail('O quantificador precisa ser no minimo 1');
      if (max < min) fail(`Quantificador invalido "{${body}}": o maximo e menor que o minimo`);
      i = close + 1;
    }

    tokens.push({ atom, min, max });
  }

  if (tokens.length === 0) throw new PatternSyntaxError('Padrao vazio. Exemplo: P P A P A');

  const minLength = tokens.reduce((a, t) => a + t.min, 0);
  const maxLength = tokens.reduce((a, t) => a + t.max, 0);

  if (minLength < 1) throw new PatternSyntaxError('O padrao precisa ter ao menos 1 rodada');
  if (maxLength > MAX_PATTERN_LENGTH) {
    throw new PatternSyntaxError(
      `Padrao longo demais: ${maxLength} rodadas (maximo ${MAX_PATTERN_LENGTH})`,
    );
  }

  return { tokens, minLength, maxLength, normalized: formatTokens(tokens) };
}

function atomToString(a: Atom): string {
  if (a.kind === 'any') return '*';
  if (a.kind === 'not') return '!' + a.colors.join('');
  return a.color;
}

export function formatTokens(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const base = atomToString(t.atom);
      if (t.min === 1 && t.max === 1) return base;
      if (t.min === t.max) return `${base}{${t.min}}`;
      return `${base}{${t.min},${t.max}}`;
    })
    .join(' ');
}

/** Versao com emoji, para mostrar no Telegram. */
export function formatTokensPretty(tokens: Token[]): string {
  return tokens
    .map((t) => {
      let base: string;
      if (t.atom.kind === 'color') base = COLOR_EMOJI[t.atom.color];
      else if (t.atom.kind === 'any') base = '\u2753';
      else base = 'nao-' + t.atom.colors.map((c) => COLOR_EMOJI[c]).join('');
      if (t.min === 1 && t.max === 1) return base;
      if (t.min === t.max) return `${base}x${t.min}`;
      return `${base}x${t.min}-${t.max}`;
    })
    .join(' ');
}
