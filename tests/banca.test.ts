import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../src/engine/grammar';
import { PadraoSimulado, simularBanca } from '../src/engine/banca';
import { Color, colorOfRoll, GameResult, WhiteRule } from '../src/types';

const ROLL_DA_COR: Record<Color, number> = { B: 0, A: 3, P: 11 };

/** Historico escrito a mao: "P A B" vira tres rodadas com essas cores. */
function hist(cores: string): GameResult[] {
  return cores
    .trim()
    .split(/\s+/)
    .map((c, i) => {
      const color = c as Color;
      return {
        roundId: 'r' + i,
        color,
        roll: ROLL_DA_COR[color],
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 30_000).toISOString(),
        live: true,
      };
    });
}

/**
 * Historico deterministico e longo, com as 15 casas equiprovaveis.
 *
 * mulberry32, e nao uma LCG com "s % 15": os bits baixos daquela sao fracos, e
 * o resto por 15 le justamente eles. A diferenca nao e academica — ela chegou
 * a inverter o resultado de um controle de 150 dias.
 */
function mulberry32(semente: number): () => number {
  let a = semente | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sorteado(n: number, semente = 7): GameResult[] {
  const out: GameResult[] = [];
  const rand = mulberry32(semente);
  for (let i = 0; i < n; i++) {
    const roll = Math.floor(rand() * 15);
    out.push({
      roundId: 'r' + i,
      color: colorOfRoll(roll),
      roll,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 30_000).toISOString(),
      live: true,
    });
  }
  return out;
}

function padrao(
  expr: string,
  entryColor: Color,
  gales: number,
  whiteRule: WhiteRule,
  id = 1,
): PadraoSimulado {
  return { id, name: expr, parsed: parsePattern(expr), entryColor, gales, whiteRule };
}

test('banca: o caixa bate centavo a centavo num historico escrito a mao', () => {
  // P -> entra no amarelo, 1 gale, branco vai pro gale, R$ 1 por entrada.
  //
  //  r0 P  gatilho, aposta 1            saldo 99
  //  r1 A  GREEN seco, recebe 2         saldo 101   lucro +1
  //  r2 P  gatilho, aposta 1            saldo 100
  //  r3 P  errou, vai pro G1, aposta 2  saldo  98
  //  r4 P  errou de novo, RED           saldo  98   lucro -3   e ja gatilha, aposta 1 -> 97
  //  r5 A  GREEN seco, recebe 2         saldo  99   lucro +1
  const r = simularBanca(hist('P A P P P A'), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
  });

  assert.equal(r.entradas, 3);
  assert.equal(r.greens, 2);
  assert.equal(r.reds, 1);
  assert.equal(r.apostado, 5);
  assert.equal(r.resultado, -1);
  assert.equal(r.sessoes.length, 1);
  assert.equal(r.sessoes[0].motivo, 'fimDoHistorico');

  assert.equal(r.extrato.length, 3);
  assert.deepEqual(
    r.extrato.map((e) => [e.gale, e.verdict, e.lucro, e.saldo]),
    [[0, 'green', 1, 101], [1, 'red', -3, 98], [0, 'green', 1, 99]],
  );
});

test('banca: o GREEN do branco sem protecao e prejuizo no caixa', () => {
  // E este o ponto do simulador: o painel conta GREEN, a carteira discorda.
  const semProteger = simularBanca(hist('P B'), [padrao('P', 'A', 1, 'protect')], {
    bancaInicial: 100,
    entrada: 1,
    entradaBranco: 0,
  });

  assert.equal(semProteger.greens, 1, 'o placar continua dizendo GREEN');
  assert.equal(semProteger.greensNoBranco, 1);
  assert.equal(semProteger.greensQuePerderamDinheiro, 1, 'e o caixa discorda');
  assert.equal(semProteger.resultado, -1);
});

test('banca: protegendo o branco de verdade, o mesmo GREEN paga', () => {
  const protegendo = simularBanca(hist('P B'), [padrao('P', 'A', 1, 'protect')], {
    bancaInicial: 100,
    entrada: 1,
    entradaBranco: 0.1,
  });

  // R$ 1,00 na cor + R$ 0,10 no branco (o minimo da plataforma, bem acima dos
  // R$ 0,077 que empatariam). O branco paga 14x sobre os R$ 0,10.
  assert.equal(protegendo.greensNoBranco, 1);
  assert.equal(protegendo.greensQuePerderamDinheiro, 0);
  assert.equal(protegendo.apostado, 1.1);
  assert.equal(protegendo.resultado, 0.3);
});

test('banca: a margem da casa aparece sozinha, qualquer que seja o padrao', () => {
  // O teste que protege o cliente de nos: se algum dia esta simulacao devolver
  // um padrao lucrativo, e porque a conta quebrou, nao porque achamos ouro.
  // Banca enorme e sem stop, para medir so a matematica do jogo.
  const historico = sorteado(200_000);

  for (const [expr, cor, gales, branco] of [
    ['*', 'A', 1, 'gale'],
    ['P P', 'A', 2, 'protect'],
    ['5 *{4}', 'A', 1, 'protect'],
    ['!0', 'P', 0, 'red'],
  ] as Array<[string, Color, number, WhiteRule]>) {
    const r = simularBanca(historico, [padrao(expr, cor, gales, branco)], {
      bancaInicial: 1_000_000,
      entrada: 1,
      reiniciar: false,
    });

    assert.ok(r.entradas > 500, `${expr}: amostra pequena demais (${r.entradas})`);
    assert.ok(
      Math.abs(r.margemDaCasa + 1 / 15) < 0.02,
      `${expr}: margem deu ${(r.margemDaCasa * 100).toFixed(2)}%, esperado perto de -6,67%`,
    );
  }
});

test('banca: o stop win encerra a sessao e a proxima comeca com a banca cheia', () => {
  const r = simularBanca(sorteado(4_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
    stopWin: 5,
    reiniciar: true,
  });

  const ganhas = r.sessoes.filter((s) => s.motivo === 'stopWin');
  assert.ok(ganhas.length > 0, 'nenhuma sessao bateu o stop win');
  for (const s of ganhas) {
    assert.ok(s.resultado >= 5, `sessao ${s.numero} fechou em ${s.resultado}`);
  }
  assert.ok(r.sessoes.length > 1, 'deveria ter reiniciado');
});

test('banca: o stop loss limita o estrago de cada sessao', () => {
  const r = simularBanca(sorteado(4_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
    stopLoss: 10,
    reiniciar: true,
  });

  const perdidas = r.sessoes.filter((s) => s.motivo === 'stopLoss');
  assert.ok(perdidas.length > 0, 'nenhuma sessao bateu o stop loss');
  for (const s of perdidas) {
    // Pode passar um pouco do limite: os ciclos ja abertos terminam de resolver.
    assert.ok(s.resultado <= -10, `sessao ${s.numero} fechou em ${s.resultado}`);
  }
});

test('banca: entrada grande demais para a banca quebra a sessao', () => {
  // R$ 40 de entrada numa banca de R$ 100: o primeiro RED com gale ja custa
  // R$ 120, mais do que existe. A sessao morre por falta de saldo.
  const r = simularBanca(sorteado(2_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 40,
    reiniciar: true,
  });

  assert.ok(
    r.sessoes.some((s) => s.motivo === 'quebrou'),
    'esperava pelo menos uma banca quebrada',
  );
});

test('banca: respeita a entrada minima da plataforma', () => {
  const r = simularBanca(hist('P A'), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 0.01,
    entradaMinima: 0.1,
  });

  assert.equal(r.apostado, 0.1, 'a entrada foi levantada para o minimo');
});

test('banca: sem padrao ou sem historico, devolve zerado em vez de estourar', () => {
  const semPadrao = simularBanca(hist('P A'), [], { bancaInicial: 100, entrada: 1 });
  assert.equal(semPadrao.entradas, 0);
  assert.equal(semPadrao.resultado, 0);

  const semHistorico = simularBanca([], [padrao('P', 'A', 1, 'gale')], { bancaInicial: 100, entrada: 1 });
  assert.equal(semHistorico.entradas, 0);
});

test('banca: varios padroes apostam ao mesmo tempo e a banca cobre todos', () => {
  // A trava de reentrancia do motor e por padrao, nao global. Dois padroes que
  // gatilham na mesma rodada abrem duas apostas, e o caixa sente as duas.
  const r = simularBanca(hist('P A'), [
    padrao('P', 'A', 1, 'gale', 1),
    padrao('P', 'A', 1, 'gale', 2),
  ], { bancaInicial: 100, entrada: 1 });

  assert.equal(r.entradas, 2, 'os dois padroes entraram na mesma rodada');
  assert.equal(r.apostado, 2);
  assert.equal(r.greens, 2);
  assert.equal(r.resultado, 2);
});

test('banca: o esquema do cliente, R$ 1,00 na cor e R$ 0,15 no branco', () => {
  const cfg = { bancaInicial: 100, entrada: 1, entradaBranco: 0.15 };
  const p = [padrao('P', 'A', 1, 'protect')];

  // GREEN no G1: a cor paga R$ 4,00 sobre os R$ 3,45 que ja sairam (1,15 + 2,30).
  // Repare que nao volta R$ 1,00: a ficha do branco come o resto da recuperacao.
  const noGale = simularBanca(hist('P P A'), p, cfg);
  assert.equal(noGale.apostado, 3.45);
  assert.equal(noGale.resultado, 0.55);
  assert.deepEqual(noGale.extrato.map((e) => [e.gale, e.verdict]), [[1, 'green']]);

  // GREEN seco: R$ 2,00 de volta sobre R$ 1,15 apostados.
  const seco = simularBanca(hist('P A'), p, cfg);
  assert.equal(seco.resultado, 0.85);

  // Branco na entrada: R$ 0,15 x 14 = R$ 2,10 sobre R$ 1,15. Aqui ele LUCRA,
  // porque R$ 0,15 e quase o dobro dos R$ 0,077 que so empatariam.
  const branco = simularBanca(hist('P B'), p, cfg);
  assert.equal(branco.resultado, 0.95);
  assert.equal(branco.greensQuePerderamDinheiro, 0);
  // O extrato da ficha do branco, separado: e com ele que se responde "mas o
  // 14x nao compensa?". Compensa neste giro; o problema e que a ficha e paga
  // em todos os outros catorze.
  assert.equal(branco.apostadoNoBranco, 0.15);
  assert.equal(branco.recebidoDoBranco, 2.1);
  assert.equal(branco.brancosPagos, 1);

  // Oito entradas na sequencia alternada, uma ficha de R$ 0,15 em cada: a conta
  // da ficha soma por entrada, e o 14x entra uma vez so, quando o branco sai.
  // (Que a ficha do branco tambem seja uma aposta de -6,67% quem mede e o
  // teste da margem, com amostra grande; aqui so se confere a contabilidade.)
  const varias = simularBanca(hist('P A P A P A P A P A P A P A P B'), p, cfg);
  assert.equal(varias.entradas, 8);
  assert.equal(varias.apostadoNoBranco, 1.2, 'uma ficha de R$ 0,15 por entrada');
  assert.equal(varias.recebidoDoBranco, 2.1, 'um unico branco pago, a 14x');

  // RED: perde tudo que entrou no ciclo.
  const red = simularBanca(hist('P P P'), p, cfg);
  assert.equal(red.resultado, -3.45);
});

test('banca: o horario limita as entradas novas, nao os ciclos abertos', () => {
  // As rodadas comecam 2026-01-01T00:00Z, de 30 em 30s = 21h do dia anterior
  // em Sao Paulo. Uma janela das 9h as 18h nao pode deixar nada entrar.
  const fora = simularBanca(sorteado(2_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100, entrada: 1, horarioInicio: 14, horarioFim: 20,
  });
  assert.equal(fora.entradas, 0, 'nada deveria entrar fora da janela');

  const dentro = simularBanca(sorteado(2_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100, entrada: 1, horarioInicio: 21, horarioFim: 23,
  });
  assert.ok(dentro.entradas > 0, 'a janela certa precisa deixar entrar');
});

test('banca: o branco ja reseta sozinho os padroes feitos so de cores', () => {
  // Vale dizer alto: preto e amarelo nunca casam com branco, entao uma
  // sequencia de cores ja morre no branco sem ninguem pedir. O filtro so muda
  // alguma coisa para padrao com curinga, negacao ou o proprio branco dentro.
  const soCores = [padrao('P P', 'A', 0, 'red')];
  const cfg = { bancaInicial: 100, entrada: 1 };

  const sem = simularBanca(hist('P B P P A'), soCores, cfg);
  const com = simularBanca(hist('P B P P A'), soCores, { ...cfg, resetarNoBranco: true });
  assert.equal(sem.entradas, com.entradas, 'para cores puras o filtro nao muda nada');
  assert.equal(sem.entradas, 1, 'os dois pretos depois do branco continuam valendo');
});

test('banca: com reset, padrao com curinga para de atravessar o branco', () => {
  // "* P" aceita qualquer coisa antes do preto — inclusive o branco. E aqui
  // que o pedido do cliente muda o comportamento de verdade.
  const comCuringa = [padrao('* P', 'A', 0, 'red')];
  const cfg = { bancaInicial: 100, entrada: 1 };

  const sem = simularBanca(hist('P B P A'), comCuringa, cfg);
  assert.equal(sem.entradas, 1, 'sem o filtro, o curinga engole o branco');

  const com = simularBanca(hist('P B P A'), comCuringa, { ...cfg, resetarNoBranco: true });
  assert.equal(com.entradas, 0, 'com o filtro, a janela zera no branco');
});

test('banca: comecar so depois do branco nao muda a margem da casa', () => {
  // A resposta honesta para "o branco reseta os padroes": a roleta nao lembra
  // do giro anterior. O filtro muda QUANTAS entradas acontecem, nunca quanto
  // cada uma paga. Se um dia este teste falhar, a conta e que esta errada.
  const historico = sorteado(60_000);
  const p = [padrao('* P', 'A', 1, 'gale')];
  const base = { bancaInicial: 1_000_000, entrada: 1, reiniciar: false };

  const normal = simularBanca(historico, p, base);
  const aposBranco = simularBanca(historico, p, { ...base, resetarNoBranco: true });

  assert.ok(aposBranco.entradas < normal.entradas, 'o filtro precisa cortar entradas');
  assert.ok(aposBranco.entradas > 300, `amostra pequena (${aposBranco.entradas})`);
  for (const [rot, r] of [['normal', normal], ['apos branco', aposBranco]] as const) {
    assert.ok(
      Math.abs(r.margemDaCasa + 1 / 15) < 0.03,
      `${rot}: margem deu ${(r.margemDaCasa * 100).toFixed(2)}%, esperado perto de -6,67%`,
    );
  }
});

test('banca: quebra quando a entrada nao cabe mais, nao quando zera o saldo', () => {
  // O erro que isso cobre: medir a quebra contra o minimo da plataforma
  // (R$ 0,10) em vez do custo da entrada configurada (R$ 1,15). A sessao
  // ficava "viva" com trocados no bolso, recusando milhares de sinais em
  // silencio em vez de admitir que a banca acabou.
  const r = simularBanca(sorteado(20_000), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 5,
    entrada: 1,
    entradaBranco: 0.15,
    reiniciar: false,
  });

  assert.equal(r.sessoes.length, 1);
  assert.equal(r.sessoes[0].motivo, 'quebrou');
  assert.equal(r.naoCouberam, 0, 'quebrou e parou, em vez de recusar sinal por sinal');

  // Parou com dinheiro ainda no bolso. Pode ate sobrar mais que uma entrada
  // seca (R$ 1,15): basta nao cobrir o gale (R$ 2,30) para o ciclo ser
  // abandonado no meio, e quem nao consegue galear nao consegue rodar a
  // estrategia como ela foi configurada.
  const sobrou = 5 + r.sessoes[0].resultado;
  assert.ok(sobrou >= 0 && sobrou < 2.3, `sobraram ${sobrou}, esperado abaixo de um gale`);
});

test('banca: a escada de recuperacao fecha o buraco quando acerta', () => {
  // r0 P  gatilho, aposta R$ 1
  // r1 P  errou, vai pro G1, aposta R$ 2
  // r2 P  RED de R$ 3 -> passa do limite de R$ 2 -> abre a escada, aposta R$ 10
  // r3 A  a recuperacao acerta: R$ 20 de volta, lucro de R$ 10
  const r = simularBanca(hist('P P P A'), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
    stopLoss: 2,
    recuperacao: [10, 20, 40],
    reiniciar: false,
  });

  assert.equal(r.recuperacoes, 1);
  assert.equal(r.recuperacoesOk, 1);
  assert.equal(r.sessoes[0].motivo, 'recuperado');
  // A recuperacao e aposta seca: R$ 10 viram R$ 20, lucro de R$ 10.
  const ultima = r.extrato[r.extrato.length - 1];
  assert.equal(ultima.apostado, 10);
  assert.equal(ultima.lucro, 10);
  assert.equal(ultima.gale, 0, 'recuperacao nao galeia');
});

test('banca: perder a escada inteira custa muito mais que o limite', () => {
  // Mesmo comeco, mas a cor de entrada nunca sai: os tres degraus morrem.
  const r = simularBanca(hist('P P P P P P P P P P P P P'), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
    stopLoss: 2,
    recuperacao: [10, 20, 40],
    reiniciar: false,
  });

  assert.equal(r.recuperacoes, 1);
  assert.equal(r.recuperacoesOk, 0);
  assert.equal(r.sessoes[0].motivo, 'recuperacaoFalhou');
  // R$ 70 de escada em cima de um limite de R$ 2: e esse o tamanho do risco.
  assert.ok(r.sessoes[0].resultado <= -70, `fechou em ${r.sessoes[0].resultado}`);
});

test('banca: sem escada configurada, o limite encerra o dia como antes', () => {
  const r = simularBanca(hist('P P P P P P P P P'), [padrao('P', 'A', 1, 'gale')], {
    bancaInicial: 100,
    entrada: 1,
    stopLoss: 2,
    reiniciar: false,
  });

  assert.equal(r.recuperacoes, 0);
  assert.equal(r.sessoes[0].motivo, 'stopLoss');
});

test('banca: melhorResultado guarda o pico, nao o fechamento', () => {
  // Ganha a primeira e perde as seguintes: o resultado final nao conta que a
  // banca subiu antes. Sem este campo nao da para responder "antes de
  // quebrar, cheguei perto da meta?".
  const r = simularBanca(hist('P A P P P P'), [padrao('P', 'A', 0, 'red')], {
    bancaInicial: 100,
    entrada: 1,
    reiniciar: false,
  });

  assert.equal(r.sessoes[0].melhorResultado, 1);
  assert.ok(r.sessoes[0].resultado < 0, `fechou em ${r.sessoes[0].resultado}`);
});

test('banca: com meta de dobrar, dobrar e sempre menos provavel que quebrar', () => {
  // O plano "quebro uma banca e dobro duas" exige dobrar em 2 de 3 tentativas.
  // Nenhuma configuracao chega la: o teto e o tiro unico de toda a banca na
  // cor, 7/15 = 46,7%, e qualquer parcelamento em apostas menores fica abaixo.
  const r = simularBanca(
    sorteado(200_000),
    [padrao('P', 'A', 1, 'protect'), padrao('A', 'P', 1, 'protect', 2)],
    { bancaInicial: 100, entrada: 10, entradaBranco: 1.5, stopWin: 100, reiniciar: true },
  );

  const dobrou = r.sessoes.filter((s) => s.motivo === 'stopWin').length;
  const quebrou = r.sessoes.filter((s) => s.motivo === 'quebrou').length;
  assert.ok(dobrou + quebrou > 100, `amostra pequena demais: ${r.sessoes.length} sessoes`);
  const taxa = dobrou / (dobrou + quebrou);
  assert.ok(taxa < 0.5, `dobrou em ${(taxa * 100).toFixed(1)}% das bancas`);
  assert.ok(r.resultado < 0, `resultado ${r.resultado}`);
});

test('banca: o tiro unico de toda a banca dobra em 7/15 das vezes', () => {
  // Entrada do tamanho da banca: acertou a cor, dobrou; errou, nao sobra nem
  // para o gale e a banca morre. E o melhor que existe para dobrar, e mesmo
  // assim perde 6,67% do dinheiro arriscado.
  const r = simularBanca(sorteado(200_000), [padrao('P', 'A', 1, 'red')], {
    bancaInicial: 100,
    entrada: 100,
    entradaBranco: 0,
    stopWin: 100,
    reiniciar: true,
  });

  const dobrou = r.sessoes.filter((s) => s.motivo === 'stopWin').length;
  const quebrou = r.sessoes.filter((s) => s.motivo === 'quebrou').length;
  const taxa = dobrou / (dobrou + quebrou);
  assert.ok(dobrou + quebrou > 1000, `amostra pequena: ${dobrou + quebrou}`);
  assert.ok(Math.abs(taxa - 7 / 15) < 0.03, `dobrou em ${(taxa * 100).toFixed(1)}%, esperado 46,7%`);
});
