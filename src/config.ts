import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

/** Where sonar keeps its db, pidfile and logs. Override with SONAR_DIR. */
export const DATA_DIR = process.env.SONAR_DIR || path.join(HOME, '.sonar');
export const DB_PATH = path.join(DATA_DIR, 'sonar.db');
export const PID_PATH = path.join(DATA_DIR, 'daemon.pid');
export const LOG_PATH = path.join(DATA_DIR, 'daemon.log');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.SONAR_PORT || 7610);
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
