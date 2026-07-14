import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as core from './core.ts';
import * as docs from './docs.ts';
import { spawnWorker } from './spawn.ts';
import { runHook } from './hooks.ts';
import { fireWatches, autoWakePeers } from './watch.ts';
import * as autopilot from './autopilot.ts';
import { brief, formatBrief } from './brief.ts';
import path from 'node:path';
import { LAN_MODE, isLoopbackAddr, allowRemoteExec, DATA_DIR } from './config.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

// Piggyback a gentle "you have unread" nudge onto write-tool responses so a busy
// agent that isn't parked in a wait() loop still learns the other side replied.
function pending(linkId: string, label?: string): string {
  if (!label) return '';
  try {
    const u = core.unreadFor(linkId, label);
    if (!u.count) return '';
    return (
      `\n\n⚠️ ${u.count} unread message${u.count === 1 ? '' : 's'} on ${linkId}` +
      (u.from.length ? ` from ${u.from.join(', ')}` : '') +
      `. Call read(link_id="${linkId}", since_seq=${u.after}) or doc_read to catch up, then wait() to keep listening.`
    );
  } catch {
    return '';
  }
}

// Rebuild the doc's "Participants" section from the authoritative list (no dupes on re-join).
function syncParticipants(linkId: string) {
  const body = core
    .listParticipants(linkId)
    .map((p) => `- **${p.label}**${p.agent ? ` (${p.agent})` : ''}${p.cwd ? ` — ${p.cwd}` : ''}${p.branch ? ` @ ${p.branch}` : ''}`)
    .join('\n');
  docs.setSection(linkId, 'Participants', body);
}

function fmtTime(iso?: string) {
  if (!iso) return '';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Minutes until an ISO timestamp, as "23m" / "expired". */
function fmtMins(iso: string): string {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return m <= 0 ? 'expired' : `${m}m`;
}

// Rebuild the doc's coordination sections from the DB (replace, so they never bloat).
function syncClaims(linkId: string) {
  const rows = core.listClaims(linkId);
  const body = rows.length
    ? rows
        .map((c) => `- \`${c.resource}\` — **${c.holder}** · exp ${fmtTime(c.expires_at)} (${fmtMins(c.expires_at)})${c.note ? ` · ${c.note}` : ''}`)
        .join('\n')
    : '_(none — no active leases)_';
  docs.setSection(linkId, 'Claims', body);
}

const TASK_BADGE: Record<string, string> = { todo: '☐', doing: '▶', done: '✓', blocked: '⛔' };
function parseDeps(raw: unknown): number[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}
function syncTasks(linkId: string) {
  const rows = core.listTasks({ linkId });
  const done = new Set(rows.filter((t) => t.status === 'done').map((t) => t.num));
  const body = rows.length
    ? rows
        .map((t) => {
          const deps = parseDeps(t.deps);
          const pending = deps.filter((d) => !done.has(d));
          // Show what a blocked task is waiting on; otherwise just list its deps.
          const depStr = deps.length
            ? t.status === 'blocked' && pending.length
              ? ` · blocked on ${pending.map((n) => '#' + n).join(', ')}`
              : ` · deps ${deps.map((n) => '#' + n).join(', ')}`
            : '';
          return `- ${TASK_BADGE[t.status] ?? '·'} **#${t.num}** ${t.title} — ${t.status} · ${t.assignee || 'unassigned'}${depStr}${t.note ? `\n    ${t.note}` : ''}`;
        })
        .join('\n')
    : '_(no tasks yet)_';
  docs.setSection(linkId, 'Tasks', body);
}

// g.files is a JSON-stringified array written by setGitState — but parse defensively so a
// malformed/hand-edited/legacy row can never throw out of gitLine → syncGit → link_join/create.
function parseFiles(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function gitLine(g: any): string {
  const head = g.head_sha ? ` @ ${String(g.head_sha).slice(0, 7)}` : '';
  const track = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  const files = parseFiles(g.files);
  const line = `- **${g.label}** — \`${g.branch ?? '?'}\`${head}${track ? ` · ${track}` : ''}${g.changed != null ? ` · ${g.changed} changed` : ''} · ${fmtTime(g.updated_at)}`;
  return files.length ? `${line}\n    ${files.slice(0, 8).join(', ')}` : line;
}
function syncGit(linkId: string) {
  const rows = core.listGitState(linkId);
  docs.setSection(linkId, 'Git', rows.length ? rows.map(gitLine).join('\n') : '_(no git state reported)_');
}

function renderMessages(msgs: any[]): string {
  if (!msgs.length) return '(no messages)';
  return msgs
    .map((m) => {
      const tag = [m.agent, m.branch].filter(Boolean).join('/');
      const head = `[${m.seq}] ${m.from_label}${tag ? ` (${tag})` : ''} · ${fmtTime(m.created_at)}${m.reply_to ? ` · ↪${m.reply_to}` : ''}`;
      return `${head}\n${m.body}`;
    })
    .join('\n\n');
}

// identity fields shared by create/join
const ident = {
  label: z.string().describe('Your handle in this link, e.g. "claude@feature/auth" or "codex@main". Pick something that identifies this session.'),
  agent: z.string().optional().describe('Which CLI you are: "claude" or "codex".'),
  repo: z.string().optional().describe('Repo name for context.'),
  branch: z.string().optional().describe('Current git branch.'),
  cwd: z.string().optional().describe('Working directory.'),
};

// ---------------------------------------------------------------------------
// Self-describing capabilities directory (returned by the `sonar_help` tool).
// A single lookup an agent can call to orient itself. Keep these two tables in
// sync when tools change — they ARE the agent-facing decision guide.
// ---------------------------------------------------------------------------
const DECISION_MAP: [need: string, use: string][] = [
  ['start collaborating with another session', 'link_create (share the ID) — or link_join if you were given a code'],
  ['get an answer from another session', 'post() your question, then simply END YOUR TURN — sonar nudges/wakes you when the reply lands (wait() only if you want to stay on-line for an immediate back-and-forth)'],
  ['catch up after a ping, or before you start working', 'doc_read (compact by default) — or read(since_seq=…, from=<your label>) for just new messages'],
  ['contribute context / ask a question / record an answer', 'doc_append(section="Context" | "Open questions" | "Answers")'],
  ['record a decision, or keep a bounded contract (API shape, types)', 'doc_set_section (replace = stays bounded, no append bloat)'],
  ['avoid clobbering a file the other session may also edit', 'claim(resource="path", from=…) BEFORE you edit it — release() when done'],
  ['split the work and track who is doing what', 'task_add then task_update(status="doing"|"done", assignee=you) — board shows in the doc "Tasks"'],
  ['order work so one task waits for another', 'task_add(depends_on=[#…]) — it starts blocked and auto-unblocks when those are done'],
  ["see the other session's branch / ahead-behind / changed files", 'git_sync(from=…, branch=…, ahead=…, behind=…, changed=…, files=[…])'],
  ['dispatch an autonomous subtask that reports back', 'spawn_worker(task=…)  — headless=true to run in the background'],
  ['be pinged/woken when something happens (an answer lands, a task finishes, a claim frees)', 'watch(event=…, arg?) — then go idle; the hub pings the link and wakes your tmux pane if it can'],
  ['have the hub EXECUTE the task board itself (spawn/wake per ready task)', 'autopilot(on=true, cwd=…) — finish tasks with task_update(status="done") and dependents dispatch automatically'],
  ['catch up on a repo at session start (last sessions, open questions, decisions, tasks)', 'brief(cwd=… or repo=…) — call it FIRST in a new session'],
  ['pull context from your OWN past Claude/Codex sessions', 'search_context(query=…, repo?/branch?/agent?)'],
  ['discover what links or sessions already exist', 'link_list / link_info / recent_sessions'],
];

const TOOL_GUIDE: { name: string; purpose: string; example: string }[] = [
  { name: 'link_create', purpose: 'mint a new link + shared doc; share the returned ID with the other session', example: 'link_create(label="claude@feat/auth", agent="claude", branch="feat/auth", cwd="…")' },
  { name: 'link_join', purpose: 'join an existing link by ID; returns participants + the compact doc', example: 'link_join(link_id="k7m2", label="codex@main", agent="codex")' },
  { name: 'link_list / link_info', purpose: 'discover links to join / inspect who is on one and recent activity', example: 'link_list()' },
  { name: 'doc_read', purpose: 'read the shared doc — compact by default; section="…" for one section; full=true for everything', example: 'doc_read(link_id="k7m2", section="Open questions")' },
  { name: 'doc_append', purpose: 'append to a section (Context / Open questions / Answers / Decisions) and ping waiters', example: 'doc_append(link_id="k7m2", section="Answers", from="claude@feat/auth", text="Q… → A…")' },
  { name: 'doc_set_section', purpose: 'replace a whole section — use for current-state (Decisions, the API contract) so it stays bounded', example: 'doc_set_section(link_id="k7m2", section="Decisions", text="…")' },
  { name: 'claim / release', purpose: 'lease a file/dir so the peer avoids clobbering you (path-overlap aware, auto-expiring; steal=true overrides a stale one). Shows in the doc "Claims"', example: 'claim(link_id="k7m2", resource="apps/web/api-client.ts", from="claude@feat/auth")' },
  { name: 'task_add / task_update', purpose: 'shared todo/doing/done board (in the doc "Tasks"); task_update to claim (status="doing", assignee=you) or finish (status="done"). task_add(depends_on=[#…]) makes a task wait — it auto-unblocks when its deps are done', example: 'task_add(link_id="k7m2", from="codex@main", title="Deploy", depends_on=[1,2])' },
  { name: 'git_sync', purpose: "report your branch / ahead-behind / changed files and get the peers' back — frontend⇄backend awareness. Shows in the doc \"Git\"", example: 'git_sync(link_id="k7m2", from="claude@feat/auth", branch="feat/auth", ahead=2, changed=3, files=["shared/types.ts"])' },
  { name: 'post', purpose: 'send a short "doc changed" / question ping to the other session; pair with wait', example: 'post(link_id="k7m2", from="claude@feat/auth", body="answered your Q in the doc")' },
  { name: 'read', purpose: 'read messages since a seq WITHOUT blocking (quick catch-up)', example: 'read(link_id="k7m2", since_seq=12)' },
  { name: 'wait', purpose: 'long-poll until a new message arrives (loop it); per-participant cursor advances automatically', example: 'wait(link_id="k7m2", from="claude@feat/auth")' },
  { name: 'search_context', purpose: 'full-text search YOUR indexed Claude + Codex history; filter by repo / branch / agent', example: 'search_context(query="rate limiting", repo="api")' },
  { name: 'recent_sessions', purpose: 'list recently indexed sessions to discover what context exists to search/link', example: 'recent_sessions(repo="api")' },
  { name: 'spawn_worker', purpose: 'launch a new claude/codex session in an isolated git worktree, pre-joined to the link, to work a task and report back into the doc', example: 'spawn_worker(link_id="k7m2", task="investigate X and answer the open question", headless=true)' },
  { name: 'watch / unwatch', purpose: 'subscribe to an event (message, task_done #N, task_ready, answer, question, release <path>) — when it fires the hub posts a targeted ping and wakes your tmux pane if possible. Register, then go idle instead of polling', example: 'watch(link_id="k7m2", from="claude@feat/auth", event="task_done", arg="3")' },
  { name: 'autopilot', purpose: 'turn the task board self-executing: every READY task is dispatched by the hub (assigned → wake that participant; unassigned → spawn a dedicated worker), capped, cascading through depends_on as tasks finish', example: 'autopilot(link_id="k7m2", from="claude@main", on=true, cwd="/path/to/repo", max=2, headless=true)' },
  { name: 'brief', purpose: 'session-start catch-up for a repo: recent sessions, the tail of the last conversation, and every active link\'s open tasks/claims/questions/decisions', example: 'brief(cwd="/path/to/repo")' },
];

export function registerTools(server: McpServer, opts: { remoteAddr?: string; relay?: boolean } = {}) {
  // In LAN mode, host-mutating tools are refused for remote callers unless explicitly allowed.
  // (Local/loopback agents on the hub machine are always permitted; default loopback mode is unaffected.)
  const remoteExecBlocked = () => (LAN_MODE && !isLoopbackAddr(opts.remoteAddr) && !allowRemoteExec()) || !!opts.relay;
  // A relay session (a remote teammate authenticated with a per-member token) may use the coordination
  // tools but NOT tools that read or run things on the hub host — its transcript index and its repos.
  const hostPrivateBlocked = () => !!opts.relay;
  const isRelay = !!opts.relay;

  server.registerTool(
    'sonar_help',
    {
      title: 'What can sonar do? (capabilities directory)',
      description:
        'Look up what sonar can do and which tool fits your situation. Returns a decision map ("if you need X → call Y") plus a one-line purpose + example for every sonar tool. Call this first if you are unsure how to coordinate with another Claude Code / Codex session.',
      inputSchema: {},
    },
    async () => {
      const map = DECISION_MAP.map(([need, use]) => `• if you need to ${need}\n    → ${use}`).join('\n');
      const guide = TOOL_GUIDE.map((t) => `${t.name}\n  ${t.purpose}\n  e.g. ${t.example}`).join('\n\n');
      return text(
        `sonar coordinates multiple Claude Code / Codex sessions through a per-link SHARED MARKDOWN DOC (the source of truth both agents + the human read and edit). post/wait are just "the doc changed" pings.\n\n` +
          `DECISION MAP\n${map}\n\n` +
          `TOOLS\n${guide}\n\n` +
          `NOTES\n` +
          `• Typical flow: link_create / link_join → doc_read → doc_append your context → post a ping → END YOUR TURN. You do NOT need to poll: sonar's nudge hook re-prompts you when new messages land (and its Stop-hold resumes you the instant a reply to your question arrives), and tmux panes are auto-woken on new activity. Put substantive content in the DOC, not just in pings.\n` +
          `• When you catch up, pass from=<your label> to read() (or use wait()) so sonar knows you've seen the messages — otherwise it keeps nudging you about them.\n` +
          `• When a collaboration is FINISHED, post a final "✅ done" so the other side stops holding for your reply.\n` +
          `• Coordination state lives in the doc too: claim/release → "Claims" section, task_add/task_update → "Tasks", git_sync → "Git". So a single doc_read shows who holds which files, the task board, and each side's git state. Before editing a shared file, claim() it; before picking up work, read the Tasks section.\n` +
          `• Tasks can depend on others: a task with unfinished deps is "blocked" and refuses doing/done until they complete; finishing a task auto-unblocks anything waiting only on it.\n` +
          `• Enforcement you may hit: marking a task "done" can trigger an operator quality-gate (e.g. a test run) — if it fails you'll get the output back, so fix and retry. And if the operator installed the claim guard, a "git commit" touching a file another participant has claimed is blocked until you coordinate or they release it.\n` +
          `• Instead of polling with wait(), you can watch(event=…) — the hub pings you (and wakes your tmux pane when possible) the moment it happens. Events: message, task_done (arg=#), task_ready (arg=#), answer, question, release (arg=path).\n` +
          `• autopilot(on=true) makes the hub EXECUTE the board: ready tasks are dispatched automatically (assignee's pane woken, or a worker spawned per task), respecting depends_on and the quality gates. Add tasks with depends_on to script a pipeline, then let it run.\n` +
          `• Starting fresh in a repo? brief(cwd=…) first — it returns recent sessions, the last conversation's tail, and open questions/decisions/tasks from active links, so you don't re-ask the human.\n` +
          `• doc_read is compact by default (Log trimmed, older entries archived); pass section="Log" or full=true for more.\n` +
          `• Re-prompting a PAUSED agent in place is an operator action (shell: "sonar wake <link> <label> [prompt]"), not an MCP tool — it needs the session to be running under tmux.\n` +
          `• If you connected to a SHARED/REMOTE hub with a member token (a teammate across the network), you have the coordination tools only — search_context, recent_sessions, and spawn_worker are host-private and disabled for you. Exchange context through the shared doc instead.\n` +
          `• Something failing (the \`sonar\` CLI errors with "fetch failed"/EPERM in your shell, a peer never replies, nudges don't fire)? Read the agent self-help runbook at ${path.join(DATA_DIR, 'AGENTS.md')} — symptom → fix. Sandboxed shells often block the CLI while these MCP tools still work.`
      );
    }
  );

  server.registerTool(
    'link_create',
    {
      title: 'Create a sonar',
      description:
        'Create a new cross-session link and return a short ID. Share that ID with the other Claude Code / Codex session so it can `link_join`. Run `git branch --show-current` and `pwd` first and pass them as branch/cwd so the link is labelled.',
      inputSchema: { title: z.string().optional().describe('Optional human title for the link.'), ...ident },
    },
    async (a) => {
      const { id } = core.createLink({ title: a.title, who: a });
      const docFile = docs.ensureDoc(id, a.title);
      syncParticipants(id);
      syncTasks(id);
      syncClaims(id);
      syncGit(id);
      docs.appendLog(id, a.label, 'created the link');
      return text(
        `Created sonar link: ${id}${a.title ? ` — ${a.title}` : ''}\n` +
          `You joined as "${a.label}".\n\n` +
          `Shared doc (the source of truth you both collaborate in):\n  ${docFile}\n\n` +
          `Next: write your context into the doc with doc_append(link_id="${id}", section="Context", text="…", from="${a.label}"), ` +
          `and add anything you need from the other agent under section="Open questions".\n` +
          `Tell your human to open the other session and run: /sonar ${id}\n` +
          `Then use wait(link_id="${id}", from="${a.label}") to be notified of updates.`
      );
    }
  );

  server.registerTool(
    'link_join',
    {
      title: 'Join a sonar',
      description:
        'Join an existing link by its ID to share context with another session. Returns current participants and recent messages. Run `git branch --show-current` / `pwd` first and pass branch/cwd.',
      inputSchema: { link_id: z.string(), ...ident },
    },
    async (a) => {
      const r = core.joinLink({ linkId: a.link_id, who: a });
      const docFile = docs.ensureDoc(a.link_id, r.link?.title);
      syncParticipants(a.link_id);
      syncClaims(a.link_id);
      syncTasks(a.link_id);
      syncGit(a.link_id);
      docs.appendLog(a.link_id, a.label, 'joined the link');
      const doc = docs.readDoc(a.link_id, { compact: true });
      return text(
        `Joined ${a.link_id}${r.link?.title ? ` — ${r.link.title}` : ''} as "${a.label}".\n\n` +
          `Shared doc: ${docFile}\n\n` +
          `=== current shared doc (compact — Log trimmed) ===\n${doc}\n=== end doc ===\n` +
          `(Full doc or a single section: doc_read(link_id="${a.link_id}", section="…") or doc_read(link_id="${a.link_id}", full=true).)\n\n` +
          `Now: add your own context with doc_append(link_id="${a.link_id}", section="Context", from="${a.label}", text="…"). ` +
          `Answer any items under "Open questions" by doc_append to "Answers" and post() a ping. ` +
          `Use wait(link_id="${a.link_id}", from="${a.label}") to listen for updates.`
      );
    }
  );

  server.registerTool(
    'link_list',
    {
      title: 'List active sonars',
      description: 'List recent links so you can find one to join (with participants and last activity).',
      inputSchema: {},
    },
    async () => {
      const rows = core.listLinks({ activeDays: 14 });
      if (!rows.length) return text('No active links. Use link_create to start one.');
      return text(
        rows
          .map(
            (r) =>
              `${r.id}${r.title ? ` — ${r.title}` : ''} · ${r.message_count} msgs · last ${fmtTime(r.last_message_at) || fmtTime(r.created_at)}\n  participants: ${r.participants || '(none)'}`
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'link_info',
    {
      title: 'Inspect a sonar',
      description: 'Show participants and recent activity for a link.',
      inputSchema: { link_id: z.string() },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link with id "${a.link_id}".`);
      const parts = core.listParticipants(a.link_id);
      const recent = core.readMessages({ linkId: a.link_id, limit: 10 });
      const cfg = core.getAutopilot(a.link_id);
      const watches = core.listWatches(a.link_id);
      return text(
        `Link ${a.link_id}\nParticipants:\n` +
          parts.map((p) => `- ${p.label} (${p.agent ?? '?'}${p.branch ? '/' + p.branch : ''}) · last seen ${fmtTime(p.last_seen)}`).join('\n') +
          `\nAutopilot: ${cfg?.on ? `ON (max ${cfg.max ?? 2}, agent ${cfg.agent || 'claude'})` : 'off'}` +
          (watches.length
            ? `\nActive watches:\n` + watches.map((w) => `- #${w.id} ${w.label} ← ${w.event}${w.arg ? `(${w.arg})` : ''}${w.once ? '' : ' · persistent'}`).join('\n')
            : '') +
          `\n\nRecent:\n${renderMessages(recent)}`
      );
    }
  );

  server.registerTool(
    'post',
    {
      title: 'Post a message to a sonar',
      description: 'Send a message (a question, an update, context) to the other session(s) on a link. Pair with `wait` to get the reply.',
      inputSchema: {
        link_id: z.string(),
        from: z.string().describe('Your participant label.'),
        body: z.string().describe('The message. Include enough context that the other session can act without your screen.'),
        agent: z.string().optional(),
        branch: z.string().optional(),
        reply_to: z.number().optional().describe('seq of the message you are replying to.'),
      },
    },
    async (a) => {
      const r = core.postMessage({ linkId: a.link_id, from: a.from, body: a.body, agent: a.agent, branch: a.branch, replyTo: a.reply_to });
      await fireWatches({ linkId: a.link_id, event: 'message', from: a.from, detail: `message from ${a.from}: ${a.body.slice(0, 140)}` });
      void autoWakePeers({ linkId: a.link_id, from: a.from, detail: `message from ${a.from}: ${a.body.slice(0, 140)}` });
      return text(
        `Posted to ${a.link_id} as seq ${r.seq}. The other side will be nudged/woken automatically — you can simply END YOUR TURN and sonar resumes you when a reply lands (or call wait(link_id="${a.link_id}", from="${a.from}", after_seq=${r.seq}) to hold on-line).` +
          pending(a.link_id, a.from)
      );
    }
  );

  server.registerTool(
    'read',
    {
      title: 'Read sonar messages',
      description:
        'Read messages on a link. Use since_seq to get only what is new since you last read. Pass `from` (your label) so sonar records you as caught up — otherwise the nudge hook keeps re-reporting the same messages as unread.',
      inputSchema: {
        link_id: z.string(),
        since_seq: z.number().optional().describe('Return only messages with seq greater than this.'),
        from: z.string().optional().describe('Your participant label — advances your unread cursor over what this call returns.'),
        limit: z.number().optional(),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link with id "${a.link_id}".`);
      const msgs = core.readMessages({ linkId: a.link_id, sinceSeq: a.since_seq, limit: a.limit });
      if (a.from && msgs.length) core.advanceCursor(a.link_id, a.from, Math.max(...msgs.map((m) => m.seq as number)));
      return text(renderMessages(msgs));
    }
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for a sonar reply (long-poll)',
      description:
        'Block until a new message (from someone other than `from`) arrives on the link, or until timeout. Returns the new messages. If it times out with none, call it again to keep waiting.',
      inputSchema: {
        link_id: z.string(),
        from: z.string().optional().describe('Your label — so you are not woken by your own messages.'),
        after_seq: z.number().optional().describe('Only resolve for messages newer than this seq.'),
        timeout_ms: z.number().optional().describe('Max wait in ms (default 25000, max 110000).'),
      },
    },
    async (a, extra) => {
      // extra.signal aborts if the MCP client cancels/disconnects — thread it through so the
      // waiter is released right away rather than held until timeout.
      const r = await core.waitForMessages({ linkId: a.link_id, from: a.from, afterSeq: a.after_seq, timeoutMs: a.timeout_ms, signal: extra?.signal });
      if (r.timedOut && !r.messages.length) {
        return text(`No new messages within the wait window. Call wait again (same args) to keep listening on ${a.link_id}.`);
      }
      return text(renderMessages(r.messages));
    }
  );

  server.registerTool(
    'search_context',
    {
      title: 'Search other sessions for context',
      description:
        "Full-text search across your indexed Claude Code AND Codex conversation history. Use this to pull context from another session by topic — optionally filtered by branch, repo, or agent. Branch filtering is exact for Claude sessions (Codex logs don't record branch; filter by repo instead).",
      inputSchema: {
        query: z.string().describe('What to look for, e.g. "rate limiting" or "auth refactor".'),
        branch: z.string().optional().describe('Restrict to a git branch (Claude sessions).'),
        repo: z.string().optional().describe('Restrict to a repo name.'),
        agent: z.string().optional().describe('"claude" or "codex".'),
        session_id: z.string().optional(),
        since_days: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async (a) => {
      if (hostPrivateBlocked())
        return text("search_context is disabled for relay/remote sessions — it searches the hub host's own Claude/Codex transcript history. Exchange context through the shared doc instead.");
      const hits = core.searchContext({
        query: a.query,
        branch: a.branch,
        repo: a.repo,
        agent: a.agent,
        sessionId: a.session_id,
        sinceDays: a.since_days,
        limit: a.limit,
      });
      if (!hits.length) return text('No matches. Try fewer/broader terms, or drop the branch/repo filter. (The indexer may still be backfilling.)');
      return text(
        hits
          .map((h, i) => {
            const loc = [h.agent, h.repo, h.branch].filter(Boolean).join(' · ');
            return `#${i + 1} ${loc} · session ${String(h.session_id || '').slice(0, 8)} · ${fmtTime(h.ts)} · ${h.role}\n  ${h.excerpt.replace(/\s+/g, ' ').trim()}`;
          })
          .join('\n\n')
      );
    }
  );

  server.registerTool(
    'recent_sessions',
    {
      title: 'List recently indexed sessions',
      description: 'List recent Claude/Codex sessions in the index (helps you discover what context exists to search or link to).',
      inputSchema: { repo: z.string().optional(), branch: z.string().optional(), agent: z.string().optional(), limit: z.number().optional() },
    },
    async (a) => {
      if (hostPrivateBlocked()) return text("recent_sessions is disabled for relay/remote sessions — it lists the hub host's own indexed sessions.");
      const rows = core.recentSessions(a);
      if (!rows.length) return text('No indexed sessions match.');
      return text(
        rows
          .map((r) => `${r.agent} · ${r.repo ?? '?'}${r.branch ? '/' + r.branch : ''} · ${String(r.session_id || '').slice(0, 8)} · indexed ${fmtTime(r.indexed_at)}`)
          .join('\n')
      );
    }
  );

  // ---- shared context document ----
  server.registerTool(
    'doc_read',
    {
      title: 'Read the shared context doc',
      description:
        "Read a link's shared markdown doc — the source of truth both agents collaborate in (context, open questions, answers, decisions). Read this before working and after any `wait` ping. " +
        'By default returns a COMPACT view (full doc with the Log trimmed to its most recent entries — older Log entries are auto-archived). ' +
        'Pass section="…" to read just one section (e.g. section="Log" for full Log history, or "Open questions"). Pass full=true only when you truly need the entire document.',
      inputSchema: {
        link_id: z.string(),
        section: z.string().optional().describe('Read only this section, e.g. "Open questions" or "Log".'),
        full: z.boolean().optional().describe('Return the entire document including full Log (rarely needed — the compact default is usually enough).'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const body = a.section ? docs.readDoc(a.link_id, { section: a.section }) : a.full ? docs.readDoc(a.link_id) : docs.readDoc(a.link_id, { compact: true });
      return text(`Shared doc: ${docs.docPath(a.link_id)}\n\n${body}`);
    }
  );

  server.registerTool(
    'doc_append',
    {
      title: 'Append to the shared context doc',
      description:
        'Append a block of text under a section of the shared doc (creating the section if needed). Use sections like "Context", "Open questions", "Answers", "Decisions". This is how you contribute context, ask the other agent questions, and record answers. Also pings anyone waiting.',
      inputSchema: {
        link_id: z.string(),
        section: z.string().describe('Section heading, e.g. "Context", "Open questions", "Answers", "Decisions".'),
        text: z.string().describe('Markdown to append. For a question, phrase it clearly and say who should answer.'),
        from: z.string().describe('Your participant label.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      docs.appendToSection(a.link_id, a.section, a.text, a.from);
      // Terse ping only — fires any wait() without re-duplicating the prose into the message stream.
      core.postMessage({ linkId: a.link_id, from: a.from, body: `📝 ${a.from} appended to "${a.section}"` });
      const sec = a.section.trim().toLowerCase();
      if (sec === 'answers') await fireWatches({ linkId: a.link_id, event: 'answer', from: a.from, detail: `${a.from} answered: ${a.text.slice(0, 140)}` });
      if (sec === 'open questions') await fireWatches({ linkId: a.link_id, event: 'question', from: a.from, detail: `${a.from} asked: ${a.text.slice(0, 140)}` });
      void autoWakePeers({ linkId: a.link_id, from: a.from, detail: `${a.from} appended to "${a.section}": ${a.text.slice(0, 140)}` });
      return text(`Appended to "${a.section}" and pinged the link. Doc: ${docs.docPath(a.link_id)}` + pending(a.link_id, a.from));
    }
  );

  server.registerTool(
    'doc_set_section',
    {
      title: 'Replace a section of the shared doc',
      description: 'Replace the entire body of one section (use to restructure/clean up, e.g. resolve "Open questions" or finalize "Decisions"). Prefer doc_append for adding new content.',
      inputSchema: { link_id: z.string(), section: z.string(), text: z.string(), from: z.string().optional() },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      docs.setSection(a.link_id, a.section, a.text);
      if (a.from) core.postMessage({ linkId: a.link_id, from: a.from, body: `📝 rewrote doc section "${a.section}"` });
      return text(`Section "${a.section}" replaced. Doc: ${docs.docPath(a.link_id)}` + pending(a.link_id, a.from));
    }
  );

  // ---- coordination state: claims (leases), task board, git presence ----
  server.registerTool(
    'claim',
    {
      title: 'Claim a file/resource (lease)',
      description:
        'Take a short-lived lease on a file, directory, or named resource so the other session knows you are editing it and avoids clobbering you. ' +
        'Conflicts are detected by path overlap (claiming a directory covers the files under it). If someone else already holds an overlapping lease this RETURNS the conflict (who, until when) instead of acquiring — work elsewhere, or pass steal=true to override a clearly stale one. ' +
        'Re-claiming your own resource extends it. Leases auto-expire (default 30 min). The active set surfaces in the doc under "Claims".',
      inputSchema: {
        link_id: z.string(),
        resource: z.string().describe('What you are claiming — usually a path, e.g. "apps/web/api-client.ts" or "apps/web" (a dir covers its files). Any label works.'),
        from: z.string().describe('Your participant label (the lease holder).'),
        ttl_min: z.number().optional().describe('Lease length in minutes (default 30, max 240). Re-claim to extend.'),
        note: z.string().optional().describe('Optional note, e.g. "refactoring the client".'),
        agent: z.string().optional(),
        steal: z.boolean().optional().describe('Override an existing conflicting lease held by someone else (only when it is clearly stale).'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const r = core.claimResource({ linkId: a.link_id, resource: a.resource, holder: a.from, agent: a.agent, ttlMin: a.ttl_min, note: a.note, steal: a.steal });
      if (!r.ok) {
        const c = r.conflicts.map((x: any) => `\`${x.resource}\` held by ${x.holder} until ${fmtTime(x.expires_at)} (${fmtMins(x.expires_at)})`).join('; ');
        return text(`✋ Could not claim "${a.resource}" — conflicting lease: ${c}.\nWork elsewhere, coordinate in the doc, or re-call with steal=true if it is stale.`);
      }
      syncClaims(a.link_id);
      core.postMessage({ linkId: a.link_id, from: a.from, body: `🔒 ${a.from} claimed ${r.claim.resource}${r.stole?.length ? ' (stole a stale lease)' : ''}` });
      return text(
        `Claimed "${r.claim.resource}" until ${fmtTime(r.claim.expires_at)} (${fmtMins(r.claim.expires_at)})${r.extended ? ' — extended' : ''}.\n` +
          `Release with release(link_id="${a.link_id}", resource="${r.claim.resource}", from="${a.from}") when done.` +
          pending(a.link_id, a.from)
      );
    }
  );

  server.registerTool(
    'release',
    {
      title: 'Release a claim',
      description: 'Release a lease you hold on a resource so the other session can edit it. Pings the link. Leases also auto-expire, so this is optional but courteous.',
      inputSchema: {
        link_id: z.string(),
        resource: z.string().describe('The exact resource you claimed.'),
        from: z.string().describe('Your participant label.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const r = core.releaseClaim({ linkId: a.link_id, resource: a.resource, holder: a.from });
      syncClaims(a.link_id);
      if (r.released) {
        core.postMessage({ linkId: a.link_id, from: a.from, body: `🔓 ${a.from} released ${a.resource}` });
        await fireWatches({ linkId: a.link_id, event: 'release', arg: a.resource, from: a.from, detail: `${a.from} released "${a.resource}" — it is free to claim` });
      }
      return text(r.released ? `Released ${r.released} lease(s) on "${a.resource}".` : `No active lease by "${a.from}" on "${a.resource}".`);
    }
  );

  server.registerTool(
    'task_add',
    {
      title: 'Add a task to the shared board',
      description:
        'Add a task to the link\'s shared task board (status starts at "todo"). The board surfaces in the doc under "Tasks". Use it to split work between sessions and track who owns what; the returned number (#N) is how you update it later. ' +
        'Pass depends_on=[#…] to make this task wait on others — it starts "blocked" and auto-unblocks to "todo" once they are all "done".',
      inputSchema: {
        link_id: z.string(),
        title: z.string().describe('Short task description.'),
        from: z.string().describe('Your participant label (recorded as creator).'),
        assignee: z.string().optional().describe('Who should own it (a participant label), if known.'),
        note: z.string().optional(),
        depends_on: z.array(z.number()).optional().describe('Task numbers this one depends on; it stays "blocked" until they are all done.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      // Quality gate: an operator-configured task_created hook can reject the task (exit non-zero).
      const gate = await runHook('task_created', { link: a.link_id, from: a.from, title: a.title });
      if (gate.ran && !gate.allowed) return text(`🚫 task_created hook rejected this task:\n${gate.output || '(no output)'}`);
      let t: any;
      try {
        t = core.createTask({ linkId: a.link_id, title: a.title, assignee: a.assignee, note: a.note, by: a.from, deps: a.depends_on, remote: isRelay });
      } catch (e) {
        return text((e as Error).message);
      }
      syncTasks(a.link_id);
      core.postMessage({ linkId: a.link_id, from: a.from, body: `🆕 task #${t.num}: ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}${t.status === 'blocked' ? ' (blocked)' : ''}` });
      let dispatched: autopilot.Dispatch[] = [];
      if (t.status === 'todo') {
        await fireWatches({ linkId: a.link_id, event: 'task_ready', arg: t.num, from: a.from, detail: `task #${t.num} "${t.title}" is ready` });
        dispatched = await autopilot.dispatchReady(a.link_id, { trigger: `task #${t.num} added` });
        syncTasks(a.link_id); // dispatch may have set assignees
      }
      const mine = dispatched.find((d) => d.num === t.num);
      const held = isRelay && t.status === 'todo' && core.getAutopilot(a.link_id)?.on;
      return text(
        `Added task #${t.num} "${t.title}" (${t.status}${t.assignee ? `, → ${t.assignee}` : ''}).\n` +
          (t.status === 'blocked'
            ? `It depends on ${a.depends_on?.map((n) => '#' + n).join(', ')} and will auto-unblock when those are done.`
            : mine
              ? mine.error
                ? `Autopilot tried to dispatch it but failed (${mine.error}) — it was re-armed for the next pass.`
                : `Autopilot dispatched it (${mine.via}${mine.assignee ? ` → ${mine.assignee}` : ''}).`
              : held
                ? `Autopilot is ON but HOLDS remote-created tasks — a participant on the hub machine must review it (any task_update from a local session approves it for dispatch).`
                : `Claim/progress it with task_update(link_id="${a.link_id}", num=${t.num}, from="${a.from}", status="doing", assignee="${a.from}"); finish with status="done".`) +
          pending(a.link_id, a.from)
      );
    }
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update a task (claim / progress / done)',
      description:
        'Change a task\'s status (todo → doing → done, or blocked), claim it by setting assignee to yourself, add a note, or change its dependencies. This is how you "claim" a task (status="doing", assignee=you) and mark it "done". ' +
        'A task with unfinished dependencies cannot move to "doing"/"done"; marking a task "done" auto-unblocks anything waiting only on it. Pings the link.',
      inputSchema: {
        link_id: z.string(),
        num: z.number().describe('The task number (#N) shown on the board.'),
        from: z.string().describe('Your participant label.'),
        status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
        assignee: z.string().optional().describe('Set the owner (use your own label to claim it).'),
        note: z.string().optional(),
        depends_on: z.array(z.number()).optional().describe('Replace this task\'s dependency list (task numbers).'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      // Cheap dependency pre-check before the (possibly slow) completion gate, so we don't run a
      // test suite only to reject the transition for unfinished deps.
      if (a.status === 'doing' || a.status === 'done') {
        const pending2 = core.unresolvedDeps(a.link_id, a.num);
        if (pending2.length) return text(`⛔ task #${a.num} is blocked by unfinished ${pending2.map((n) => '#' + n).join(', ')} — finish those first.`);
      }
      // Quality gate: an operator-configured task_completed hook can block marking a task done.
      if (a.status === 'done') {
        const gate = await runHook('task_completed', { link: a.link_id, from: a.from, num: a.num, title: core.getTask(a.link_id, a.num)?.title });
        if (gate.ran && !gate.allowed) return text(`🚫 task_completed hook blocked marking #${a.num} done:\n${gate.output || '(no output)'}`);
      }
      let r: { task: any; unblocked: number[] };
      try {
        r = core.updateTask({ linkId: a.link_id, num: a.num, status: a.status, assignee: a.assignee, note: a.note, deps: a.depends_on, localTouch: !isRelay });
      } catch (e) {
        return text((e as Error).message);
      }
      const t = r.task;
      syncTasks(a.link_id);
      core.postMessage({ linkId: a.link_id, from: a.from, body: `📌 task #${t.num} → ${t.status}${t.assignee ? ` (${t.assignee})` : ''}` });
      if (r.unblocked.length) core.postMessage({ linkId: a.link_id, from: a.from, body: `🟢 unblocked ${r.unblocked.map((n) => '#' + n).join(', ')} (deps done)` });
      // Event fan-out: watchers of this task's completion, watchers of each newly-ready task,
      // then autopilot (which dispatches anything now ready, including the unblocked ones).
      let dispatched: autopilot.Dispatch[] = [];
      if (a.status === 'done') {
        await fireWatches({ linkId: a.link_id, event: 'task_done', arg: t.num, from: a.from, detail: `task #${t.num} "${t.title}" was completed by ${a.from}` });
      }
      for (const n of r.unblocked) {
        const ut = core.getTask(a.link_id, n);
        await fireWatches({ linkId: a.link_id, event: 'task_ready', arg: n, from: a.from, detail: `task #${n} "${ut?.title ?? ''}" unblocked (deps done)` });
      }
      if (a.status === 'done' || a.status === 'todo') {
        dispatched = await autopilot.dispatchReady(a.link_id, { trigger: `task #${t.num} → ${a.status}` });
        if (dispatched.length) syncTasks(a.link_id);
      }
      return text(
        `Task #${t.num} "${t.title}" is now ${t.status}${t.assignee ? ` · ${t.assignee}` : ''}.` +
          (r.unblocked.length ? ` Unblocked ${r.unblocked.map((n) => '#' + n).join(', ')}.` : '') +
          (dispatched.length ? ` Autopilot dispatched: ${dispatched.map((d) => `#${d.num} (${d.error ? 'FAILED: ' + d.error : d.via})`).join(', ')}.` : '') +
          pending(a.link_id, a.from)
      );
    }
  );

  server.registerTool(
    'git_sync',
    {
      title: 'Report your git state + see the others',
      description:
        "Publish your current git state to the link and get back what every other participant last reported — so a frontend/backend pair can see each other's branch, ahead/behind, and which files changed. Run these locally and pass the results:\n" +
        '  branch:   git branch --show-current\n' +
        '  head:     git rev-parse --short HEAD\n' +
        '  ahead/behind: git rev-list --left-right --count @{u}...HEAD  (behind = left, ahead = right; omit if no upstream)\n' +
        '  changed + files: git status --porcelain  (count the lines for "changed"; pass a few notable paths)\n' +
        'Surfaces in the doc under "Git". Call it after you commit/pull, or whenever you want to sync. (Reporting only — it does not run git for you.)',
      inputSchema: {
        link_id: z.string(),
        from: z.string().describe('Your participant label.'),
        branch: z.string().optional(),
        head: z.string().optional().describe('Short HEAD sha.'),
        upstream: z.string().optional().describe('Upstream ref, e.g. origin/main.'),
        ahead: z.number().optional(),
        behind: z.number().optional(),
        changed: z.number().optional().describe('Count of changed files (git status --porcelain line count).'),
        files: z.array(z.string()).optional().describe('A handful of notable changed paths (surfaced so peers spot overlap).'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const all = core.setGitState({
        linkId: a.link_id,
        label: a.from,
        branch: a.branch,
        head: a.head,
        upstream: a.upstream,
        ahead: a.ahead,
        behind: a.behind,
        changed: a.changed,
        files: a.files,
      });
      syncGit(a.link_id);
      const peers = all.filter((g: any) => g.label !== a.from);
      const peerText = peers.length ? peers.map(gitLine).join('\n') : '(no other participant has reported git state yet)';
      return text(`Synced your git state to ${a.link_id}.\nOther participants:\n${peerText}` + pending(a.link_id, a.from));
    }
  );

  // ---- spawn a worker session ----
  server.registerTool(
    'spawn_worker',
    {
      title: 'Spawn a worker agent on a link',
      description:
        'Launch a NEW Claude/Codex session that auto-joins this link and works a task, collaborating through the shared doc. By default it opens in an isolated git worktree on a temp branch (so its edits stay separate) in a new terminal window. Use this to dispatch a sub-agent to investigate or build something and report back into the doc.',
      inputSchema: {
        link_id: z.string(),
        task: z.string().describe('What the worker should do. Be specific; it cannot see your screen.'),
        agent: z.enum(['claude', 'codex']).optional().describe('Which CLI to launch (default claude).'),
        cwd: z.string().optional().describe('Repo/dir to base the worktree on (default: the hub server cwd — pass the repo you want).'),
        headless: z.boolean().optional().describe('Run non-interactively in the background (auto-approves tools in its isolated worktree). Default false = opens a visible terminal.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      if (remoteExecBlocked()) {
        return text(
          'spawn_worker is disabled for remote callers while the hub is exposed on the LAN — it runs code on the hub host. ' +
            'The hub operator can set SONAR_ALLOW_REMOTE_EXEC=1 to allow it.'
        );
      }
      try {
        const r = await spawnWorker({ linkId: a.link_id, task: a.task, agent: a.agent, cwd: a.cwd, headless: a.headless });
        return text(
          `Spawned ${r.agent} worker (${r.mode}) on link ${a.link_id}.\n` +
            (r.branch ? `Worktree: ${r.workdir}\nBranch: ${r.branch}\n` : `Dir: ${r.workdir}\n`) +
            (r.mode === 'headless' ? `Log: ${r.log}\n` : '') +
            `It will join the link, read the shared doc, do the task, and write back. Watch progress in the doc: ${r.doc}`
        );
      } catch (e) {
        return text(`Couldn't spawn worker: ${(e as Error).message}`);
      }
    }
  );

  // ---- watches: event subscriptions ("wake me when …") ----
  server.registerTool(
    'watch',
    {
      title: 'Watch for an event (get pinged/woken)',
      description:
        'Subscribe to an event on this link instead of polling with wait(). When it fires, the hub posts a targeted ping to the link (your next wait()/read sees it) and — if your session runs in a sonar tmux pane — types a wake prompt into it so you resume automatically. ' +
        'Events: "message" (any new post), "task_done" (arg = task # — or omit for any), "task_ready" (a task becomes workable), "answer" (something appended to Answers), "question" (appended to Open questions), "release" (arg = a path you are waiting on; overlap-aware like claims). ' +
        'One-shot by default; pass once=false to keep it active after each fire. Your own actions never trigger your own watches.',
      inputSchema: {
        link_id: z.string(),
        from: z.string().describe('Your participant label (who to ping/wake).'),
        event: z.enum(['message', 'task_done', 'task_ready', 'answer', 'question', 'release']),
        arg: z.string().optional().describe('Scope: task number for task_* events, a path for release. Omit to match any.'),
        note: z.string().optional().describe('Why you are watching (shown to whoever looks at the watch list).'),
        once: z.boolean().optional().describe('Default true = fires once then deactivates. false = persistent.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const w = core.addWatch({ linkId: a.link_id, label: a.from, event: a.event, arg: a.arg, note: a.note, once: a.once });
      return text(
        `Watch #${w.id} armed: ${a.event}${a.arg ? `(${a.arg})` : ''} → ping ${a.from}${w.once ? ' (one-shot)' : ' (persistent)'}.\n` +
          `You can now end your turn / go idle — the hub will ping the link (and wake your tmux pane if it can) when it fires. ` +
          `Cancel with unwatch(link_id="${a.link_id}", from="${a.from}", id=${w.id}).` +
          pending(a.link_id, a.from)
      );
    }
  );

  server.registerTool(
    'unwatch',
    {
      title: 'Cancel a watch',
      description: 'Remove one of your event subscriptions (by id), or all of them on the link (omit id).',
      inputSchema: {
        link_id: z.string(),
        from: z.string().describe('Your participant label.'),
        id: z.number().optional().describe('The watch id to remove; omit to remove all of yours on this link.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      const n = core.removeWatch({ linkId: a.link_id, id: a.id, label: a.from });
      return text(n ? `Removed ${n} watch(es).` : 'No matching watch (you can only remove your own).');
    }
  );

  // ---- autopilot: the self-executing task board ----
  server.registerTool(
    'autopilot',
    {
      title: 'Autopilot — self-executing task board',
      description:
        'Turn the link\'s task board into an execution engine. While ON, the hub dispatches every READY task itself: a task with an assignee → that participant is pinged and their tmux pane woken; an unassigned task → a dedicated worker is spawned in an isolated worktree to claim it, work it, and mark it done. ' +
        'Completions cascade — finishing a task auto-unblocks its depends_on dependents, which are then dispatched too (bounded by max concurrent, default 2; quality-gate hooks still guard every "done"). ' +
        'To script a pipeline: add tasks with depends_on, enable autopilot, watch the doc. Call with on omitted to see current status. Re-arm a stuck task by setting it back to status="todo".',
      inputSchema: {
        link_id: z.string(),
        from: z.string().describe('Your participant label.'),
        on: z.boolean().optional().describe('true = enable, false = disable. Omit to just show status.'),
        cwd: z.string().optional().describe('Repo/dir workers are based on (worktrees branch from here). REQUIRED when enabling — pass your repo root.'),
        agent: z.enum(['claude', 'codex']).optional().describe('CLI for spawned workers (default claude).'),
        max: z.number().optional().describe('Max tasks in flight at once (default 2, max 8).'),
        headless: z.boolean().optional().describe('Spawn workers headless (background) instead of visible terminals. Default false.'),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link "${a.link_id}".`);
      if (a.on === undefined) {
        const cfg = core.getAutopilot(a.link_id);
        const inflight = core.inflightTasks(a.link_id);
        const ready = core.readyTasks(a.link_id);
        return text(
          `Autopilot on ${a.link_id}: ${cfg?.on ? `ON (agent ${cfg.agent || 'claude'}, max ${cfg.max ?? 2}${cfg.headless ? ', headless' : ''}${cfg.cwd ? `, cwd ${cfg.cwd}` : ''})` : 'off'}\n` +
            `In flight: ${inflight.length ? inflight.map((t) => `#${t.num} (${t.status}${t.assignee ? ` · ${t.assignee}` : ''})`).join(', ') : 'none'}\n` +
            `Ready (undispatched): ${ready.length ? ready.map((t) => `#${t.num}${t.created_remote ? ' (held: remote-created — a local task_update approves it)' : ''}`).join(', ') : 'none'}`
        );
      }
      if (a.on && remoteExecBlocked()) {
        return text('autopilot is disabled for remote/relay callers — it spawns workers on the hub host. Ask the hub operator to enable it (or set SONAR_ALLOW_REMOTE_EXEC=1).');
      }
      if (a.on && !a.cwd) return text('Pass cwd=<your repo root> when enabling autopilot — workers need a repo to base their worktrees on.');
      const r = await autopilot.setAutopilot(a.link_id, a.on ? { on: true, cwd: a.cwd, agent: a.agent, max: a.max, headless: a.headless, by: a.from } : { on: false });
      if (!a.on) return text('Autopilot OFF — tasks are no longer auto-dispatched (running workers finish their current task).');
      return text(
        `Autopilot ON (max ${r.config?.max ?? 2} in flight, agent ${r.config?.agent || 'claude'}${r.config?.headless ? ', headless' : ''}).\n` +
          (r.dispatched.length
            ? `Dispatched now: ${r.dispatched.map((d) => `#${d.num} (${d.error ? 'FAILED: ' + d.error : d.via}${d.assignee ? ` → ${d.assignee}` : ''})`).join(', ')}.`
            : 'Nothing ready yet — add tasks (use depends_on to order them) and they will dispatch as they become ready.') +
          `\nEvery "done" still passes your quality-gate hooks; watch progress in the doc or the menu bar.` +
          pending(a.link_id, a.from)
      );
    }
  );

  // ---- brief: session-start catch-up ----
  server.registerTool(
    'brief',
    {
      title: 'Brief — catch up on a repo at session start',
      description:
        "Call this FIRST when starting work in a repo. Returns a briefing assembled from the hub's memory: recent Claude/Codex sessions in the repo, the tail of the most recent conversation, and — for every active link involving the repo — open tasks, held claims, open questions, and recorded decisions. Saves the human from re-pasting context you already have.",
      inputSchema: {
        cwd: z.string().optional().describe('Your working directory (repo is derived from its git root). Pass this normally.'),
        repo: z.string().optional().describe('Repo name override (basename of the git root), if cwd is not enough.'),
        branch: z.string().optional().describe('Restrict recent-session list to a branch.'),
        days: z.number().optional().describe('How far back to look for active links (default 14).'),
      },
    },
    async (a) => {
      if (hostPrivateBlocked())
        return text("brief is disabled for relay/remote sessions — it reads the hub host's transcript index. Use doc_read on the shared link instead.");
      return text(formatBrief(brief({ repo: a.repo, cwd: a.cwd, branch: a.branch, days: a.days })));
    }
  );
}
