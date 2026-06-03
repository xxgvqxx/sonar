import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { DATA_DIR, MCP_URL } from './config.ts';
import { docPath, ensureDoc } from './docs.ts';
import { tmuxAvailable, launchWindow, recordPane } from './tmux.ts';

const pexec = promisify(execFile);
const WORKTREES = path.join(DATA_DIR, 'worktrees');
const WORKERS = path.join(DATA_DIR, 'workers');
/** A headless worker whose log hasn't been written to in this long is treated as stalled.
 *  Generous (5 min) so a long quiet operation — a big test run, a slow build — that
 *  writes no stdout isn't mislabelled stalled. It's a soft glance-signal, not an alert. */
const STALL_MS = 300_000;

/** Is a pid still alive? (signal 0 = existence check; EPERM still means alive.) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readTerminalPref(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'menubar.json'), 'utf8')).terminal || 'ghostty';
  } catch {
    return 'ghostty';
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function workerPrompt(opts: { linkId: string; agent: string; task: string; cwd: string; branch?: string }): string {
  return [
    `You are a sonar WORKER agent (label "${opts.agent}@worker"). You were spawned to collaborate with other Claude Code / Codex sessions through the sonar hub (MCP server "sonar", ${MCP_URL}).`,
    ``,
    `Link: ${opts.linkId}`,
    `Shared doc: ${docPath(opts.linkId)}`,
    `Working dir: ${opts.cwd}${opts.branch ? ` (git branch ${opts.branch})` : ''}`,
    ``,
    `YOUR TASK:`,
    opts.task,
    ``,
    `PROTOCOL — follow this exactly:`,
    `1. Call link_join (link_id="${opts.linkId}", label="${opts.agent}@worker", agent="${opts.agent}", cwd="${opts.cwd}"${opts.branch ? `, branch="${opts.branch}"` : ''}).`,
    `2. Call doc_read (link_id="${opts.linkId}") to load shared context and any Open questions.`,
    `3. Immediately post(link_id="${opts.linkId}", from="${opts.agent}@worker", body="▶ starting: <one-line plan>") so the human and other agents know you're alive and what you're about to do.`,
    `4. Work the task in CHECKPOINTS. This may run for many minutes — do NOT go silent for long stretches:`,
    `   • After each meaningful step (and at least every few minutes on long work), post(...) a one-line progress update, and append substantive findings to the doc with doc_append (section="Answers"/"Context"/"Decisions", from="${opts.agent}@worker").`,
    `   • At each checkpoint also do a quick wait(link_id="${opts.linkId}", from="${opts.agent}@worker", timeout_ms=2000) (or read) to pick up any new instructions or redirection from the other agent / human, and re-read the doc if pinged. Don't run 15+ minutes without checking in.`,
    `5. If you get blocked, add the question with doc_append (section="Open questions", ...), post(...) a one-line ping, then wait() in a loop for the answer.`,
    `6. When finished, append a short summary to the doc (section "Decisions"/"Answers") and post a final "✅ done: <summary>". If you fail or give up, post "✖ failed: <reason>" so watchers aren't left hanging.`,
    ``,
    `Treat the shared doc as how the human follows along, and treat your progress posts as a heartbeat — a silent worker looks dead. Write clearly into the doc rather than only in your terminal.`,
  ].join('\n');
}

function launchTerminal(terminal: string, dir: string, cmd: string) {
  const keep = `${cmd}; exec zsh`;
  if (terminal === 'ghostty') {
    spawn('open', ['-na', 'Ghostty', '--args', `--working-directory=${dir}`, '-e', 'zsh', '-lc', keep], { detached: true, stdio: 'ignore' }).unref();
  } else if (terminal === 'iterm') {
    const script = `tell application "iTerm2"\n create window with default profile\n tell current session of current window to write text "cd ${q(dir)} && ${cmd}"\n activate\nend tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const script = `tell application "Terminal" to do script "cd ${q(dir)} && ${cmd}"`;
    spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Spawn a worker agent session pre-joined to a link.
 * Creates an isolated git worktree on a temp branch (if cwd is a git repo) and
 * launches `claude`/`codex` there with an initial prompt that joins the link.
 */
export async function spawnWorker(opts: {
  linkId: string;
  agent?: 'claude' | 'codex';
  task: string;
  cwd?: string;
  headless?: boolean;
  terminal?: string;
  dryRun?: boolean;
}) {
  const agent = opts.agent || 'claude';
  const baseCwd = opts.cwd || process.cwd();
  ensureDoc(opts.linkId);

  const suffix = crypto.randomBytes(2).toString('hex');
  const root = await gitRoot(baseCwd);
  let workdir = baseCwd;
  let branch: string | undefined;

  if (root) {
    branch = `sonar/${opts.linkId}-${suffix}`;
    workdir = path.join(WORKTREES, `${opts.linkId}-${suffix}`);
    fs.mkdirSync(WORKTREES, { recursive: true });
    try {
      await pexec('git', ['-C', root, 'worktree', 'add', '-b', branch, workdir], { timeout: 20000 });
    } catch (e) {
      throw new Error(`git worktree add failed: ${(e as Error).message}`);
    }
  }

  // Keep control files OUT of the user's repo: store prompt/launcher/log/meta under ~/.sonar
  // (when workdir is an isolated worktree this also keeps it clean).
  const workerId = `${opts.linkId}-${suffix}`;
  const ctrlDir = path.join(WORKERS, workerId);
  fs.mkdirSync(ctrlDir, { recursive: true });
  const prompt = workerPrompt({ linkId: opts.linkId, agent, task: opts.task, cwd: workdir, branch });
  const promptFile = path.join(ctrlDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  const bin = agent === 'codex' ? 'codex' : 'claude';

  if (opts.dryRun) {
    return { worker_id: workerId, agent, workdir, branch, mode: 'dry-run', doc: docPath(opts.linkId), promptFile };
  }

  // Persist a worker record so the hub/menu bar can list it and report status.
  const recordWorker = (extra: Record<string, unknown>) => {
    const meta = {
      id: workerId,
      link_id: opts.linkId,
      agent,
      task: opts.task.slice(0, 280),
      workdir,
      branch: branch ?? null,
      started_at: new Date().toISOString(),
      ...extra,
    };
    try {
      fs.writeFileSync(path.join(ctrlDir, 'meta.json'), JSON.stringify(meta, null, 2));
    } catch {
      /* non-fatal: worker still runs, just won't show status */
    }
  };

  if (opts.headless) {
    const logFile = path.join(ctrlDir, 'worker.log');
    const out = fs.openSync(logFile, 'a');
    // headless: non-interactive, auto-approve tools (worker runs in an isolated worktree)
    const args =
      agent === 'codex'
        ? ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]
        : ['-p', prompt, '--permission-mode', 'bypassPermissions'];
    const child = spawn(bin, args, { cwd: workdir, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    recordWorker({ mode: 'headless', pid: child.pid ?? null, log: logFile });
    return { worker_id: workerId, agent, workdir, branch, mode: 'headless', pid: child.pid, log: logFile, doc: docPath(opts.linkId) };
  }

  // interactive: launch via a script file so no prompt text/quotes leak into the
  // shell or AppleScript (fixes Terminal.app breaking on quotes in the prompt).
  const launcher = path.join(ctrlDir, 'launch.sh');
  fs.writeFileSync(launcher, `#!/bin/zsh\ncd ${q(workdir)} || exit 1\nexec ${bin} "$(cat ${q(promptFile)})"\n`);
  fs.chmodSync(launcher, 0o755);
  const terminal = opts.terminal || readTerminalPref();
  const launchCmd = `zsh ${q(launcher)}`;
  const label = `${agent}@worker`;

  // tmux mode: launch in a named tmux window so sonar can wake/talk to the live pane.
  if (terminal === 'tmux' && (await tmuxAvailable())) {
    const target = await launchWindow({ window: workerId, cwd: workdir, cmd: launchCmd });
    recordWorker({ mode: 'tmux', pid: null, log: null, target });
    recordPane({ id: workerId, target, link_id: opts.linkId, label, agent, cwd: workdir, kind: 'worker' });
    return { worker_id: workerId, agent, workdir, branch, mode: 'tmux', target, label, doc: docPath(opts.linkId) };
  }

  launchTerminal(terminal, workdir, launchCmd);
  recordWorker({ mode: 'interactive', pid: null, log: null });
  return { worker_id: workerId, agent, workdir, branch, mode: 'interactive', terminal, doc: docPath(opts.linkId) };
}

/** Derive a worker's live status from its process + log heartbeat. */
function workerStatus(meta: any): 'running' | 'stalled' | 'finished' | 'interactive' | 'unknown' {
  if (meta.mode === 'interactive' || meta.mode === 'tmux') return 'interactive';
  if (!meta.pid) return 'unknown';
  if (!alive(meta.pid)) return 'finished';
  try {
    const age = Date.now() - fs.statSync(meta.log).mtimeMs;
    return age > STALL_MS ? 'stalled' : 'running';
  } catch {
    return 'running';
  }
}

/** List worker records (optionally for one link), each enriched with live status.
 *  Old finished workers are dropped so the list doesn't grow without bound. */
export async function listWorkers(linkId?: string) {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(WORKERS);
  } catch {
    return [];
  }
  const cutoff = Date.now() - 3 * 86_400_000;
  const out: any[] = [];
  for (const d of dirs) {
    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(WORKERS, d, 'meta.json'), 'utf8'));
    } catch {
      continue; // no meta yet (or a dry-run dir) — skip
    }
    if (linkId && meta.link_id !== linkId) continue;
    const status = workerStatus(meta);
    const started = Date.parse(meta.started_at || '') || 0;
    if (status === 'finished' && started && started < cutoff) continue;
    out.push({ ...meta, status });
  }
  out.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return out;
}

/** Stop a running headless worker (SIGTERM its process). */
export async function stopWorker(id: string) {
  let meta: any;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(WORKERS, id, 'meta.json'), 'utf8'));
  } catch {
    return { ok: false, error: 'no such worker' };
  }
  if (meta.mode !== 'headless' || !meta.pid) return { ok: false, error: 'not a headless worker (no tracked process)' };
  if (!alive(meta.pid)) return { ok: false, error: 'worker already exited' };
  try {
    process.kill(meta.pid, 'SIGTERM');
    return { ok: true, stopped: meta.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listWorktrees(): Promise<string[]> {
  try {
    return fs.readdirSync(WORKTREES);
  } catch {
    return [];
  }
}

export async function pruneWorktree(name: string) {
  const wt = path.join(WORKTREES, name);
  // The owning repo is the worktree's common git dir's parent — NOT the worktree
  // itself (you can't `git worktree remove` the tree you're standing in).
  let mainRepo: string | null = null;
  try {
    const { stdout } = await pexec('git', ['-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    mainRepo = path.dirname(stdout.trim());
  } catch {
    /* no longer a registered worktree */
  }
  if (mainRepo) {
    try {
      await pexec('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wt]);
    } catch {
      /* fall through to manual rm */
    }
  }
  fs.rmSync(wt, { recursive: true, force: true });
  if (mainRepo) {
    try {
      await pexec('git', ['-C', mainRepo, 'worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }
  return { removed: name };
}
