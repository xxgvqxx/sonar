import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { DATA_DIR, MCP_URL } from './config.ts';
import { docPath, ensureDoc } from './docs.ts';

const pexec = promisify(execFile);
const WORKTREES = path.join(DATA_DIR, 'worktrees');

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
    `3. Work the task. The shared doc is the source of truth — keep it updated as you go:`,
    `   • Add findings/answers with doc_append (link_id, section="Answers" or "Context" or "Decisions", text=..., from="${opts.agent}@worker").`,
    `   • If you are blocked and need input from the other agent or the human, add a question with doc_append (section="Open questions", ...) and call post(...) with a one-line ping.`,
    `4. Periodically call wait(link_id="${opts.linkId}", from="${opts.agent}@worker", timeout_ms=30000) to receive replies; re-read the doc when pinged. Loop a few times if you are waiting on an answer.`,
    `5. When finished, write a short summary to the doc (section "Decisions" or "Answers") and post a final "done" message.`,
    ``,
    `Always treat the shared doc as how the human follows along — write clearly into it rather than only in your terminal.`,
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

  // Keep control files OUT of the user's repo: store prompt/launcher/log under ~/.sonar
  // (when workdir is an isolated worktree this also keeps it clean).
  const ctrlDir = path.join(DATA_DIR, 'workers', `${opts.linkId}-${suffix}`);
  fs.mkdirSync(ctrlDir, { recursive: true });
  const prompt = workerPrompt({ linkId: opts.linkId, agent, task: opts.task, cwd: workdir, branch });
  const promptFile = path.join(ctrlDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  const bin = agent === 'codex' ? 'codex' : 'claude';

  if (opts.dryRun) {
    return { agent, workdir, branch, mode: 'dry-run', doc: docPath(opts.linkId), promptFile };
  }

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
    return { agent, workdir, branch, mode: 'headless', pid: child.pid, log: logFile, doc: docPath(opts.linkId) };
  }

  // interactive: launch via a script file so no prompt text/quotes leak into the
  // shell or AppleScript (fixes Terminal.app breaking on quotes in the prompt).
  const launcher = path.join(ctrlDir, 'launch.sh');
  fs.writeFileSync(launcher, `#!/bin/zsh\ncd ${q(workdir)} || exit 1\nexec ${bin} "$(cat ${q(promptFile)})"\n`);
  fs.chmodSync(launcher, 0o755);
  const terminal = opts.terminal || readTerminalPref();
  launchTerminal(terminal, workdir, `zsh ${q(launcher)}`);
  return { agent, workdir, branch, mode: 'interactive', terminal, doc: docPath(opts.linkId) };
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
