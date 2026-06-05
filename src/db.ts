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

  -- Resource leases: an agent claims a file/dir/label so peers avoid clobbering it.
  -- released_at IS NULL && expires_at > now() == active. Expiry is lazy (filtered in queries).
  CREATE TABLE IF NOT EXISTS claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id     TEXT NOT NULL,
    resource    TEXT NOT NULL,
    holder      TEXT NOT NULL,
    agent       TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    released_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_claims_link ON claims (link_id, released_at, expires_at);

  -- Shared task board: lightweight todo/doing/done/blocked coordination per link.
  -- num is a per-link human number (like messages.seq).
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id     TEXT NOT NULL,
    num         INTEGER NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'todo',
    assignee    TEXT,
    note        TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deps        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_link ON tasks (link_id, num);

  -- Latest git snapshot each participant reports. Agent-reported (not hub-derived) so it
  -- works cross-machine — the hub can't see a remote teammate's working tree.
  CREATE TABLE IF NOT EXISTS git_state (
    link_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    branch     TEXT,
    head_sha   TEXT,
    upstream   TEXT,
    ahead      INTEGER,
    behind     INTEGER,
    changed    INTEGER,
    files      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (link_id, label)
  );

  -- Per-member access tokens for remote (tunnel/LAN) callers. Only the sha-256 HASH is stored,
  -- never the secret. revoked_at IS NULL == active. The single env/config SONAR_TOKEN still works
  -- alongside these as the "admin" token.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at  TEXT
  );

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

// Idempotent migrations for columns added after a table first shipped (CREATE TABLE IF NOT
// EXISTS won't alter an existing table). Each ALTER throws "duplicate column" once applied —
// swallow that so startup stays clean on an already-migrated db.
for (const stmt of ['ALTER TABLE tasks ADD COLUMN deps TEXT']) {
  try {
    db.exec(stmt);
  } catch {
    /* column already present */
  }
}
