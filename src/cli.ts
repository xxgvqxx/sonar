import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASE_URL, MCP_URL, PID_PATH, LOG_PATH, DATA_DIR, PORT, HOST, VERSION, CONFIG_FILE, urlFor, LAN_MODE, getToken, setToken } from './config.ts';

const SELF = fileURLToPath(import.meta.url);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, HOST);
  });
}

async function findFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 100; p++) if (await isPortFree(p)) return p;
  throw new Error(`no free port found near ${from}`);
}

/** Merge a patch into ~/.sonar/config.json, preserving existing fields (e.g. port + token). */
function writeConfig(patch: Record<string, unknown>) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* new file */
  }
  Object.assign(cfg, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function writePortConfig(port: number) {
  writeConfig({ port });
}

function isRunning(): number | null {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
  } catch {
    return null; // no pidfile
  }
  if (!pid) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return pid;
  } catch (e) {
    // EPERM = the process exists but is owned by another user → still running.
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

async function api(method: string, route: string, body?: any): Promise<any> {
  // Attach the token when configured. BASE_URL is loopback (the local hub exempts loopback
  // callers anyway), but this is correct + needed if SONAR_TOKEN points the CLI at a remote hub.
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureUp() {
  if (isRunning()) return;
  throw new Error('sonar hub is not running. Start it with: sonar start');
}

function gitBranch(): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** First non-internal IPv4 of this machine — what a teammate on the LAN would dial. */
function lanIp(): string | undefined {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------
// daemon lifecycle
// --------------------------------------------------------------------------
async function cmdDaemon() {
  const { startServer } = await import('./server.ts');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Going LAN with no token? Generate a URL-safe one, persist it (merged with port), and hand it
  // to the live server via setToken so its auth middleware sees it. Log it so the operator can share.
  if (LAN_MODE) {
    let token = getToken();
    if (!token) {
      token = randomBytes(18).toString('base64url');
      writeConfig({ token });
      setToken(token);
      console.log(`sonar: LAN mode — generated shared token: ${token}`);
    } else {
      console.log(`sonar: LAN mode — using configured token: ${token}`);
    }
    console.log(`sonar: teammates connect with  Authorization: Bearer ${token}  — run "sonar invite" for the full command.`);
  }
  fs.writeFileSync(PID_PATH, String(process.pid));
  const shutdown = () => {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  startServer();
}

function spawnDaemon(displayUrl = BASE_URL) {
  const existing = isRunning();
  if (existing) {
    console.log(`sonar already running (pid ${existing}) on ${displayUrl}`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out); // the child holds its own dup'd fd; don't leak ours in the parent
  console.log(`sonar hub starting on ${displayUrl} (pid ${child.pid}) — logs: ${LOG_PATH}`);
}

async function cmdStart() {
  if (!isRunning() && !(await isPortFree(PORT))) {
    console.log(`Port ${PORT} is in use by another process.`);
    console.log(`Run "sonar port auto" to move sonar to a free port (it re-registers with Claude/Codex), or free the port.`);
    return;
  }
  spawnDaemon();
}

function cmdStop() {
  const pid = isRunning();
  if (!pid) {
    console.log('sonar is not running.');
    return;
  }
  process.kill(pid);
  try {
    fs.unlinkSync(PID_PATH);
  } catch {}
  console.log(`Stopped sonar (pid ${pid}).`);
}

async function cmdStatus() {
  const pid = isRunning();
  if (!pid) {
    console.log('sonar: stopped');
    return;
  }
  try {
    const h = await api('GET', '/health');
    console.log(`sonar: running (pid ${pid}) on ${BASE_URL}`);
    console.log(`  links=${h.links} messages=${h.messages} indexed_turns=${h.indexed_turns} indexed_files=${h.indexed_files}`);
    console.log(`  MCP endpoint: ${MCP_URL}`);
    if (LAN_MODE) {
      const ip = lanIp();
      if (ip) console.log(`  LAN MCP endpoint: http://${ip}:${PORT}/mcp  (run "sonar invite" for teammate setup)`);
    }
  } catch {
    console.log(`sonar: pid ${pid} alive but not responding on ${BASE_URL} yet (give the indexer a moment).`);
  }
}

// Print everything a teammate on another machine needs to point their Claude/Codex at this hub.
function cmdInvite() {
  const ip = lanIp();
  const token = getToken();
  if (!ip) {
    console.log('sonar invite: could not find a non-internal IPv4 address for this machine.');
    console.log('  Are you on a network? Otherwise teammates cannot reach this hub.');
  }
  const url = `http://${ip ?? '<this-machine-lan-ip>'}:${PORT}/mcp`;

  console.log('Invite a teammate to this sonar hub\n');
  console.log(`  MCP URL:  ${url}`);
  console.log(`  Token:    ${token ?? '(none configured)'}\n`);

  if (!LAN_MODE) {
    console.log('! The hub is currently bound to loopback only — teammates cannot reach it yet.');
    console.log('  Restart it on the LAN:  SONAR_HOST=0.0.0.0 sonar start');
    console.log('  (that auto-generates a shared token; or set SONAR_TOKEN yourself before starting)');
    console.log('  Remote code-exec endpoints stay disabled unless you also set SONAR_ALLOW_REMOTE_EXEC=1.\n');
  }
  if (!token) {
    console.log('! No token configured. Start the hub with SONAR_HOST=0.0.0.0 (generates one) or set SONAR_TOKEN.\n');
  }

  const tok = token ?? '<token>';
  console.log('Claude Code (run on the teammate\'s machine):');
  console.log(`  claude mcp add --transport http --scope user sonar ${url} --header "Authorization: Bearer ${tok}"\n`);

  console.log('Codex — add to ~/.codex/config.toml:');
  console.log('  [mcp_servers.sonar]');
  console.log(`  url = "${url}"`);
  console.log('  # Codex must send the bearer token on every request. If your Codex build supports an');
  console.log('  # http_headers / bearer_token field for [mcp_servers.*], set it to the token above;');
  console.log(`  # otherwise add an "Authorization: Bearer ${tok}" header however your Codex version configures HTTP MCP headers.`);
  console.log('  # (Streamable-HTTP MCP also needs  rmcp_client = true  under [features].)\n');

  console.log('Reminder: the hub host must be bound to the LAN (SONAR_HOST=0.0.0.0) for any of this to be reachable.');
}

// --------------------------------------------------------------------------
// register with Claude Code + Codex, install slash command / skill
// --------------------------------------------------------------------------
const CLAUDE_CMD_DIR = path.join(os.homedir(), '.claude', 'commands');
const CODEX_SKILL_DIR = path.join(os.homedir(), '.codex', 'skills', 'sonar');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

const SLASH_COMMAND = `---
description: Link this session to other Claude Code / Codex sessions via sonar — collaborate through a shared doc, ask/answer across sessions, or dispatch a worker.
---

You have the sonar MCP tools: sonar_help (capabilities directory — call it if unsure which tool fits), link_create, link_join, link_list, doc_read, doc_append, doc_set_section, claim, release, task_add, task_update, git_sync, post, wait, read, watch, unwatch, autopilot, brief, search_context, spawn_worker. sonar coordinates multiple Claude Code / Codex sessions through a per-link SHARED MARKDOWN DOC that is the source of truth (both agents and the human read and edit it). Pings via post/wait just say "the doc changed".

User argument (may be empty): "$ARGUMENTS"

First run: git branch --show-current  and  pwd. Use label "claude@<branch>", agent "claude".

INTERPRET THE ARGUMENT:
- empty / "new" / "create" / a title  → CREATE: call link_create. Tell the user the link ID and that the OTHER session must run  /sonar <id>  to join. Then immediately write what you are working on into the doc with doc_append(section="Context", from="claude@<branch>", text=<a clear briefing the other agent can act on without seeing your screen>). If the user gave something to ask the other agent, add it with doc_append(section="Open questions", ...). Show the user the shared doc path. Then run the LISTEN LOOP.
- a code like "k7m2" / "join k7m2"  → JOIN (link_join returns the current doc), then do COLLABORATE.
- "listen <code>"  → link_join if not joined, then go straight to the LISTEN LOOP.
- "spawn <code> <task>"  → call spawn_worker(link_id, task=<the task>) and report what launched + the doc path.
- "search <text>"  → call search_context (add branch/repo filters if the user named one) and summarize the hits.
- "doc <code>"  → call doc_read and show the user the doc.
- "list"  → call link_list.
- "brief"  → run pwd, then call brief(cwd=<pwd>) and give the user a tight summary of where things stand (recent sessions, open questions, tasks). Offer to rejoin any active link it surfaces.
- "autopilot <code> [on|off]"  → the user wants the task board on <code> to execute itself. Run pwd first; call autopilot(link_id, from=<label>, on=true, cwd=<pwd>) (ask about headless vs visible terminals if unclear). Report what was dispatched. "off" → autopilot(link_id, from, on=false).
- "tunnel" / "remote"  → the user wants to collaborate with a teammate on ANOTHER machine/network. This is an OPERATOR action, not a tool you call: tell them to run  sonar tunnel  in a terminal (it starts a background tunnel and prints a connect command + a revocable per-member token; the teammate runs that, and  sonar tunnel stop  ends it). Then collaborate over the link as usual.

COLLABORATE (after joining):
1. Summarize the returned doc for the user.
2. Add your own context: doc_append(section="Context", from="claude@<branch>", text=…).
3. Answer any items under "Open questions" you can (from this repo / your knowledge): doc_append(section="Answers", from=…, text="Q… → A…") then post() a one-line ping. If unsure, ask the user before answering.
4. If you need something from the other agent, add it under "Open questions" and post() a ping.
5. Run the LISTEN LOOP.

LISTEN LOOP — CRITICAL. Do NOT end your turn after one post/append:
- Call wait(link_id, from="claude@<branch>", timeout_ms=30000).
- If messages arrive: tell the user VERBATIM what arrived, then doc_read to see the latest doc. Handle anything addressed to you (answer in the doc + post a ping), or ask the user how to respond.
- If it times out empty: call wait AGAIN.
- Keep looping for several rounds (about 8) so real back-and-forth can happen. Stop when the other side signals done, the task is resolved, or the user interrupts. On stop, summarize the doc and tell the user they can resume with  /sonar listen <id>.

RULES:
- ALWAYS surface to the user what the other agent said and what changed in the doc. Never go silent after posting.
- Put substantive content in the DOC (doc_append), not just in chat pings.
- Waiting for something SPECIFIC (a task to finish, an answer, a file to free up)? Prefer watch(link_id, from, event, arg?) over an endless wait() loop — tell the user a watch is armed, then end your turn; the hub pings the link (and can wake this session if it runs under tmux) when it fires.
- A pipeline of tasks the user wants run without babysitting? task_add each step (depends_on to order them), then autopilot(on=true, cwd=<repo>) — the hub spawns/wakes per ready task and cascades as they finish. Quality gates still guard every "done".
- Same repo as the other session? Use claim(resource, from) BEFORE editing a shared file (it returns a conflict instead of clobbering), the task board (task_add / task_update with status="doing"/"done", and depends_on to order work), and git_sync to share your branch / ahead-behind / changed files. All of these render into the doc.
- If THIS session is on a REMOTE/shared hub (you connected with a member token via  sonar connect), you have coordination tools only — search_context, recent_sessions, and spawn_worker are host-local and will be refused; exchange everything through the shared doc.
- Live back-and-forth requires the OTHER session to also be running /sonar <id> (or /sonar listen <id>) at the same time. If it is not, tell the user: your writes are saved and will be seen when it joins, but nobody replies until then — or suggest /sonar spawn <id> <task> to dispatch a worker that will respond.
`;

function codexSkill(url: string): string {
  return `---
name: sonar
description: Collaborate with other Claude Code / Codex sessions via the local sonar MCP server, using a shared markdown doc. Use when the user wants to link this session to another terminal/branch, share or pull context, ask/answer across sessions, or dispatch a worker.
---

# sonar

The sonar MCP server (url = "${url}") coordinates multiple Claude Code / Codex sessions through a per-link SHARED MARKDOWN DOC that is the source of truth. post/wait are just "the doc changed" pings.

Run  git branch --show-current  and  pwd  first. Use label "codex@<branch>", agent "codex".

## Start or join
- Start a link: link_create (label, agent="codex", branch, cwd). Report the ID; tell the user the other session runs /sonar <id> (or asks its agent to join <id>). Then write your context with doc_append(section="Context", from=...).
- Join: link_join(link_id, label, agent, branch, cwd) — it returns the current doc. Summarize it for the user.

## Collaborate through the doc
- doc_read(link_id) — read the shared doc (do this before working and after every wait ping).
- doc_append(link_id, section, text, from) — add to "Context" / "Open questions" / "Answers" / "Decisions". This is how you contribute, ask, and answer.
- Answer items under "Open questions" by appending to "Answers" and calling post() to ping.

## Listen loop (critical — do not stop after one message)
- wait(link_id, from="codex@<branch>", timeout_ms=30000). If messages arrive, tell the user verbatim and doc_read for the latest; handle anything for you. If it times out empty, call wait again. Loop several rounds. Always report to the user what arrived and what changed.

## Coordinate the same repo
- claim(link_id, resource, from) before editing a shared file — it returns a conflict (who holds it) instead of letting you clobber; release(...) when done.
- task_add / task_update (status="doing"/"done", assignee, depends_on) — a shared board; finishing a task auto-unblocks its dependents.
- git_sync(link_id, from, branch, ahead, behind, changed, files) — publish your tree and see the peers'. All of these surface in the doc (Claims / Tasks / Git).
- watch(link_id, from, event, arg?) — waiting for something specific (task_done #N, task_ready, answer, question, release <path>, message)? Arm a watch and go idle instead of looping wait(); the hub pings the link (and wakes a tmux pane) when it fires. unwatch(...) cancels.
- autopilot(link_id, from, on=true, cwd=<repo>) — the hub EXECUTES the board: each ready task is dispatched (worker spawned, or assignee woken), cascading through depends_on as tasks finish. on=false stops it.
- sonar_help() — a capabilities directory (decision map + every tool) if you're unsure which to use.

## Dispatch / search (host-local)
- brief(cwd=<pwd>) — call FIRST when starting work in a repo: recent sessions, last conversation tail, open questions/decisions/tasks/claims from active links.
- spawn_worker(link_id, task) — launch a new Claude/Codex session in an isolated git worktree that joins the link and works the task, writing back into the doc.
- search_context(query, optional repo/branch/agent) — full-text search across BOTH Claude Code and Codex history (branch filter is exact only for Claude logs; filter Codex by repo).

## Remote teammates
Live back-and-forth needs the other session active on the same link at the same time; otherwise writes are saved for when it joins, or use spawn_worker. To collaborate with a teammate on ANOTHER machine/network, the human runs  sonar tunnel  (operator action — prints a connect command + a revocable token). NOTE: if THIS session is connected to a remote/shared hub with a member token, you get coordination tools only — spawn_worker and search_context are host-local and will be refused; use the doc.
`;
}

function installClaude(url: string, token?: string): string {
  try {
    fs.mkdirSync(CLAUDE_CMD_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLAUDE_CMD_DIR, 'sonar.md'), SLASH_COMMAND);
  } catch (e) {
    return `  slash command: FAILED (${(e as Error).message})`;
  }
  // (re)register the MCP server with the Claude Code CLI (user scope). remove-then-add is
  // idempotent and updates the URL when the port changes. A token (when set) is sent as a
  // Bearer header so registration works against an exposed hub (it's ignored on a loopback hub).
  try {
    execFileSync('claude', ['mcp', 'remove', 'sonar', '-s', 'user'], { stdio: 'pipe' });
  } catch {
    /* not registered yet */
  }
  const addArgs = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'sonar', url];
  if (token) addArgs.push('--header', `Authorization: Bearer ${token}`);
  try {
    execFileSync('claude', addArgs, { stdio: 'pipe' });
    return `  Claude Code: registered MCP server at ${url}${token ? ' (with token)' : ''} + /sonar command`;
  } catch (e) {
    const manual = `claude mcp add --transport http --scope user sonar ${url}${token ? ` --header "Authorization: Bearer ${token}"` : ''}`;
    return `  Claude Code: /sonar command written, but auto-registration failed (${(e as Error).message}).\n    Run manually:  ${manual}`;
  }
}

function installCodex(url: string, token?: string): string {
  const lines: string[] = [];
  try {
    fs.mkdirSync(CODEX_SKILL_DIR, { recursive: true });
    fs.writeFileSync(path.join(CODEX_SKILL_DIR, 'SKILL.md'), codexSkill(url));
    lines.push('  Codex: sonar skill written');
  } catch (e) {
    lines.push(`  Codex skill: FAILED (${(e as Error).message})`);
  }
  try {
    let cfg = '';
    try {
      cfg = fs.readFileSync(CODEX_CONFIG, 'utf8');
    } catch {
      /* no config yet */
    }
    if (/\[mcp_servers\.sonar\]/.test(cfg)) {
      // update the existing url line within the block
      const updated = cfg.replace(/(\[mcp_servers\.sonar\][^[]*?url\s*=\s*)"[^"]*"/, `$1"${url}"`);
      if (updated !== cfg) {
        fs.writeFileSync(CODEX_CONFIG, updated);
        lines.push(`  Codex: updated [mcp_servers.sonar] url → ${url}`);
      } else {
        lines.push('  Codex: [mcp_servers.sonar] present');
      }
    } else {
      fs.appendFileSync(CODEX_CONFIG, `\n[mcp_servers.sonar]\nurl = "${url}"\n`);
      lines.push('  Codex: added [mcp_servers.sonar] to config.toml');
    }
    if (cfg && !/rmcp_client\s*=\s*true/.test(cfg)) {
      lines.push('  ! Codex needs `rmcp_client = true` under [features] for streamable-HTTP MCP. Add it if missing.');
    }
    if (token) {
      lines.push(`  ! Codex must send "Authorization: Bearer ${token}" to this hub — set it via your Codex build's`);
      lines.push('    http_headers / bearer_token field for [mcp_servers.sonar] (key name varies by version).');
    }
  } catch (e) {
    lines.push(`  Codex config: FAILED (${(e as Error).message})`);
  }
  return lines.join('\n');
}

// Session-init awareness injected into every Claude/Codex session so it knows it
// can spawn a worker / pull context from the start (not only after /sonar).
const SESSION_INIT = `## sonar — multi-session coordination (available)
A local **sonar** MCP server is running, letting you coordinate with other Claude Code / Codex sessions. When it helps, use it (call **sonar_help** for a full capabilities directory):
- **brief(cwd?)** — starting substantive work in a repo? Call this FIRST: it returns recent sessions here, the tail of the last conversation, and open questions / decisions / tasks / claims from active links — catch up instead of asking the user to re-explain.
- **spawn_worker(link_id, task)** — if a task has a separable part (investigate another area/repo, run a parallel subtask, reproduce something in isolation), call link_create then spawn_worker to launch a worker agent in an isolated git worktree that does it and reports back through the shared doc. (Guided flow: /sonar — Codex: the "sonar" skill.)
- **search_context(query, repo?, branch?)** — pull relevant context from your OWN past sessions (Claude + Codex history) instead of asking the user to re-paste.
- **Coordinating the same repo with another live session:** claim(resource) before editing a shared file (avoid clobbering), the task board (task_add / task_update, depends_on), and git_sync to share branch/diff state — all surface in the shared doc.
- **watch(event, arg?)** — instead of polling wait() for something specific (a task finishing, an answer, a claim freeing), register a watch and go idle; the hub pings the link and wakes your tmux pane when it fires.
- **autopilot(on=true, cwd=…)** — makes the hub EXECUTE the task board: ready tasks are dispatched automatically (worker per unassigned task, wake for assigned ones), cascading through depends_on. Script a pipeline as tasks, enable autopilot, let it run.
- Each link has a shared doc at ~/.sonar/links/<id>/context.md that is the source of truth; collaborate via doc_append / doc_read, ping with post / wait.
- **Across machines/networks:** the human can run \`sonar tunnel\` (operator action) to share this hub with a remote teammate over a revocable token; suggest it if they want to collaborate with someone not on this machine.
Use this only when it genuinely helps — don't spawn workers for trivial tasks. If the sonar tools aren't listed, the hub may be down (run: sonar start).`;

const CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const CODEX_AGENTS = path.join(os.homedir(), '.codex', 'AGENTS.md');

function upsertManagedBlock(file: string, body: string): boolean {
  const begin = '<!-- sonar:begin (managed by `sonar install`) -->';
  const end = '<!-- sonar:end -->';
  const block = `${begin}\n${body}\n${end}`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    /* file may not exist */
  }
  const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end}`);
  let next: string;
  if (re.test(existing)) {
    next = existing.replace(re, block);
  } else {
    next = existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  if (next === existing) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

function installSessionInit(): string {
  const lines: string[] = [];
  try {
    upsertManagedBlock(CLAUDE_MD, SESSION_INIT);
    lines.push('  Session init: ~/.claude/CLAUDE.md updated (Claude sessions)');
  } catch (e) {
    lines.push(`  ~/.claude/CLAUDE.md: FAILED (${(e as Error).message})`);
  }
  try {
    upsertManagedBlock(CODEX_AGENTS, SESSION_INIT);
    lines.push('  Session init: ~/.codex/AGENTS.md updated (Codex sessions)');
  } catch (e) {
    lines.push(`  ~/.codex/AGENTS.md: FAILED (${(e as Error).message})`);
  }
  return lines.join('\n');
}

function reRegister(port: number): string {
  const url = urlFor(port);
  const tok = getToken();
  return `${installClaude(url, tok)}\n${installCodex(url, tok)}`;
}

async function cmdInstall() {
  // resolve the port: keep current if sonar is already running; else use the configured
  // port if free, otherwise fall back to the next free one.
  let port = PORT;
  if (!isRunning() && !(await isPortFree(PORT))) {
    port = await findFreePort(PORT + 1);
    console.log(`Port ${PORT} is in use — sonar will use ${port} instead.\n`);
  }
  writePortConfig(port);
  const url = urlFor(port);
  console.log(`Installing sonar (MCP endpoint ${url})\n`);
  const tok = getToken();
  console.log(installClaude(url, tok));
  console.log(installCodex(url, tok));
  console.log(installSessionInit());
  console.log('\nStarting the hub...');
  spawnDaemon(`http://${HOST}:${port}`);
  console.log('\nDone. Restart Claude Code / Codex so they pick up the new MCP server + session-init note.');
  console.log('Then in either tool: /sonar   (Codex: ask it to use the sonar skill)');
}

async function cmdPort(args: string[]) {
  const arg = args[0];
  // stop the current daemon first so it releases its port
  const pid = isRunning();
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
  }
  let port: number;
  if (!arg || arg === 'auto') {
    await sleep(400);
    port = await findFreePort(PORT); // PORT is free again now if it was ours
    console.log(`Auto-selected free port ${port}.`);
  } else {
    port = Number(arg);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${arg}`);
    // wait briefly for the old daemon to release, then ensure the target is free
    for (let i = 0; i < 15 && !(await isPortFree(port)); i++) await sleep(120);
    if (!(await isPortFree(port))) throw new Error(`port ${port} is in use by another process`);
  }
  writePortConfig(port);
  console.log(`sonar port → ${port}`);
  console.log(reRegister(port));
  spawnDaemon(`http://${HOST}:${port}`);
  console.log(`\nMCP endpoint: ${urlFor(port)}`);
  console.log('Restart Claude Code / Codex to pick up the new MCP URL. The menu bar follows automatically.');
}

// --------------------------------------------------------------------------
// terminal helpers
// --------------------------------------------------------------------------
async function cmdCreate(args: string[]) {
  await ensureUp();
  const title = args.join(' ') || undefined;
  const r = await api('POST', '/api/links', { title, label: `cli@${gitBranch() ?? 'local'}`, agent: 'cli', branch: gitBranch(), cwd: process.cwd() });
  console.log(`Created link: ${r.id}${title ? ` — ${title}` : ''}`);
  console.log(`Other session: /sonar ${r.id}`);
}

async function cmdPost(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar post <id> <message…>');
  const r = await api('POST', `/api/links/${id}/messages`, { from: `cli@${gitBranch() ?? 'local'}`, agent: 'cli', branch: gitBranch(), body: args.join(' ') });
  console.log(`posted seq ${r.seq}`);
}

async function cmdRead(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar read <id> [since_seq]');
  const since = args[0] ? Number(args[0]) : 0;
  const msgs = await api('GET', `/api/links/${id}/messages?since=${since}`);
  for (const m of msgs) console.log(`[${m.seq}] ${m.from_label}: ${m.body}`);
}

async function cmdWatch(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar watch <id>');
  console.log(`Watching ${id} (Ctrl-C to stop)…`);
  let after = 0;
  for (;;) {
    const r = await api('GET', `/api/links/${id}/wait?after=${after}&timeout=60000`);
    for (const m of r.messages) {
      console.log(`[${m.seq}] ${m.from_label} (${m.agent ?? '?'}): ${m.body}`);
      after = Math.max(after, m.seq);
    }
  }
}

async function cmdSearch(args: string[]) {
  await ensureUp();
  const q = args.join(' ');
  if (!q) throw new Error('usage: sonar search <query>');
  const hits = await api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=10`);
  for (const h of hits) {
    console.log(`${h.agent} · ${h.repo ?? '?'}${h.branch ? '/' + h.branch : ''} · ${h.role}\n  ${String(h.excerpt).replace(/\s+/g, ' ').trim()}\n`);
  }
}

async function cmdBrief(args: string[]) {
  await ensureUp();
  const repo = args[0];
  const qs = new URLSearchParams();
  if (repo) qs.set('repo', repo);
  else qs.set('cwd', process.cwd());
  const r = await api('GET', `/api/brief?${qs}`);
  console.log(r.text);
}

async function cmdAutopilot(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar autopilot <id> [on|off|status] [--agent claude|codex] [--max N] [--headless]');
  const sub = args.find((a) => !a.startsWith('--')) || 'status';
  if (sub === 'status') {
    const r = await api('GET', `/api/links/${id}/autopilot`);
    const cfg = r.config;
    console.log(`autopilot on ${id}: ${cfg?.on ? `ON (agent ${cfg.agent || 'claude'}, max ${cfg.max ?? 2}${cfg.headless ? ', headless' : ''}${cfg.cwd ? `, cwd ${cfg.cwd}` : ''})` : 'off'}`);
    console.log(`  in flight: ${r.inflight.length ? r.inflight.map((t: any) => `#${t.num}(${t.status})`).join(' ') : 'none'}`);
    console.log(`  ready:     ${r.ready.length ? r.ready.map((t: any) => `#${t.num}`).join(' ') : 'none'}`);
    return;
  }
  if (sub === 'off') {
    await api('POST', `/api/links/${id}/autopilot`, { on: false });
    console.log(`autopilot OFF on ${id}.`);
    return;
  }
  if (sub !== 'on') throw new Error(`unknown subcommand "${sub}" — use on | off | status`);
  let agent: string | undefined, max: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') agent = args[++i];
    else if (args[i] === '--max') max = Number(args[++i]);
  }
  const headless = args.includes('--headless');
  const r = await api('POST', `/api/links/${id}/autopilot`, { on: true, cwd: process.cwd(), agent, max, headless, by: `cli@${gitBranch() ?? 'local'}` });
  console.log(`autopilot ON on ${id} (max ${r.config?.max ?? 2}, agent ${r.config?.agent || 'claude'}${r.config?.headless ? ', headless' : ''}).`);
  if (r.dispatched?.length) {
    for (const d of r.dispatched) console.log(`  dispatched #${d.num} "${d.title}" — ${d.error ? `FAILED: ${d.error}` : `${d.via}${d.assignee ? ` → ${d.assignee}` : ''}`}`);
  } else {
    console.log('  nothing ready yet — tasks dispatch as they are added/unblocked. Watch with: sonar watch ' + id);
  }
}

async function cmdWatches(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar watches <id> [rm <watchId>]');
  if (args[0] === 'rm') {
    const wid = Number(args[1]);
    if (!wid) throw new Error('usage: sonar watches <id> rm <watchId>');
    const r = await api('DELETE', `/api/links/${id}/watches/${wid}`);
    console.log(r.removed ? `removed watch #${wid}` : `no watch #${wid}`);
    return;
  }
  const rows = await api('GET', `/api/links/${id}/watches`);
  if (!rows.length) return console.log('no active watches.');
  for (const w of rows)
    console.log(`#${w.id} ${w.label} ← ${w.event}${w.arg ? `(${w.arg})` : ''}${w.once ? '' : ' · persistent'}${w.fire_count ? ` · fired ${w.fire_count}×` : ''}${w.note ? ` · ${w.note}` : ''}`);
}

async function cmdReindex() {
  await ensureUp();
  process.stdout.write('rebuilding transcript index… ');
  const r = await api('POST', '/api/reindex');
  console.log(`done — ${r.indexed_turns} turns from ${r.indexed_files} files.`);
}

async function cmdWorktrees(args: string[]) {
  await ensureUp();
  if (args[0] === 'prune') {
    const which = args.slice(1);
    const all = await api('GET', '/api/worktrees');
    const targets = which.includes('--all') ? all : which;
    if (!targets.length) throw new Error('usage: sonar worktrees prune <name|--all>');
    for (const name of targets) {
      await api('DELETE', `/api/worktrees/${name}`);
      console.log(`pruned ${name}`);
    }
    return;
  }
  const list = await api('GET', '/api/worktrees');
  if (!list.length) {
    console.log('no worker worktrees.');
    return;
  }
  list.forEach((n: string) => console.log(n));
  console.log(`\nprune with: sonar worktrees prune <name>   (or --all)`);
}

async function cmdRm(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar rm <id>');
  const r = await api('DELETE', `/api/links/${id}`);
  console.log(r.deleted ? `removed link ${id}` : `no link ${id}`);
}

async function cmdDoc(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar doc <id> [--open]');
  const r = await api('GET', `/api/links/${id}/doc`);
  if (args.includes('--open')) {
    spawn('open', [r.path]);
    console.log(`opened ${r.path}`);
    return;
  }
  console.log(r.markdown);
}

async function cmdSpawn(args: string[]) {
  await ensureUp();
  const id = args.shift();
  if (!id) throw new Error('usage: sonar spawn <id> [claude|codex] <task…>');
  let agent: string | undefined;
  if (args[0] === 'claude' || args[0] === 'codex') agent = args.shift();
  const headless = args.includes('--headless');
  const task = args.filter((x) => x !== '--headless').join(' ');
  if (!task) throw new Error('provide a task for the worker');
  const r = await api('POST', `/api/links/${id}/spawn`, { agent, task, cwd: process.cwd(), headless });
  console.log(`spawned ${r.agent} worker (${r.mode})${r.branch ? ` on branch ${r.branch}` : ''}`);
  console.log(`  workdir: ${r.workdir}`);
  console.log(`  doc:     ${r.doc}`);
}

async function cmdWake(args: string[]) {
  await ensureUp();
  const force = args.includes('--force');
  const rest = args.filter((x) => x !== '--force');
  const id = rest.shift();
  const label = rest.shift();
  if (!id || !label) throw new Error('usage: sonar wake <link> <label> [message…] [--force]\n  (label is the agent\'s handle, e.g. claude@worker)');
  const message = rest.join(' ') || undefined;
  const r = await api('POST', '/api/wake', { link_id: id, label, message, force });
  if (r.ok) {
    console.log(`woke ${label} → typed into ${r.target}`);
    console.log(`  prompt: ${r.message}`);
  } else {
    console.error(`could not wake ${label}: ${r.error}`);
    if (r.busy) console.error('  (re-run with --force to inject anyway)');
    process.exitCode = 1;
  }
}

function cmdAttach() {
  // Open the sonar tmux session in this terminal so you can watch the agent panes.
  const child = spawn('tmux', ['attach', '-t', 'sonar'], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
}

function cmdBar(args: string[]) {
  const menubarDir = path.join(path.dirname(SELF), '..', 'menubar');
  const uv = 'uv';
  const fg = args[0] === 'fg' || args.includes('--foreground');
  if (fg) {
    const child = spawn(uv, ['run', '--directory', menubarDir, 'python', 'sonar_bar.py'], { stdio: 'inherit' });
    child.on('exit', (c) => process.exit(c ?? 0));
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(path.join(DATA_DIR, 'menubar.log'), 'a');
  const child = spawn(uv, ['run', '--directory', menubarDir, 'python', 'sonar_bar.py'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  console.log(`sonar menu bar starting (pid ${child.pid}). First run will install deps via uv.`);
  console.log(`If it doesn't appear, run: sonar bar fg   (to see errors)`);
}

// --------------------------------------------------------------------------
// claim enforcement (pre-commit guard) + quality-gate hooks inspection
// --------------------------------------------------------------------------
const GUARD_START = '# >>> sonar guard >>>';
const GUARD_END = '# <<< sonar guard <<<';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function gitTry(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}
function repoRoot(): string | null {
  return gitTry(['rev-parse', '--show-toplevel']);
}
function hookDir(root: string): string {
  const hp = gitTry(['-C', root, 'config', '--get', 'core.hooksPath']);
  return hp ? path.resolve(root, hp) : path.join(root, '.git', 'hooks');
}

async function cmdGuard(args: string[]) {
  const sub = args[0];
  if (sub === 'check') return guardCheck();
  if (sub === 'install') return guardInstall(args.slice(1));
  if (sub === 'uninstall') return guardUninstall();
  if (sub === 'status') return guardStatus();
  throw new Error('usage: sonar guard <install [--link <id>] [--label <name>] [--hub <url>] [--token <t>] | check | status | uninstall>');
}

function guardInstall(args: string[]) {
  const root = repoRoot();
  if (!root) throw new Error('not inside a git repository.');
  let link: string | undefined, label: string | undefined, hub: string | undefined, token: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--link') link = args[++i];
    else if (args[i] === '--label') label = args[++i];
    else if (args[i] === '--hub') hub = args[++i];
    else if (args[i] === '--token') token = args[++i];
  }
  // Persist coordinates in this repo's git config so the hook is self-contained.
  if (link) git(['-C', root, 'config', 'sonar.link', link]);
  if (label) git(['-C', root, 'config', 'sonar.label', label]);
  if (hub) git(['-C', root, 'config', 'sonar.hub', hub]);
  if (token) git(['-C', root, 'config', 'sonar.token', token]);
  link = link || gitTry(['-C', root, 'config', '--get', 'sonar.link']) || undefined;
  label = label || gitTry(['-C', root, 'config', '--get', 'sonar.label']) || undefined;
  if (!link || !label) throw new Error("provide --link <id> and --label <your-participant-label> (stored in this repo's git config).");

  const dir = hookDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const hookPath = path.join(dir, 'pre-commit');
  const block = `${GUARD_START}\n"${process.execPath}" --disable-warning=ExperimentalWarning "${SELF}" guard check || exit 1\n${GUARD_END}\n`;
  let body: string;
  if (fs.existsSync(hookPath)) {
    body = fs.readFileSync(hookPath, 'utf8');
    if (body.includes(GUARD_START)) body = body.replace(new RegExp(`${GUARD_START}[\\s\\S]*?${GUARD_END}\\n?`), block);
    else body = (body.endsWith('\n') ? body : body + '\n') + '\n' + block;
  } else {
    body = `#!/bin/sh\n${block}`;
  }
  fs.writeFileSync(hookPath, body);
  fs.chmodSync(hookPath, 0o755);
  console.log(`Installed sonar guard pre-commit hook → ${hookPath}`);
  console.log(`  link=${link} label=${label}${hub ? ` hub=${hub}` : ''}`);
  console.log('Commits touching a file another participant has claimed will be blocked.');
  console.log('Bypass once with:  git commit --no-verify   (or  SONAR_GUARD_OFF=1 git commit …)');
}

function guardUninstall() {
  const root = repoRoot();
  if (!root) throw new Error('not inside a git repository.');
  const hookPath = path.join(hookDir(root), 'pre-commit');
  if (!fs.existsSync(hookPath)) return console.log('no pre-commit hook to clean.');
  let body = fs.readFileSync(hookPath, 'utf8');
  if (!body.includes(GUARD_START)) return console.log('sonar guard is not installed in the pre-commit hook.');
  body = body.replace(new RegExp(`\\n?${GUARD_START}[\\s\\S]*?${GUARD_END}\\n?`), '\n');
  if (body.replace(/^#!.*\n?/, '').trim() === '') fs.rmSync(hookPath, { force: true });
  else fs.writeFileSync(hookPath, body);
  console.log('Removed sonar guard from the pre-commit hook (git config sonar.* left intact).');
}

function guardStatus() {
  const root = repoRoot();
  if (!root) return console.log('not inside a git repository.');
  const hookPath = path.join(hookDir(root), 'pre-commit');
  const installed = fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes(GUARD_START);
  console.log(`sonar guard: ${installed ? 'installed' : 'not installed'}  (${hookPath})`);
  console.log(`  link=${gitTry(['-C', root, 'config', '--get', 'sonar.link']) || '(unset)'} label=${gitTry(['-C', root, 'config', '--get', 'sonar.label']) || '(unset)'} hub=${gitTry(['-C', root, 'config', '--get', 'sonar.hub']) || BASE_URL}`);
}

// The pre-commit entrypoint. MUST fail-open (exit 0) on anything but a positively-detected
// conflict, so it never breaks normal commits when sonar isn't in use or the hub is unreachable.
async function guardCheck() {
  try {
    if (process.env.SONAR_GUARD_OFF) process.exit(0);
    const root = repoRoot();
    if (!root) process.exit(0);
    const link = gitTry(['-C', root, 'config', '--get', 'sonar.link']);
    const label = gitTry(['-C', root, 'config', '--get', 'sonar.label']);
    if (!link || !label) process.exit(0);
    const staged = gitTry(['-C', root, 'diff', '--cached', '--name-only']) || '';
    const paths = staged.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!paths.length) process.exit(0);

    const hub = gitTry(['-C', root, 'config', '--get', 'sonar.hub']) || BASE_URL;
    const token = gitTry(['-C', root, 'config', '--get', 'sonar.token']) || getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    let conflicts: any[] = [];
    try {
      const res = await fetch(`${hub}/api/links/${link}/claims/check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ holder: label, paths }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        process.stderr.write(`sonar guard: skipped (hub HTTP ${res.status})\n`);
        process.exit(0);
      }
      conflicts = (await res.json()).conflicts || [];
    } catch (e) {
      process.stderr.write(`sonar guard: skipped (${(e as Error).message})\n`);
      process.exit(0); // hub down / unreachable → never block a commit
    }
    if (!conflicts.length) process.exit(0);

    process.stderr.write(`\n✋ sonar guard: commit blocked — files claimed by another participant on link ${link}:\n`);
    for (const c of conflicts) process.stderr.write(`   • ${c.path}  → leased by ${c.holder} (resource "${c.resource}", until ${c.expires_at})\n`);
    process.stderr.write('\n   Coordinate in the shared doc, wait for the lease to lapse, or bypass once with:  git commit --no-verify\n\n');
    process.exit(1);
  } catch (e) {
    process.stderr.write(`sonar guard: internal error, allowing commit (${(e as Error).message})\n`);
    process.exit(0);
  }
}

async function cmdHooks(_args: string[]) {
  const { loadHooks, HOOKS_FILE } = await import('./hooks.ts');
  const hooks = loadHooks();
  const keys = Object.keys(hooks);
  console.log(`Quality-gate hooks: ${HOOKS_FILE}`);
  if (!keys.length) {
    console.log('  (none configured)');
    console.log('  Example  ~/.sonar/hooks.json:  { "task_completed": "npm test --silent", "task_created": "./scripts/validate-task.sh" }');
    console.log('  A non-zero exit blocks the operation; context arrives via SONAR_EVENT / SONAR_LINK / SONAR_NUM / SONAR_TITLE / SONAR_FROM env vars.');
    return;
  }
  for (const k of keys) console.log(`  ${k}: ${hooks[k]}`);
}

// --------------------------------------------------------------------------
// remote access: per-member tokens, ephemeral tunnel, teammate connect
// --------------------------------------------------------------------------
function which(bin: string): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

async function cmdToken(args: string[]) {
  await ensureUp();
  const sub = args[0];
  if (sub === 'add') {
    const name = args[1];
    if (!name) throw new Error('usage: sonar token add <name>');
    const r = await api('POST', '/api/admin/tokens', { name });
    console.log(`Created per-member token "${r.name}":\n\n    ${r.token}\n`);
    console.log('Share it once (only its hash is stored). The teammate connects with:');
    console.log(`    sonar connect ${(getToken() ? '<hub-url>' : '<hub-url>')} --token ${r.token}`);
    console.log(`Revoke anytime with:  sonar token revoke ${r.name}`);
    return;
  }
  if (sub === 'list') {
    const r = await api('GET', '/api/admin/tokens');
    console.log(`exposed: ${r.exposed}`);
    if (!r.tokens.length) return console.log('  (no per-member tokens)');
    for (const t of r.tokens)
      console.log(`  ${t.revoked_at ? '✗' : '●'} ${t.name}  created ${t.created_at}${t.last_used_at ? `  · last used ${t.last_used_at}` : ''}${t.revoked_at ? `  · REVOKED` : ''}`);
    return;
  }
  if (sub === 'revoke') {
    const which2 = args[1];
    if (!which2) throw new Error('usage: sonar token revoke <name|token>');
    const r = await api('POST', '/api/admin/tokens/revoke', { token: which2 });
    console.log(r.revoked ? `Revoked "${r.name || which2}".` : `No active token matched "${which2}".`);
    return;
  }
  throw new Error('usage: sonar token <add <name> | list | revoke <name|token>>');
}

// Point THIS machine's Claude Code + Codex at a REMOTE sonar hub (a teammate joining a shared hub).
async function cmdConnect(args: string[]) {
  const urlArg = args.find((a) => /^https?:\/\//.test(a));
  if (!urlArg) throw new Error('usage: sonar connect <hub-url> [--token <token>]   (e.g. https://xxxx.trycloudflare.com)');
  let token: string | undefined;
  for (let i = 0; i < args.length; i++) if (args[i] === '--token') token = args[++i];
  const base = urlArg.replace(/\/+$/, '').replace(/\/mcp$/, '');
  const mcpUrl = `${base}/mcp`;
  console.log(`Connecting this machine to the remote sonar hub: ${mcpUrl}${token ? ' (with token)' : ''}\n`);
  console.log(installClaude(mcpUrl, token));
  console.log(installCodex(mcpUrl, token));
  console.log('\nRestart Claude Code / Codex to pick up the remote hub. (This replaces any local "sonar" registration.)');
  console.log('Your agent gets the coordination tools (links / doc / messages / claims / tasks / git_sync);');
  console.log('host-only tools — search_context, recent_sessions, spawn_worker — are not available on a remote hub.');
}

// A managed background tunnel: start it once, query/copy it anytime with `status`, tear it down
// with `stop`. State (provider/pid/url/token) persists in ~/.sonar/tunnel.json so any later CLI
// invocation can manage it — no terminal stays tied up.
const TUNNEL_FILE = path.join(DATA_DIR, 'tunnel.json');
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log');

function readTunnel(): any | null {
  try {
    return JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Wait for the provider to publish its public URL. ngrok exposes a local API (:4040); both also
// log the URL, so we scan the log too (covers cloudflared and ngrok alike).
async function waitForTunnelUrl(provider: string, logPath: string): Promise<string | null> {
  const re = /https:\/\/[^\s"']+\.(?:trycloudflare\.com|ngrok[-a-z.]*\.app|ngrok\.io)[^\s"']*/;
  for (let i = 0; i < 40; i++) {
    if (provider === 'ngrok') {
      try {
        const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          const j: any = await r.json();
          const u = (j.tunnels || []).map((t: any) => t.public_url).find((x: string) => x && x.startsWith('https'));
          if (u) return u.replace(/\/+$/, '');
        }
      } catch {
        /* not up yet */
      }
    }
    try {
      const m = fs.readFileSync(logPath, 'utf8').match(re);
      if (m) return m[0].replace(/\/+$/, '');
    } catch {
      /* no log yet */
    }
    await sleep(300);
  }
  return null;
}

function printTunnelInfo(t: any) {
  const base = String(t.url).replace(/\/+$/, '');
  const bar = '━'.repeat(64);
  console.log(bar);
  console.log(`Tunnel:        ${t.provider}${t.startedAt ? `  (since ${t.startedAt})` : ''}`);
  console.log(`Public URL:    ${base}/mcp`);
  console.log(`Member token:  ${t.token}   (name: ${t.name})`);
  console.log('\nGive your teammate ONE of these — then they restart Claude Code / Codex:');
  console.log(`    sonar connect ${base} --token ${t.token}`);
  console.log(`    claude mcp add --transport http --scope user sonar ${base}/mcp --header "Authorization: Bearer ${t.token}"`);
  console.log(bar);
}

async function cmdTunnel(args: string[]) {
  const sub = args[0];
  if (sub === 'status') return tunnelStatus();
  if (sub === 'stop' || sub === 'off') return tunnelStop();
  return tunnelStart(args);
}

function tunnelStatus() {
  const t = readTunnel();
  if (!t) return console.log('No tunnel running. Start one with:  sonar tunnel');
  if (!pidAlive(t.pid)) return console.log(`Tunnel state is stale (process ${t.pid} is gone). Clean up with:  sonar tunnel stop`);
  printTunnelInfo(t);
  console.log('Manage:  sonar tunnel status   |   sonar tunnel stop');
}

async function tunnelStop() {
  const t = readTunnel();
  try {
    await ensureUp();
    await api('POST', '/api/admin/expose', { on: false });
  } catch {
    /* hub may be down; still clean local state */
  }
  if (!t) return console.log('No tunnel was running. Exposed mode dropped (if it was on).');
  try {
    if (pidAlive(t.pid)) process.kill(t.pid);
  } catch {}
  if (!t.keepToken && t.name) {
    try {
      await api('POST', '/api/admin/tokens/revoke', { token: t.name });
    } catch {}
  }
  try { fs.rmSync(TUNNEL_FILE, { force: true }); } catch {}
  try { fs.rmSync(TUNNEL_LOG, { force: true }); } catch {}
  console.log(`Tunnel stopped${t.keepToken ? `; token "${t.name}" kept (revoke: sonar token revoke ${t.name})` : ` and token "${t.name}" revoked`}. Hub no longer exposed.`);
}

async function tunnelStart(args: string[]) {
  await ensureUp();
  const existing = readTunnel();
  if (existing && pidAlive(existing.pid)) {
    console.log('A tunnel is already running:\n');
    return tunnelStatus();
  }
  let provider: string | undefined, memberName: string | undefined, keepToken = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider') provider = args[++i];
    else if (args[i] === '--name') memberName = args[++i];
    else if (args[i] === '--keep-token') keepToken = true;
  }
  provider = provider || (which('cloudflared') ? 'cloudflared' : which('ngrok') ? 'ngrok' : undefined);
  if (!provider) {
    console.log('No tunnel provider found. Install one:');
    console.log('  cloudflared:  brew install cloudflared   (quick tunnels — no account needed)');
    console.log('  ngrok:        brew install ngrok && ngrok config add-authtoken <token>');
    return;
  }

  // Ensure an admin token so THIS machine's CLI / menu bar / agents still authenticate once exposed.
  let admin = getToken();
  if (!admin) {
    admin = randomBytes(18).toString('base64url');
    writeConfig({ token: admin });
    setToken(admin);
    installClaude(MCP_URL, admin);
    installCodex(MCP_URL, admin);
    console.log("Generated an admin token (~/.sonar/config.json) and re-registered this machine's Claude/Codex with it.");
    console.log('Restart any open local Claude/Codex session so it picks up the token.\n');
  }

  memberName = memberName || `guest-${randomBytes(3).toString('hex')}`;
  const minted = await api('POST', '/api/admin/tokens', { name: memberName });
  await api('POST', '/api/admin/expose', { on: true });

  const cmdArgs =
    provider === 'ngrok'
      ? ['http', String(PORT), '--log', 'stdout', '--log-format', 'logfmt']
      : ['tunnel', '--url', `http://127.0.0.1:${PORT}`];
  console.log(`Starting ${provider} tunnel → http://127.0.0.1:${PORT} (a few seconds)…`);
  const logFd = fs.openSync(TUNNEL_LOG, 'w');
  const child = spawn(provider, cmdArgs, { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);

  const url = await waitForTunnelUrl(provider, TUNNEL_LOG);
  if (!url) {
    try { if (child.pid) process.kill(child.pid); } catch {}
    try { await api('POST', '/api/admin/expose', { on: false }); } catch {}
    try { await api('POST', '/api/admin/tokens/revoke', { token: memberName }); } catch {}
    console.error(`Could not detect the tunnel URL. Check ${TUNNEL_LOG} (is ${provider} configured/authed?).`);
    return;
  }
  const state = { provider, pid: child.pid, url, name: memberName, token: minted.token, keepToken, startedAt: new Date().toISOString() };
  fs.writeFileSync(TUNNEL_FILE, JSON.stringify(state, null, 2));
  try { fs.chmodSync(TUNNEL_FILE, 0o600); } catch {}
  console.log('');
  printTunnelInfo(state);
  console.log('Runs in the background. Re-show this anytime:  sonar tunnel status   ·   Close it:  sonar tunnel stop');
}

function cmdHelp() {
  console.log(`sonar ${VERSION} — cross-session context bridge for Claude Code + Codex CLI

Daemon:
  sonar install        register MCP with Claude Code & Codex, install /sonar, start hub
  sonar start|stop|status
  sonar invite         print LAN URL + token + paste-ready setup for a teammate on the same network
  sonar daemon         run the hub in the foreground
  sonar port <N|auto>  change the hub port (re-registers with Claude/Codex); "auto" picks a free one

Remote teammates (across networks):
  sonar tunnel [--name <m>] [--provider cloudflared|ngrok] [--keep-token]
                       start a BACKGROUND tunnel + mint a per-member token, print the connect command
  sonar tunnel status  re-show the live tunnel URL + token + connect command
  sonar tunnel stop    close the tunnel, drop exposed mode, revoke the token
  sonar token add <name> | list | revoke <name|token>   manage per-member access tokens (revocable)
  sonar connect <hub-url> [--token <t>]   point THIS machine's Claude/Codex at a remote sonar hub

Terminal helpers (talk to the running hub):
  sonar create [title]
  sonar post <id> <message…>
  sonar read <id> [since_seq]
  sonar watch <id>     live-tail a link
  sonar brief [repo]   session-start catch-up: recent sessions + open questions/tasks/decisions for a repo
  sonar autopilot <id> on|off|status [--agent claude|codex] [--max N] [--headless]
                       self-executing task board: hub dispatches every ready task (worker or wake)
  sonar watches <id> [rm <watchId>]    list / remove event subscriptions on a link
  sonar search <query>
  sonar doc <id> [--open]              print (or open) the shared context doc
  sonar spawn <id> [claude|codex] <task…> [--headless]   dispatch a worker session on a link
  sonar wake <id> <label> [message…] [--force]   type a prompt into a live tmux pane to make a paused agent run again
  sonar attach                         attach to the sonar tmux session to watch agent panes
  sonar rm <id>                        delete a link and its doc
  sonar reindex                        rebuild the transcript search index
  sonar worktrees [prune <name|--all>] list / clean up worker git worktrees

Coordination enforcement:
  sonar guard install --link <id> --label <name> [--hub <url>] [--token <t>]
                                       install a pre-commit hook that blocks commits touching files
                                       another participant has claimed on the link
  sonar guard status | uninstall       inspect / remove the pre-commit guard in this repo
  sonar hooks                          show configured quality-gate hooks (~/.sonar/hooks.json)

Menu bar app:
  sonar bar            launch the macOS menu bar control panel (uv + rumps)
  sonar bar fg         run it in the foreground (to see errors)

Hub: ${BASE_URL}   MCP: ${MCP_URL}
Configure with env: SONAR_PORT (${PORT}), SONAR_DIR, SONAR_INDEX_DAYS,
  SONAR_HOST (bind addr; 0.0.0.0 to expose on the LAN), SONAR_TOKEN (shared access token for remote callers),
  SONAR_ALLOW_REMOTE_EXEC (permit code-exec endpoints for remote callers — off by default).`);
}

// --------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case 'daemon':
      return cmdDaemon();
    case 'start':
      return cmdStart();
    case 'stop':
      return cmdStop();
    case 'status':
      return cmdStatus();
    case 'invite':
      return cmdInvite();
    case 'install':
      return cmdInstall();
    case 'create':
      return cmdCreate(rest);
    case 'post':
      return cmdPost(rest);
    case 'read':
      return cmdRead(rest);
    case 'watch':
      return cmdWatch(rest);
    case 'search':
      return cmdSearch(rest);
    case 'doc':
      return cmdDoc(rest);
    case 'spawn':
      return cmdSpawn(rest);
    case 'wake':
      return cmdWake(rest);
    case 'attach':
      return cmdAttach();
    case 'rm':
      return cmdRm(rest);
    case 'brief':
      return cmdBrief(rest);
    case 'autopilot':
      return cmdAutopilot(rest);
    case 'watches':
      return cmdWatches(rest);
    case 'reindex':
      return cmdReindex();
    case 'worktrees':
      return cmdWorktrees(rest);
    case 'guard':
      return cmdGuard(rest);
    case 'hooks':
      return cmdHooks(rest);
    case 'token':
      return cmdToken(rest);
    case 'tunnel':
      return cmdTunnel(rest);
    case 'connect':
      return cmdConnect(rest);
    case 'port':
      return cmdPort(rest);
    case 'bar':
      return cmdBar(rest);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return cmdHelp();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      return cmdHelp();
  }
};

run().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
