import { DatabaseSync } from 'node:sqlite';
import { Color, GameResult, WhiteRule } from '../types';
import { ResultsRepo } from '../db/repos';
import { parsePattern } from './grammar';
import {
  BancaConfig,
  PadraoSimulado,
  PontoCurva,
  resumoDiario,
  ResumoDiario,
  Sessao,
  simularBanca,
  SimulacaoBanca,
} from './banca';
import { gerarHistorico, rodadasPorDia } from './roleta';

/**
 * Uma rodada de simulacao, do pedido ao resultado pronto para a tela.
 *
 * Mora fora do servidor HTTP por duas razoes. A primeira e que mil dias de
 * simulacao levam mais de dez segundos, e o painel divide o processo com o
 * motor de alertas: rodar isso na thread principal atrasaria alertas de verdade
 * no Telegram do cliente. A segunda e que, isolada aqui, a mesma funcao roda
 * dentro de uma worker thread, dentro de um teste e dentro de um script de
 * linha de comando sem nenhuma adaptacao.
 */

/** Padrao como ele atravessa a fronteira do worker: expressao, nao AST. */
export interface PadraoSerializado {
  id: number;
  name: string;
  expr: string;
  entryColor: Color;
  gales: number;
  whiteRule: WhiteRule;
}

export interface PedidoSimulacao {
  /**
   * Historico real ja carregado, em ordem cronologica.
   *
   * Serve a teste e script, que ja tem o historico na mao. O painel manda
   * `banco` no lugar: ver o porque lá.
   */
  historico?: GameResult[] | null;
  /**
   * Banco de onde LER o historico, aqui dentro.
   *
   * Mandar o historico pronto pelo workerData parecia mais simples e custava
   * caro no lugar errado: serializar 75 mil rodadas para atravessar a
   * fronteira da thread travava a thread principal por mais de um segundo —
   * ou seja, o trabalho de tirar a simulacao de lá era desfeito na entrega.
   * Medido: 1.182 ms de atraso no event loop antes desta mudanca.
   *
   * Abrir o SQLite em modo leitura numa segunda thread e seguro: o banco roda
   * em WAL, que aceita leitor e escritor ao mesmo tempo.
   */
  banco?: { caminho: string; limite: number } | null;
  /** Dias de roleta honesta a gerar. 0 ou null pula a coluna de controle. */
  diasControle: number | null;
  seed: number;
  padroes: PadraoSerializado[];
  cfg: BancaConfig;
}

/** O que a tela precisa de uma coluna, sem os milhares de pontos que ela nao desenha. */
export interface ColunaSimulacao {
  giros: number;
  resumo: ResumoDiario;
  entradas: number;
  greens: number;
  reds: number;
  apostado: number;
  margemDaCasa: number;
  maiorQueda: number;
  naoCouberam: number;
  apostadoNoBranco: number;
  recebidoDoBranco: number;
  brancosPagos: number;
  curva: PontoCurva[];
  /**
   * Resultado de cada dia, em reais.
   *
   * Vai junto mesmo para mil dias de controle, porque sao mil numeros e e
   * com eles que a tela desenha as duas pilhas de dias — a pilha na meta e
   * a pilha quebrada. Essas duas pilhas explicam o plano melhor que
   * qualquer media: a media de -R$ 25 nao existe em dia nenhum.
   */
  resultadosPorDia: number[];
  sessoes: Sessao[];
  extrato: SimulacaoBanca['extrato'];
}

export interface SaidaSimulacao {
  real: ColunaSimulacao | null;
  controle: (ColunaSimulacao & { dias: number; seed: number }) | null;
}

/**
 * Afina a curva de saldo para caber num grafico.
 *
 * Mil dias geram dezenas de milhares de pontos, e manda-los para o navegador
 * travaria o painel sem desenhar um pixel a mais: o grafico tem menos de mil
 * colunas de largura. O ultimo ponto entra sempre, para a curva terminar no
 * valor de verdade e nao num ponto qualquer de amostragem.
 */
export function reduzirCurva(curva: readonly PontoCurva[], maximo = 400): PontoCurva[] {
  if (curva.length <= maximo) return [...curva];
  const passo = curva.length / maximo;
  const out: PontoCurva[] = [];
  for (let i = 0; i < maximo; i++) out.push(curva[Math.floor(i * passo)]);
  out.push(curva[curva.length - 1]);
  return out;
}

/**
 * Le o historico direto do arquivo, sem passar pelos repositorios de escrita.
 *
 * Usa `ResultsRepo` de proposito, em vez de uma consulta propria: a traducao de
 * linha para rodada fica num lugar so, e uma mudanca de coluna nao deixa o
 * simulador lendo errado em silencio. E nao usa `openDb` porque aquele aplica o
 * schema, e aplicar schema de uma thread paralela ao processo que esta
 * escrevendo seria pedir problema por nada.
 */
function lerHistorico(banco: { caminho: string; limite: number }): GameResult[] {
  let db;
  try {
    db = abrirSoLeitura(banco.caminho);
  } catch (err) {
    // Sem isso o cliente veria um erro cru de SQLite e nao teria como saber
    // que o problema e o caminho do banco, nao a tabela dele.
    throw new Error(`Nao consegui abrir o historico em ${banco.caminho}.`);
  }
  try {
    return new ResultsRepo(db).recent(banco.limite);
  } catch (err) {
    throw new Error(`Nao consegui ler o historico em ${banco.caminho}.`);
  } finally {
    db.close();
  }
}

/**
 * `readOnly` so chegou ao node:sqlite no Node 22.12, e o projeto declara aceitar
 * 22.5. Em versao antiga a opcao derruba a abertura, entao a queda para abertura
 * comum e o que mantem o simulador funcionando em vez de dar erro na cara do
 * cliente — nada aqui escreve, a trava e cinto de seguranca e nao requisito.
 */
type OpcoesSqlite = NonNullable<ConstructorParameters<typeof DatabaseSync>[1]>
  & { readOnly?: boolean };

function abrirSoLeitura(caminho: string): DatabaseSync {
  try {
    return new DatabaseSync(caminho, { readOnly: true } as OpcoesSqlite);
  } catch {
    return new DatabaseSync(caminho);
  }
}

function montarPadroes(padroes: readonly PadraoSerializado[]): PadraoSimulado[] {
  const out: PadraoSimulado[] = [];
  for (const p of padroes) {
    try {
      out.push({
        id: p.id,
        name: p.name,
        parsed: parsePattern(p.expr),
        entryColor: p.entryColor,
        gales: p.gales,
        whiteRule: p.whiteRule,
      });
    } catch {
      // Padrao gravado por uma versao anterior da gramatica: fica de fora em
      // vez de derrubar a simulacao inteira.
    }
  }
  return out;
}

/**
 * Quantas apostas do extrato voltam para a tela.
 *
 * O extrato existe para o cliente conferir a mao onde o dia virou, e isso se
 * faz nas ultimas apostas. Mil dias produzem mais de cinquenta mil linhas, que
 * nenhuma tela mostra e nenhum navegador agradece.
 */
const LINHAS_DE_EXTRATO = 300;

function coluna(sim: SimulacaoBanca, comExtrato: boolean): ColunaSimulacao {
  return {
    giros: sim.roundsScanned,
    resumo: resumoDiario(sim),
    entradas: sim.entradas,
    greens: sim.greens,
    reds: sim.reds,
    apostado: sim.apostado,
    margemDaCasa: sim.margemDaCasa,
    maiorQueda: sim.maiorQueda,
    naoCouberam: sim.naoCouberam,
    apostadoNoBranco: sim.apostadoNoBranco,
    recebidoDoBranco: sim.recebidoDoBranco,
    brancosPagos: sim.brancosPagos,
    curva: reduzirCurva(sim.curva),
    resultadosPorDia: sim.sessoes.map((s) => s.resultado),
    // Mil dias de controle sao mil sessoes: a tabela de dias e util no real,
    // onde cada linha e um dia que o cliente viveu e pode conferir.
    sessoes: comExtrato ? sim.sessoes : [],
    extrato: comExtrato ? sim.extrato.slice(-LINHAS_DE_EXTRATO) : [],
  };
}

export function rodarSimulacao(pedido: PedidoSimulacao): SaidaSimulacao {
  const padroes = montarPadroes(pedido.padroes);
  if (padroes.length === 0) {
    throw new Error('Nenhum dos padroes escolhidos tem gatilho que o motor entenda.');
  }

  const historico = pedido.historico && pedido.historico.length > 0
    ? pedido.historico
    : pedido.banco
      ? lerHistorico(pedido.banco)
      : null;
  const real = historico && historico.length > 0
    ? coluna(simularBanca(historico, padroes, pedido.cfg), true)
    : null;

  let controle: SaidaSimulacao['controle'] = null;
  if (pedido.diasControle && pedido.diasControle > 0) {
    const sim = simularBanca(
      gerarHistorico({ rodadas: rodadasPorDia() * pedido.diasControle, seed: pedido.seed }),
      padroes,
      pedido.cfg,
    );
    controle = { ...coluna(sim, false), dias: pedido.diasControle, seed: pedido.seed };
  }

  return { real, controle };
}
