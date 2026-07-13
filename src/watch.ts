// Watch DELIVERY: when a coordination event happens (a task finishes, an answer lands,
// a claim is released, a message arrives), fire any matching subscriptions — post a
// targeted message on the link (so the subscriber's wait() loop / unread nudge sees it)
// and, best-effort, wake the subscriber's live tmux pane so a parked agent resumes on
// its own. Registration + matching live in core.ts; this file only delivers.
import * as core from './core.ts';
import { wake } from './tmux.ts';
import { appendLog } from './docs.ts';

/** Label used for hub-originated notification posts — never fires watches itself. */
export const WATCH_LABEL = 'sonar';

export type WatchFire = { id: number; label: string; event: string; woke: boolean };

/**
 * Fire all watches matching (event, arg) on a link. `from` is the actor whose action caused
 * the event — their own watches never fire. Returns what fired (and whether each wake landed).
 * Never throws: watch delivery is a courtesy, not a transaction.
 */
export async function fireWatches(opts: {
  linkId: string;
  event: core.WatchEvent;
  arg?: string | number;
  from: string;
  detail: string;
}): Promise<WatchFire[]> {
  // Hub-originated posts (including our own notifications) never cause fires — no recursion.
  if (opts.from === WATCH_LABEL) return [];
  let matched: any[] = [];
  try {
    matched = core.matchWatches(opts.linkId, opts.event, opts.arg != null ? String(opts.arg) : undefined, opts.from);
  } catch {
    return [];
  }
  // Mark + post synchronously first (so notifications land before this call returns), then run
  // the pane wakes CONCURRENTLY — each wake costs ~0.6s of idle-probing, and serial wakes would
  // stack that latency onto the tool handler that triggered the event.
  const fired: (WatchFire & { scope: string })[] = [];
  const wakes: Promise<void>[] = [];
  for (const w of matched) {
    try {
      core.markWatchFired(w.id);
      const scope = w.arg ? `(${w.event} ${w.arg})` : `(${w.event})`;
      // The message notifies universally — any session in a wait() loop (or seeing the unread
      // nudge) learns why it was pinged without needing a tmux pane.
      core.postMessage({
        linkId: opts.linkId,
        from: WATCH_LABEL,
        body: `📣 ${w.label}: your watch ${scope} fired — ${opts.detail}${w.once ? '' : ' (watch stays active)'}`,
      });
      const entry = { id: w.id, label: w.label, event: w.event, woke: false, scope };
      fired.push(entry);
      // Best-effort pane wake: idle-gated + loop-capped by tmux.ts. A busy or non-tmux
      // session just keeps the message; nothing to clean up on failure.
      wakes.push(
        wake({
          linkId: opts.linkId,
          label: w.label,
          message: `Your sonar watch fired on link ${opts.linkId}: ${opts.detail}. Call doc_read(link_id="${opts.linkId}") and read(link_id="${opts.linkId}") to catch up, then continue.`,
        })
          .then((r) => {
            entry.woke = !!r.ok;
          })
          .catch(() => {})
      );
    } catch {
      /* one bad watch must not stop the rest */
    }
  }
  await Promise.allSettled(wakes);
  for (const f of fired) {
    try {
      appendLog(opts.linkId, WATCH_LABEL, `watch fired for **${f.label}** ${f.scope}: ${opts.detail}${f.woke ? ' · woke pane' : ''}`);
    } catch {
      /* log is best-effort */
    }
  }
  return fired.map(({ scope: _scope, ...f }) => f);
}

/**
 * Implicit watch(message) for everyone: after new activity on a link, try to wake EVERY other
 * participant with unread messages — no explicit watch() registration required, so two agents
 * ping-pong on their own. Only reaches live sonar tmux panes (a no-op otherwise; non-tmux
 * sessions are covered by the Stop-hook nudge instead). Idle-gate + loop-cap live in tmux.ts.
 * Fire-and-forget: call it un-awaited so posting never pays the pane-probe latency.
 */
export async function autoWakePeers(opts: { linkId: string; from: string; detail: string }): Promise<void> {
  if (opts.from === WATCH_LABEL) return;
  try {
    const peers = core.listParticipants(opts.linkId).filter((p) => p.label !== opts.from && p.label !== WATCH_LABEL);
    await Promise.allSettled(
      peers.map(async (p) => {
        if (!core.unreadFor(opts.linkId, p.label).count) return;
        const r = await wake({
          linkId: opts.linkId,
          label: p.label,
          message: `New activity on sonar link ${opts.linkId}: ${opts.detail}. Call read(link_id="${opts.linkId}", from="${p.label}") and doc_read(link_id="${opts.linkId}") to catch up, handle anything addressed to you, then reply on the link.`,
        });
        if (r.ok) {
          try {
            appendLog(opts.linkId, WATCH_LABEL, `auto-woke **${p.label}** (new activity from ${opts.from})`);
          } catch {
            /* log is best-effort */
          }
        }
      })
    );
  } catch {
    /* wake delivery is a courtesy, never a failure */
  }
}
