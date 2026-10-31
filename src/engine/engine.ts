import { Color, GameResult, Pattern, Scoreboard, Signal } from '../types';
import { Repos } from '../db/repos';
import { ParsedPattern, parsePattern } from './grammar';
import { matchAtEnd } from './matcher';
import { classifyAttempt } from './rules';

export type EngineEvent =
  | { kind: 'entry'; pattern: Pattern; signal: Signal; triggerColors: Color[]; round: GameResult }
  | { kind: 'gale'; pattern: Pattern; signal: Signal; gale: number; round: GameResult }
  | {
      kind: 'resolved';
      pattern: Pattern;
      signal: Signal;
      status: 'green' | 'red';
      round: GameResult;
      scoreboard: Scoreboard;
    }
  | { kind: 'gap'; reason: string; roundsToRearm: number };

export class Engine {
  /**
   * Cache de padroes compilados, indexado pela propria expressao. Como a chave e
   * o conteudo, nao existe invalidacao a fazer quando um padrao e editado.
   */
  private compiled = new Map<string, ParsedPattern>();

  /**
   * Quantas rodadas contiguas e confiaveis vimos desde a ultima descontinuidade.
   * Enquanto esse numero for menor que o padrao mais longo, nao disparamos nada:
   * um buraco no historico produziria gatilhos falsos silenciosamente, que e o
   * pior tipo de defeito possivel aqui.
   */
  private trustedStreak = 0;

  constructor(private repos: Repos) {}

  private parse(expr: string): ParsedPattern {
    let p = this.compiled.get(expr);
    if (!p) {
      p = parsePattern(expr);
      this.compiled.set(expr, p);
    }
    return p;
  }

  /** Maior janela exigida pelos padroes ativos. */
  private windowSize(patterns: Pattern[]): number {
    let max = 1;
    for (const p of patterns) {
      try {
        max = Math.max(max, this.parse(p.expr).maxLength);
      } catch {
        // Padrao invalido no banco: ignorado aqui e reportado em evaluate().
      }
    }
    return max;
  }

  /**
   * Marca o historico como descontinuo. Chamado pelo coletor quando reconecta e
   * nao consegue provar que preencheu todos os rounds perdidos.
   */
  markGap(reason: string): EngineEvent {
    this.trustedStreak = 0;
    const roundsToRearm = this.windowSize(this.repos.patterns.list({ activeOnly: true }));
    return { kind: 'gap', reason, roundsToRearm };
  }

  /** Reconstroi a confianca a partir do que ja esta no banco (usado no boot). */
  primeFromHistory(): void {
    this.trustedStreak = this.repos.results.count();
  }

  get armed(): boolean {
    return this.trustedStreak >= this.windowSize(this.repos.patterns.list({ activeOnly: true }));
  }

  /**
   * Processa um resultado novo. A ordem aqui e deliberada:
   *   1. grava o resultado (dedup por round_id)
   *   2. resolve os sinais abertos que esperavam por esta rodada
   *   3. so entao procura gatilhos novos na janela que ja inclui esta rodada
   *
   * Invertida, essa ordem faria um padrao resolver e re-disparar na mesma
   * rodada com a janela errada.
   */
  onResult(result: GameResult): EngineEvent[] {
    const isNew = this.repos.results.insert(result);
    if (!isNew) return [];

    this.trustedStreak++;
    const events: EngineEvent[] = [];
    events.push(...this.resolveOpenSignals(result));
    events.push(...this.evaluateTriggers(result));
    return events;
  }

  private resolveOpenSignals(round: GameResult): EngineEvent[] {
    const events: EngineEvent[] = [];

    for (const signal of this.repos.signals.openSignals()) {
      const pattern = this.repos.patterns.get(signal.patternId);
      // O padrao pode ter sido apagado enquanto o sinal estava aberto; nesse caso
      // o ON DELETE CASCADE ja removeu o sinal, mas defendemos de qualquer forma.
      if (!pattern) continue;

      const canGale = signal.currentGale < signal.galesAllowed;
      const res = classifyAttempt(round.color, signal.entryColor, signal.whiteRule, canGale);

      this.repos.signals.addEvent(signal.id, signal.currentGale, round.roundId, round.color, res.outcome);

      if (res.verdict === 'next') {
        const nextGale = signal.currentGale + 1;
        this.repos.signals.advanceGale(signal.id, nextGale);
        events.push({ kind: 'gale', pattern, signal: this.repos.signals.get(signal.id)!, gale: nextGale, round });
        continue;
      }

      const status = res.verdict;
      this.repos.signals.resolve(
        signal.id,
        status,
        status === 'green' ? signal.currentGale : null,
        res.wonOnWhite,
      );

      events.push({
        kind: 'resolved',
        pattern,
        signal: this.repos.signals.get(signal.id)!,
        status,
        round,
        scoreboard: this.repos.signals.scoreboard(pattern.id, pattern.name),
      });
    }

    return events;
  }

  private evaluateTriggers(round: GameResult): EngineEvent[] {
    const patterns = this.repos.patterns.list({ activeOnly: true });
    if (patterns.length === 0) return [];

    const window = this.windowSize(patterns);
    if (this.trustedStreak < window) return [];

    const history = this.repos.results.recentColors(window);
    const events: EngineEvent[] = [];

    for (const pattern of patterns) {
      // Trava de reentrancia: um padrao com sinal aberto nao dispara de novo.
      if (this.repos.signals.hasOpen(pattern.id)) continue;

      let parsed: ParsedPattern;
      try {
        parsed = this.parse(pattern.expr);
      } catch {
        continue;
      }

      const len = matchAtEnd(parsed, history);
      if (len === null) continue;

      const signal = this.repos.signals.open(pattern.id, round.roundId, pattern);
      events.push({
        kind: 'entry',
        pattern,
        signal,
        triggerColors: history.slice(history.length - len),
        round,
      });
    }

    return events;
  }
}
