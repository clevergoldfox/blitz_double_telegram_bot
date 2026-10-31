PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Todo giro confirmado do Double. Guardamos para sempre: e esse historico que
-- torna possivel o backtest de um padrao novo.
CREATE TABLE IF NOT EXISTS results (
  round_id   TEXT PRIMARY KEY,
  color      TEXT NOT NULL CHECK (color IN ('P','A','B')),
  roll       INTEGER,
  created_at TEXT NOT NULL,
  live       INTEGER NOT NULL DEFAULT 1,
  seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_results_created ON results (created_at);

CREATE TABLE IF NOT EXISTS patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  expr        TEXT NOT NULL,
  entry_color TEXT NOT NULL CHECK (entry_color IN ('P','A','B')),
  gales       INTEGER NOT NULL CHECK (gales BETWEEN 0 AND 2),
  white_rule  TEXT NOT NULL CHECK (white_rule IN ('gale','red','protect')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS signals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id       INTEGER NOT NULL REFERENCES patterns (id) ON DELETE CASCADE,
  trigger_round_id TEXT NOT NULL,
  entry_color      TEXT NOT NULL CHECK (entry_color IN ('P','A','B')),
  gales_allowed    INTEGER NOT NULL,
  white_rule       TEXT NOT NULL,
  current_gale     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','green','red')),
  resolved_gale    INTEGER,
  won_on_white     INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_pattern ON signals (pattern_id, status);

-- Trava de reentrancia no proprio banco: um padrao nunca pode ter dois sinais
-- abertos ao mesmo tempo. Sem isso, uma sequencia que se sobrepoe a si mesma
-- (PPAPA, por exemplo) dispararia alertas duplicados em cascata.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_one_open
  ON signals (pattern_id) WHERE status = 'open';

-- Cada tentativa de um sinal (entrada, G1, G2) com o resultado que saiu.
CREATE TABLE IF NOT EXISTS signal_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id  INTEGER NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  gale       INTEGER NOT NULL,
  round_id   TEXT NOT NULL,
  color      TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('win','loss','white')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_signal ON signal_events (signal_id);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
