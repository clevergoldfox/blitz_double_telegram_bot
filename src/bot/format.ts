import { COLOR_EMOJI, COLOR_NAME, Color, GameResult, Pattern, Scoreboard, WHITE_RULE_LABEL } from '../types';
import { BacktestResult } from '../engine/backtest';
import { SourceStatus } from '../sources/types';
import { formatTokensPretty, parsePattern } from '../engine/grammar';

/** Escapa o que vai dentro de HTML do Telegram (nome de padrao e texto do usuario). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function pct(n: number): string {
  return (n * 100).toFixed(1).replace('.', ',') + '%';
}

export function colorChip(c: Color): string {
  return `${COLOR_EMOJI[c]} ${COLOR_NAME[c].toUpperCase()}`;
}

export function seqPretty(colors: readonly Color[]): string {
  return colors.map((c) => COLOR_EMOJI[c]).join('');
}

/** "Até G1" / "sem gale" / "até G2" */
export function galeLabel(gales: number): string {
  return gales === 0 ? 'sem gale' : `ate G${gales}`;
}

export function patternExprPretty(expr: string): string {
  try {
    return formatTokensPretty(parsePattern(expr).tokens);
  } catch {
    return expr;
  }
}

export function patternHeadline(p: Pattern): string {
  return `Padrao #${p.id} <b>${esc(p.name)}</b>`;
}

/** Resumo curto de placar, usado no pe dos alertas. */
export function scoreInline(sb: Scoreboard): string {
  if (sb.total === 0) return 'sem historico ainda';
  return `${sb.greens}V / ${sb.reds}D (${pct(sb.hitRate)})`;
}

export function entryAlert(p: Pattern, trigger: readonly Color[], sb: Scoreboard): string {
  return [
    '\u{1F6A8} <b>ENTRADA CONFIRMADA</b>',
    '',
    patternHeadline(p),
    `Gatilho: ${seqPretty(trigger)}`,
    '',
    `➡️ Entrar no <b>${colorChip(p.entryColor)}</b>`,
    `${galeLabel(p.gales)} · ${WHITE_RULE_LABEL[p.whiteRule]}`,
    '',
    `Placar deste padrao: ${scoreInline(sb)}`,
  ].join('\n');
}

export function galeAlert(p: Pattern, gale: number, saiu: Color): string {
  return [
    `⚠️ <b>G${gale}</b> — ${patternHeadline(p)}`,
    `Saiu ${COLOR_EMOJI[saiu]} ${COLOR_NAME[saiu]}.`,
    `Entrar de novo no <b>${colorChip(p.entryColor)}</b> (G${gale}).`,
  ].join('\n');
}

export function resolvedAlert(
  p: Pattern,
  status: 'green' | 'red',
  saiu: Color,
  gale: number | null,
  wonOnWhite: boolean,
  sb: Scoreboard,
): string {
  const head =
    status === 'green'
      ? `✅ <b>GREEN${gale !== null ? ` no G${gale}` : ''}</b>${wonOnWhite ? ' (branco protegido)' : ''}`
      : '❌ <b>RED</b>';

  const streak =
    sb.streakKind === 'none' || sb.currentStreak < 2
      ? ''
      : ` · ${sb.currentStreak} ${sb.streakKind === 'green' ? 'greens' : 'reds'} seguidos`;

  return [
    `${head} — ${patternHeadline(p)}`,
    `Saiu ${COLOR_EMOJI[saiu]} ${COLOR_NAME[saiu]}.`,
    `Placar: ${scoreInline(sb)}${streak}`,
  ].join('\n');
}

export function gapAlert(reason: string, roundsToRearm: number): string {
  return [
    '\u{1F527} <b>Historico incompleto</b>',
    esc(reason),
    '',
    `Para nao emitir sinal errado, os alertas ficam pausados ate completar ${roundsToRearm} rodada(s) seguidas.`,
  ].join('\n');
}

export function patternLine(p: Pattern, sb: Scoreboard): string {
  const flag = p.active ? '\u{1F7E2}' : '⚫';
  return [
    `${flag} <b>#${p.id}</b> ${esc(p.name)}`,
    `   ${patternExprPretty(p.expr)} → ${COLOR_EMOJI[p.entryColor]} · ${galeLabel(p.gales)} · ${WHITE_RULE_LABEL[p.whiteRule]}`,
    `   placar: ${scoreInline(sb)}`,
  ].join('\n');
}

export function scoreboardBlock(sb: Scoreboard, titulo: string): string {
  if (sb.total === 0 && sb.open === 0) {
    return `<b>${esc(titulo)}</b>\nNenhum sinal registrado ainda.`;
  }
  const linhas = [
    `<b>${esc(titulo)}</b>`,
    `Sinais: ${sb.total}${sb.open ? ` (+${sb.open} em andamento)` : ''}`,
    `✅ GREEN: ${sb.greens}  —  ❌ RED: ${sb.reds}`,
    `Assertividade: <b>${pct(sb.hitRate)}</b>`,
  ];
  const det: string[] = [];
  if (sb.greenG0) det.push(`G0: ${sb.greenG0}`);
  if (sb.greenG1) det.push(`G1: ${sb.greenG1}`);
  if (sb.greenG2) det.push(`G2: ${sb.greenG2}`);
  if (sb.greenWhite) det.push(`branco: ${sb.greenWhite}`);
  if (det.length) linhas.push(`Greens por gale — ${det.join(' · ')}`);
  if (sb.bestGreenStreak) linhas.push(`Melhor sequencia: ${sb.bestGreenStreak} greens · pior: ${sb.worstRedStreak} reds`);
  return linhas.join('\n');
}

export function backtestBlock(p: { expr: string; entryColor: Color; gales: number }, bt: BacktestResult): string {
  if (bt.signals === 0) {
    return [
      '\u{1F4C8} <b>Teste no historico</b>',
      `${patternExprPretty(p.expr)} → ${COLOR_EMOJI[p.entryColor]} · ${galeLabel(p.gales)}`,
      '',
      `Esse padrao nao apareceu nenhuma vez nas ${bt.roundsScanned} rodadas guardadas.`,
      'Quanto mais historico o robo acumular, mais confiavel fica esse teste.',
    ].join('\n');
  }

  const det: string[] = [];
  bt.greenByGale.forEach((n, g) => { if (n) det.push(`G${g}: ${n}`); });
  if (bt.greenWhite) det.push(`branco: ${bt.greenWhite}`);

  return [
    '\u{1F4C8} <b>Teste no historico</b>',
    `${patternExprPretty(p.expr)} → ${COLOR_EMOJI[p.entryColor]} · ${galeLabel(p.gales)}`,
    '',
    `Rodadas analisadas: ${bt.roundsScanned}`,
    `Vezes que o padrao apareceu: <b>${bt.signals}</b>`,
    `✅ GREEN: ${bt.greens}  —  ❌ RED: ${bt.reds}`,
    `Assertividade historica: <b>${pct(bt.hitRate)}</b>`,
    det.length ? `Greens por gale — ${det.join(' · ')}` : '',
    `Melhor sequencia: ${bt.bestGreenStreak} greens · pior: ${bt.worstRedStreak} reds`,
    '',
    '<i>Resultado passado nao garante o proximo giro.</i>',
  ].filter(Boolean).join('\n');
}

export function statusBlock(
  st: SourceStatus,
  ultimos: readonly GameResult[],
  totalResultados: number,
  padroesAtivos: number,
  armed: boolean,
  tz: string,
): string {
  const ultimo = ultimos.length ? ultimos[ultimos.length - 1] : null;
  const quando = ultimo
    ? new Date(ultimo.createdAt).toLocaleString('pt-BR', { timeZone: tz })
    : 'nunca';

  return [
    `${st.connected ? '\u{1F7E2}' : '\u{1F534}'} <b>Status do robo</b>`,
    '',
    `Fonte: ${st.mode.toUpperCase()} · ${esc(st.detail)}`,
    `Ultimo resultado: ${ultimo ? COLOR_EMOJI[ultimo.color] : '—'} em ${quando}`,
    st.lastLatencyMs !== null ? `Atraso do ultimo round: ${st.lastLatencyMs} ms` : '',
    `Reconexoes: ${st.reconnects}`,
    '',
    `Rodadas no historico: ${totalResultados}`,
    `Padroes ativos: ${padroesAtivos}`,
    `Alertas: ${armed ? 'armados' : '<b>pausados</b> (historico se reconstruindo)'}`,
    '',
    `Ultimas rodadas: ${seqPretty(ultimos.map((r) => r.color))}`,
  ].filter(Boolean).join('\n');
}

export const HELP = [
  '<b>Robo de padroes — Double da Blitz</b>',
  '',
  '<b>Cadastrar padrao</b>',
  '<code>/novo &lt;sequencia&gt; = &lt;entrada&gt; [G0|G1|G2] [branco:gale|red|protege] [nome]</code>',
  'Exemplos:',
  '<code>/novo P P A P A = P G1 sem branco</code>',
  '<code>/novo ⚫⚫\u{1F7E1}⚫\u{1F7E1} = ⚫ G1</code>',
  '<code>/novo P{3} = A G2 branco:protege Tres pretos</code>',
  '<code>/novo !B{10} = B G0 Dez sem branco</code>',
  '',
  '<b>Gerenciar</b>',
  '/padroes — lista tudo com placar',
  '/editar &lt;id&gt; &lt;campo&gt; &lt;valor&gt; — campos: nome, seq, entrada, gales, branco',
  '/ativar &lt;id&gt; · /desativar &lt;id&gt; · /excluir &lt;id&gt;',
  '',
  '<b>Consultar</b>',
  '/placar [id] [hoje|semana|total] — assertividade',
  '/testar &lt;id&gt; — roda o padrao no historico guardado',
  '/ultimos [n] — ultimas rodadas',
  '/status — conexao, atraso e saude do robo',
  '',
  '<b>Cores:</b> P = preto, A = amarelo, B = branco.',
  '<b>Curingas:</b> <code>*</code> qualquer cor, <code>!B</code> nao-branco, <code>P{3}</code> repeticao, <code>P{2,4}</code> faixa.',
  '',
  '<i>O robo mostra frequencia historica. Nao prevê o proximo giro.</i>',
].join('\n');
