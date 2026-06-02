import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

/** Where sonar keeps its db, pidfile and logs. Override with SONAR_DIR. */
export const DATA_DIR = process.env.SONAR_DIR || path.join(HOME, '.sonar');
export const DB_PATH = path.join(DATA_DIR, 'sonar.db');
export const PID_PATH = path.join(DATA_DIR, 'daemon.pid');
export const LOG_PATH = path.join(DATA_DIR, 'daemon.log');
/** Persisted runtime config (currently just the chosen port) — source of truth across hub/CLI/menu bar. */
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 7610;

function persistedPort(): number | undefined {
  try {
    const p = Number(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).port);
    return Number.isInteger(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the port: SONAR_PORT env > ~/.sonar/config.json > default. */
export const PORT = Number(process.env.SONAR_PORT) || persistedPort() || DEFAULT_PORT;
export const urlFor = (port: number) => `http://${HOST}:${port}/mcp`;
export const BASE_URL = `http://${HOST}:${PORT}`;
export const MCP_URL = `${BASE_URL}/mcp`;

export const VERSION = '0.1.0';

/** Transcript sources to index. */
export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
export const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');

/** Only index session logs modified within this many days (bounds first-run backfill). */
export const INDEX_DAYS = Number(process.env.SONAR_INDEX_DAYS || 45);
/** How often the indexer rescans logs, in ms. */
export const INDEX_POLL_MS = Number(process.env.SONAR_INDEX_POLL_MS || 4000);
/** Cap a single indexed text row to keep the FTS index lean. */
export const MAX_TEXT = 8000;

/** Default long-poll window for `wait` (kept under typical MCP client timeouts). */
export const DEFAULT_WAIT_MS = 25_000;
export const MAX_WAIT_MS = 110_000;
