import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, GameResult, WhiteRule } from '../src/types';
import { parsePattern } from '../src/engine/grammar';
import {
  BancaConfig,
  Degrau,
  PadraoSimulado,
  resumoDiario,
  simularBanca,
  teoriaDaEscada,
} from '../src/engine/banca';
import { gerarHistorico, mulberry32, rodadasPorDia } from '../src/engine/roleta';
import { rodarSimulacao } from '../src/engine/simrun';

/** A tabela de 6 niveis que o cliente desenhou, com a entrada minima de R$ 0,10. */
const TABELA_DO_CLIENTE: Degrau[] = [
  { entrada: 0.76, branco: 0.1 },
  { entrada: 1.73, branco: 0.2 },
  { entrada: 3.97, branco: 0.52 },
  { entrada: 9.22, branco: 1.27 },
  { entrada: 21.45, branco: 3.02 },
  { entrada: 50.0, branco: 7.1 },
];

/** Historico a partir de uma string de cores, uma rodada a cada 30s. */
function hist(cores: string): GameResult[] {
  const t0 = Date.UTC(2026, 0, 1, 3, 0, 0);
  return cores.split(/\s+/).filter(Boolean).map((c, i) => ({
    roundId: 'r' + i,
    color: c as Color,
    roll: c === 'B' ? 0 : c === 'A' ? 1 : 8,
    createdAt: new Date(t0 + i * 30_000).toISOString(),
    live: true,
  }));
}

function padrao(expr: string, entryColor: Color, whiteRule: WhiteRule = 'red'): PadraoSimulado {
  return { id: 1, name: expr, parsed: parsePattern(expr), entryColor, gales: 2, whiteRule };
}

const base: BancaConfig = { bancaInicial: 100, entrada: 1, reiniciar: false, entradaMinima: 0.1 };

test('escada: cada degrau cobra o valor da tabela, nao o dobro do anterior', () => {
  // 1, 3, 9 e o teste todo: dobrando sairia 1, 2, 4 (total 7) e a tabela manda
  // cobrar 13. Errar isso faria o painel medir uma tabela que o cliente nao tem.
  const escada: Degrau[] = [
    { entrada: 1, branco: 0 },
    { entrada: 3, branco: 0 },
    { entrada: 9, branco: 0 },
  ];
  // Dispara em 'A A' e entra no preto; so sai amarelo, entao a escada sobe
  // ate o fim e morre no ultimo degrau.
  const r = simularBanca(hist('A A A A A'), [padrao('A A', 'P')], { ...base, escada });

  assert.equal(r.extrato.length, 1, 'uma escada perdida e um lancamento no extrato');
  assert.equal(r.extrato[0].verdict, 'red');
  assert.equal(r.extrato[0].apostado, 13, 'a escada inteira custa 1 + 3 + 9');
  assert.equal(r.extrato[0].lucro, -13);
  assert.equal(r.extrato[0].gale, 2, 'morreu no terceiro degrau');
});

test('escada: a tabela manda no numero de tentativas, nao o campo gales do padrao', () => {
  // O padrao diz 2 gales (3 tentativas). A tabela tem 5 degraus, e quem vale e
  // a tabela: o ciclo precisa chegar ao quinto degrau.
  const escada: Degrau[] = [1, 2, 3, 4, 5].map((v) => ({ entrada: v, branco: 0 }));
  const r = simularBanca(hist('A A A A A A A'), [padrao('A A', 'P')], { ...base, escada });

  assert.equal(r.extrato.length, 1);
  assert.equal(r.extrato[0].gale, 4, 'cinco degraus sao cinco tentativas');
  assert.equal(r.extrato[0].apostado, 15, '1+2+3+4+5');
});

test('escada: ganhar num degrau do meio paga aquele degrau e devolve o gasto', () => {
  const escada: Degrau[] = [
    { entrada: 1, branco: 0 },
    { entrada: 3, branco: 0 },
    { entrada: 9, branco: 0 },
  ];
  // Perde o primeiro degrau (sai amarelo) e ganha o segundo (sai preto).
  const r = simularBanca(hist('A A A P'), [padrao('A A', 'P')], { ...base, escada });

  assert.equal(r.extrato.length, 1);
  assert.equal(r.extrato[0].verdict, 'green');
  assert.equal(r.extrato[0].apostado, 4, 'gastou 1 e depois 3');
  assert.equal(r.extrato[0].lucro, 2, '3 pagos a 2x sao 6, menos os 4 gastos');
});

test('escada: a protecao do branco e a da linha, e paga 14x sobre ela', () => {
  const escada: Degrau[] = [
    { entrada: 1, branco: 0.5 },
    { entrada: 3, branco: 2 },
  ];
  // Perde o primeiro degrau e no segundo sai branco: a ficha de 2 paga 28.
  const r = simularBanca(hist('A A A B'), [padrao('A A', 'P', 'protect')], { ...base, escada });

  assert.equal(r.extrato.length, 1);
  assert.equal(r.extrato[0].verdict, 'green');
  assert.equal(r.extrato[0].noBranco, true);
  assert.equal(r.extrato[0].apostado, 6.5, '1+0,5 no primeiro degrau, 3+2 no segundo');
  assert.equal(r.extrato[0].lucro, 21.5, '2 no branco pagam 28, menos os 6,5 gastos');
});

test('escada: perder a escada encerra o dia quando a regra pede', () => {
  const escada: Degrau[] = [
    { entrada: 1, branco: 0 },
    { entrada: 3, branco: 0 },
  ];
  // Depois da escada perdida ha gatilho de sobra no historico. Com a regra
  // ligada nenhuma entrada nova aparece; com ela desligada, aparecem.
  const cores = 'A A A A A A A A A A A A';
  const para = simularBanca(hist(cores), [padrao('A A', 'P')], { ...base, escada });
  const segue = simularBanca(hist(cores), [padrao('A A', 'P')], {
    ...base, escada, pararNoPrimeiroRed: false,
  });

  assert.equal(para.entradas, 1, 'a regra encerra o dia na primeira escada perdida');
  assert.equal(para.sessoes[0].motivo, 'escadaPerdida');
  assert.ok(segue.entradas > 1, 'sem a regra, o dia continua apostando');
});

test('teoria: a margem de qualquer tabela e exatamente -1/15', () => {
  // Nenhuma tabela de apostas muda a margem da casa: ela muda a forma da
  // variancia. Esta e a conta que o cliente mais precisa ver, entao tem teste.
  const tabelas: Degrau[][] = [
    TABELA_DO_CLIENTE,
    [{ entrada: 1, branco: 0 }],
    [{ entrada: 5, branco: 0.4 }, { entrada: 11, branco: 0.9 }, { entrada: 25, branco: 2 }],
  ];
  for (const t of tabelas) {
    for (const regra of ['protect', 'red', 'gale'] as WhiteRule[]) {
      const r = teoriaDaEscada(t, { entryColor: 'P', whiteRule: regra }, 50);
      assert.ok(
        Math.abs(r.margem + 1 / 15) < 1e-9,
        `margem ${r.margem} com regra ${regra} deveria ser -1/15`,
      );
    }
  }
});

test('teoria: a tabela do cliente perde a escada em 1,03% dos ciclos', () => {
  const t = teoriaDaEscada(TABELA_DO_CLIENTE, { entryColor: 'P', whiteRule: 'protect' }, 50);

  // Seis degraus, e cada degrau so avanca quando sai a cor contraria: (7/15)^6.
  assert.ok(Math.abs(t.chanceDePerder - (7 / 15) ** 6) < 1e-12);
  assert.ok(Math.abs(t.acumulado - 99.34) < 0.005, 'a escada inteira custa R$ 99,34');
  assert.ok(Math.abs(t.perdaQuandoPerde + 99.34) < 0.005);
  // A conta que explica o plano inteiro: a meta exige dezenas de escadas
  // ganhas seguidas, porque uma escada perdida leva a banca toda.
  assert.ok(t.ciclosParaMeta > 70 && t.ciclosParaMeta < 95, `ciclos ${t.ciclosParaMeta}`);
  assert.ok(
    Math.abs(t.chanceDeBaterMeta - (1 - t.chanceDePerder) ** t.ciclosParaMeta) < 1e-12,
  );
});

test('teoria e simulacao chegam no mesmo numero', () => {
  // Duas contas independentes: uma fecha a probabilidade no papel, a outra
  // joga centenas de dias. Se discordarem, uma das duas esta errada — e e por
  // isso que este teste existe em vez de so uma delas.
  const meta = 10;
  const padroes = [padrao('A P A A A', 'P', 'protect')];
  const t = teoriaDaEscada(TABELA_DO_CLIENTE, padroes[0], meta);
  const sim = simularBanca(
    gerarHistorico({ rodadas: rodadasPorDia() * 300, seed: 424242 }),
    padroes,
    { bancaInicial: 100, entrada: 0.76, escada: TABELA_DO_CLIENTE, stopWin: meta,
      sessaoPorDia: true, reiniciar: true, entradaMinima: 0.1 },
  );
  const r = resumoDiario(sim);

  assert.equal(r.dias, 300);
  assert.ok(
    Math.abs(r.taxaNaMeta - t.chanceDeBaterMeta) < 0.06,
    `simulacao ${r.taxaNaMeta.toFixed(3)} x teoria ${t.chanceDeBaterMeta.toFixed(3)}`,
  );
});

test('resumo diario: metas por perda sai da razao entre o dia bom e o dia ruim', () => {
  const sim = simularBanca(
    gerarHistorico({ rodadas: rodadasPorDia() * 120, seed: 99 }),
    [padrao('A P A A A', 'P', 'protect')],
    // Meta de R$ 20, nao de R$ 50: um padrao sozinho dispara umas 60 vezes ao
    // dia, e 60 escadas ganhas nao chegam a R$ 50 nem no dia perfeito. Com uma
    // meta inalcancavel nao existiria dia bom para comparar com o dia ruim.
    { bancaInicial: 100, entrada: 0.76, escada: TABELA_DO_CLIENTE, stopWin: 20,
      sessaoPorDia: true, reiniciar: true, entradaMinima: 0.1 },
  );
  const r = resumoDiario(sim);

  assert.ok(r.diasNaMeta > 0 && r.diasPerdidos > 0, 'precisa dos dois tipos de dia');
  assert.ok(
    Math.abs(r.metasPorPerdaNecessarias - Math.abs(r.mediaDiaRuim) / r.mediaDiaBom) < 1e-9,
  );
  assert.ok(
    Math.abs(r.metasPorPerdaObtidas - r.diasNaMeta / r.diasPerdidos) < 1e-9,
  );
  // O plano empata quando as duas se igualam. Enquanto obtidas < necessarias,
  // mais dias de operacao sao mais prejuizo, nao menos.
  assert.ok(r.metasPorPerdaObtidas < r.metasPorPerdaNecessarias);
  assert.ok(r.mediaPorDia < 0);
});

test('roleta de controle: a roda e justa e reproduzivel', () => {
  const n = 150_000;
  const h = gerarHistorico({ rodadas: n, seed: 2026 });
  const conta = (c: Color) => h.filter((r) => r.color === c).length / n;

  assert.ok(Math.abs(conta('A') - 7 / 15) < 0.006, `amarelo ${conta('A')}`);
  assert.ok(Math.abs(conta('P') - 7 / 15) < 0.006, `preto ${conta('P')}`);
  assert.ok(Math.abs(conta('B') - 1 / 15) < 0.004, `branco ${conta('B')}`);

  // Mesma semente, mesmo historico: sem isso o cliente nao consegue comparar
  // duas tabelas, porque o chao mudaria junto com a tabela.
  const a = gerarHistorico({ rodadas: 500, seed: 7 }).map((r) => r.color).join('');
  const b = gerarHistorico({ rodadas: 500, seed: 7 }).map((r) => r.color).join('');
  const c = gerarHistorico({ rodadas: 500, seed: 8 }).map((r) => r.color).join('');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('roleta de controle: os bits baixos do sorteio nao sao enviesados', () => {
  // Um LCG ingenuo passaria no teste de cor e falharia aqui, porque as 15
  // casas nao sairiam com a mesma frequencia.
  const rnd = mulberry32(13);
  const n = 150_000;
  const casas = new Array(15).fill(0);
  for (let i = 0; i < n; i++) casas[Math.floor(rnd() * 15)]++;

  const esperado = n / 15;
  const chi = casas.reduce((s, o) => s + (o - esperado) ** 2 / esperado, 0);
  // 14 graus de liberdade, 99,9%: 36,12. Passar disso denunciaria vies.
  assert.ok(chi < 36.12, `chi-quadrado ${chi.toFixed(2)} alto demais`);
});

test('simrun: devolve as duas colunas e nao vaza milhares de pontos', () => {
  const saida = rodarSimulacao({
    historico: gerarHistorico({ rodadas: rodadasPorDia() * 20, seed: 5, inicioEm: '2026-02-01T03:00:00.000Z' }),
    diasControle: 30,
    seed: 11,
    padroes: [{ id: 1, name: 'T', expr: 'A P A A A', entryColor: 'P', gales: 2, whiteRule: 'protect' }],
    cfg: { bancaInicial: 100, entrada: 0.76, escada: TABELA_DO_CLIENTE, stopWin: 50,
      sessaoPorDia: true, reiniciar: true, entradaMinima: 0.1 },
  });

  assert.ok(saida.real && saida.controle);
  assert.equal(saida.controle.dias, 30);
  assert.ok(saida.real.curva.length <= 401, 'a curva do real cabe num grafico');
  assert.ok(saida.controle.curva.length <= 401, 'a curva do controle cabe num grafico');
  assert.ok(saida.real.extrato.length <= 300, 'o extrato vem cortado');
  assert.ok(saida.real.sessoes.length > 0, 'o real traz a tabela de dias');
  assert.equal(saida.controle.sessoes.length, 0, 'mil dias de controle nao viram tabela');
});
