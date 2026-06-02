import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.ts';

const pexec = promisify(execFile);

export type Proc = { pid: number; ppid: number; agent: 'claude' | 'codex'; command: string; cwd?: string };

// Decide whether a process command line is a live agent *session* we could kill.
// Excludes GUI-app helpers, language servers, our own daemon, and short-lived subcommands.
function classify(command: string): 'claude' | 'codex' | null {
  if (/Claude\.app|chrome-native-host|Codex\.app|crashpad|--type=|Helpers\/|Framework|SkyComputerUse|node_repl|kernel\.js|sonar|cli\.ts/i.test(command)) {
    return null;
  }
  const first = command.trim().split(/\s+/)[0] || '';
  const base = first.split('/').pop() || first;
  if (base === 'claude') {
    if (/\bclaude\s+mcp\b/.test(command)) return null;
    return 'claude';
  }
  if (base === 'codex') {
    if (/\bapp-server\b|\bmcp\b/.test(command)) return null; // backends, not a TUI session
    return 'codex';
  }
  return null;
}

export async function detectAgentProcs(): Promise<Proc[]> {
  let out = '';
  try {
    out = (await pexec('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return [];
  }
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const agent = classify(m[3]);
    if (!agent) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), agent, command: m[3].trim() });
  }
  if (procs.length) {
    try {
      const pids = procs.map((p) => p.pid).join(',');
      const { stdout } = await pexec('lsof', ['-a', '-p', pids, '-d', 'cwd', '-Fpn'], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
      let cur = 0;
      const cwds = new Map<number, string>();
      for (const l of stdout.split('\n')) {
        if (l.startsWith('p')) cur = Number(l.slice(1));
        else if (l.startsWith('n')) cwds.set(cur, l.slice(1));
      }
      for (const p of procs) p.cwd = cwds.get(p.pid);
    } catch {
      /* lsof best-effort */
    }
  }
  return procs;
}

export async function listSessions(opts: { recent?: number; activeSecs?: number } = {}) {
  const recent = Math.min(opts.recent ?? 40, 300);
  const activeMs = (opts.activeSecs ?? 180) * 1000;
  const rows = db
    .prepare(
      `SELECT session_id, agent, repo, branch, cwd, path, mtime_ms, size
       FROM idx_files WHERE session_id IS NOT NULL
       ORDER BY mtime_ms DESC LIMIT ?`
    )
    .all(recent) as any[];
  const procs = await detectAgentProcs();
  const now = Date.now();
  return rows.map((r) => {
    let mtime = r.mtime_ms as number;
    let bytes = r.size as number;
    try {
      const st = fs.statSync(r.path); // fresh stat → real-time activity between index polls
      mtime = st.mtimeMs;
      bytes = st.size;
    } catch {
      /* file gone */
    }
    const pids = procs
      .filter((p) => p.agent === r.agent && p.cwd && r.cwd && p.cwd === r.cwd)
      .map((p) => p.pid);
    return {
      session_id: r.session_id,
      agent: r.agent,
      repo: r.repo,
      branch: r.branch,
      cwd: r.cwd,
      path: r.path,
      bytes,
      last_ms: mtime,
      last_iso: new Date(mtime).toISOString(),
      active: now - mtime < activeMs,
      pids,
    };
  });
}

export async function killSession(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  const procs = await detectAgentProcs();
  if (!procs.some((p) => p.pid === pid)) {
    throw new Error(`pid ${pid} is not a detected Claude/Codex session process (refusing to kill).`);
  }
  process.kill(pid, signal);
  return { ok: true, pid, signal };
}

export function listRepos(limit = 30) {
  return db
    .prepare(
      `SELECT cwd, repo, agent, MAX(mtime_ms) AS last_ms
       FROM idx_files WHERE cwd IS NOT NULL
       GROUP BY cwd ORDER BY last_ms DESC LIMIT ?`
    )
    .all(limit) as any[];
}
