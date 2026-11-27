import { Color, GameResult, RoundView, WhiteRule } from '../types';
import { ParsedPattern } from './grammar';
import { matchAtEnd } from './matcher';
import { classifyAttempt } from './rules';

/**
 * Simulador de banca: o mesmo motor de padroes, agora contando dinheiro.
 *
 * A diferenca para o backtest nao e o veredito — esse continua vindo de
 * classifyAttempt, para o placar daqui bater com o do painel — e sim o caixa.
 * No placar, "branco protegido" conta GREEN. No caixa, branco em cima de uma
 * aposta de cor so devolve dinheiro se o apostador tambem tiver posto ficha no
 * branco. Mostrar essa diferenca e a razao de este arquivo existir.
 *
 * A trava de reentrancia do motor e POR PADRAO, nao global: varios padroes
 * ficam em gale ao mesmo tempo e a banca precisa cobrir todos. E isso que
 * esvazia a banca rapido, e e por isso que a simulacao roda todos juntos.
 */

/** Pagamentos do Double. Configuraveis porque sao regra da casa, nao nossa. */
export const PAGA_COR = 2;
export const PAGA_BRANCO = 14;

export interface PadraoSimulado {
  id: number;
  name: string;
  parsed: ParsedPattern;
  entryColor: Color;
  gales: number;
  whiteRule: WhiteRule;
}

/**
 * Um degrau da tabela de apostas: quanto vai na cor e quanto vai no branco.
 *
 * Existe porque a tabela que o cliente desenhou nao e um martingale puro —
 * cada nivel tem valor proprio, arredondado para o minimo da plataforma, e os
 * tres ultimos degraus (a 'recuperacao' dele) sobem muito mais do que o dobro.
 * Dobrar na mao erraria a tabela dele em todos os degraus menos o primeiro.
 */
export interface Degrau {
  /** Aposta na cor de entrada, em reais. */
  entrada: number;
  /** Ficha no branco nesta tentativa, em reais. 0 desliga a protecao aqui. */
  branco: number;
}

export interface BancaConfig {
  /** Banca inicial, em reais. */
  bancaInicial: number;
  /** Entrada fixa, em reais. Ignorada quando entradaPct vem preenchido. */
  entrada: number;
  /** Entrada como fracao da banca corrente (0.01 = 1%). */
  entradaPct?: number | null;
  /** Lucro, em reais, que encerra a sessao. */
  stopWin?: number | null;
  /** Prejuizo, em reais (positivo), que encerra a sessao. */
  stopLoss?: number | null;
  /** Ao encerrar uma sessao, abrir outra com a banca cheia. Ligado por padrao. */
  reiniciar?: boolean;
  /**
   * Ficha no branco na entrada seca, em reais. Dobra junto com a cor no gale.
   * 0 desliga a protecao. null (o padrao) segue a regra de cada padrao: quem
   * marcou "branco protegido" no painel recebe a ficha que empata, e quem nao
   * marcou perde a entrada quando sai branco.
   */
  entradaBranco?: number | null;
  /** Hora local em que o robo comeca a operar (0-23). null = sem restricao. */
  horarioInicio?: number | null;
  /** Hora local em que para de abrir entradas novas (0-23, exclusiva). */
  horarioFim?: number | null;
  /** Fuso para ler os horarios. Padrao: America/Sao_Paulo. */
  timezone?: string;
  /**
   * Tratar o branco como reinicio: a sequencia so volta a contar depois dele,
   * entao nenhum padrao casa atravessando um branco.
   */
  resetarNoBranco?: boolean;
  /**
   * Uma sessao por dia: a banca volta ao valor cheio a cada virada de data e
   * os stops valem como meta diaria. E assim que se responde "em quantos dias
   * eu bati a meta e em quantos eu bati o limite".
   */
  sessaoPorDia?: boolean;
  /**
   * Degraus de recuperacao depois do stop loss, em reais (ex.: [10, 20, 40]).
   *
   * Cada degrau e UMA entrada seca, sem gale, no proximo sinal que aparecer —
   * acertou, o dia fecha recuperado; errou, sobe para o degrau seguinte. Ao
   * acabarem os degraus, o dia fecha com o prejuizo inteiro. A ficha do branco
   * acompanha na mesma proporcao da entrada normal.
   */
  recuperacao?: number[] | null;
  /**
   * Tabela de degraus, do primeiro ao ultimo (ex.: a de 6 niveis do cliente).
   *
   * Quando vem preenchida manda em tudo: substitui entrada, entradaPct,
   * entradaBranco, recuperacao E o numero de gales de cada padrao — o ciclo
   * sobe um degrau por tentativa perdida e so morre quando a tabela acaba.
   * Um padrao com 2 gales numa tabela de 6 degraus faz 6 tentativas, porque
   * a tabela e o plano de aposta e o padrao e so o gatilho.
   */
  escada?: Degrau[] | null;
  /**
   * Uma escada por vez em toda a banca, em vez de uma por padrao.
   *
   * Faz muita diferenca e e facil errar: o motor ao vivo trava reentrancia
   * POR PADRAO, entao dois padroes podem estar subindo a escada ao mesmo
   * tempo. Numa tabela dimensionada para a banca inteira (a de 6 degraus do
   * cliente consome R$ 99,34 de uma banca de R$ 100) a segunda escada
   * simplesmente nao tem como ser paga, e o dia morre por falta de caixa e
   * nao por estrategia. Quem aposta a tabela na mao faz uma escada por vez,
   * entao e esse o padrao quando ha escada configurada.
   */
  umaEscadaPorVez?: boolean;
  /**
   * Encerrar o dia quando a escada inteira e perdida.
   *
   * A alternativa — continuar com o que sobrou em caixa — parece mais
   * corajosa e e na verdade so uma forma de morrer no meio da escada
   * seguinte: depois de perder R$ 99,34 de uma banca de R$ 100 o que resta e
   * o lucro do dia, que nao paga uma tabela inteira. As duas regras tem o
   * mesmo valor esperado, mas mudam muito o placar de dias, e e por isso que
   * a escolha fica exposta em vez de embutida.
   */
  pararNoPrimeiroRed?: boolean;
  /** Menor aposta que a plataforma aceita. Na Blitz, R$ 0,10. */
  entradaMinima?: number;
  pagaCor?: number;
  pagaBranco?: number;
}

export type MotivoFim =
  | 'stopWin'
  | 'stopLoss'
  | 'quebrou'
  | 'fimDoDia'
  | 'fimDoHistorico'
  /** Bateu o limite, entrou em recuperacao e ela deu certo. */
  | 'recuperado'
  /** Bateu o limite, tentou recuperar e perdeu todos os degraus. */
  | 'recuperacaoFalhou'
  /** Perdeu a escada inteira e a regra manda encerrar o dia ali. */
  | 'escadaPerdida';

export interface Sessao {
  numero: number;
  inicioEm: string | null;
  fimEm: string | null;
  rodadas: number;
  entradas: number;
  greens: number;
  reds: number;
  apostado: number;
  /** Resultado realizado da sessao, em reais. */
  resultado: number;
  /**
   * Resultado no instante em que o stop disparou. Difere do final porque os
   * ciclos ja abertos ainda terminam de resolver — nao da para desapostar.
   */
  resultadoNoStop: number | null;
  /**
   * Melhor resultado realizado que a sessao chegou a ver, em reais.
   * Responde "antes de quebrar, cheguei perto da meta?" — o resultado
   * final sozinho nao diz se a banca subiu antes de descer.
   */
  melhorResultado: number;
  motivo: MotivoFim;
}

export interface Entrada {
  em: string;
  patternId: number;
  patternName: string;
  entryColor: Color;
  /** Gale em que o ciclo fechou (0 = entrada seca). */
  gale: number;
  verdict: 'green' | 'red';
  /** GREEN que veio do branco, nao da cor apostada. */
  noBranco: boolean;
  apostado: number;
  lucro: number;
  saldo: number;
}

export interface PontoCurva {
  em: string;
  saldo: number;
  sessao: number;
}

export interface SimulacaoBanca {
  roundsScanned: number;
  sessoes: Sessao[];
  entradas: number;
  greens: number;
  reds: number;
  /** GREENs do placar que vieram do branco. */
  greensNoBranco: number;
  /** Destes, os que mesmo assim fecharam no vermelho no caixa. */
  greensQuePerderamDinheiro: number;
  apostado: number;
  /** Soma do resultado de todas as sessoes, em reais. */
  resultado: number;
  /** resultado / apostado. Tende a -6,67% nao importa o padrao. */
  margemDaCasa: number;
  /** Maior sequencia de REDs seguidos, somando todos os padroes. */
  piorSequenciaRed: number;
  /** Maior queda do pico ao fundo dentro de uma sessao, em reais. */
  maiorQueda: number;
  /** Sinais que nao viraram entrada por falta de saldo. */
  naoCouberam: number;
  /** Quantas vezes a recuperacao foi acionada. */
  recuperacoes: number;
  /** Destas, quantas fecharam o buraco. */
  recuperacoesOk: number;
  /** Total posto na ficha do branco, somando entrada seca e gales. */
  apostadoNoBranco: number;
  /** Total que a ficha do branco devolveu quando o branco saiu. */
  recebidoDoBranco: number;
  /** Quantas vezes o branco saiu com ficha nossa em cima dele. */
  brancosPagos: number;
  curva: PontoCurva[];
  extrato: Entrada[];
}

/** Em centavos: float acumula erro ao longo de milhares de apostas. */
const cent = (reais: number) => Math.round(reais * 100);
const real = (centavos: number) => centavos / 100;

interface Aberto {
  pattern: PadraoSimulado;
  gale: number;
  /** Entrada base do ciclo, em centavos: os gales dobram a partir dela. */
  base: number;
  /** Ficha base no branco, em centavos. Dobra junto. */
  baseBranco: number;
  /** Apostado na cor nesta tentativa. */
  naCor: number;
  /** Apostado no branco nesta tentativa. */
  noBranco: number;
  /** Caixa do ciclo, isolado: varios ciclos correm ao mesmo tempo. */
  apostadoNoCiclo: number;
  recebidoNoCiclo: number;
  abertoEm: string;
  /** Aposta de recuperacao: uma so, sem gale, fora do fluxo normal. */
  ehRecuperacao: boolean;
}

export function simularBanca(
  history: readonly GameResult[],
  padroes: readonly PadraoSimulado[],
  cfg: BancaConfig,
): SimulacaoBanca {
  const pagaCor = cfg.pagaCor ?? PAGA_COR;
  const pagaBranco = cfg.pagaBranco ?? PAGA_BRANCO;
  const minimo = Math.max(1, cent(cfg.entradaMinima ?? 0.1));
  const bancaInicial = cent(cfg.bancaInicial);
  const entradaFixa = cent(cfg.entrada);
  const stopWin = cfg.stopWin != null ? cent(Math.abs(cfg.stopWin)) : null;
  const stopLoss = cfg.stopLoss != null ? cent(Math.abs(cfg.stopLoss)) : null;
  const reiniciar = cfg.reiniciar !== false;
  const resetarNoBranco = cfg.resetarNoBranco === true;
  const hIni = cfg.horarioInicio ?? null;
  const hFim = cfg.horarioFim ?? null;
  const tz = cfg.timezone ?? 'America/Sao_Paulo';
  const horaLocal = fazerLeitorDeHora(tz);
  const dataLocal = fazerLeitorDeData(tz);
  const porDia = cfg.sessaoPorDia === true;
  let diaCorrente: string | null = null;
  /** Em modo diario, so a virada da data libera o fechamento da sessao. */
  let viraDia = false;
  // A escada e lida uma vez, em centavos, e deixa de ser opcional dali para a
  // frente: todo o resto do laco pergunta so 'tem escada?'.
  const escada = (cfg.escada ?? []).length > 0
    ? (cfg.escada as Degrau[]).map((d) => ({
        entrada: Math.max(minimo, cent(d.entrada)),
        branco: cent(d.branco) > 0 ? Math.max(minimo, cent(d.branco)) : 0,
      }))
    : null;
  // Com tabela, uma escada por vez e o comportamento realista; sem tabela, o
  // antigo (um ciclo por padrao) continua valendo.
  const umaPorVez = cfg.umaEscadaPorVez ?? escada !== null;
  const pararNoRed = cfg.pararNoPrimeiroRed ?? escada !== null;
  const degraus = escada
    ? []
    : (cfg.recuperacao ?? []).map((v) => cent(v)).filter((v) => v > 0);
  let emRecuperacao = false;
  let degrau = 0;

  const out: SimulacaoBanca = {
    roundsScanned: history.length,
    sessoes: [],
    entradas: 0,
    greens: 0,
    reds: 0,
    greensNoBranco: 0,
    greensQuePerderamDinheiro: 0,
    apostado: 0,
    resultado: 0,
    margemDaCasa: 0,
    piorSequenciaRed: 0,
    maiorQueda: 0,
    naoCouberam: 0,
    recuperacoes: 0,
    recuperacoesOk: 0,
    apostadoNoBranco: 0,
    recebidoDoBranco: 0,
    brancosPagos: 0,
    curva: [],
    extrato: [],
  };
  if (padroes.length === 0 || history.length === 0) return out;

  const janela: RoundView[] = [];
  const window = Math.max(...padroes.map((p) => p.parsed.maxLength));
  const abertos = new Map<number, Aberto>();

  let saldo = bancaInicial;
  /**
   * Resultado ja fechado da sessao. Os stops medem por aqui, e nao pelo caixa:
   * enquanto ha ficha na mesa o caixa esta artificialmente baixo, e um stop
   * loss olhando para ele dispararia por um prejuizo que ainda nao existe.
   */
  let realizado = 0;
  let pico = 0;
  let apostadoTotal = 0;
  let apostadoSessao = 0;
  // Caixa separado da ficha do branco: e a pergunta mais natural do cliente —
  // "o 14x nao compensa?" — e so da para responder com o extrato dela.
  let apostadoBranco = 0;
  let recebidoBranco = 0;
  let runRed = 0;

  let numeroSessao = 1;
  let sessao = novaSessao(numeroSessao);
  /** A sessao corrente ja foi empurrada para o relatorio? */
  let sessaoFechada = false;
  let parando = false;
  let motivo: MotivoFim = 'fimDoHistorico';

  for (const round of history) {
    // Virou o dia: encerra a sessao corrente. Os ciclos ja abertos ainda
    // resolvem nesta rodada, entao a conta do dia anterior fecha completa.
    if (porDia) {
      const hoje = dataLocal(round.createdAt);
      if (diaCorrente !== null && hoje !== diaCorrente) {
        // Bateu meta ou limite mais cedo? Entao o dia ja estava encerrado e o
        // motivo que vale e aquele. Senao, o dia simplesmente acabou.
        if (!parando) { parando = true; motivo = 'fimDoDia'; }
        viraDia = true;
      }
      diaCorrente = hoje;
    }

    janela.push({ color: round.color, roll: round.roll });
    if (janela.length > window) janela.shift();
    sessao.rodadas++;

    // ---- 1. resolve o que estava aberto, cobrando e pagando ----
    for (const [id, a] of [...abertos]) {
      // Com tabela, quem decide se ha proxima tentativa e o tamanho dela, nao
      // o campo 'gales' do padrao.
      const podeGalear = escada && !a.ehRecuperacao
        ? a.gale < escada.length - 1
        : a.gale < a.pattern.gales;
      const res = classifyAttempt(round.color, a.pattern.entryColor, a.pattern.whiteRule, podeGalear);

      let retorno = 0;
      if (round.color === a.pattern.entryColor) {
        retorno = a.naCor * (round.color === 'B' ? pagaBranco : pagaCor);
      } else if (round.color === 'B') {
        retorno = a.noBranco * pagaBranco;
        if (retorno > 0) {
          recebidoBranco += retorno;
          out.brancosPagos++;
        }
      }
      saldo += retorno;
      a.recebidoNoCiclo += retorno;

      if (res.verdict === 'next') {
        const d = escada && !a.ehRecuperacao ? escada[a.gale + 1] : null;
        const proxima = d ? d.entrada : a.base * 2 ** (a.gale + 1);
        const h = d && a.pattern.entryColor !== 'B' ? d.branco
          : d ? 0
          : a.baseBranco * 2 ** (a.gale + 1);
        if (saldo < proxima + h) {
          // Sem saldo para o gale: o ciclo morre onde esta, e a banca com ele.
          registrar(a, 'red', false, round);
          abertos.delete(id);
          if (!parando) { parando = true; motivo = 'quebrou'; }
          continue;
        }
        saldo -= proxima + h;
        apostadoTotal += proxima + h;
        apostadoSessao += proxima + h;
        apostadoBranco += h;
        a.apostadoNoCiclo += proxima + h;
        a.gale++;
        a.naCor = proxima;
        a.noBranco = h;
        continue;
      }

      if (a.ehRecuperacao) {
        registrar(a, res.verdict, res.wonOnWhite, round);
        abertos.delete(id);
        if (res.verdict === 'green') {
          emRecuperacao = false;
          parando = true;
          motivo = 'recuperado';
          out.recuperacoesOk++;
        } else if (++degrau >= degraus.length) {
          emRecuperacao = false;
          parando = true;
          motivo = 'recuperacaoFalhou';
        }
        continue;
      }

      registrar(a, res.verdict, res.wonOnWhite, round);
      abertos.delete(id);
      if (pararNoRed && res.verdict === 'red' && !parando) {
        parando = true;
        motivo = 'escadaPerdida';
      }
    }

    // ---- 2. stops, conferidos com o caixa ja atualizado ----
    if (!parando) {
      if (stopWin !== null && realizado >= stopWin) { parando = true; motivo = 'stopWin'; }
      else if (stopLoss !== null && -realizado >= stopLoss) {
        // Com recuperacao configurada, o limite nao encerra o dia na hora:
        // abre a escada. Sem ela, encerra como sempre.
        if (degraus.length > 0 && !emRecuperacao) {
          emRecuperacao = true;
          degrau = 0;
          out.recuperacoes++;
          sessao.resultadoNoStop = real(realizado);
        } else if (!emRecuperacao) {
          parando = true;
          motivo = 'stopLoss';
        }
      }
      else if (abertos.size === 0 && saldo < custoDeUmaEntrada()) { parando = true; motivo = 'quebrou'; }
      if (parando) sessao.resultadoNoStop = real(realizado);
    }

    // Uma sessao so termina de verdade quando os ciclos abertos fecham: quem ja
    // tem ficha na mesa nao consegue desapostar porque bateu o stop.
    // No modo diario, bater o stop encerra o DIA: nao se comeca outra banca
    // na sequencia. A proxima so abre quando a data virar.
    if (parando && abertos.size === 0 && (!porDia || viraDia)) {
      fecharSessao(motivo, round.createdAt);
      if (!reiniciar) break;
      sessao = novaSessao(++numeroSessao);
      sessaoFechada = false;
      viraDia = false;
      emRecuperacao = false;
      degrau = 0;
      saldo = bancaInicial;
      realizado = 0;
      pico = 0;
      apostadoSessao = 0;
      parando = false;
      motivo = 'fimDoHistorico';
    }

    // O branco zera a janela: com isso nenhum padrao casa atravessando um
    // branco, que e o que o cliente chama de "o branco reseta os padroes".
    if (resetarNoBranco && round.color === 'B') janela.length = 0;

    // ---- 3. so entao procura gatilho novo, na ordem do motor ao vivo ----
    if (parando) continue;
    if (!dentroDoHorario(round.createdAt)) continue;
    // Na recuperacao espera-se o que esta na mesa fechar: a escada e uma
    // aposta de cada vez, para o degrau valer o que ele diz valer.
    if (emRecuperacao && abertos.size > 0) continue;

    // Escada em andamento ocupa a banca toda: nao se abre outra por cima.
    if (umaPorVez && abertos.size > 0) continue;

    for (const p of padroes) {
      if (abertos.has(p.id)) continue;
      if (matchAtEnd(p.parsed, janela) === null) continue;

      if (emRecuperacao) {
        const aposta = degraus[degrau];
        // Ficha do branco na mesma proporcao da entrada normal.
        const hr = cfg.entradaBranco != null && cfg.entradaBranco > 0 && p.entryColor !== 'B'
          ? Math.max(minimo, Math.round(aposta * (cent(cfg.entradaBranco) / entradaFixa)))
          : 0;
        if (saldo < aposta + hr) {
          parando = true;
          motivo = 'quebrou';
          emRecuperacao = false;
          break;
        }
        saldo -= aposta + hr;
        apostadoTotal += aposta + hr;
        apostadoSessao += aposta + hr;
        apostadoBranco += hr;
        abertos.set(p.id, {
          pattern: { ...p, gales: 0 },
          gale: 0,
          base: aposta,
          baseBranco: hr,
          naCor: aposta,
          noBranco: hr,
          apostadoNoCiclo: aposta + hr,
          recebidoNoCiclo: 0,
          abertoEm: round.createdAt,
          ehRecuperacao: true,
        });
        out.entradas++;
        sessao.entradas++;
        break;
      }

      const base = escada
        ? escada[0].entrada
        : Math.max(minimo, cfg.entradaPct ? Math.round(saldo * cfg.entradaPct) : entradaFixa);
      const h = escada
        ? (p.entryColor === 'B' ? 0 : escada[0].branco)
        : brancoDe(base, p);
      if (saldo < base + h) {
        out.naoCouberam++;
        continue;
      }

      saldo -= base + h;
      apostadoTotal += base + h;
      apostadoSessao += base + h;
      apostadoBranco += h;
      abertos.set(p.id, {
        pattern: p,
        gale: 0,
        base,
        baseBranco: h,
        naCor: base,
        noBranco: h,
        apostadoNoCiclo: base + h,
        recebidoNoCiclo: 0,
        abertoEm: round.createdAt,
        ehRecuperacao: false,
      });
      out.entradas++;
      sessao.entradas++;
      if (sessao.inicioEm === null) sessao.inicioEm = round.createdAt;
      if (umaPorVez) break;
    }
  }

  // Sessao que ficou aberta quando o historico acabou: so entra no relatorio se
  // chegou a apostar alguma coisa, senao vira uma linha vazia sem sentido. E
  // nunca de novo, senao a sessao encerrada por stop com --sem-reinicio seria
  // contada duas vezes e o resultado total sairia dobrado.
  if (!sessaoFechada && sessao.entradas > 0) {
    fecharSessao(parando ? motivo : 'fimDoHistorico', history[history.length - 1].createdAt);
  }

  out.apostado = real(apostadoTotal);
  out.apostadoNoBranco = real(apostadoBranco);
  out.recebidoDoBranco = real(recebidoBranco);
  out.resultado = out.sessoes.reduce((s, x) => s + x.resultado, 0);
  out.margemDaCasa = apostadoTotal > 0 ? out.resultado / out.apostado : 0;
  return out;

  // ---------- auxiliares ----------

  function novaSessao(numero: number): Sessao {
    return {
      numero,
      inicioEm: null,
      fimEm: null,
      rodadas: 0,
      entradas: 0,
      greens: 0,
      reds: 0,
      apostado: 0,
      resultado: 0,
      resultadoNoStop: null,
      melhorResultado: 0,
      motivo: 'fimDoHistorico',
    };
  }

  /**
   * Ficha no branco da entrada seca, em centavos.
   *
   * Sem valor informado, usa a que empata: o branco paga 14x, entao a propria
   * ficha mais 13 vezes ela, e cor/13 devolve exatamente a aposta da cor. O
   * minimo da plataforma manda por cima, e e dai que vem a conta que o cliente
   * percebeu sozinho: com R$ 0,10 na cor, o minimo de R$ 0,10 no branco ja e
   * 13 vezes mais do que precisaria, e a protecao fica cara demais.
   */
  function brancoDe(naCor: number, p: PadraoSimulado): number {
    if (p.entryColor === 'B') return 0;
    if (cfg.entradaBranco != null) {
      return cfg.entradaBranco <= 0 ? 0 : Math.max(minimo, cent(cfg.entradaBranco));
    }
    if (p.whiteRule !== 'protect') return 0;
    return Math.max(minimo, Math.round(naCor / (pagaBranco - 1)));
  }

  /**
   * Menor desembolso possivel para abrir uma entrada agora. A banca quebrou
   * quando nem a entrada mais barata cabe — nao quando o saldo fica abaixo do
   * minimo da plataforma, que e bem mais fundo e deixaria a sessao "viva"
   * sem conseguir apostar em nada.
   */
  function custoDeUmaEntrada(): number {
    if (escada) {
      let menor = Infinity;
      for (const p of padroes) {
        menor = Math.min(menor, escada[0].entrada + (p.entryColor === 'B' ? 0 : escada[0].branco));
      }
      return menor;
    }
    const base = Math.max(
      minimo,
      cfg.entradaPct ? Math.round(saldo * cfg.entradaPct) : entradaFixa,
    );
    let menor = Infinity;
    for (const p of padroes) menor = Math.min(menor, base + brancoDe(base, p));
    return menor;
  }

  /** O horario so barra entrada nova; ciclo ja aberto sempre termina. */
  function dentroDoHorario(em: string): boolean {
    if (hIni === null && hFim === null) return true;
    const h = horaLocal(em);
    if (hIni !== null && hFim !== null) {
      // Janela que vira a meia-noite (ex.: 22h as 2h) tambem funciona.
      return hIni <= hFim ? h >= hIni && h < hFim : h >= hIni || h < hFim;
    }
    if (hIni !== null) return h >= hIni;
    return h < (hFim as number);
  }

  function fecharSessao(porque: MotivoFim, em: string) {
    sessaoFechada = true;
    sessao.motivo = porque;
    sessao.fimEm = em;
    sessao.resultado = real(realizado);
    sessao.melhorResultado = real(pico);
    sessao.apostado = real(apostadoSessao);
    out.sessoes.push(sessao);
  }

  function registrar(a: Aberto, verdict: 'green' | 'red', noBranco: boolean, round: GameResult) {
    const lucro = a.recebidoNoCiclo - a.apostadoNoCiclo;
    realizado += lucro;

    if (verdict === 'green') {
      out.greens++;
      sessao.greens++;
      runRed = 0;
      if (noBranco) {
        out.greensNoBranco++;
        if (lucro < 0) out.greensQuePerderamDinheiro++;
      }
    } else {
      out.reds++;
      sessao.reds++;
      runRed++;
      out.piorSequenciaRed = Math.max(out.piorSequenciaRed, runRed);
    }

    pico = Math.max(pico, realizado);
    out.maiorQueda = Math.max(out.maiorQueda, real(pico - realizado));

    out.extrato.push({
      em: round.createdAt,
      patternId: a.pattern.id,
      patternName: a.pattern.name,
      entryColor: a.pattern.entryColor,
      gale: a.gale,
      verdict,
      noBranco,
      apostado: real(a.apostadoNoCiclo),
      lucro: real(lucro),
      saldo: real(bancaInicial + realizado),
    });
    out.curva.push({ em: round.createdAt, saldo: real(bancaInicial + realizado), sessao: sessao.numero });
  }
}

/** Fins de sessao que contam como dia ganho e como dia perdido. */
const FINS_BONS: ReadonlySet<MotivoFim> = new Set(['stopWin', 'recuperado']);
const FINS_RUINS: ReadonlySet<MotivoFim> = new Set([
  'stopLoss', 'quebrou', 'recuperacaoFalhou', 'escadaPerdida',
]);

export interface ResumoDiario {
  dias: number;
  diasNaMeta: number;
  diasPerdidos: number;
  /** Dias que so acabaram porque o historico/dia terminou, sem bater nada. */
  diasNeutros: number;
  taxaNaMeta: number;
  /** Media de um dia que bateu a meta, em reais. */
  mediaDiaBom: number;
  /** Media de um dia perdido, em reais (negativa). */
  mediaDiaRuim: number;
  mediaPorDia: number;
  /**
   * Fracao de dias na meta que faria o conjunto empatar.
   *
   * E a regua honesta do plano: nao basta ganhar na maioria dos dias, porque o
   * dia ruim custa muito mais do que o dia bom paga.
   */
  taxaParaEmpatar: number;
  /**
   * Quantas metas sao necessarias para cobrir um dia perdido, e quantas o plano
   * de fato entrega. Mesma pergunta que o cliente faz em voz alta — "preciso
   * bater a meta quantas vezes para cobrir uma perda?" — com os dois lados na
   * mesma unidade, para a comparacao ser direta.
   */
  metasPorPerdaNecessarias: number;
  metasPorPerdaObtidas: number;
  resultado: number;
}

/**
 * Converte sessoes diarias no placar de dias. So faz sentido sobre uma
 * simulacao rodada com `sessaoPorDia: true`, em que uma sessao e um dia.
 */
export function resumoDiario(sim: SimulacaoBanca): ResumoDiario {
  const bons = sim.sessoes.filter((s) => FINS_BONS.has(s.motivo));
  const ruins = sim.sessoes.filter((s) => FINS_RUINS.has(s.motivo));
  const dias = sim.sessoes.length;
  const soma = (xs: Sessao[]) => xs.reduce((t, s) => t + s.resultado, 0);
  const mediaDiaBom = bons.length > 0 ? soma(bons) / bons.length : 0;
  const mediaDiaRuim = ruins.length > 0 ? soma(ruins) / ruins.length : 0;

  // Quanto o dia ruim custa dividido pelo que o dia bom paga. Sem dia ruim
  // medido a conta nao existe, e e mais honesto devolver 0 do que inventar.
  const perda = Math.abs(mediaDiaRuim);
  const metasPorPerdaNecessarias = mediaDiaBom > 0 ? perda / mediaDiaBom : 0;
  const metasPorPerdaObtidas = ruins.length > 0 ? bons.length / ruins.length : 0;

  return {
    dias,
    diasNaMeta: bons.length,
    diasPerdidos: ruins.length,
    diasNeutros: dias - bons.length - ruins.length,
    taxaNaMeta: dias > 0 ? bons.length / dias : 0,
    mediaDiaBom,
    mediaDiaRuim,
    mediaPorDia: dias > 0 ? sim.resultado / dias : 0,
    // W ganhos e L perdas empatam quando W*bom = L*perda, ou seja quando a
    // fracao de dias bons e perda/(bom+perda).
    taxaParaEmpatar: mediaDiaBom + perda > 0 ? perda / (mediaDiaBom + perda) : 0,
    metasPorPerdaNecessarias,
    metasPorPerdaObtidas,
    resultado: sim.resultado,
  };
}

/**
 * Probabilidade de cada cor numa roda de 15 casas: 7 amarelas, 7 pretas, 1
 * branca. Conferida contra o historico real por teste de aderencia.
 */
const P_COR = 7 / 15;
const P_BRANCO = 1 / 15;

export interface TeoriaEscada {
  degraus: number;
  /** Soma de tudo que a escada inteira desembolsa, em reais. */
  acumulado: number;
  /** Chance de a escada fechar como RED, que e o que encerra o dia. */
  chanceDePerder: number;
  /** Lucro medio de uma escada que fecha no verde, em reais. */
  lucroQuandoGanha: number;
  /** Resultado medio de uma escada que fecha no vermelho, em reais. */
  perdaQuandoPerde: number;
  /** Valor esperado por escada, em reais. */
  valorEsperado: number;
  /** Total apostado por escada, em media. */
  giroMedio: number;
  /** valorEsperado / giroMedio. Da -1/15 para qualquer tabela. */
  margem: number;
  /** Escadas ganhas seguidas que a meta exige. */
  ciclosParaMeta: number;
  /**
   * Chance de o dia bater a meta: e preciso ganhar `ciclosParaMeta` escadas
   * SEM perder nenhuma, porque uma escada perdida consome a banca inteira.
   */
  chanceDeBaterMeta: number;
  /** Fracao de dias na meta que empataria o periodo. */
  chanceParaEmpatar: number;
}

/**
 * Resolve a tabela no papel, sem simular nada.
 *
 * Vale mais que a simulacao para explicar o plano, porque sai em uma linha: a
 * escada de 6 degraus do cliente fecha em RED 1,03% das vezes, a meta de R$ 50
 * exige dezenas de escadas ganhas sem nenhuma perda, e 0,9897 elevado a isso da
 * 43%. E tambem serve de conferencia da simulacao: as duas contas sao
 * independentes, entao discordarem denuncia erro em uma das duas.
 *
 * A conta e exata, nao aproximada, e caminha a escada guardando duas coisas por
 * degrau: a chance de chegar ali e o dinheiro que a ficha do branco ja devolveu
 * no caminho. A segunda parcela so existe na regra 'gale', em que o branco paga
 * a ficha E deixa o ciclo continuar; sem ela a margem da regra 'gale' sairia
 * errada, porque o 14x recebido no meio da escada desapareceria da conta.
 */
export function teoriaDaEscada(
  escada: readonly Degrau[],
  padrao: { entryColor: Color; whiteRule: WhiteRule },
  meta: number,
): TeoriaEscada {
  const n = escada.length;
  const noBranco = padrao.entryColor === 'B';
  // Entrada no proprio branco ganha com 1/15 e perde com 14/15: a regra do
  // branco nao se aplica a si mesma.
  const pGanhaCor = noBranco ? P_BRANCO : P_COR;
  const pBranco = noBranco ? 0 : P_BRANCO;
  const pOutra = 1 - pGanhaCor - pBranco;
  // O branco encerra o ciclo em 'protect' (verde) e em 'red' (vermelho); em
  // 'gale' ele gasta o degrau e o ciclo segue.
  const brancoSegue = padrao.whiteRule === 'gale';
  const brancoEhVerde = padrao.whiteRule === 'protect';

  let acumulado = 0;
  // Em centavos: a conta anda por milhares de escadas e float acumula erro.
  let gasto = 0;
  /** Chance de a escada chegar viva a este degrau. */
  let pChega = 1;
  /** Dinheiro que a ficha do branco ja devolveu, ponderado pela chance. */
  let recebidoNoCaminho = 0;

  let pVerde = 0;
  let pVermelho = 0;
  let somaVerde = 0;
  let somaVermelho = 0;
  let giro = 0;

  for (let i = 0; i < n; i++) {
    const cor = Math.round(escada[i].entrada * 100);
    const br = noBranco ? 0 : Math.round(escada[i].branco * 100);
    acumulado += escada[i].entrada + (noBranco ? 0 : escada[i].branco);
    gasto += cor + br;
    giro += pChega * (cor + br);

    // Ganhou na cor: recebe 2x a ficha da cor, mais o que o branco devolveu
    // antes, menos tudo o que ja saiu do bolso.
    const pCor = pChega * pGanhaCor;
    pVerde += pCor;
    somaVerde += recebidoNoCaminho * pGanhaCor + pCor * (cor * PAGA_COR - gasto);

    if (pBranco > 0 && !brancoSegue) {
      // Saiu branco e o ciclo acaba aqui. A ficha do branco paga 14x de
      // qualquer forma: quem decide se isso conta verde ou vermelho e o placar,
      // nao o caixa. Por isso a regra 'red' tambem recebe este dinheiro.
      const pBr = pChega * pBranco;
      const resultado = recebidoNoCaminho * pBranco + pBr * (br * PAGA_BRANCO - gasto);
      if (brancoEhVerde) {
        pVerde += pBr;
        somaVerde += resultado;
      } else {
        pVermelho += pBr;
        somaVermelho += resultado;
      }
    }

    // Sobra para o proximo degrau: a cor contraria sempre, e o branco tambem
    // quando a regra e 'gale' — e ai ele entra levando o 14x que acabou de pagar.
    const pSegue = pOutra + (brancoSegue ? pBranco : 0);
    recebidoNoCaminho = recebidoNoCaminho * pSegue
      + (brancoSegue ? pChega * pBranco * br * PAGA_BRANCO : 0);
    pChega *= pSegue;
  }

  // O que sobrou de probabilidade e a escada perdida inteira.
  pVermelho += pChega;
  somaVermelho += recebidoNoCaminho - pChega * gasto;

  const evCent = somaVerde + somaVermelho;
  const lucroQuandoGanha = pVerde > 0 ? somaVerde / pVerde / 100 : 0;
  const perdaQuandoPerde = pVermelho > 0 ? somaVermelho / pVermelho / 100 : 0;
  const ciclos = lucroQuandoGanha > 0 ? Math.ceil(meta / lucroQuandoGanha) : 0;
  const ganhoNaMeta = ciclos * lucroQuandoGanha;
  const perda = Math.abs(perdaQuandoPerde);

  return {
    degraus: n,
    acumulado,
    chanceDePerder: pVermelho,
    lucroQuandoGanha,
    perdaQuandoPerde,
    valorEsperado: evCent / 100,
    giroMedio: giro / 100,
    margem: giro > 0 ? evCent / giro : 0,
    ciclosParaMeta: ciclos,
    chanceDeBaterMeta: ciclos > 0 ? (1 - pVermelho) ** ciclos : 0,
    chanceParaEmpatar: ganhoNaMeta + perda > 0 ? perda / (ganhoNaMeta + perda) : 0,
  };
}

/** Le a hora local de um ISO em UTC. Um formatador so, reusado por rodada. */
function fazerLeitorDeHora(timezone: string): (iso: string) => number {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false });
  return (iso) => Number(fmt.format(new Date(iso)));
}

/** Data local (AAAA-MM-DD) de um ISO em UTC, para fatiar as sessoes por dia. */
function fazerLeitorDeData(timezone: string): (iso: string) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return (iso) => fmt.format(new Date(iso));
}
