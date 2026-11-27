import { colorOfRoll, GameResult } from '../types';

/**
 * Roleta honesta, para servir de controle ao lado do historico real.
 *
 * Por que isso existe: qualquer tabela de apostas medida em algumas semanas de
 * historico pode ter pegado uma janela de sorte. Os primeiros 27 dias gravados,
 * por exemplo, correram a -1,8% quando a margem da casa e -6,7% — quem olhasse
 * so para eles acharia a estrategia melhor do que ela e. Rodar a MESMA tabela
 * contra milhares de dias de uma roda comprovadamente justa separa as duas
 * coisas: o que a estrategia faz e o que o periodo fez por ela.
 *
 * A roda e a do Double: 15 casas, 7 amarelas (1-7), 7 pretas (8-14) e um branco
 * (0) — o mapa de cor vem de `colorOfRoll`, o mesmo que le os numeros da
 * plataforma, e esta conferido contra os 74 mil giros gravados. Os testes de
 * aderencia sobre o historico real nao conseguiram distinguir a roda da
 * plataforma desta aqui, e e isso que faz dela um controle legitimo.
 */

/** Casas da roda: 0 a 14. */
export const CASAS = 15;

/**
 * PRNG mulberry32.
 *
 * Nao e `Math.random` porque a simulacao precisa ser reproduzivel: o cliente
 * roda o mesmo pedido duas vezes e tem de ver o mesmo numero, senao nao da para
 * comparar duas tabelas entre si. E nao e um LCG simples porque os bits baixos
 * de um LCG sao mal distribuidos, e `floor(x * 15)` depende justamente da parte
 * que um LCG faz pior — o sorteio sairia enviesado exatamente onde importa.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RoletaOpts {
  /** Quantas rodadas gerar. */
  rodadas: number;
  /** Semente: o mesmo numero devolve sempre o mesmo historico. */
  seed?: number;
  /** Instante da primeira rodada (ISO). Padrao: uma virada de dia redonda. */
  inicioEm?: string;
  /** Segundos entre rodadas. Na Blitz uma rodada leva ~30s. */
  intervaloSegundos?: number;
}

/**
 * Gera historico sintetico no mesmo formato que vem do banco, para o simulador
 * nao precisar saber de onde o historico veio.
 */
export function gerarHistorico(opts: RoletaOpts): GameResult[] {
  const rnd = mulberry32(opts.seed ?? 1);
  const passo = (opts.intervaloSegundos ?? 30) * 1000;
  // Comeca na virada do dia em Sao Paulo (03:00 UTC), para o primeiro dia
  // simulado ser um dia inteiro e nao um pedaco.
  const t0 = new Date(opts.inicioEm ?? '2026-01-01T03:00:00.000Z').getTime();
  const out: GameResult[] = new Array(opts.rodadas);
  for (let i = 0; i < opts.rodadas; i++) {
    const roll = Math.floor(rnd() * CASAS);
    const em = new Date(t0 + i * passo).toISOString();
    out[i] = {
      roundId: `sim-${opts.seed ?? 1}-${i}`,
      color: colorOfRoll(roll),
      roll,
      createdAt: em,
      revealedAt: em,
      live: false,
    };
  }
  return out;
}

/** Rodadas por dia no ritmo da plataforma, para dimensionar o controle. */
export function rodadasPorDia(intervaloSegundos = 30): number {
  return Math.floor((24 * 60 * 60) / intervaloSegundos);
}
