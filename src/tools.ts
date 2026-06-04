import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as core from './core.ts';
import * as docs from './docs.ts';
import { spawnWorker } from './spawn.ts';
import { LAN_MODE, isLoopbackAddr } from './config.ts';

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
  ['get an answer from another LIVE session', 'post() then wait() in a loop (re-read the doc on each ping)'],
  ['catch up after a ping, or before you start working', 'doc_read (compact by default) — or read(since_seq=…) for just new messages'],
  ['contribute context / ask a question / record an answer', 'doc_append(section="Context" | "Open questions" | "Answers")'],
  ['record a decision, or keep a bounded contract (API shape, types)', 'doc_set_section (replace = stays bounded, no append bloat)'],
  ['dispatch an autonomous subtask that reports back', 'spawn_worker(task=…)  — headless=true to run in the background'],
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
  { name: 'post', purpose: 'send a short "doc changed" / question ping to the other session; pair with wait', example: 'post(link_id="k7m2", from="claude@feat/auth", body="answered your Q in the doc")' },
  { name: 'read', purpose: 'read messages since a seq WITHOUT blocking (quick catch-up)', example: 'read(link_id="k7m2", since_seq=12)' },
  { name: 'wait', purpose: 'long-poll until a new message arrives (loop it); per-participant cursor advances automatically', example: 'wait(link_id="k7m2", from="claude@feat/auth")' },
  { name: 'search_context', purpose: 'full-text search YOUR indexed Claude + Codex history; filter by repo / branch / agent', example: 'search_context(query="rate limiting", repo="api")' },
  { name: 'recent_sessions', purpose: 'list recently indexed sessions to discover what context exists to search/link', example: 'recent_sessions(repo="api")' },
  { name: 'spawn_worker', purpose: 'launch a new claude/codex session in an isolated git worktree, pre-joined to the link, to work a task and report back into the doc', example: 'spawn_worker(link_id="k7m2", task="investigate X and answer the open question", headless=true)' },
];

export function registerTools(server: McpServer, opts: { remoteAddr?: string } = {}) {
  // In LAN mode, host-mutating tools are refused for remote callers unless explicitly allowed.
  // (Local/loopback agents on the hub machine are always permitted; default loopback mode is unaffected.)
  const remoteExecBlocked = () => LAN_MODE && !isLoopbackAddr(opts.remoteAddr) && !process.env.SONAR_ALLOW_REMOTE_EXEC;

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
          `• Typical flow: link_create / link_join → doc_read → doc_append your context → post a ping → wait() in a loop, re-reading the doc on each ping. Put substantive content in the DOC, not just in pings.\n` +
          `• doc_read is compact by default (Log trimmed, older entries archived); pass section="Log" or full=true for more.\n` +
          `• Re-prompting a PAUSED agent in place is an operator action (shell: "sonar wake <link> <label> [prompt]"), not an MCP tool — it needs the session to be running under tmux.`
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
      return text(
        `Link ${a.link_id}\nParticipants:\n` +
          parts.map((p) => `- ${p.label} (${p.agent ?? '?'}${p.branch ? '/' + p.branch : ''}) · last seen ${fmtTime(p.last_seen)}`).join('\n') +
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
      return text(`Posted to ${a.link_id} as seq ${r.seq}. Call wait(link_id="${a.link_id}", from="${a.from}", after_seq=${r.seq}) to await a reply.` + pending(a.link_id, a.from));
    }
  );

  server.registerTool(
    'read',
    {
      title: 'Read sonar messages',
      description: 'Read messages on a link. Use since_seq to get only what is new since you last read.',
      inputSchema: {
        link_id: z.string(),
        since_seq: z.number().optional().describe('Return only messages with seq greater than this.'),
        limit: z.number().optional(),
      },
    },
    async (a) => {
      if (!core.linkExists(a.link_id)) return text(`No link with id "${a.link_id}".`);
      const msgs = core.readMessages({ linkId: a.link_id, sinceSeq: a.since_seq, limit: a.limit });
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
    async (a) => {
      const r = await core.waitForMessages({ linkId: a.link_id, from: a.from, afterSeq: a.after_seq, timeoutMs: a.timeout_ms });
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
}
