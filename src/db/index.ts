import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = DatabaseSync;

/**
 * Abre o banco e aplica o schema. O schema e idempotente (tudo IF NOT EXISTS),
 * portanto roda em toda inicializacao sem precisar de ferramenta de migracao.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const schemaPath = join(__dirname, 'schema.sql');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

export function getMeta(db: Db, k: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
  return row ? row.v : null;
}

export function setMeta(db: Db, k: string, v: string): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}
