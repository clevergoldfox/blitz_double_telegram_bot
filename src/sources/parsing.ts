import { Color, GameResult, isColor } from '../types';

/**
 * Nomes de campo candidatos. Como nao existe API publica documentada da Blitz,
 * aceitamos varios nomes e ficamos com o primeiro que aparecer. Tudo isso e
 * sobrescrevivel por .env, entao adaptar a resposta real e configuracao, nao
 * reescrita de codigo.
 */
export interface FieldMap {
  id: string[];
  color: string[];
  roll: string[];
  createdAt: string[];
  status: string[];
}

export const DEFAULT_FIELDS: FieldMap = {
  id: ['id', 'game_id', 'gameId', 'round_id', 'roundId', 'uuid', '_id'],
  color: ['color', 'cor', 'result_color', 'resultColor', 'winning_color'],
  roll: ['roll', 'number', 'numero', 'result', 'value', 'winning_number'],
  createdAt: ['created_at', 'createdAt', 'finished_at', 'finishedAt', 'timestamp', 'time', 'date'],
  status: ['status', 'state', 'phase'],
};

/**
 * Mapa de cor. A familia Blaze usa 0 = branco, 1 = vermelho/amarelo, 2 = preto.
 * Na Blitz o lugar do vermelho e ocupado pelo amarelo.
 */
export const DEFAULT_COLOR_MAP: Record<string, Color> = {
  '0': 'B', '1': 'A', '2': 'P',
  white: 'B', branco: 'B', blanco: 'B',
  black: 'P', preto: 'P', negro: 'P',
  red: 'A', vermelho: 'A', yellow: 'A', amarelo: 'A', amarillo: 'A',
  P: 'P', A: 'A', B: 'B',
};

/** Status que indicam round encerrado. Nunca agimos sobre round em andamento. */
export const COMPLETE_STATUSES = new Set(['complete', 'completed', 'finished', 'done', 'rolled', 'closed']);

export function parseColorMapSpec(spec: string): Record<string, Color> {
  // formato: "0=B,1=A,2=P"
  const out: Record<string, Color> = {};
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || !v) continue;
    const up = v.toUpperCase();
    if (isColor(up)) out[k.toLowerCase()] = up;
  }
  return out;
}

function pick(obj: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return undefined;
}

export function coerceColor(v: unknown, map: Record<string, Color>): Color | null {
  if (v === undefined || v === null) return null;
  const key = String(v).trim().toLowerCase();
  if (map[key]) return map[key];
  const up = key.toUpperCase();
  return isColor(up) ? up : null;
}

/** Converte o que vier para ISO 8601; cai no agora quando nao da. */
function coerceDate(v: unknown): string {
  if (typeof v === 'number') {
    // epoch em segundos ou milissegundos
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export interface ExtractOptions {
  fields?: Partial<FieldMap>;
  colorMap?: Record<string, Color>;
  /** Exige status de round encerrado quando o objeto tiver campo de status. */
  requireComplete?: boolean;
}

/**
 * Varre um JSON arbitrario e extrai todo round de Double que reconhecer.
 *
 * Deliberadamente tolerante: a mensagem pode vir embrulhada em varias camadas
 * ({"payload":{"data":[...]}}), como lista ou como objeto unico.
 */
export function extractRounds(payload: unknown, opts: ExtractOptions = {}): GameResult[] {
  const fields: FieldMap = { ...DEFAULT_FIELDS, ...opts.fields } as FieldMap;
  const colorMap = opts.colorMap ?? DEFAULT_COLOR_MAP;
  const requireComplete = opts.requireComplete ?? true;

  const found: GameResult[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > 8) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const obj = node as Record<string, unknown>;
    const color = coerceColor(pick(obj, fields.color), colorMap);
    const rawId = pick(obj, fields.id);

    if (color !== null && rawId !== undefined) {
      const statusRaw = pick(obj, fields.status);
      const statusOk =
        statusRaw === undefined ||
        !requireComplete ||
        COMPLETE_STATUSES.has(String(statusRaw).toLowerCase());

      if (statusOk) {
        const rollRaw = pick(obj, fields.roll);
        const roll = typeof rollRaw === 'number' ? rollRaw : Number.isFinite(Number(rollRaw)) ? Number(rollRaw) : null;
        found.push({
          roundId: String(rawId),
          color,
          roll,
          createdAt: coerceDate(pick(obj, fields.createdAt)),
          live: true,
        });
      }
    }

    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  visit(payload, 0);

  // ordem cronologica e sem repetir round
  const byId = new Map<string, GameResult>();
  for (const r of found) if (!byId.has(r.roundId)) byId.set(r.roundId, r);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Desembrulha frame de socket.io / engine.io. Mensagens vem como
 * '42["double.tick",{...}]' ou '0{"sid":...}'. Devolve o JSON de dentro, ou null.
 */
export function unwrapSocketFrame(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;

  const start = text.search(/[[{]/);
  if (start === -1) return null;

  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}
