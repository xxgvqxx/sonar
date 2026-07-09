// Autopilot: a self-EXECUTING task board. When enabled on a link, any task that becomes
// ready (status "todo", unblocked, not yet dispatched) is dispatched by the hub itself:
//   • task has an assignee  → wake that participant's live tmux pane (best-effort) + ping them
//   • task is unassigned    → spawn a worker in an isolated worktree whose whole mission is
//                             that one task (claim it → work it → mark it done)
// Completion cascades naturally: a worker's task_update(status="done") auto-unblocks
// dependents (core.ts), and the tool handler calls dispatchReady() again — so a dependency
// graph executes itself, gated by the operator's quality-gate hooks at every "done".
//
// Guardrails: per-link concurrency cap (default 2), dispatched_at prevents double-dispatch,
// resetting a task to "todo" re-arms it, and `sonar autopilot <id> off` stops future dispatch.
// SONAR_AUTOPILOT_DRY=1 makes dispatch a dry-run (no real processes) — used by tests.
import * as core from './core.ts';
import { spawnWorker } from './spawn.ts';
import { wake } from './tmux.ts';
import { appendLog } from './docs.ts';
import { WATCH_LABEL } from './watch.ts';

const DEFAULT_MAX = 2;
const MAX_MAX = 8;

const dryRun = () => {
  const v = (process.env.SONAR_AUTOPILOT_DRY || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

export type Dispatch = { num: number; title: string; via: 'worker' | 'wake' | 'ping' | 'dry-run'; assignee?: string; error?: string };

/** The one-task mission handed to a spawned worker (wrapped by spawn.ts's generic worker protocol). */
function taskMission(linkId: string, num: number, title: string, label: string, note?: string): string {
  return [
    `Work EXACTLY ONE task from this link's shared task board: task #${num} — "${title}".${note ? ` Note: ${note}` : ''}`,
    ``,
    `Board protocol (do this in addition to the worker protocol below):`,
    `1. Claim it first: task_update(link_id="${linkId}", num=${num}, from="${label}", status="doing", assignee="${label}").`,
    `2. Read the doc (Context / Decisions) before you start; respect any claims other participants hold (use claim() before editing shared files).`,
    `3. Do the work. Verify it (run the relevant tests/build if the repo has them).`,
    `4. Mark it finished: task_update(link_id="${linkId}", num=${num}, from="${label}", status="done"). An operator quality-gate may run — if it blocks you, fix the problem and retry rather than giving up.`,
    `5. Do NOT pick up other tasks — finishing yours may auto-unblock dependents, and the hub dispatches those itself.`,
    `If you cannot complete it, task_update(..., status="blocked", note="<why>") and describe the blocker under "Open questions" so a human or another agent can pick it up.`,
  ].join('\n');
}

/**
 * Dispatch every ready task on the link, up to the concurrency cap. Called after any task
 * mutation (add / done / reset) and when autopilot is switched on. Safe to call repeatedly —
 * dispatched_at makes it idempotent. Never throws.
 */
export async function dispatchReady(linkId: string, opts: { trigger?: string } = {}): Promise<Dispatch[]> {
  let cfg: core.AutopilotConfig | null;
  try {
    cfg = core.getAutopilot(linkId);
  } catch {
    return [];
  }
  if (!cfg?.on) return [];

  const max = Math.min(Math.max(cfg.max ?? DEFAULT_MAX, 1), MAX_MAX);
  const out: Dispatch[] = [];

  for (const snap of core.readyTasks(linkId)) {
    if (core.inflightTasks(linkId).length >= max) break; // re-count each round: dispatches below add to it

    // Re-fetch: the awaits below yield the event loop, so a concurrent dispatch pass may have
    // taken (or a peer may have claimed/blocked) a task after our snapshot — never double-dispatch.
    const t = core.getTask(linkId, snap.num);
    if (!t || t.status !== 'todo' || t.dispatched_at) continue;
    // Tasks created by a RELAY (remote member-token) session are held: autopilot must not turn a
    // coordination-only token into code exec on the hub host. A local participant approves one by
    // touching it (any task_update from a local session clears the hold).
    if (t.created_remote) continue;

    if (t.assignee) {
      // Assigned to a known participant — nudge them rather than spawning a duplicate brain.
      // Mark dispatched FIRST so a concurrent dispatch pass can't double-ping.
      core.markDispatched(linkId, t.num);
      core.postMessage({
        linkId,
        from: WATCH_LABEL,
        body: `🤖 autopilot: task #${t.num} "${t.title}" is ready — assigned to ${t.assignee}. Claim it with task_update(num=${t.num}, status="doing").`,
      });
      let via: Dispatch['via'] = 'ping';
      try {
        const r = await wake({
          linkId,
          label: t.assignee,
          message: `Autopilot: task #${t.num} "${t.title}" on sonar link ${linkId} is ready and assigned to you. task_update(link_id="${linkId}", num=${t.num}, from="${t.assignee}", status="doing") then work it; mark it done when verified.`,
        });
        if (r.ok) via = 'wake';
      } catch {
        /* no pane — the ping message stands */
      }
      appendLog(linkId, WATCH_LABEL, `autopilot dispatched **#${t.num}** to ${t.assignee} (${via})${opts.trigger ? ` · trigger: ${opts.trigger}` : ''}`);
      out.push({ num: t.num, title: t.title, via, assignee: t.assignee });
      continue;
    }

    // Unassigned → spawn a dedicated worker. Reserve the task before the (async) spawn so a
    // concurrent pass can't dispatch it twice; un-reserve if the spawn fails so it can retry.
    const label = `${cfg.agent || 'claude'}@task-${t.num}`;
    core.markDispatched(linkId, t.num, label);
    try {
      const r = await spawnWorker({
        linkId,
        agent: cfg.agent,
        task: taskMission(linkId, t.num, t.title, label, t.note),
        cwd: cfg.cwd,
        headless: cfg.headless,
        label,
        dryRun: dryRun(),
      });
      const via: Dispatch['via'] = dryRun() ? 'dry-run' : 'worker';
      core.postMessage({
        linkId,
        from: WATCH_LABEL,
        body: `🤖 autopilot: spawned ${label} (${r.mode}) for task #${t.num} "${t.title}"${r.branch ? ` · worktree branch ${r.branch}` : ''}`,
      });
      appendLog(linkId, WATCH_LABEL, `autopilot spawned **${label}** for **#${t.num}** (${r.mode})${opts.trigger ? ` · trigger: ${opts.trigger}` : ''}`);
      out.push({ num: t.num, title: t.title, via, assignee: label });
    } catch (e) {
      rearm(linkId, t.num);
      const msg = (e as Error).message;
      core.postMessage({ linkId, from: WATCH_LABEL, body: `⚠️ autopilot: could not spawn a worker for task #${t.num}: ${msg}` });
      out.push({ num: t.num, title: t.title, via: 'worker', error: msg });
    }
  }
  return out;
}

/** Clear a failed dispatch so the task is picked up again next pass (status→todo drops the
 *  dispatched_at reservation AND the minted @task-N assignee — see core.updateTask). */
function rearm(linkId: string, num: number) {
  try {
    core.updateTask({ linkId, num, status: 'todo' });
  } catch {
    /* best effort */
  }
}

/** Enable/disable autopilot and immediately dispatch anything already ready. */
export async function setAutopilot(
  linkId: string,
  cfg: (Omit<core.AutopilotConfig, 'on'> & { on: boolean }) | { on: false }
): Promise<{ config: core.AutopilotConfig | null; dispatched: Dispatch[] }> {
  const saved = core.setAutopilot(linkId, cfg.on ? (cfg as core.AutopilotConfig) : null);
  core.postMessage({
    linkId,
    from: WATCH_LABEL,
    body: cfg.on
      ? `🤖 autopilot ON — ready tasks are dispatched automatically (max ${Math.min(Math.max((cfg as any).max ?? DEFAULT_MAX, 1), MAX_MAX)} in flight${(cfg as any).agent ? `, agent ${(cfg as any).agent}` : ''}).`
      : '🤖 autopilot OFF — tasks are no longer auto-dispatched.',
  });
  appendLog(linkId, WATCH_LABEL, cfg.on ? 'autopilot enabled' : 'autopilot disabled');
  const dispatched = cfg.on ? await dispatchReady(linkId, { trigger: 'autopilot enabled' }) : [];
  return { config: saved, dispatched };
}
