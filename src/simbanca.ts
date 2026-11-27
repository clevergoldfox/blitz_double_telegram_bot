/**
 * Simulador de banca pela linha de comando.
 *
 * Roda os padroes cadastrados sobre o historico guardado contando dinheiro de
 * mentira, com as regras reais do caixa. Serve para responder "e se eu
 * apostasse?" sem apostar.
 *
 *   npm run banca
 *   npm run banca -- --entrada 1 --branco 0,15 --stop-loss 20
 *   npm run banca -- --inicio 9 --fim 18 --reset-branco
 *   npm run banca -- --db data/bot.db --banca 100
 */
import { openDb } from './db/index';
import { makeRepos } from './db/repos';
import { parsePattern } from './engine/grammar';
import { BancaConfig, PadraoSimulado, simularBanca, SimulacaoBanca } from './engine/banca';
import { colorOfRoll, GameResult } from './types';

function arg(nome: string): string | null {
  // lastIndexOf: repetir a opcao sobrescreve, que e o que todo mundo espera de
  // uma linha de comando. Com indexOf, "--entrada 1 ... --entrada 0,5" ficava
  // valendo 1 em silencio.
  const i = process.argv.lastIndexOf('--' + nome);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(nome: string): boolean {
  return process.argv.includes('--' + nome);
}
/** Aceita "0,15" e "0.15": o cliente escreve com virgula. */
function num(nome: string, padrao: number | null): number | null {
  const v = arg(nome);
  if (v === null) return padrao;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`--${nome} precisa ser um numero, veio "${v}"`);
  return n;
}

const brl = (n: number) => (n < 0 ? '-' : '') + 'R$ ' + Math.abs(n).toFixed(2).replace('.', ',');
const pct = (n: number) => (n * 100).toFixed(2).replace('.', ',') + '%';

function dia(iso: string | null): string {
  return iso ? iso.slice(0, 10).split('-').reverse().join('/') : '-';
}

function relatorio(titulo: string, r: SimulacaoBanca, bancaInicial: number): void {
  const quebradas = r.sessoes.filter((s) => s.motivo === 'quebrou').length;
  const ganhas = r.sessoes.filter((s) => s.motivo === 'stopWin').length;
  const perdidas = r.sessoes.filter((s) => s.motivo === 'stopLoss').length;
  const abertas = r.sessoes.filter((s) => s.motivo === 'fimDoHistorico').length;
  const neutras = r.sessoes.filter((s) => s.motivo === 'fimDoDia').length;
  const recOk = r.sessoes.filter((s) => s.motivo === 'recuperado').length;
  const recNao = r.sessoes.filter((s) => s.motivo === 'recuperacaoFalhou').length;

  console.log('\n' + '='.repeat(66));
  console.log(titulo);
  console.log('='.repeat(66));
  console.log(`rodadas lidas .......... ${r.roundsScanned}`);
  console.log(`entradas ............... ${r.entradas}  (${r.greens} GREEN / ${r.reds} RED)`);
  if (r.entradas > 0) {
    console.log(`acerto no placar ....... ${pct(r.greens / (r.greens + r.reds))}`);
  }
  console.log(`GREEN que veio de branco ${r.greensNoBranco}` +
    (r.greensQuePerderamDinheiro > 0
      ? `  — destes, ${r.greensQuePerderamDinheiro} deram PREJUIZO no caixa`
      : ''));
  console.log(`total apostado ......... ${brl(r.apostado)}`);
  if (r.apostadoNoBranco > 0) {
    const saldoBranco = r.recebidoDoBranco - r.apostadoNoBranco;
    console.log(`  ficha no branco ...... ${brl(r.apostadoNoBranco)} apostados,` +
      ` ${brl(r.recebidoDoBranco)} recebidos em ${r.brancosPagos} brancos` +
      `  =>  ${brl(saldoBranco)}  (${pct(saldoBranco / r.apostadoNoBranco)})`);
    const naCor = r.apostado - r.apostadoNoBranco;
    const saldoCor = r.resultado - saldoBranco;
    console.log(`  aposta na cor ........ ${brl(naCor)} apostados` +
      `  =>  ${brl(saldoCor)}  (${pct(saldoCor / naCor)})`);
  }
  console.log(`resultado .............. ${brl(r.resultado)}`);
  console.log(`margem da casa ......... ${pct(r.margemDaCasa)}`);
  console.log(`pior sequencia de RED .. ${r.piorSequenciaRed}`);
  console.log(`maior queda da banca ... ${brl(r.maiorQueda)}`);
  if (r.naoCouberam > 0) console.log(`sinais sem saldo ....... ${r.naoCouberam}`);

  console.log(`\nsessoes: ${r.sessoes.length}` +
    `  (${ganhas} bateram o stop win, ${perdidas} o stop loss, ` +
    `${quebradas} quebraram, ${neutras} fecharam o dia sem bater meta nem limite, ` +
    `${abertas} ainda abertas no fim)`);

  if (r.recuperacoes > 0) {
    const falhas = r.recuperacoes - r.recuperacoesOk;
    console.log(`
recuperacao acionada ${r.recuperacoes}x:` +
      ` ${r.recuperacoesOk} fecharam o buraco, ${falhas} perderam a escada inteira`);
    const dias = (m: string) => r.sessoes.filter((s) => s.motivo === m);
    const media = (xs: typeof r.sessoes) =>
      xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.resultado, 0) / xs.length;
    if (recOk > 0) console.log(`  dia recuperado ....... ${recOk}, media ${brl(media(dias('recuperado')))}`);
    if (recNao > 0) console.log(`  escada perdida ....... ${recNao}, media ${brl(media(dias('recuperacaoFalhou')))}`);
    const pior = r.sessoes.reduce((m, s) => Math.min(m, s.resultado), 0);
    console.log(`  pior dia do periodo .. ${brl(pior)}`);
  }

  if (r.sessoes.length > 1) {
    const vivas = r.sessoes.filter((s) => s.resultado > 0).length;
    console.log(`sessoes que terminaram no lucro: ${vivas} de ${r.sessoes.length}` +
      ` (${pct(vivas / r.sessoes.length)})`);
  }

  const mostrar = r.sessoes.slice(0, 40);
  if (mostrar.length > 0) {
    console.log('\n  #   inicio       fim          entradas   apostado   resultado      melhor   motivo');
    for (const s of mostrar) {
      console.log(
        `  ${String(s.numero).padStart(2)}  ${dia(s.inicioEm).padEnd(12)} ${dia(s.fimEm).padEnd(12)}` +
        ` ${String(s.entradas).padStart(8)}  ${brl(s.apostado).padStart(10)}` +
        ` ${brl(s.resultado).padStart(11)}  ${('+' + brl(s.melhorResultado)).padStart(11)}   ${s.motivo}`,
      );
    }
    if (r.sessoes.length > mostrar.length) {
      console.log(`  ... e mais ${r.sessoes.length - mostrar.length} sessoes`);
    }
  }

  // Media por motivo de fim. Importa porque "quebrou" nem sempre custa a
  // banca inteira: com entrada grande a sessao morre por nao conseguir pagar
  // o gale, com dinheiro ainda em caixa. Sem esta linha a conta de
  // "quebro uma, dobro duas" sai errada.
  if (r.sessoes.length > 1) {
    const motivos = [...new Set(r.sessoes.map((s) => s.motivo))];
    console.log(`\npor motivo de fim:`);
    for (const m of motivos) {
      const xs = r.sessoes.filter((s) => s.motivo === m);
      const soma = xs.reduce((t, x) => t + x.resultado, 0);
      console.log(`  ${m.padEnd(20)} ${String(xs.length).padStart(7)}` +
        `  media ${brl(soma / xs.length).padStart(11)}` +
        `  ${pct(xs.length / r.sessoes.length).padStart(7)} das sessoes`);
    }
    console.log(`  media geral por sessao ..... ${brl(r.resultado / r.sessoes.length)}`);
  }

  // O resultado final de uma sessao nao diz se a banca subiu antes de cair.
  // Com meta de dobrar, a pergunta que importa e justamente esta: das vezes
  // que quebrou, quantas chegaram perto?
  if (r.sessoes.length > 1) {
    const picoMedio = (xs: typeof r.sessoes) =>
      xs.length === 0 ? 0 : xs.reduce((m, s) => m + s.melhorResultado, 0) / xs.length;
    const maior = r.sessoes.reduce((m, s) => Math.max(m, s.melhorResultado), 0);
    console.log(`\nmelhor momento de uma sessao .. +${brl(maior)}`);
    console.log(`pico medio das sessoes ........ +${brl(picoMedio(r.sessoes))}`);
    const quebraram = r.sessoes.filter((s) => s.motivo === 'quebrou');
    if (quebraram.length > 0) {
      const topo = quebraram.reduce((m, s) => Math.max(m, s.melhorResultado), 0);
      console.log(`das ${quebraram.length} que quebraram: pico medio +${brl(picoMedio(quebraram))},` +
        ` melhor +${brl(topo)}`);
    }
  }

  const fim = bancaInicial + (r.sessoes[r.sessoes.length - 1]?.resultado ?? 0);
  console.log(`\nbanca de ${brl(bancaInicial)} na ultima sessao terminou em ${brl(fim)}`);

  // Com sessao por dia, o que interessa e a assimetria entre o dia bom e o dia
  // ruim: o RED pula a linha do stop de uma vez, o GREEN encosta nela de a
  // pouco. Dois dias "iguais" nao se anulam.
  const ganhos = r.sessoes.filter((s) => s.motivo === 'stopWin');
  const perdas = r.sessoes.filter((s) => s.motivo === 'stopLoss');
  if (ganhos.length > 0 && perdas.length > 0) {
    const media = (xs: typeof ganhos) => xs.reduce((s, x) => s + x.resultado, 0) / xs.length;
    const mg = media(ganhos);
    const mp = media(perdas);
    console.log(`\ndia de meta batida: ${ganhos.length}, media ${brl(mg)}`);
    console.log(`dia de limite batido: ${perdas.length}, media ${brl(mp)}`);
    console.log(`para empatar seria preciso bater a meta em ${pct(-mp / (mg - mp))} dos dias`);

    let pior = 0;
    let corrente = 0;
    for (const s of r.sessoes) {
      corrente = s.motivo === 'stopLoss' ? corrente + 1 : 0;
      pior = Math.max(pior, corrente);
    }
    console.log(`pior sequencia de dias no limite: ${pior}`);
  }
}

/**
 * Roleta honesta: 15 casas equiprovaveis, uma rodada a cada 30 segundos.
 *
 * Usa mulberry32 e nao a LCG simples que aparece nos testes: aquela tem bits
 * baixos fracos, e "s % 15" le exatamente esses bits. Com ela, este controle
 * acusou 128 dias de limite batido em 150 — vicio do gerador, nao do jogo.
 * Esta passa no qui-quadrado das 15 casas.
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

function sorteado(n: number): GameResult[] {
  const out: GameResult[] = [];
  const rand = mulberry32(20261118);
  for (let i = 0; i < n; i++) {
    const roll = Math.floor(rand() * 15);
    out.push({
      roundId: 'sorteio-' + i,
      color: colorOfRoll(roll),
      roll,
      createdAt: new Date(Date.UTC(2026, 0, 1, 3) + i * 30_000).toISOString(),
      live: true,
    });
  }
  return out;
}

function main(): void {
  const caminho = arg('db') ?? 'data/bot.db';
  const db = openDb(caminho);
  const repos = makeRepos(db);

  const padroes: PadraoSimulado[] = [];
  for (const p of repos.patterns.list({ activeOnly: !flag('todos') })) {
    try {
      padroes.push({
        id: p.id,
        name: p.name,
        parsed: parsePattern(p.expr),
        entryColor: p.entryColor,
        gales: p.gales,
        whiteRule: p.whiteRule,
      });
    } catch {
      console.warn(`padrao #${p.id} ignorado: expressao nao entendida ("${p.expr}")`);
    }
  }

  const total = repos.results.count();
  const pedidas = Number(num('aleatorio', 0));
  // Controle: as mesmas regras sobre uma roleta sorteada. Serve para separar o
  // que e comportamento do jogo do que e sorte destes dezessete dias.
  const historico = pedidas > 0
    ? sorteado(pedidas)
    : repos.results.recent(Math.min(total, Number(num('rodadas', 200_000))));

  const cfg: BancaConfig = {
    bancaInicial: num('banca', 100) as number,
    entrada: num('entrada', 1) as number,
    entradaBranco: num('branco', null),
    entradaPct: num('entrada-pct', null),
    stopWin: num('stop-win', null),
    stopLoss: num('stop-loss', null),
    entradaMinima: num('minimo', 0.1) as number,
    horarioInicio: num('inicio', null),
    horarioFim: num('fim', null),
    resetarNoBranco: flag('reset-branco'),
    sessaoPorDia: flag('dia'),
    recuperacao: (arg('recuperacao') ?? '')
      .split(',')
      .map((v) => Number(v.trim().replace(',', '.')))
      .filter((v) => Number.isFinite(v) && v > 0),
    reiniciar: !flag('sem-reinicio'),
  };

  console.log(`banco: ${caminho}  |  ${total} rodadas guardadas, ${historico.length} na simulacao` +
    (pedidas > 0 ? '  [ROLETA SORTEADA, nao o historico real]' : ''));
  console.log(`padroes: ${padroes.length} (${padroes.map((p) => '#' + p.id).join(' ')})`);
  console.log(`entrada ${brl(cfg.entrada)} na cor` +
    (cfg.entradaBranco ? ` + ${brl(cfg.entradaBranco)} no branco` : ' (sem ficha no branco)') +
    `, banca ${brl(cfg.bancaInicial)}`);

  relatorio('RESULTADO', simularBanca(historico, padroes, cfg), cfg.bancaInicial);
  db.close();
}

main();
