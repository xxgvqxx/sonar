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
              (SELECT MAX(seq) FROM messages m WHERE m.link_id = l.id) AS last_seq,
              (SELECT GROUP_CONCAT(label, ', ') FROM participants p WHERE p.link_id = l.id) AS participants,
              (SELECT GROUP_CONCAT(DISTINCT agent) FROM participants p WHERE p.link_id = l.id) AS agents
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

/**
 * How many messages on `linkId` are unread for participant `label`, relative to
 * their wait() read-cursor (which only wait() advances). Does NOT mutate the
 * cursor. Used to piggyback a "you have N unread" nudge onto other tool responses
 * so a busy agent that isn't sitting in a wait() loop still learns the other replied.
 */
export function unreadFor(linkId: string, label: string): { count: number; lastSeq: number; after: number; from: string[] } {
  const after = cursors.get(`${linkId}:${label}`) ?? 0;
  const rows = readMessages({ linkId, sinceSeq: after, excludeFrom: label });
  const from = [...new Set(rows.map((r) => r.from_label as string))];
  const lastSeq = rows.length ? Math.max(...rows.map((r) => r.seq as number)) : after;
  return { count: rows.length, lastSeq, after, from };
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

// ---------------------------------------------------------------------------
// Resource claims (leases) — keep two agents off the same file/dir.
// ---------------------------------------------------------------------------
/** Normalise a resource string: trim, forward-slashes, no trailing slash (except root). */
function normResource(r: string): string {
  const t = r.trim().replace(/\\/g, '/');
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

/** Two resources conflict if equal, or one is a path-prefix of the other (a dir covers its files). */
function resourcesOverlap(a: string, b: string): boolean {
  const x = normResource(a);
  const y = normResource(b);
  if (x === y) return true;
  if (x === '/' || y === '/') return true; // root covers everything beneath it
  return y.startsWith(x + '/') || x.startsWith(y + '/');
}

function getClaim(id: number) {
  return db.prepare('SELECT id, resource, holder, agent, note, created_at, expires_at FROM claims WHERE id = ?').get(id) as any;
}

/** Active (unreleased, unexpired) leases on a link. */
export function listClaims(linkId: string) {
  return db
    .prepare(
      `SELECT id, resource, holder, agent, note, created_at, expires_at
       FROM claims WHERE link_id = ? AND released_at IS NULL AND expires_at > ?
       ORDER BY created_at`
    )
    .all(linkId, now()) as any[];
}

/**
 * Acquire (or extend) a lease. Returns {ok:false, conflicts} when another holder has an
 * overlapping active lease and steal is not set; otherwise {ok:true, claim, extended?, stole}.
 */
export function claimResource(opts: {
  linkId: string;
  resource: string;
  holder: string;
  agent?: string;
  ttlMin?: number;
  note?: string;
  steal?: boolean;
}) {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}".`);
  const resource = normResource(opts.resource);
  if (!resource) throw new Error('resource is required');
  const ttl = Math.min(Math.max(opts.ttlMin ?? 30, 1), 240);
  const ts = now();
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

  const active = listClaims(opts.linkId);
  const blocking = active.filter((c) => c.holder !== opts.holder && resourcesOverlap(c.resource, resource));
  if (blocking.length && !opts.steal) return { ok: false as const, conflicts: blocking };

  const stole: any[] = [];
  if (blocking.length && opts.steal) {
    for (const c of blocking) {
      db.prepare('UPDATE claims SET released_at = ? WHERE id = ?').run(ts, c.id);
      stole.push(c);
    }
  }

  // Re-claiming your own exact resource extends it rather than stacking duplicates.
  const mine = active.find((c) => c.holder === opts.holder && normResource(c.resource) === resource);
  if (mine) {
    db.prepare('UPDATE claims SET expires_at = ?, note = COALESCE(?, note) WHERE id = ?').run(expiresAt, opts.note ?? null, mine.id);
    touchParticipant(opts.linkId, { label: opts.holder, agent: opts.agent });
    return { ok: true as const, claim: getClaim(mine.id), extended: true, stole };
  }
  const info = db
    .prepare('INSERT INTO claims (link_id, resource, holder, agent, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(opts.linkId, resource, opts.holder, opts.agent ?? null, opts.note ?? null, ts, expiresAt);
  touchParticipant(opts.linkId, { label: opts.holder, agent: opts.agent });
  return { ok: true as const, claim: getClaim(Number(info.lastInsertRowid)), stole };
}

export function releaseClaim(opts: { linkId: string; resource: string; holder: string }) {
  const resource = normResource(opts.resource);
  const ts = now();
  const mine = listClaims(opts.linkId).filter((c) => c.holder === opts.holder && normResource(c.resource) === resource);
  for (const c of mine) db.prepare('UPDATE claims SET released_at = ? WHERE id = ?').run(ts, c.id);
  return { released: mine.length };
}

// ---------------------------------------------------------------------------
// Shared task board
// ---------------------------------------------------------------------------
export const TASK_STATUS = ['todo', 'doing', 'done', 'blocked'] as const;

export function getTask(linkId: string, num: number) {
  return db
    .prepare('SELECT num, title, status, assignee, note, created_by, created_at, updated_at FROM tasks WHERE link_id = ? AND num = ?')
    .get(linkId, num) as any;
}

export function listTasks(opts: { linkId: string; status?: string }) {
  if (opts.status) {
    return db
      .prepare('SELECT num, title, status, assignee, note, updated_at FROM tasks WHERE link_id = ? AND status = ? ORDER BY num')
      .all(opts.linkId, opts.status) as any[];
  }
  return db.prepare('SELECT num, title, status, assignee, note, updated_at FROM tasks WHERE link_id = ? ORDER BY num').all(opts.linkId) as any[];
}

export function createTask(opts: { linkId: string; title: string; assignee?: string; note?: string; by?: string }) {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}".`);
  if (!opts.title?.trim()) throw new Error('title is required');
  const ts = now();
  const numRow = db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS next FROM tasks WHERE link_id = ?').get(opts.linkId) as any;
  const num = numRow.next as number;
  db.prepare(
    `INSERT INTO tasks (link_id, num, title, status, assignee, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?)`
  ).run(opts.linkId, num, opts.title.trim(), opts.assignee ?? null, opts.note ?? null, opts.by ?? null, ts, ts);
  return getTask(opts.linkId, num);
}

export function updateTask(opts: { linkId: string; num: number; status?: string; assignee?: string; note?: string }) {
  const task = getTask(opts.linkId, opts.num);
  if (!task) throw new Error(`No task #${opts.num} on ${opts.linkId}.`);
  if (opts.status && !TASK_STATUS.includes(opts.status as any)) throw new Error(`status must be one of: ${TASK_STATUS.join(', ')}`);
  db.prepare(
    `UPDATE tasks SET status = COALESCE(?, status), assignee = COALESCE(?, assignee), note = COALESCE(?, note), updated_at = ?
     WHERE link_id = ? AND num = ?`
  ).run(opts.status ?? null, opts.assignee ?? null, opts.note ?? null, now(), opts.linkId, opts.num);
  return getTask(opts.linkId, opts.num);
}

// ---------------------------------------------------------------------------
// Git presence — each participant reports its own tree (works cross-machine).
// ---------------------------------------------------------------------------
export function listGitState(linkId: string) {
  return db
    .prepare('SELECT label, branch, head_sha, upstream, ahead, behind, changed, files, updated_at FROM git_state WHERE link_id = ? ORDER BY updated_at DESC')
    .all(linkId) as any[];
}

export function setGitState(opts: {
  linkId: string;
  label: string;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changed?: number;
  files?: string[];
}) {
  if (!linkExists(opts.linkId)) throw new Error(`No link with id "${opts.linkId}".`);
  const files = opts.files && opts.files.length ? JSON.stringify(opts.files.slice(0, 20)) : null;
  db.prepare(
    `INSERT INTO git_state (link_id, label, branch, head_sha, upstream, ahead, behind, changed, files, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_id, label) DO UPDATE SET
       branch = excluded.branch, head_sha = excluded.head_sha, upstream = excluded.upstream,
       ahead = excluded.ahead, behind = excluded.behind, changed = excluded.changed,
       files = excluded.files, updated_at = excluded.updated_at`
  ).run(
    opts.linkId,
    opts.label,
    opts.branch ?? null,
    opts.head ?? null,
    opts.upstream ?? null,
    opts.ahead ?? null,
    opts.behind ?? null,
    opts.changed ?? null,
    files,
    now()
  );
  touchParticipant(opts.linkId, { label: opts.label, branch: opts.branch });
  return listGitState(opts.linkId);
}

export function deleteLink(linkId: string) {
  db.prepare('DELETE FROM messages WHERE link_id = ?').run(linkId);
  db.prepare('DELETE FROM participants WHERE link_id = ?').run(linkId);
  db.prepare('DELETE FROM claims WHERE link_id = ?').run(linkId);
  db.prepare('DELETE FROM tasks WHERE link_id = ?').run(linkId);
  db.prepare('DELETE FROM git_state WHERE link_id = ?').run(linkId);
  const info = db.prepare('DELETE FROM links WHERE id = ?').run(linkId);
  // Release any parked long-poll waiters and prune their read-cursors, so repeated
  // create/delete churn doesn't grow these in-memory maps without bound.
  const set = waiters.get(linkId);
  if (set) {
    for (const w of [...set]) w.resolve();
    waiters.delete(linkId);
  }
  for (const key of [...cursors.keys()]) if (key.startsWith(`${linkId}:`)) cursors.delete(key);
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
