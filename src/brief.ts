// Session-start briefing: everything a fresh session should know about a repo, in one call —
// recent sessions there (from the transcript index), the tail of the most recent conversation,
// and the live state of any active links whose participants are in that repo (open tasks,
// held claims, open questions, decisions, autopilot). The point is continuity without the
// human re-pasting context: "call brief() first" is injected into session-init.
import { db } from './db.ts';
import * as core from './core.ts';
import * as docs from './docs.ts';
import { repoForCwd } from './indexer.ts'; // same (memoised) repo naming as the index itself

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Last N lines of a doc section's body (header stripped), or null if effectively empty. */
function sectionTail(linkId: string, section: string, maxLines = 15): string | null {
  let text: string;
  try {
    text = docs.readDoc(linkId, { section });
  } catch {
    return null;
  }
  const body = text
    .split('\n')
    .filter((l) => !/^##\s+/.test(l))
    .map((l) => l.trimEnd());
  while (body.length && !body[0]) body.shift();
  while (body.length && !body[body.length - 1]) body.pop();
  if (!body.length || /^\(no section /.test(body[0])) return null;
  return body.slice(-maxLines).join('\n');
}

export type Brief = {
  repo?: string;
  sessions: any[];
  last_session?: { session_id: string; agent: string; branch?: string; turns: { role: string; text: string; ts?: string }[] };
  links: {
    id: string;
    title?: string;
    participants: string[];
    autopilot: boolean;
    open_tasks: any[];
    claims: any[];
    watches: number;
    open_questions?: string | null;
    decisions?: string | null;
  }[];
};

export function brief(opts: { repo?: string; cwd?: string; branch?: string; days?: number } = {}): Brief {
  const repo = opts.repo || repoForCwd(opts.cwd) || undefined;
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);

  const sessions = repo ? core.recentSessions({ repo, branch: opts.branch, limit: 8 }) : core.recentSessions({ limit: 8 });

  // Tail of the most recent conversation in this repo — what "last time" was about.
  let last_session: Brief['last_session'];
  const newest = sessions[0];
  if (newest?.session_id) {
    const rows = db
      .prepare(`SELECT role, text, ts FROM transcripts WHERE session_id = ? ORDER BY ts DESC LIMIT 8`)
      .all(newest.session_id) as any[];
    if (rows.length) {
      last_session = {
        session_id: newest.session_id,
        agent: newest.agent,
        branch: newest.branch ?? undefined,
        turns: rows.reverse().map((r) => ({ role: r.role, text: clip(String(r.text).replace(/\s+/g, ' ').trim(), 240), ts: r.ts })),
      };
    }
  }

  // Active links whose participants are in this repo (match by indexed repo name, falling
  // back to the repo derived from their reported cwd). No repo → all recent links.
  const links: Brief['links'] = [];
  for (const l of core.listLinks({ activeDays: days })) {
    const parts = core.listParticipants(l.id);
    const inRepo = !repo || parts.some((p) => p.repo === repo || (p.cwd && repoForCwd(p.cwd) === repo));
    if (!inRepo) continue;
    links.push({
      id: l.id,
      title: l.title ?? undefined,
      participants: parts.map((p) => p.label),
      autopilot: !!core.getAutopilot(l.id)?.on,
      open_tasks: core.listTasks({ linkId: l.id }).filter((t) => t.status !== 'done'),
      claims: core.listClaims(l.id),
      watches: core.listWatches(l.id).length,
      open_questions: sectionTail(l.id, 'Open questions'),
      decisions: sectionTail(l.id, 'Decisions'),
    });
  }

  return { repo, sessions, last_session, links };
}

const fmtTime = (iso?: string) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16) : '');

/** Render a Brief as terminal/agent-friendly text (shared by the MCP tool and the CLI). */
export function formatBrief(b: Brief): string {
  const out: string[] = [];
  out.push(`BRIEF${b.repo ? ` — repo "${b.repo}"` : ''}`);

  if (b.sessions.length) {
    out.push('', `Recent sessions:`);
    for (const s of b.sessions.slice(0, 6)) {
      out.push(`  • ${s.agent} · ${s.repo ?? '?'}${s.branch ? '/' + s.branch : ''} · ${String(s.session_id || '').slice(0, 8)} · ${fmtTime(s.indexed_at)}`);
    }
  } else {
    out.push('', '(no indexed sessions for this repo — the indexer may still be backfilling)');
  }

  if (b.last_session) {
    out.push('', `Tail of the most recent session (${b.last_session.agent} · ${String(b.last_session.session_id).slice(0, 8)}):`);
    for (const t of b.last_session.turns) out.push(`  [${t.role}] ${t.text}`);
    out.push(`  (dig deeper with search_context(query="…", session_id="${b.last_session.session_id}"))`);
  }

  if (b.links.length) {
    for (const l of b.links) {
      out.push('', `Link ${l.id}${l.title ? ` — ${l.title}` : ''}  (participants: ${l.participants.join(', ') || 'none'}${l.autopilot ? ' · autopilot ON' : ''})`);
      if (l.open_tasks.length) {
        out.push(`  Open tasks:`);
        for (const t of l.open_tasks) out.push(`    #${t.num} [${t.status}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`);
      }
      if (l.claims.length) {
        out.push(`  Active claims:`);
        for (const c of l.claims) out.push(`    ${c.resource} — ${c.holder} (until ${fmtTime(c.expires_at)})`);
      }
      if (l.open_questions) out.push(`  Open questions:`, ...l.open_questions.split('\n').map((x) => `    ${x}`));
      if (l.decisions) out.push(`  Decisions:`, ...l.decisions.split('\n').map((x) => `    ${x}`));
      out.push(`  Catch up / rejoin: link_join(link_id="${l.id}", …) or doc_read(link_id="${l.id}")`);
    }
  } else {
    out.push('', '(no active links for this repo)');
  }

  return out.join('\n');
}
