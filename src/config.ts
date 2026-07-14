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

/** Bind address: SONAR_HOST env > loopback. Set SONAR_HOST=0.0.0.0 to expose on the LAN. */
export const HOST = process.env.SONAR_HOST || '127.0.0.1';
/** Address LOCAL clients (this machine's CLI / menu bar / Claude registration) dial. When HOST is a
 *  LAN bind like 0.0.0.0, local clients still reach the hub over loopback (0.0.0.0 includes it), and
 *  0.0.0.0 is not a valid *connect* target — so local URLs always use loopback. Remote teammates use
 *  the machine's LAN IP instead (see `sonar invite`). */
export const LOCAL_HOST = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost' ? HOST : '127.0.0.1';
export const DEFAULT_PORT = 7610;

function persistedPort(): number | undefined {
  try {
    const p = Number(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).port);
    return Number.isInteger(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

function persistedToken(): string | undefined {
  try {
    const t = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).token;
    return typeof t === 'string' && t.length ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the port: SONAR_PORT env > ~/.sonar/config.json > default. */
export const PORT = Number(process.env.SONAR_PORT) || persistedPort() || DEFAULT_PORT;
// urlFor/BASE_URL/MCP_URL are for LOCAL display + registration, so they use LOCAL_HOST (loopback) —
// the bundled CLI / menu bar / local Claude registration always talk to the hub on this machine.
// (The server still BINDS to HOST; only the *connect* URLs are loopback.)
export const urlFor = (port: number) => `http://${LOCAL_HOST}:${port}/mcp`;
export const BASE_URL = `http://${LOCAL_HOST}:${PORT}`;
export const MCP_URL = `${BASE_URL}/mcp`;

/** True for a hostname that means "this machine only" (loopback). */
export function isLoopbackHost(h: string): boolean {
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/** True for a socket remote address that is loopback — handles the IPv4-mapped IPv6 form too. */
export function isLoopbackAddr(addr?: string): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

/** When HOST is non-loopback the hub is reachable from other machines, so auth applies. */
export const LAN_MODE = !isLoopbackHost(HOST);

/**
 * Whether remote (non-loopback) callers may hit the code-exec surface (spawn/kill/wake/...).
 * Parsed as a real boolean: only 1/true/yes/on enable it. Plain truthiness would treat
 * SONAR_ALLOW_REMOTE_EXEC=0 (or =false) as ENABLED — the opposite of what an operator means.
 */
export function allowRemoteExec(): boolean {
  const v = (process.env.SONAR_ALLOW_REMOTE_EXEC || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Shared access token: SONAR_TOKEN env > `token` in ~/.sonar/config.json > none.
 * Mutable so the daemon can generate + install one at boot in LAN mode (see setToken).
 * Read it LIVE via getToken() — never capture it as a const at module load.
 */
export let TOKEN: string | undefined = process.env.SONAR_TOKEN || persistedToken() || undefined;
export function getToken(): string | undefined {
  return TOKEN;
}
export function setToken(t: string): void {
  TOKEN = t;
}

/**
 * "Exposed" mode: the hub is reachable by remote callers through a tunnel (cloudflared/ngrok) or a
 * LAN bind. A tunnel forwards external traffic to loopback, so it is indistinguishable from a local
 * call at the socket level — therefore in exposed mode the loopback auth exemption is DROPPED and
 * every caller must present a valid token. Starts from SONAR_EXPOSED; `sonar tunnel` toggles it live.
 */
let EXPOSED = process.env.SONAR_EXPOSED === '1' || LAN_MODE;
export function isExposed(): boolean {
  return EXPOSED;
}
export function setExposed(v: boolean): void {
  EXPOSED = v;
}

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

/** Hard cap on how long /api/nudge may hold a Stop hook's turn open awaiting a peer reply. */
export const MAX_NUDGE_HOLD_MS = 900_000;
