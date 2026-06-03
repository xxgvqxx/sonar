// Talk to a *live* agent pane: launch managed sessions inside a tmux window so
// sonar can type a prompt into the exact pane with `send-keys` — i.e. wake a
// paused agent to run another turn, with its full context, in place.
// macOS has no TIOCSTI and Ghostty isn't scriptable, so tmux is the channel.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.ts';

const pexec = promisify(execFile);
const PANES = path.join(DATA_DIR, 'panes');
export const TMUX_SESSION = 'sonar'; // all managed agent windows live under this tmux session

const QUIESCE_MS = 450; // capture the pane twice this far apart; unchanged ⇒ idle
const WAKE_WINDOW_MS = 10 * 60_000; // loop-cap window
const WAKE_MAX = 5; // ...max wakes per pane per window
const DEAD_TTL_MS = 6 * 3_600_000; // prune dead pane records older than this
const BUSY_HINT = /esc to (interrupt|cancel)/i; // a turn is running

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await pexec('tmux', args, { timeout: 8000 });
  return stdout;
}
async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    await pexec('tmux', args, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export async function tmuxAvailable(): Promise<boolean> {
  return tmuxOk(['-V']);
}

const sanitizeWindow = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40) || 'agent';

/** Launch `cmd` in a fresh tmux window under the `sonar` session; returns its target. */
export async function launchWindow(opts: { window: string; cwd: string; cmd: string }): Promise<string> {
  const win = sanitizeWindow(opts.window);
  const target = `${TMUX_SESSION}:${win}`;
  if (!(await tmuxOk(['has-session', '-t', TMUX_SESSION]))) {
    // create the session+window; if a race already created the session, fall back to a new window
    if (!(await tmuxOk(['new-session', '-d', '-s', TMUX_SESSION, '-n', win, '-c', opts.cwd, opts.cmd]))) {
      await tmux(['new-window', '-t', TMUX_SESSION, '-n', win, '-c', opts.cwd, opts.cmd]);
    }
  } else {
    await tmux(['new-window', '-t', TMUX_SESSION, '-n', win, '-c', opts.cwd, opts.cmd]);
  }
  return target;
}

// ---- pane registry (maps a managed pane → tmux target + link/label) ----------
const paneFile = (id: string) => path.join(PANES, `${id}.json`);

export function recordPane(rec: {
  id: string;
  target: string;
  link_id?: string;
  label?: string;
  agent?: string;
  cwd: string;
  kind: string;
}) {
  fs.mkdirSync(PANES, { recursive: true });
  fs.writeFileSync(paneFile(rec.id), JSON.stringify({ ...rec, started_at: new Date().toISOString(), wakes: [] }, null, 2));
}

function readPane(id: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(paneFile(id), 'utf8'));
  } catch {
    return null;
  }
}

async function paneAlive(target: string): Promise<boolean> {
  return tmuxOk(['list-panes', '-t', target]);
}

/** List managed panes (optionally for one link), each with a live `alive` flag. */
export async function listPanes(linkId?: string) {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(PANES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const id of ids) {
    const p = readPane(id);
    if (!p) continue;
    const alive = await paneAlive(p.target);
    if (!alive) {
      // prune long-dead records so the list doesn't grow forever
      const started = Date.parse(p.started_at || '') || 0;
      if (started && Date.now() - started > DEAD_TTL_MS) {
        try {
          fs.unlinkSync(paneFile(id));
        } catch {
          /* best effort */
        }
        continue;
      }
    }
    if (linkId && p.link_id !== linkId) continue;
    out.push({ ...p, alive });
  }
  out.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return out;
}

async function capturePane(target: string): Promise<string> {
  return tmux(['capture-pane', '-p', '-t', target]);
}

/** Idle = the pane's output is quiescent and shows no running-turn hint. */
export async function isIdle(target: string): Promise<{ idle: boolean; reason: string }> {
  let a: string;
  try {
    a = await capturePane(target);
  } catch {
    return { idle: false, reason: 'pane not found' };
  }
  await sleep(QUIESCE_MS);
  let b: string;
  try {
    b = await capturePane(target);
  } catch {
    return { idle: false, reason: 'pane not found' };
  }
  if (a !== b) return { idle: false, reason: 'pane output is still changing (mid-turn)' };
  if (BUSY_HINT.test(a.slice(-600))) return { idle: false, reason: 'pane shows a running turn' };
  return { idle: true, reason: 'quiescent' };
}

/** Type `text` into the pane and submit it (Enter), as if the human typed it. */
export async function sendPrompt(target: string, text: string) {
  const line = text.replace(/\s+/g, ' ').trim(); // single line — an embedded newline would submit early
  await tmux(['send-keys', '-t', target, '-l', line]);
  await sleep(140); // let the composer settle before submitting
  await tmux(['send-keys', '-t', target, 'Enter']);
}

/** Wake the live pane for (linkId, label): idle-gated, loop-capped, types a prompt. */
export async function wake(opts: { linkId: string; label: string; message?: string; force?: boolean }) {
  const panes = await listPanes(opts.linkId);
  const pane = panes.find((p) => p.label === opts.label);
  if (!pane) return { ok: false, error: `no sonar-launched tmux pane for "${opts.label}" on ${opts.linkId}. Spawn one with the terminal set to tmux, or resume instead.` };
  if (!pane.alive) return { ok: false, error: `that pane is no longer live (the "${opts.label}" session exited).` };

  const now = Date.now();
  const recent = (pane.wakes || []).filter((t: number) => now - t < WAKE_WINDOW_MS);
  if (recent.length >= WAKE_MAX) {
    return { ok: false, error: `wake loop cap hit (${WAKE_MAX} per ${WAKE_WINDOW_MS / 60_000}min) for "${opts.label}" — backing off.` };
  }

  if (!opts.force) {
    const { idle, reason } = await isIdle(pane.target);
    if (!idle) return { ok: false, busy: true, error: `pane is busy: ${reason}. Pass force to inject anyway.` };
  }

  const msg =
    (opts.message && opts.message.trim()) ||
    `A new update arrived on sonar link ${opts.linkId} — call doc_read(link_id="${opts.linkId}") and read(link_id="${opts.linkId}") to catch up, then continue and reply on the link.`;
  await sendPrompt(pane.target, msg);

  recent.push(now);
  pane.wakes = recent;
  try {
    fs.writeFileSync(paneFile(pane.id), JSON.stringify(pane, null, 2));
  } catch {
    /* best effort */
  }
  return { ok: true, target: pane.target, label: opts.label, message: msg };
}
