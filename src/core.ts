import crypto from 'node:crypto';
import { db } from './db.ts';
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from './config.ts';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Identity passed by a caller (Claude/Codex session) on most calls.
// ---------------------------------------------------------------------------
export type Who = {
  label: string;
  agent?: string;
  repo?: string;
  branch?: string;
  cwd?: string;
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // no i/l/o/u — unambiguous

function newId(len = 4): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let id = '';
    for (let i = 0; i < len; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    const exists = db.prepare('SELECT 1 FROM links WHERE id = ?').get(id);
    if (!exists) return id;
  }
  return newId(len + 1); // widen on repeated collisions
}

function touchParticipant(linkId: string, who: Who) {
  const ts = now();
  db.prepare(
    `INSERT INTO participants (link_id, label, agent, repo, branch, cwd, joined_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_id, label) DO UPDATE SET
       agent = COALESCE(excluded.agent, agent),
       repo = COALESCE(excluded.repo, repo),
       branch = COALESCE(excluded.branch, branch),
       cwd = COALESCE(excluded.cwd, cwd),
       last_seen = excluded.last_seen`
  ).run(linkId, who.label, who.agent ?? null, who.repo ?? null, who.branch ?? null, who.cwd ?? null, ts, ts);
}

export function createLink(opts: { title?: string; who: Who }) {
  const id = newId();
  db.prepare('INSERT INTO links (id, title, created_at, created_by) VALUES (?, ?, ?, ?)').run(
    id,
    opts.title ?? null,
    now(),
    opts.who.label
  );
  touchParticipant(id, opts.who);
  return { id, title: opts.title ?? null };
}

export function linkExists(linkId: string): boolean {
  return !!db.prepare('SELECT 1 FROM links WHERE id = ?').get(linkId);
}

export function joinLink(opts: { linkId: string; who: Who }) {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}". Ask the other session for the code, or create one.`);
  touchParticipant(opts.linkId, opts.who);
  return {
    link: getLink(opts.linkId),
    participants: listParticipants(opts.linkId),
    recent: readMessages({ linkId: opts.linkId, limit: 20 }),
  };
}

export function getLink(linkId: string) {
  return db.prepare('SELECT id, title, created_at, created_by FROM links WHERE id = ?').get(linkId) as any;
}

export function listParticipants(linkId: string) {
  return db
    .prepare('SELECT label, agent, repo, branch, cwd, last_seen FROM participants WHERE link_id = ? ORDER BY last_seen DESC')
    .all(linkId) as any[];
}

export function listLinks(opts: { activeDays?: number } = {}) {
  const rows = db
    .prepare(
      `SELECT l.id, l.title, l.created_at,
              (SELECT MAX(created_at) FROM messages m WHERE m.link_id = l.id) AS last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.link_id = l.id) AS message_count,
              (SELECT GROUP_CONCAT(label, ', ') FROM participants p WHERE p.link_id = l.id) AS participants
       FROM links l
       ORDER BY COALESCE(last_message_at, created_at) DESC
       LIMIT 50`
    )
    .all() as any[];
  if (opts.activeDays) {
    const cutoff = new Date(Date.now() - opts.activeDays * 86_400_000).toISOString();
    return rows.filter((r) => (r.last_message_at ?? r.created_at) >= cutoff);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Messages + long-poll waiter registry
// ---------------------------------------------------------------------------
type Waiter = { from?: string; resolve: () => void };
const waiters = new Map<string, Set<Waiter>>();
// Per-participant read cursor: `${linkId}:${label}` -> highest seq already delivered to them.
// Lets wait(from=X) with no after_seq advance naturally instead of re-returning the whole backlog.
const cursors = new Map<string, number>();

function wake(linkId: string, fromLabel: string) {
  const set = waiters.get(linkId);
  if (!set) return;
  for (const w of [...set]) {
    if (w.from && w.from === fromLabel) continue; // don't wake a session on its own message
    set.delete(w);
    w.resolve();
  }
  if (set.size === 0) waiters.delete(linkId);
}

export function postMessage(opts: {
  linkId: string;
  from: string;
  body: string;
  agent?: string;
  branch?: string;
  replyTo?: number;
}) {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}".`);
  const ts = now();
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE link_id = ?').get(opts.linkId) as any;
  const seq = seqRow.next as number;
  const info = db
    .prepare(
      `INSERT INTO messages (link_id, seq, from_label, agent, branch, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(opts.linkId, seq, opts.from, opts.agent ?? null, opts.branch ?? null, opts.body, opts.replyTo ?? null, ts);
  // keep the sender registered/fresh even if they never formally joined
  touchParticipant(opts.linkId, { label: opts.from, agent: opts.agent, branch: opts.branch });
  wake(opts.linkId, opts.from);
  return { id: Number(info.lastInsertRowid), seq, created_at: ts };
}

export function readMessages(opts: { linkId: string; sinceSeq?: number; limit?: number; excludeFrom?: string }) {
  const since = opts.sinceSeq ?? 0;
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = db
    .prepare(
      `SELECT seq, from_label, agent, branch, body, reply_to, created_at
       FROM messages
       WHERE link_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(opts.linkId, since, limit) as any[];
  return opts.excludeFrom ? rows.filter((r) => r.from_label !== opts.excludeFrom) : rows;
}

/**
 * Long-poll: resolve as soon as a message newer than `afterSeq` (and not from
 * `from`) exists, otherwise wait up to `timeoutMs`.
 */
export async function waitForMessages(opts: {
  linkId: string;
  from?: string;
  afterSeq?: number;
  timeoutMs?: number;
}): Promise<{ messages: any[]; timedOut: boolean }> {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}".`);
  const key = opts.from ? `${opts.linkId}:${opts.from}` : null;
  // Default to the caller's read cursor so a wait() loop doesn't keep re-returning old messages.
  const afterSeq = opts.afterSeq ?? (key ? cursors.get(key) ?? 0 : 0);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);

  const advance = (msgs: any[]) => {
    if (key && msgs.length) cursors.set(key, Math.max(cursors.get(key) ?? 0, ...msgs.map((m) => m.seq)));
    return msgs;
  };
  const peek = () => readMessages({ linkId: opts.linkId, sinceSeq: afterSeq, excludeFrom: opts.from });

  const immediate = peek();
  if (immediate.length) return { messages: advance(immediate), timedOut: false };

  return new Promise((resolve) => {
    const set = waiters.get(opts.linkId) ?? new Set<Waiter>();
    waiters.set(opts.linkId, set);
    let done = false;
    const waiter: Waiter = {
      from: opts.from,
      resolve: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(waiter);
        if (set.size === 0) waiters.delete(opts.linkId);
        resolve({ messages: advance(peek()), timedOut: false });
      },
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      set.delete(waiter);
      if (set.size === 0) waiters.delete(opts.linkId);
      resolve({ messages: advance(peek()), timedOut: true });
    }, timeoutMs);
    set.add(waiter);
  });
}

// ---------------------------------------------------------------------------
// Transcript search (FTS5 over indexed Claude/Codex logs)
// ---------------------------------------------------------------------------
function ftsQuery(q: string): string | null {
  const toks = q.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!toks.length) return null;
  // quote each token (neutralises FTS operators) — implicit AND between them
  return toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

export function searchContext(opts: {
  query: string;
  branch?: string;
  repo?: string;
  agent?: string;
  sessionId?: string;
  sinceDays?: number;
  limit?: number;
}) {
  const match = ftsQuery(opts.query);
  if (!match) return [];
  const where: string[] = ['transcripts MATCH ?'];
  const params: any[] = [match];
  if (opts.branch) {
    where.push('branch = ?');
    params.push(opts.branch);
  }
  if (opts.repo) {
    where.push('repo = ?');
    params.push(opts.repo);
  }
  if (opts.agent) {
    where.push('agent = ?');
    params.push(opts.agent);
  }
  if (opts.sessionId) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.sinceDays) {
    where.push('ts >= ?');
    params.push(new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString());
  }
  const limit = Math.min(opts.limit ?? 12, 50);
  params.push(limit);
  return db
    .prepare(
      `SELECT snippet(transcripts, 0, '«', '»', '…', 18) AS excerpt,
              agent, repo, branch, cwd, role, ts, session_id, source,
              bm25(transcripts) AS score
       FROM transcripts
       WHERE ${where.join(' AND ')}
       ORDER BY bm25(transcripts)
       LIMIT ?`
    )
    .all(...params) as any[];
}

export function recentSessions(opts: { repo?: string; branch?: string; agent?: string; limit?: number }) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.repo) {
    where.push('repo = ?');
    params.push(opts.repo);
  }
  if (opts.branch) {
    where.push('branch = ?');
    params.push(opts.branch);
  }
  if (opts.agent) {
    where.push('agent = ?');
    params.push(opts.agent);
  }
  const limit = Math.min(opts.limit ?? 20, 100);
  params.push(limit);
  return db
    .prepare(
      `SELECT session_id, agent, repo, branch, cwd, MAX(updated_at) AS indexed_at
       FROM idx_files
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY session_id
       ORDER BY indexed_at DESC
       LIMIT ?`
    )
    .all(...params) as any[];
}

export function deleteLink(linkId: string) {
  db.prepare('DELETE FROM messages WHERE link_id = ?').run(linkId);
  db.prepare('DELETE FROM participants WHERE link_id = ?').run(linkId);
  const info = db.prepare('DELETE FROM links WHERE id = ?').run(linkId);
  return { deleted: Number(info.changes) > 0 };
}

export function stats() {
  const n = (sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    links: n('SELECT COUNT(*) AS n FROM links'),
    messages: n('SELECT COUNT(*) AS n FROM messages'),
    indexed_turns: n('SELECT COUNT(*) AS n FROM transcripts'),
    indexed_files: n('SELECT COUNT(*) AS n FROM idx_files'),
  };
}
