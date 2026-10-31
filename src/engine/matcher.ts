import { Color } from '../types';
import { Atom, ParsedPattern, Token } from './grammar';

export function atomMatches(atom: Atom, color: Color): boolean {
  switch (atom.kind) {
    case 'any': return true;
    case 'color': return atom.color === color;
    case 'not': return !atom.colors.includes(color);
  }
}

/**
 * Casa o padrao contra o FINAL do historico.
 *
 * O historico vem em ordem cronologica (mais antigo -> mais recente) e o padrao
 * precisa terminar exatamente na ultima rodada: e isso que caracteriza um gatilho
 * recem-confirmado. Como quantificadores do tipo {2,4} deixam o comprimento
 * variavel, testamos cada comprimento possivel, do maior para o menor, e
 * devolvemos o primeiro que casar.
 *
 * @returns quantas rodadas o padrao consumiu, ou null se nao casou.
 */
export function matchAtEnd(parsed: ParsedPattern, history: readonly Color[]): number | null {
  const hi = Math.min(parsed.maxLength, history.length);
  for (let len = hi; len >= parsed.minLength; len--) {
    const slice = history.slice(history.length - len);
    if (consumesExactly(parsed.tokens, slice)) return len;
  }
  return null;
}

/** true se os tokens consomem a sequencia inteira, sem sobra de nenhum lado. */
export function consumesExactly(tokens: readonly Token[], seq: readonly Color[]): boolean {
  // memo[ti][si] = ja sabemos o resultado de (token ti a partir de seq si)?
  const memo = new Map<number, boolean>();
  const key = (ti: number, si: number) => ti * (seq.length + 1) + si;

  const walk = (ti: number, si: number): boolean => {
    if (ti === tokens.length) return si === seq.length;
    const k = key(ti, si);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;

    const tok = tokens[ti];
    let ok = false;
    // Avanca uma repeticao por vez; para assim que uma cor nao casar, pois
    // repeticoes de um mesmo atomo precisam ser contiguas.
    for (let count = 0; count <= tok.max; count++) {
      if (count > 0) {
        const idx = si + count - 1;
        if (idx >= seq.length || !atomMatches(tok.atom, seq[idx])) break;
      }
      if (count < tok.min) continue;
      if (walk(ti + 1, si + count)) { ok = true; break; }
    }

    memo.set(k, ok);
    return ok;
  };

  return walk(0, 0);
}
