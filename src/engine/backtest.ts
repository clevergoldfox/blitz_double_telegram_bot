import { Color, GameResult, WhiteRule } from '../types';
import { ParsedPattern } from './grammar';
import { matchAtEnd } from './matcher';
import { classifyAttempt } from './rules';

export interface BacktestConfig {
  parsed: ParsedPattern;
  entryColor: Color;
  gales: number;
  whiteRule: WhiteRule;
}

export interface BacktestResult {
  roundsScanned: number;
  signals: number;
  greens: number;
  /** greenByGale[n] = quantos GREEN fecharam no gale n. */
  greenByGale: number[];
  greenWhite: number;
  reds: number;
  /** Sinal que ainda estava aberto quando o historico terminou. */
  unresolved: number;
  hitRate: number;
  bestGreenStreak: number;
  worstRedStreak: number;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Reexecuta um padrao sobre o historico guardado, com a mesma ordem de operacoes
 * e a mesma regra de resolucao do motor ao vivo (ver rules.classifyAttempt).
 *
 * E isso que permite responder "esse padrao aconteceu N vezes nos ultimos 30
 * dias, com X% de acerto" no instante em que o cliente cadastra o padrao, em vez
 * de ele esperar duas semanas o placar ao vivo encher.
 */
export function backtest(history: readonly GameResult[], cfg: BacktestConfig): BacktestResult {
  const out: BacktestResult = {
    roundsScanned: history.length,
    signals: 0,
    greens: 0,
    greenByGale: new Array(cfg.gales + 1).fill(0),
    greenWhite: 0,
    reds: 0,
    unresolved: 0,
    hitRate: 0,
    bestGreenStreak: 0,
    worstRedStreak: 0,
    firstAt: null,
    lastAt: null,
  };

  const window = cfg.parsed.maxLength;
  const colors: Color[] = [];

  // Sinal aberto corrente (no maximo um, igual a trava de reentrancia do motor).
  let openGale: number | null = null;

  let runGreen = 0;
  let runRed = 0;

  const closeGreen = (gale: number, onWhite: boolean) => {
    out.greens++;
    if (onWhite) out.greenWhite++;
    else if (gale < out.greenByGale.length) out.greenByGale[gale]++;
    runGreen++;
    runRed = 0;
    out.bestGreenStreak = Math.max(out.bestGreenStreak, runGreen);
  };

  const closeRed = () => {
    out.reds++;
    runRed++;
    runGreen = 0;
    out.worstRedStreak = Math.max(out.worstRedStreak, runRed);
  };

  for (const round of history) {
    colors.push(round.color);
    if (colors.length > window) colors.shift();

    // 1. resolve o sinal aberto com esta rodada
    if (openGale !== null) {
      const canGale = openGale < cfg.gales;
      const res = classifyAttempt(round.color, cfg.entryColor, cfg.whiteRule, canGale);
      if (res.verdict === 'next') {
        openGale++;
      } else if (res.verdict === 'green') {
        closeGreen(openGale, res.wonOnWhite);
        openGale = null;
      } else {
        closeRed();
        openGale = null;
      }
    }

    // 2. so depois procura gatilho novo, exatamente como no motor ao vivo
    if (openGale === null && matchAtEnd(cfg.parsed, colors) !== null) {
      openGale = 0;
      out.signals++;
      if (out.firstAt === null) out.firstAt = round.createdAt;
      out.lastAt = round.createdAt;
    }
  }

  if (openGale !== null) out.unresolved = 1;

  const resolved = out.greens + out.reds;
  out.hitRate = resolved > 0 ? out.greens / resolved : 0;
  return out;
}
