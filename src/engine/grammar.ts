import { Color, COLOR_EMOJI, colorOfRoll, isColor, MAX_ROLL } from '../types';

/**
 * Gramatica de padroes do Double.
 *
 *   expr       := token+
 *   token      := atom quantificador?
 *   atom       := 'P' | 'A' | 'B' | '*' | '!' cor+ | numero | '!' numero
 *   numero     := n | n '-' n | '[' lista ']'
 *   quantificador := '{' n '}' | '{' n ',' m '}'
 *
 * Exemplos por cor:
 *   "P P A P A"   -> preto, preto, amarelo, preto, amarelo  (o padrao do cliente)
 *   "P{3}"        -> tres pretos seguidos
 *   "!B{10}"      -> dez rodadas sem branco
 *   "P * P"       -> preto, qualquer cor, preto
 *   "P{2,4} A"    -> de dois a quatro pretos, depois um amarelo
 *
 * Exemplos por numero (a pedra sorteada, 0 a 14):
 *   "5"           -> saiu a pedra 5
 *   "[1,5,9]"     -> saiu 1, 5 ou 9
 *   "8-14"        -> saiu qualquer pedra da faixa do preto
 *   "!0"          -> qualquer pedra menos o branco
 *   "5 apos 5 casas" -> saiu o 5 e a entrada cai na 5a rodada seguinte
 *
 * Numero e cor convivem no mesmo padrao: "0 P P" e branco, preto, preto.
 */

export type Atom =
  | { kind: 'color'; color: Color }
  | { kind: 'any' }
  | { kind: 'not'; colors: Color[] }
  | { kind: 'roll'; rolls: number[] }
  | { kind: 'notRoll'; rolls: number[] };

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
  /** true se algum atomo depende da pedra sorteada, e nao so da cor. */
  usesRolls: boolean;
}

export class PatternSyntaxError extends Error {}

/** Teto de rodadas por padrao: evita padrao absurdo travar o motor. */
export const MAX_PATTERN_LENGTH = 60;

// Sufixo livre ([a-z]*) de proposito: o cliente escreve "amarelho", "pretos",
// "amarela". Tolerar a variacao evita erro de sintaxe por causa de digitacao.
const WORD_ALIASES: Array<[RegExp, string]> = [
  // Ruido de linguagem natural, jogado fora antes de qualquer outra coisa.
  // O artigo so cai junto com o substantivo ("a pedra 5"): sozinho, "a" e
  // amarelo, e remover a solta destruiria "P A P" sem aviso.
  [/\b(?:ao|se|quando|sair|saiu|saindo|entrar|entra)\b/g, ' '],
  [/\b(?:a|o|na|no|da|do|de)?\s*(?:pedras?|numeros?)\b/g, ' '],
  [/pret[a-z]*/g, 'P'],
  [/amarel[a-z]*/g, 'A'],
  [/branc[a-z]*/g, 'B'],
  // "vermelho" e aceito como apelido de amarelo: quem vem da Blaze usa esse termo.
  [/vermelh[a-z]*/g, 'A'],
];

const CHAR_ALIASES: Record<string, string> = {
  // emojis de cor
  '⚫': 'P', '⬛': 'P', '\u{1F5A4}': 'P', '\u{1F311}': 'P',
  '\u{1F7E1}': 'A', '\u{1F7E8}': 'A', '\u{1F49B}': 'A',
  '⚪': 'B', '⬜': 'B', '\u{1F90D}': 'B',
  // apelidos de letra
  V: 'A', N: 'P',
};

/**
 * "apos N casas" e como o cliente fala a espera entre o gatilho e a entrada.
 *
 * A convencao, escrita aqui para nao se perder: **a entrada acontece na N-esima
 * rodada depois do gatilho**. Entao o padrao precisa cobrir as N-1 rodadas do
 * meio, porque o motor entra sempre na rodada seguinte ao casamento.
 *
 *   "5 apos 1 casa"  -> "5"        (entra na proxima rodada)
 *   "5 apos 5 casas" -> "5 *{4}"   (quatro rodadas no meio, entra na quinta)
 */
const WAIT_ALIAS = /\b(?:apos|depois\s+de|espera[r]?|aguarda[r]?|pula[r]?)\s+(\d{1,2})\s+(?:casas?|rodadas?)\b/g;

/** Avanca/retrocede ignorando espacos: usado para decidir o papel do "-". */
function vizinho(chars: readonly string[], from: number, step: -1 | 1): string {
  for (let i = from; i >= 0 && i < chars.length; i += step) {
    if (chars[i] !== ' ') return chars[i];
  }
  return '';
}

/**
 * Deixa a entrada do usuario num formato canonico antes de tokenizar.
 * Aceita emoji, nome da cor em portugues, numero e separadores livres.
 */
export function normalizeExpr(raw: string): string {
  let s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  s = s.replace(WAIT_ALIAS, (_m, n: string) => {
    const casas = Number(n);
    // 0 ou 1 casa = entrada na proxima rodada, que ja e o comportamento padrao.
    return casas <= 1 ? ' ' : ` *{${casas - 1}} `;
  });

  for (const [re, rep] of WORD_ALIASES) s = s.replace(re, rep);
  s = s.toUpperCase();

  // Por ponto de codigo, nao por unidade UTF-16: o 🟡 e par substituto e
  // indexar com s[i] o parte em dois pedacos que nenhum alias reconhece.
  const chars = [...s];

  let out = '';
  let depth = 0; // dentro de {} ou []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);

    if (CHAR_ALIASES[ch]) { out += CHAR_ALIASES[ch]; continue; }

    // O "-" tem dois papeis: separador livre ("P-P") e faixa de numero ("8-14").
    // So vale como faixa quando ha digito dos dois lados, ignorando espacos.
    if (ch === '-') {
      const faixa = /\d/.test(vizinho(chars, i - 1, -1)) && /\d/.test(vizinho(chars, i + 1, 1));
      out += faixa ? '-' : ' ';
      continue;
    }

    // A virgula separa cores ("P,P,A") mas tambem compoe quantificador ("{2,4}")
    // e conjunto de pedras ("[1,5]"). So vira espaco fora de chaves e colchetes.
    if (depth === 0 && '+,/>'.includes(ch)) { out += ' '; continue; }

    out += ch;
  }

  return out
    .replace(/\s+/g, ' ')
    .replace(/\s*([{,}[\]])\s*/g, '$1')
    .replace(/\s*-\s*/g, '-')
    .trim();
}

function parseRollList(body: string, fail: (m: string) => never): number[] {
  const rolls: number[] = [];
  for (const parte of body.split(',')) {
    const item = parte.trim();
    if (!item) fail('Lista de pedras com item vazio. Exemplo: [1,5,9]');

    const faixa = /^(\d{1,2})-(\d{1,2})$/.exec(item);
    if (faixa) {
      const de = Number(faixa[1]);
      const ate = Number(faixa[2]);
      if (de > MAX_ROLL || ate > MAX_ROLL) fail(`A pedra vai de 0 a ${MAX_ROLL}. Recebi "${item}"`);
      if (de > ate) fail(`Faixa invertida "${item}". Escreva ${ate}-${de}`);
      for (let n = de; n <= ate; n++) if (!rolls.includes(n)) rolls.push(n);
      continue;
    }

    if (!/^\d{1,2}$/.test(item)) fail(`Pedra invalida "${item}". Use numero de 0 a ${MAX_ROLL}`);
    const n = Number(item);
    if (n > MAX_ROLL) fail(`A pedra ${n} nao existe no Double: vai de 0 a ${MAX_ROLL}`);
    if (!rolls.includes(n)) rolls.push(n);
  }
  if (rolls.length === 0) fail('Informe ao menos uma pedra. Exemplo: 5 ou [1,5,9]');
  return rolls;
}

export function parsePattern(raw: string): ParsedPattern {
  const src = normalizeExpr(raw);
  if (!src) throw new PatternSyntaxError('Padrao vazio. Exemplo: P P A P A');

  const tokens: Token[] = [];
  let i = 0;

  const fail = (msg: string): never => {
    throw new PatternSyntaxError(`${msg} (posicao ${i + 1} de "${src}")`);
  };

  /** Le "5", "8-14" ou "[1,5,9]" a partir de src[i]. */
  const readRolls = (): number[] => {
    if (src[i] === '[') {
      const close = src.indexOf(']', i);
      if (close === -1) fail('Falta fechar "]"');
      const body = src.slice(i + 1, close);
      i = close + 1;
      return parseRollList(body, fail);
    }
    const m = /^\d{1,2}(?:-\d{1,2})?/.exec(src.slice(i));
    if (!m) fail('Esperava um numero de pedra aqui');
    i += m![0].length;
    return parseRollList(m![0], fail);
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
      if (src[i] === '[' || /\d/.test(src[i] ?? '')) {
        const rolls = readRolls();
        if (rolls.length > MAX_ROLL) fail('Essa negacao exclui todas as pedras: nunca casa');
        atom = { kind: 'notRoll', rolls };
      } else {
        const colors: Color[] = [];
        while (i < src.length && isColor(src[i])) {
          const c = src[i] as Color;
          if (!colors.includes(c)) colors.push(c);
          i++;
        }
        if (colors.length === 0) fail('Depois de "!" informe uma cor ou um numero, ex. !B ou !0');
        if (colors.length === 3) fail('"!PAB" nunca casa: exclui todas as cores');
        atom = { kind: 'not', colors };
      }
    } else if (ch === '[' || /\d/.test(ch)) {
      atom = { kind: 'roll', rolls: readRolls() };
    } else if (isColor(ch)) {
      atom = { kind: 'color', color: ch };
      i++;
    } else {
      return fail(`Caractere invalido "${ch}". Use P, A, B, numero de 0 a ${MAX_ROLL}, *, ! ou {n}`);
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

  const usesRolls = tokens.some((t) => t.atom.kind === 'roll' || t.atom.kind === 'notRoll');

  return { tokens, minLength, maxLength, normalized: formatTokens(tokens), usesRolls };
}

/** "5", "[1,5]", "[8-14]" — colapsa sequencias para nao virar lista quilometrica. */
export function formatRolls(rolls: readonly number[]): string {
  const ord = [...rolls].sort((a, b) => a - b);
  const partes: string[] = [];
  let i = 0;
  while (i < ord.length) {
    let j = i;
    while (j + 1 < ord.length && ord[j + 1] === ord[j] + 1) j++;
    partes.push(j > i ? `${ord[i]}-${ord[j]}` : String(ord[i]));
    i = j + 1;
  }
  return partes.length === 1 && !partes[0].includes('-') ? partes[0] : `[${partes.join(',')}]`;
}

function atomToString(a: Atom): string {
  switch (a.kind) {
    case 'any': return '*';
    case 'not': return '!' + a.colors.join('');
    case 'roll': return formatRolls(a.rolls);
    case 'notRoll': return '!' + formatRolls(a.rolls);
    case 'color': return a.color;
  }
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

/** Pedras que caem todas na mesma cor ganham o emoji junto: "🟡5" le melhor que "5". */
function rollsPretty(rolls: readonly number[]): string {
  const cores = new Set(rolls.map(colorOfRoll));
  const txt = formatRolls(rolls);
  return cores.size === 1 ? `${COLOR_EMOJI[[...cores][0]]}${txt}` : txt;
}

/** Versao com emoji, para mostrar no Telegram. */
export function formatTokensPretty(tokens: Token[]): string {
  return tokens
    .map((t) => {
      let base: string;
      switch (t.atom.kind) {
        case 'color': base = COLOR_EMOJI[t.atom.color]; break;
        case 'any': base = '❓'; break;
        case 'not': base = 'nao-' + t.atom.colors.map((c) => COLOR_EMOJI[c]).join(''); break;
        case 'roll': base = rollsPretty(t.atom.rolls); break;
        case 'notRoll': base = 'nao-' + rollsPretty(t.atom.rolls); break;
      }
      if (t.min === 1 && t.max === 1) return base;
      if (t.min === t.max) return `${base}x${t.min}`;
      return `${base}x${t.min}-${t.max}`;
    })
    .join(' ');
}
