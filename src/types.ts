/** Cores do Double da Blitz. P = Preto, A = Amarelo, B = Branco. */
export type Color = 'P' | 'A' | 'B';

export const COLORS: readonly Color[] = ['P', 'A', 'B'] as const;

export const COLOR_EMOJI: Record<Color, string> = { P: '\u26AB', A: '\u{1F7E1}', B: '\u26AA' };
export const COLOR_NAME: Record<Color, string> = { P: 'Preto', A: 'Amarelo', B: 'Branco' };

export function isColor(v: unknown): v is Color {
  return v === 'P' || v === 'A' || v === 'B';
}

/** Maior pedra do Double: a roleta tem 15 casas, de 0 a 14. */
export const MAX_ROLL = 14;

/**
 * Cor da pedra sorteada. E a disposicao fixa da roleta do Double, nao um
 * detalhe da plataforma: 0 e o branco, 1 a 7 sao amarelos, 8 a 14 sao pretos.
 * (O mapa em sources/parsing traduz o *codigo* de cor que a casa envia; isto
 * aqui traduz o numero da pedra, que e sempre o mesmo em qualquer casa.)
 */
export function colorOfRoll(roll: number): Color {
  if (roll === 0) return 'B';
  return roll <= 7 ? 'A' : 'P';
}

/**
 * O minimo que o casador precisa saber de uma rodada.
 * GameResult satisfaz esta forma, entao o historico do banco serve direto.
 */
export interface RoundView {
  color: Color;
  roll: number | null;
}

/**
 * Como o branco e tratado quando sai no lugar da cor de entrada.
 *  - 'gale'    : branco perde a tentativa e avanca para o proximo gale (padrao do mercado)
 *  - 'red'     : branco encerra o sinal imediatamente como RED
 *  - 'protect' : branco conta como GREEN (aposta protegida no branco)
 */
export type WhiteRule = 'gale' | 'red' | 'protect';

export const WHITE_RULE_LABEL: Record<WhiteRule, string> = {
  gale: 'sem protecao (branco vai pro gale)',
  red: 'sem protecao (branco = RED na hora)',
  protect: 'com protecao no branco',
};

/** Um giro confirmado do Double. */
export interface GameResult {
  /** Identificador do round na plataforma. Chave natural, usada para deduplicacao. */
  roundId: string;
  color: Color;
  /** Numero sorteado (0-14 em roletas da familia Blaze). Opcional: nem toda fonte expoe. */
  roll: number | null;
  /** Momento em que a plataforma abriu o round (ISO 8601). */
  createdAt: string;
  /**
   * Momento em que a cor foi revelada, quando a plataforma informa (updated_at).
   * Na Blitz isso acontece ~15s depois de createdAt, e e a referencia correta
   * para medir atraso de alerta.
   */
  revealedAt?: string | null;
  /** true quando o round chegou ao vivo; false quando veio de backfill do historico. */
  live: boolean;
}

export interface Pattern {
  id: number;
  name: string;
  /** Expressao na gramatica de padroes, ex. "P P A P A". */
  expr: string;
  entryColor: Color;
  /** Numero de gales permitidos apos a entrada: 0, 1 ou 2. */
  gales: number;
  whiteRule: WhiteRule;
  active: boolean;
  createdAt: string;
}

export type NewPattern = Omit<Pattern, 'id' | 'createdAt'>;

export type SignalStatus = 'open' | 'green' | 'red';

export interface Signal {
  id: number;
  patternId: number;
  /** Round cujo resultado completou o gatilho do padrao. */
  triggerRoundId: string;
  entryColor: Color;
  galesAllowed: number;
  whiteRule: WhiteRule;
  /** Tentativa corrente: 0 = entrada, 1 = G1, 2 = G2. */
  currentGale: number;
  status: SignalStatus;
  /** Em que gale o sinal bateu, quando status = 'green'. */
  resolvedGale: number | null;
  /** true quando fechou GREEN por conta do branco protegido. */
  wonOnWhite: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

/** Placar agregado de um padrao (ou do conjunto todo). */
export interface Scoreboard {
  patternId: number | null;
  patternName: string;
  total: number;
  greens: number;
  greenG0: number;
  greenG1: number;
  greenG2: number;
  greenWhite: number;
  reds: number;
  open: number;
  hitRate: number;
  currentStreak: number;
  streakKind: 'green' | 'red' | 'none';
  bestGreenStreak: number;
  worstRedStreak: number;
}

/**
 * Quanto o alerta revela sobre a estrategia.
 *
 *  - 'completo': nome do padrao e sequencia do gatilho aparecem no alerta.
 *  - 'publico' : ambos somem, sobra "Sinal #id" com entrada, gale e placar.
 *
 * Existe para quem revende o sinal: o assinante precisa saber onde entrar,
 * mas nao deve conseguir deduzir o padrao e usar por conta propria.
 */
export type AlertMode = 'completo' | 'publico';
