import 'dotenv/config';
import { resolve } from 'node:path';
import { Color } from './types';
import { DEFAULT_COLOR_MAP, FieldMap, parseColorMapSpec } from './sources/parsing';
import { Level } from './logger';

function str(key: string, fallback?: string): string {
  const v = process.env[key]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variavel de ambiente obrigatoria ausente: ${key} (veja o .env.example)`);
}

function optional(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v ? v : undefined;
}

function num(key: string, fallback: number): number {
  const v = process.env[key]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} precisa ser numero, recebi "${v}"`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(v);
}

function list(key: string): string[] {
  const v = process.env[key]?.trim();
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export type SourceKind = 'blitz' | 'simulator';

export interface Config {
  telegram: {
    token: string;
    /** Chat de destino dos alertas: privado, grupo ou canal. */
    chatId: string;
    /** Quem pode configurar padroes. Vazio = qualquer um, o que nao recomendamos. */
    ownerIds: number[];
  };
  source: {
    kind: SourceKind;
    simIntervalMs: number;
    simScripted: Color[];
    wsUrl?: string;
    wsSubscribe?: string;
    restRecentUrl?: string;
    pollMs: number;
    origin?: string;
    referer?: string;
    userAgent: string;
    colorMap: Record<string, Color>;
    fields: Partial<FieldMap>;
    requireComplete: boolean;
    staleAfterMs: number;
    backfillLimit: number;
  };
  dbPath: string;
  timezone: string;
  log: { level: Level; file?: string };
}

export function loadConfig(): Config {
  const kind = (str('SOURCE', 'simulator') as SourceKind);
  if (kind !== 'blitz' && kind !== 'simulator') {
    throw new Error(`SOURCE invalido: "${kind}". Use "blitz" ou "simulator".`);
  }

  const colorMapSpec = optional('BLITZ_COLOR_MAP');
  const colorMap = colorMapSpec
    ? { ...DEFAULT_COLOR_MAP, ...parseColorMapSpec(colorMapSpec) }
    : DEFAULT_COLOR_MAP;

  const fields: Partial<FieldMap> = {};
  const fieldEnv: Array<[keyof FieldMap, string]> = [
    ['id', 'BLITZ_FIELD_ID'],
    ['color', 'BLITZ_FIELD_COLOR'],
    ['roll', 'BLITZ_FIELD_ROLL'],
    ['createdAt', 'BLITZ_FIELD_CREATED_AT'],
    ['status', 'BLITZ_FIELD_STATUS'],
  ];
  for (const [k, env] of fieldEnv) {
    const v = list(env);
    if (v.length) fields[k] = v;
  }

  const scripted = (optional('SIM_SCRIPTED') ?? '')
    .toUpperCase()
    .split('')
    .filter((c): c is Color => c === 'P' || c === 'A' || c === 'B');

  return {
    telegram: {
      token: str('TELEGRAM_BOT_TOKEN'),
      chatId: str('TELEGRAM_CHAT_ID'),
      ownerIds: list('TELEGRAM_OWNER_IDS').map(Number).filter(Number.isFinite),
    },
    source: {
      kind,
      simIntervalMs: num('SIM_INTERVAL_MS', 20_000),
      simScripted: scripted,
      wsUrl: optional('BLITZ_WS_URL'),
      wsSubscribe: optional('BLITZ_WS_SUBSCRIBE'),
      restRecentUrl: optional('BLITZ_REST_RECENT_URL'),
      pollMs: num('BLITZ_POLL_MS', 3_000),
      origin: optional('BLITZ_ORIGIN'),
      referer: optional('BLITZ_REFERER'),
      userAgent: str(
        'BLITZ_USER_AGENT',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
      colorMap,
      fields,
      requireComplete: bool('BLITZ_REQUIRE_COMPLETE', true),
      staleAfterMs: num('BLITZ_STALE_AFTER_MS', 120_000),
      backfillLimit: num('BLITZ_BACKFILL_LIMIT', 50),
    },
    dbPath: resolve(str('DB_PATH', 'data/bot.db')),
    timezone: str('TZ_DISPLAY', 'America/Sao_Paulo'),
    log: { level: str('LOG_LEVEL', 'info') as Level, file: optional('LOG_FILE') },
  };
}
