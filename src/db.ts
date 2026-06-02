import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DATA_DIR, DB_PATH } from './config.ts';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    created_at  TEXT NOT NULL,
    created_by  TEXT
  );

  CREATE TABLE IF NOT EXISTS participants (
    link_id   TEXT NOT NULL,
    label     TEXT NOT NULL,
    agent     TEXT,
    repo      TEXT,
    branch    TEXT,
    cwd       TEXT,
    joined_at TEXT,
    last_seen TEXT,
    PRIMARY KEY (link_id, label)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    from_label TEXT NOT NULL,
    agent      TEXT,
    branch     TEXT,
    body       TEXT NOT NULL,
    reply_to   INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_link ON messages (link_id, seq);

  -- Incremental tail state for each indexed JSONL log file.
  CREATE TABLE IF NOT EXISTS idx_files (
    path       TEXT PRIMARY KEY,
    offset     INTEGER NOT NULL DEFAULT 0,
    size       INTEGER,
    mtime_ms   INTEGER,
    session_id TEXT,
    cwd        TEXT,
    repo       TEXT,
    branch     TEXT,
    agent      TEXT,
    updated_at TEXT
  );

  -- Full-text index over conversation turns from both CLIs.
  CREATE VIRTUAL TABLE IF NOT EXISTS transcripts USING fts5 (
    text,
    path       UNINDEXED,
    source     UNINDEXED,
    session_id UNINDEXED,
    agent      UNINDEXED,
    repo       UNINDEXED,
    branch     UNINDEXED,
    cwd        UNINDEXED,
    role       UNINDEXED,
    ts         UNINDEXED,
    tokenize = 'porter unicode61'
  );
`);
