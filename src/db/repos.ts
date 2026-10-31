import { Db } from './index';
import { Color, GameResult, NewPattern, Pattern, Scoreboard, Signal, SignalStatus, WhiteRule } from '../types';

const toBool = (v: unknown): boolean => v === 1 || v === true || v === '1';

interface ResultRow { round_id: string; color: string; roll: number | null; created_at: string; live: number }
function mapResult(r: ResultRow): GameResult {
  return { roundId: r.round_id, color: r.color as Color, roll: r.roll, createdAt: r.created_at, live: toBool(r.live) };
}

export class ResultsRepo {
  constructor(private db: Db) {}

  /** @returns true se o round era novo; false se ja conheciamos (deduplicacao por round_id). */
  insert(r: GameResult): boolean {
    const res = this.db
      .prepare(
        'INSERT INTO results (round_id, color, roll, created_at, live) VALUES (?, ?, ?, ?, ?)' +
          ' ON CONFLICT(round_id) DO NOTHING',
      )
      .run(r.roundId, r.color, r.roll, r.createdAt, r.live ? 1 : 0);
    return res.changes > 0;
  }

  has(roundId: string): boolean {
    return this.db.prepare('SELECT 1 FROM results WHERE round_id = ?').get(roundId) !== undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number };
    return row.n;
  }

  /** Ultimos N resultados em ordem cronologica (mais antigo -> mais recente). */
  recent(limit: number): GameResult[] {
    const rows = this.db
      .prepare('SELECT * FROM results ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as unknown as ResultRow[];
    return rows.map(mapResult).reverse();
  }

  recentColors(limit: number): Color[] {
    return this.recent(limit).map((r) => r.color);
  }

  latest(): GameResult | null {
    const row = this.db
      .prepare('SELECT * FROM results ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as unknown as ResultRow | undefined;
    return row ? mapResult(row) : null;
  }

  /** Historico inteiro em ordem cronologica. Usado pelo backtest. */
  allAsc(): GameResult[] {
    const rows = this.db
      .prepare('SELECT * FROM results ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as ResultRow[];
    return rows.map(mapResult);
  }
}

interface PatternRow {
  id: number; name: string; expr: string; entry_color: string;
  gales: number; white_rule: string; active: number; created_at: string;
}
function mapPattern(r: PatternRow): Pattern {
  return {
    id: r.id, name: r.name, expr: r.expr, entryColor: r.entry_color as Color,
    gales: r.gales, whiteRule: r.white_rule as WhiteRule, active: toBool(r.active), createdAt: r.created_at,
  };
}

export class PatternsRepo {
  constructor(private db: Db) {}

  create(p: NewPattern): Pattern {
    const res = this.db
      .prepare(
        'INSERT INTO patterns (name, expr, entry_color, gales, white_rule, active)' +
          ' VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(p.name, p.expr, p.entryColor, p.gales, p.whiteRule, p.active ? 1 : 0);
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): Pattern | null {
    const row = this.db.prepare('SELECT * FROM patterns WHERE id = ?').get(id) as unknown as PatternRow | undefined;
    return row ? mapPattern(row) : null;
  }

  list(opts: { activeOnly?: boolean } = {}): Pattern[] {
    const sql = opts.activeOnly
      ? 'SELECT * FROM patterns WHERE active = 1 ORDER BY id'
      : 'SELECT * FROM patterns ORDER BY id';
    return (this.db.prepare(sql).all() as unknown as PatternRow[]).map(mapPattern);
  }

  update(id: number, patch: Partial<NewPattern>): Pattern | null {
    const cols: Record<keyof NewPattern, string> = {
      name: 'name', expr: 'expr', entryColor: 'entry_color',
      gales: 'gales', whiteRule: 'white_rule', active: 'active',
    };
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    for (const [k, col] of Object.entries(cols) as Array<[keyof NewPattern, string]>) {
      const v = patch[k];
      if (v === undefined) continue;
      sets.push(col + ' = ?');
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return this.get(id);
    this.db.prepare('UPDATE patterns SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM patterns WHERE id = ?').run(id).changes > 0;
  }
}

interface SignalRow {
  id: number; pattern_id: number; trigger_round_id: string; entry_color: string;
  gales_allowed: number; white_rule: string; current_gale: number; status: string;
  resolved_gale: number | null; won_on_white: number; created_at: string; resolved_at: string | null;
}
function mapSignal(r: SignalRow): Signal {
  return {
    id: r.id, patternId: r.pattern_id, triggerRoundId: r.trigger_round_id,
    entryColor: r.entry_color as Color, galesAllowed: r.gales_allowed,
    whiteRule: r.white_rule as WhiteRule, currentGale: r.current_gale,
    status: r.status as SignalStatus, resolvedGale: r.resolved_gale,
    wonOnWhite: toBool(r.won_on_white), createdAt: r.created_at, resolvedAt: r.resolved_at,
  };
}

export type Outcome = 'win' | 'loss' | 'white';

export class SignalsRepo {
  constructor(private db: Db) {}

  open(patternId: number, triggerRoundId: string, p: Pattern): Signal {
    const res = this.db
      .prepare(
        'INSERT INTO signals (pattern_id, trigger_round_id, entry_color, gales_allowed, white_rule)' +
          ' VALUES (?, ?, ?, ?, ?)',
      )
      .run(patternId, triggerRoundId, p.entryColor, p.gales, p.whiteRule);
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): Signal | null {
    const row = this.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as unknown as SignalRow | undefined;
    return row ? mapSignal(row) : null;
  }

  openSignals(): Signal[] {
    const rows = this.db
      .prepare("SELECT * FROM signals WHERE status = 'open' ORDER BY id")
      .all() as unknown as SignalRow[];
    return rows.map(mapSignal);
  }

  hasOpen(patternId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM signals WHERE pattern_id = ? AND status = 'open'")
      .get(patternId);
    return row !== undefined;
  }

  advanceGale(id: number, gale: number): void {
    this.db.prepare('UPDATE signals SET current_gale = ? WHERE id = ?').run(gale, id);
  }

  resolve(id: number, status: Exclude<SignalStatus, 'open'>, resolvedGale: number | null, wonOnWhite: boolean): void {
    this.db
      .prepare(
        "UPDATE signals SET status = ?, resolved_gale = ?, won_on_white = ?," +
          " resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      )
      .run(status, resolvedGale, wonOnWhite ? 1 : 0, id);
  }

  addEvent(signalId: number, gale: number, roundId: string, color: Color, outcome: Outcome): void {
    this.db
      .prepare('INSERT INTO signal_events (signal_id, gale, round_id, color, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(signalId, gale, roundId, color, outcome);
  }

  /**
   * Placar de um padrao, ou de todos quando patternId e null.
   * `since` e um ISO 8601; quando informado, conta so o que foi resolvido depois.
   */
  scoreboard(patternId: number | null, patternName: string, since?: string): Scoreboard {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (patternId !== null) { where.push('pattern_id = ?'); args.push(patternId); }
    if (since) { where.push('(resolved_at IS NULL OR resolved_at >= ?)'); args.push(since); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = this.db
      .prepare('SELECT status, resolved_gale, won_on_white FROM signals ' + clause + ' ORDER BY id')
      .all(...args) as unknown as Array<{ status: string; resolved_gale: number | null; won_on_white: number }>;

    const sb: Scoreboard = {
      patternId, patternName, total: 0, greens: 0, greenG0: 0, greenG1: 0, greenG2: 0,
      greenWhite: 0, reds: 0, open: 0, hitRate: 0, currentStreak: 0, streakKind: 'none',
      bestGreenStreak: 0, worstRedStreak: 0,
    };

    let runGreen = 0;
    let runRed = 0;
    for (const r of rows) {
      if (r.status === 'open') { sb.open++; continue; }
      sb.total++;
      if (r.status === 'green') {
        sb.greens++;
        if (toBool(r.won_on_white)) sb.greenWhite++;
        else if (r.resolved_gale === 0) sb.greenG0++;
        else if (r.resolved_gale === 1) sb.greenG1++;
        else if (r.resolved_gale === 2) sb.greenG2++;
        runGreen++; runRed = 0;
        sb.bestGreenStreak = Math.max(sb.bestGreenStreak, runGreen);
        sb.currentStreak = runGreen; sb.streakKind = 'green';
      } else {
        sb.reds++;
        runRed++; runGreen = 0;
        sb.worstRedStreak = Math.max(sb.worstRedStreak, runRed);
        sb.currentStreak = runRed; sb.streakKind = 'red';
      }
    }
    sb.hitRate = sb.total > 0 ? sb.greens / sb.total : 0;
    return sb;
  }
}

export interface Repos {
  results: ResultsRepo;
  patterns: PatternsRepo;
  signals: SignalsRepo;
}

export function makeRepos(db: Db): Repos {
  return { results: new ResultsRepo(db), patterns: new PatternsRepo(db), signals: new SignalsRepo(db) };
}
