import { Color, NewPattern, WhiteRule } from '../types';
import { normalizeExpr, parsePattern } from '../engine/grammar';

export class CommandError extends Error {}

export interface NovoInput extends NewPattern {}

/**
 * Interpreta o corpo do /novo.
 *
 * Aceita a forma solta que o cliente realmente escreve, por exemplo:
 *   P P A P A = P G1 sem branco
 *   ⚫⚫\u{1F7E1}⚫\u{1F7E1} = ⚫ G1
 *   P{3} = A G2 branco:protege Tres pretos
 *   Preto+Preto+amarelo+preto+amarelo = preto ate g1 sem protecao no branco
 *
 * Nada e adivinhado em silencio: o que nao for informado assume o padrao
 * declarado abaixo, e o bot sempre repete a configuracao final na confirmacao.
 */
export function parseNovo(body: string): NovoInput {
  const raw = body.trim();
  if (!raw) throw new CommandError('Falta a definicao do padrao. Veja /ajuda para exemplos.');

  const eq = raw.indexOf('=');
  if (eq === -1) {
    throw new CommandError(
      'Use o formato <sequencia> = <cor de entrada>.\nExemplo: <code>/novo P P A P A = P G1</code>',
    );
  }

  const leftRaw = raw.slice(0, eq).trim();
  const rightRaw = raw.slice(eq + 1).trim();

  if (!leftRaw) throw new CommandError('Falta a sequencia antes do "=".');
  if (!rightRaw) throw new CommandError('Falta a cor de entrada depois do "=".');

  // --- sequencia (gatilho) ---
  const parsed = parsePattern(leftRaw); // lanca PatternSyntaxError com mensagem amigavel

  // --- lado direito: cor de entrada, depois as opcoes ---
  const tokens = rightRaw.split(/\s+/).filter(Boolean);

  const entryColor = readColor(tokens[0]);
  if (entryColor === null) {
    throw new CommandError(
      `Nao entendi a cor de entrada "${tokens[0]}". Use P (preto), A (amarelo) ou B (branco).`,
    );
  }

  let gales = 0;
  let whiteRule: WhiteRule = 'gale';
  let galesInformado = false;
  let brancoInformado = false;
  const nameParts: string[] = [];

  const rest = tokens.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const low = stripAccents(t.toLowerCase());

    // "ate g1" / "g1" / "gale 2"
    const g = /^g(\d)$/.exec(low);
    if (g) {
      gales = clampGales(Number(g[1]));
      galesInformado = true;
      continue;
    }
    if (low === 'ate' || low === 'gale' || low === 'gales') continue;
    if (/^\d$/.test(low) && !galesInformado && i > 0 && ['gale', 'gales'].includes(stripAccents(rest[i - 1].toLowerCase()))) {
      gales = clampGales(Number(low));
      galesInformado = true;
      continue;
    }

    // "branco:gale" / "branco:red" / "branco:protege"
    const b = /^branco:(\w+)$/.exec(low);
    if (b) {
      whiteRule = readWhiteRule(b[1]);
      brancoInformado = true;
      continue;
    }

    // "sem branco", "sem protecao", "sem protecao no branco"
    if (low === 'sem') {
      const next = rest[i + 1] ? stripAccents(rest[i + 1].toLowerCase()) : '';
      if (next === 'branco' || next === 'protecao') {
        whiteRule = 'gale';
        brancoInformado = true;
        i++;
        // engole um "no branco" que venha depois de "sem protecao"
        if (stripAccents((rest[i + 1] ?? '').toLowerCase()) === 'no') i += 2;
        continue;
      }
    }

    // "com protecao", "com branco", "protege"
    if (low === 'com') {
      const next = rest[i + 1] ? stripAccents(rest[i + 1].toLowerCase()) : '';
      if (next === 'branco' || next === 'protecao') {
        whiteRule = 'protect';
        brancoInformado = true;
        i++;
        if (stripAccents((rest[i + 1] ?? '').toLowerCase()) === 'no') i += 2;
        continue;
      }
    }
    if (low === 'protege' || low === 'protecao' || low === 'protegido') {
      whiteRule = 'protect';
      brancoInformado = true;
      continue;
    }

    nameParts.push(t);
  }

  const name = nameParts.join(' ').trim() || parsed.normalized;

  return {
    name: name.slice(0, 60),
    expr: parsed.normalized,
    entryColor,
    gales,
    whiteRule,
    active: true,
  };
}

function clampGales(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(2, Math.trunc(n));
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Le uma unica cor, aceitando letra, emoji ou nome em portugues. */
export function readColor(token: string | undefined): Color | null {
  if (!token) return null;
  const n = normalizeExpr(token);
  // normalizeExpr pode devolver mais de uma cor se o usuario colar varias
  if (n.length !== 1) return null;
  return n === 'P' || n === 'A' || n === 'B' ? (n as Color) : null;
}

export function readWhiteRule(word: string): WhiteRule {
  const w = stripAccents(word.toLowerCase());
  if (['protege', 'protecao', 'protegido', 'protect', 'com'].includes(w)) return 'protect';
  if (['red', 'perde', 'morre', 'encerra'].includes(w)) return 'red';
  if (['gale', 'sem', 'segue', 'continua'].includes(w)) return 'gale';
  throw new CommandError(
    `Nao entendi "branco:${word}". Use branco:gale, branco:red ou branco:protege.`,
  );
}

export { parsePattern };
