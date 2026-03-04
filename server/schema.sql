CREATE TABLE IF NOT EXISTS atoms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  ts TEXT NOT NULL,
  due TEXT,
  urgency REAL NOT NULL,
  importance REAL NOT NULL,
  title TEXT,
  preview TEXT,
  payload TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atoms_ts ON atoms(ts DESC);
CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
CREATE INDEX IF NOT EXISTS idx_atoms_state ON atoms(state);

CREATE TABLE IF NOT EXISTS logogram_dictionary (
  id TEXT PRIMARY KEY,
  phrase TEXT NOT NULL UNIQUE,
  canonical_key TEXT NOT NULL UNIQUE,
  segment_mask INTEGER NOT NULL,
  style TEXT NOT NULL DEFAULT '{}',
  language TEXT NOT NULL DEFAULT 'heptapod_b_v1',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logogram_dictionary_language_active
ON logogram_dictionary(language, is_active);
