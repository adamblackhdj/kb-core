"use strict";
/**
 * Single source of truth for the local KB SQLite schema.
 *
 * Used by:
 *   - scripts/kb.js::initDb                 (read-path bootstrap when the DB
 *                                            file already exists)
 *   - scripts/sync-from-clickup.js::rebuildDatabase
 *                                           (full rebuild inside a tmp file
 *                                            that's later renamed over the
 *                                            live DB)
 *
 * Previously each call site had its own CREATE TABLE block and they drifted
 * (AUTOINCREMENT, entries_updated_at trigger, entries_history presence).
 * Keep all schema changes here.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  category        TEXT,
  clickup_page_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS entry_relations (
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  note       TEXT,
  PRIMARY KEY (entry_id, related_id)
);

-- Versioned snapshot of entry content. One row per detected change.
-- entry_id is intentionally NOT a foreign key - we want to retain history
-- rows for entries that have since been deleted from ClickUp.
CREATE TABLE IF NOT EXISTS entries_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL,
  clickup_page_id TEXT,
  title           TEXT,
  body            TEXT,
  category        TEXT,
  tags            TEXT,
  change_type     TEXT NOT NULL CHECK (change_type IN ('created','updated','deleted')),
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_entry_id  ON entries_history(entry_id);
CREATE INDEX IF NOT EXISTS idx_history_synced_at ON entries_history(synced_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
  USING fts5(title, body, content=entries, content_rowid=id, tokenize='porter ascii');

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
`;

/**
 * Apply the shared schema to a DatabaseSync handle. Idempotent
 * (everything is CREATE ... IF NOT EXISTS).
 */
function applySchema(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = { SCHEMA_SQL, applySchema };
