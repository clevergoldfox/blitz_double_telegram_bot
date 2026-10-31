import { Color, WhiteRule } from '../types';
import { Outcome } from '../db/repos';

/** O que acontece com o sinal depois de uma tentativa. */
export type Verdict = 'green' | 'red' | 'next';

export interface AttemptResult {
  /** Para o log de eventos. */
  outcome: Outcome;
  /** Destino do sinal: fechou GREEN, fechou RED, ou vai para o proximo gale. */
  verdict: Verdict;
  /** true quando o GREEN veio do branco protegido, e nao da cor de entrada. */
  wonOnWhite: boolean;
}

/**
 * Regra unica de resolucao de uma tentativa.
 *
 * Esta funcao e deliberadamente pura e e o UNICO lugar onde a semantica de
 * gale/branco existe. O motor ao vivo e o backtest chamam exatamente ela, o que
 * garante que o placar historico e o placar em tempo real nunca divirjam.
 *
 * @param canGale true se ainda sobra gale depois desta tentativa
 */
export function classifyAttempt(
  color: Color,
  entryColor: Color,
  whiteRule: WhiteRule,
  canGale: boolean,
): AttemptResult {
  // Acertar a cor de entrada sempre vence, inclusive quando a entrada e o branco.
  if (color === entryColor) {
    return { outcome: 'win', verdict: 'green', wonOnWhite: false };
  }

  if (color === 'B') {
    switch (whiteRule) {
      case 'protect':
        return { outcome: 'white', verdict: 'green', wonOnWhite: true };
      case 'red':
        return { outcome: 'white', verdict: 'red', wonOnWhite: false };
      case 'gale':
        return { outcome: 'white', verdict: canGale ? 'next' : 'red', wonOnWhite: false };
    }
  }

  return { outcome: 'loss', verdict: canGale ? 'next' : 'red', wonOnWhite: false };
}
