import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { CLAUDE_PROJECTS, CODEX_SESSIONS, INDEX_DAYS, INDEX_POLL_MS, MAX_TEXT } from './config.ts';

// ---------------------------------------------------------------------------
// git-root / repo detection, memoised per cwd
// ---------------------------------------------------------------------------
const repoCache = new Map<string, string | null>();
export function repoForCwd(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;
  let dir = cwd;
  let found: string | null = null;
  for (let i = 0; i < 30; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        found = path.basename(dir);
        break;
      }
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const repo = found ?? path.basename(cwd);
  repoCache.set(cwd, repo);
  return repo;
}

// ---------------------------------------------------------------------------
// text extraction
// ---------------------------------------------------------------------------
function collectText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object') {
        const t = block.type;
        if ((t === 'text' || t === 'input_text' || t === 'output_text') && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

type Turn = { role: string; text: string; ts?: string };
type FileMeta = { session_id?: string; cwd?: string; branch?: string; agent: 'claude' | 'codex' };

// Parse one Claude Code transcript line. Each line carries its own metadata.
function parseClaudeLine(obj: any, meta: FileMeta): Turn | null {
  if (obj.cwd) meta.cwd = obj.cwd;
  if (obj.gitBranch) meta.branch = obj.gitBranch;
  if (obj.sessionId) meta.session_id = obj.sessionId;
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg) return null;
  const text = collectText(msg.content).trim();
  if (!text) return null;
  return { role: msg.role || obj.type, text, ts: obj.timestamp };
}

// Parse one Codex rollout line. Session metadata arrives in session_meta/turn_context.
function parseCodexLine(obj: any, meta: FileMeta): Turn | null {
  const type = obj.type;
  const payload = obj.payload || {};
  if (type === 'session_meta') {
    if (payload.id) meta.session_id = payload.id;
    if (payload.cwd) meta.cwd = payload.cwd;
    return null;
  }
  if (type === 'turn_context') {
    if (payload.cwd) meta.cwd = payload.cwd;
    return null;
  }
  if (type === 'response_item' && payload.type === 'message') {
    const text = collectText(payload.content).trim();
    if (!text) return null;
    return { role: payload.role || 'assistant', text, ts: obj.timestamp };
  }
  return null;
}

// ---------------------------------------------------------------------------
// incremental file tailing
// ---------------------------------------------------------------------------
const insertTurn = db.prepare(
  `INSERT INTO transcripts (text, path, source, session_id, agent, repo, branch, cwd, role, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function loadFileState(p: string): { offset: number; meta: FileMeta } | null {
  const row = db.prepare('SELECT offset, session_id, cwd, branch, agent FROM idx_files WHERE path = ?').get(p) as any;
  if (!row) return null;
  return {
    offset: row.offset ?? 0,
    meta: { session_id: row.session_id, cwd: row.cwd, branch: row.branch, agent: (row.agent as any) || 'claude' },
  };
}

function saveFileState(p: string, offset: number, size: number, mtimeMs: number, meta: FileMeta) {
  const repo = repoForCwd(meta.cwd);
  db.prepare(
    `INSERT INTO idx_files (path, offset, size, mtime_ms, session_id, cwd, repo, branch, agent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       offset=excluded.offset, size=excluded.size, mtime_ms=excluded.mtime_ms,
       session_id=COALESCE(excluded.session_id, idx_files.session_id),
       cwd=COALESCE(excluded.cwd, idx_files.cwd),
       repo=COALESCE(excluded.repo, idx_files.repo),
       branch=COALESCE(excluded.branch, idx_files.branch),
       agent=excluded.agent, updated_at=excluded.updated_at`
  ).run(p, offset, size, Math.floor(mtimeMs), meta.session_id ?? null, meta.cwd ?? null, repo, meta.branch ?? null, meta.agent, new Date().toISOString());
}

function indexFile(p: string, agent: 'claude' | 'codex', mtimeMs: number) {
  let state = loadFileState(p);
  const meta: FileMeta = state?.meta ?? { agent };
  meta.agent = agent;
  let offset = state?.offset ?? 0;

  let fd: number;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) {
      // file truncated/rotated — drop its rows and re-read from scratch
      db.prepare('DELETE FROM transcripts WHERE path = ?').run(p);
      offset = 0;
    }
    if (size <= offset) return;

    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, offset);

    // Work in BYTES, not characters: offset is a byte position, and transcripts
    // contain multi-byte UTF-8 (emoji, accents). Find the last newline byte so we
    // only decode complete lines and advance the offset by the exact byte count.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return; // no complete line yet
    const complete = buf.subarray(0, lastNl).toString('utf8');
    const consumed = lastNl + 1; // bytes consumed (newline can't be part of a multi-byte char)

    const parse = agent === 'claude' ? parseClaudeLine : parseCodexLine;
    const turns: Turn[] = [];
    for (const line of complete.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let obj: any;
      try {
        obj = JSON.parse(s);
      } catch {
        continue;
      }
      const turn = parse(obj, meta);
      if (turn) turns.push(turn);
    }

    const repo = repoForCwd(meta.cwd);
    const write = db.prepare('BEGIN');
    write.run();
    try {
      for (const t of turns) {
        insertTurn.run(
          t.text.slice(0, MAX_TEXT),
          p,
          agent,
          meta.session_id ?? null,
          agent,
          repo,
          meta.branch ?? null,
          meta.cwd ?? null,
          t.role,
          t.ts ?? null
        );
      }
      saveFileState(p, offset + consumed, size, mtimeMs, meta);
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// directory scanning
// ---------------------------------------------------------------------------
function listClaudeFiles(): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const dir = path.join(CLAUDE_PROJECTS, proj);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

function listCodexFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(CODEX_SESSIONS, 0);
  return out;
}

let scanning = false;
function scanOnce() {
  if (scanning) return;
  scanning = true;
  const cutoff = Date.now() - INDEX_DAYS * 86_400_000;
  try {
    const jobs: Array<{ p: string; agent: 'claude' | 'codex'; mtimeMs: number }> = [];
    for (const p of listClaudeFiles()) jobs.push({ p, agent: 'claude', mtimeMs: 0 });
    for (const p of listCodexFiles()) jobs.push({ p, agent: 'codex', mtimeMs: 0 });
    for (const job of jobs) {
      let st: fs.Stats;
      try {
        st = fs.statSync(job.p);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      job.mtimeMs = st.mtimeMs;
      try {
        indexFile(job.p, job.agent, job.mtimeMs);
      } catch (e) {
        console.error(`[indexer] ${job.p}: ${(e as Error).message}`);
      }
    }
  } finally {
    scanning = false;
  }
}

export function startIndexer() {
  // defer the first (potentially large) backfill so the server answers requests immediately
  setTimeout(scanOnce, 150).unref();
  setInterval(scanOnce, INDEX_POLL_MS).unref();
}

/** Wipe and rebuild the transcript index from scratch (bounded by INDEX_DAYS). */
export function reindexAll() {
  db.exec('DELETE FROM transcripts; DELETE FROM idx_files;');
  scanOnce();
}
