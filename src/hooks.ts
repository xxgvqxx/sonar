import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

// Operator-defined quality gates. A coordination event (a task being created / marked done) can
// run a configured shell command on the HUB host; a non-zero exit blocks the operation and the
// command's output is surfaced as the reason. Inspired by Claude Code agent-team hooks.
//
// Config: ~/.sonar/hooks.json — a flat map of event -> shell command, e.g.
//   { "task_completed": "npm test --silent", "task_created": "./scripts/validate-task.sh" }
// (a top-level { "hooks": { … } } wrapper is also accepted). Context is passed as env vars:
//   SONAR_EVENT, SONAR_LINK, SONAR_FROM, SONAR_NUM, SONAR_TITLE, SONAR_STATUS.

export const HOOKS_FILE = path.join(DATA_DIR, 'hooks.json');
const HOOK_TIMEOUT_MS = Number(process.env.SONAR_HOOK_TIMEOUT_MS || 120_000);

export type HookEvent = 'task_created' | 'task_completed';

export function loadHooks(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8'));
    if (j && typeof j === 'object') return (j.hooks && typeof j.hooks === 'object' ? j.hooks : j) as Record<string, string>;
  } catch {
    /* no/invalid hooks file → no gates */
  }
  return {};
}

export type HookResult = { ran: boolean; allowed: boolean; output: string };

/**
 * Run the gate for `event`, if one is configured. Resolves async (awaited from the tool handler)
 * so a slow gate — a test run — never blocks the hub's event loop or other sessions.
 *
 * Semantics: exit 0 → allowed. Non-zero exit / timeout → blocked (the gate ran and said no).
 * Failure to even START the command (e.g. ENOENT) → allowed, but loudly — a misconfigured hook
 * shouldn't wedge the whole board.
 */
export async function runHook(event: HookEvent, ctx: Record<string, string | number | undefined> = {}): Promise<HookResult> {
  const cmd = loadHooks()[event];
  if (!cmd || typeof cmd !== 'string') return { ran: false, allowed: true, output: '' };

  const env: Record<string, string> = { ...process.env, SONAR_EVENT: event };
  for (const [k, v] of Object.entries(ctx)) if (v != null && v !== '') env[`SONAR_${k.toUpperCase()}`] = String(v);

  return await new Promise<HookResult>((resolve) => {
    let settled = false;
    const done = (r: HookResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let out = '';
    try {
      const child = spawn('sh', ['-c', cmd], { env, timeout: HOOK_TIMEOUT_MS });
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', (e) => done({ ran: true, allowed: true, output: `hook "${event}" could not start: ${e.message} (allowed)` }));
      child.on('close', (code, signal) => {
        const reason = code === 0 ? '' : signal ? `killed by ${signal}${signal === 'SIGTERM' ? ' (timed out?)' : ''}` : `exit ${code}`;
        done({ ran: true, allowed: code === 0, output: out.slice(0, 4000).trim() || reason });
      });
    } catch (e) {
      done({ ran: true, allowed: true, output: `hook "${event}" error: ${(e as Error).message} (allowed)` });
    }
  });
}
