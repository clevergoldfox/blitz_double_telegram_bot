import { Color, colorOfRoll, MAX_ROLL, WhiteRule } from '../types';
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

/**
 * Chance de GREEN de uma entrada qualquer, sem padrao nenhum na frente.
 *
 * Serve de regua: um padrao so tem valor se bater este numero com folga. Como
 * cada giro e independente, qualquer gatilho tende a este mesmo resultado no
 * longo prazo — e o cliente precisa ver os dois lado a lado para decidir.
 *
 * Enumeramos as 15 casas da roleta usando a MESMA classifyAttempt do motor,
 * em vez de uma formula fechada: se um dia a regra do branco mudar, esta
 * regua acompanha sozinha, sem ninguem lembrar de atualizar a conta.
 */
export function baselineHitRate(entryColor: Color, gales: number, whiteRule: WhiteRule): number {
  const casas: Color[] = [];
  for (let roll = 0; roll <= MAX_ROLL; roll++) casas.push(colorOfRoll(roll));

  const daqui = (gale: number): number => {
    let p = 0;
    for (const cor of casas) {
      const res = classifyAttempt(cor, entryColor, whiteRule, gale < gales);
      if (res.verdict === 'green') p += 1 / casas.length;
      else if (res.verdict === 'next') p += (1 / casas.length) * daqui(gale + 1);
    }
    return p;
  };

  return daqui(0);
}

/**
 * Minimo de sinais resolvidos para o painel arriscar um veredito.
 *
 * Abaixo disso nem o intervalo salva: com 5 sinais ele vai de 20% a 90% e nao
 * informa nada. Trinta e o ponto em que o intervalo comeca a ser estreito o
 * bastante para a comparacao com a linha de base significar alguma coisa.
 */
export const MINIMO_PARA_VEREDITO = 30;

export interface IntervaloWilson {
  baixo: number;
  alto: number;
}

/**
 * Intervalo de confianca de 95% para a taxa de acerto (metodo de Wilson).
 *
 * Wilson e nao a formula normal simples porque as taxas daqui vivem perto de
 * 90%: a formula simples passa de 100% e chega a devolver limite inferior
 * negativo com poucos sinais, e um painel que mostra "acerto entre -4% e 104%"
 * perde a confianca do cliente com razao.
 */
export function intervaloWilson(greens: number, total: number, z = 1.96): IntervaloWilson {
  if (total <= 0) return { baixo: 0, alto: 1 };
  const p = greens / total;
  const z2 = z * z;
  const centro = (p + z2 / (2 * total)) / (1 + z2 / total);
  const meio = (z / (1 + z2 / total))
    * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { baixo: Math.max(0, centro - meio), alto: Math.min(1, centro + meio) };
}

/**
 * Veredito do padrao contra a sua propria linha de base.
 *
 *  - 'poucosDados': ainda nao da para dizer nada.
 *  - 'acima'      : o intervalo inteiro passa da linha de base.
 *  - 'abaixo'     : o intervalo inteiro fica abaixo dela.
 *  - 'dentro'     : o intervalo cobre a linha de base, ou seja, o padrao nao se
 *                   distingue de apostar sem padrao nenhum.
 */
export type VereditoPadrao = 'poucosDados' | 'acima' | 'dentro' | 'abaixo';

/**
 * Compara a taxa medida com a linha de base levando o tamanho da amostra em
 * conta.
 *
 * Existe porque comparar as duas taxas cruas engana: um padrao com 12 de 13
 * sinais mostra 92,3% e aparecia no painel como melhor que um padrao com 1.219
 * de 1.552, que mostra 78,5%. O primeiro tem intervalo de 66,7% a 98,6% e nao
 * sustenta conclusao nenhuma; o segundo tem intervalo de 76,4% a 80,5% e cobre
 * a propria linha de base, ou seja, empata com apostar sem padrao. Pintar o
 * primeiro de verde e o caminho mais curto para o cliente apostar mais no
 * padrao que ele menos conhece.
 */
export function compararComBase(
  greens: number,
  total: number,
  linhaDeBase: number,
): { intervalo: IntervaloWilson; veredito: VereditoPadrao } {
  const intervalo = intervaloWilson(greens, total);
  if (total < MINIMO_PARA_VEREDITO) return { intervalo, veredito: 'poucosDados' };
  if (intervalo.baixo > linhaDeBase) return { intervalo, veredito: 'acima' };
  if (intervalo.alto < linhaDeBase) return { intervalo, veredito: 'abaixo' };
  return { intervalo, veredito: 'dentro' };
}
