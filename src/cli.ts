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
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    if (pid && (process.kill(pid, 0) as any) !== false) return pid;
  } catch {
    /* not running */
  }
  return null;
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

You have the sonar MCP tools: link_create, link_join, doc_read, doc_append, doc_set_section, post, wait, read, search_context, spawn_worker. sonar coordinates multiple Claude Code / Codex sessions through a per-link SHARED MARKDOWN DOC that is the source of truth (both agents and the human read and edit it). Pings via post/wait just say "the doc changed".

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

## Dispatch / search
- spawn_worker(link_id, task) — launch a new Claude/Codex session in an isolated git worktree that joins the link and works the task, writing back into the doc.
- search_context(query, optional repo/branch/agent) — full-text search across BOTH Claude Code and Codex history (branch filter is exact only for Claude logs; filter Codex by repo).

Live back-and-forth needs the other session active on the same link at the same time; otherwise writes are saved for when it joins, or use spawn_worker.
`;
}

function installClaude(url: string): string {
  try {
    fs.mkdirSync(CLAUDE_CMD_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLAUDE_CMD_DIR, 'sonar.md'), SLASH_COMMAND);
  } catch (e) {
    return `  slash command: FAILED (${(e as Error).message})`;
  }
  // (re)register the MCP server with the Claude Code CLI (user scope). remove-then-add is
  // idempotent and updates the URL when the port changes.
  try {
    execFileSync('claude', ['mcp', 'remove', 'sonar', '-s', 'user'], { stdio: 'pipe' });
  } catch {
    /* not registered yet */
  }
  try {
    execFileSync('claude', ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'sonar', url], { stdio: 'pipe' });
    return `  Claude Code: registered MCP server at ${url} + /sonar command`;
  } catch (e) {
    return (
      `  Claude Code: /sonar command written, but auto-registration failed (${(e as Error).message}).\n` +
      `    Run manually:  claude mcp add --transport http --scope user sonar ${url}`
    );
  }
}

function installCodex(url: string): string {
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
  } catch (e) {
    lines.push(`  Codex config: FAILED (${(e as Error).message})`);
  }
  return lines.join('\n');
}

// Session-init awareness injected into every Claude/Codex session so it knows it
// can spawn a worker / pull context from the start (not only after /sonar).
const SESSION_INIT = `## sonar — multi-session coordination (available)
A local **sonar** MCP server is running, letting you coordinate with other Claude Code / Codex sessions. When it helps, use it:
- **spawn_worker(link_id, task)** — if a task has a separable part (investigate another area/repo, run a parallel subtask, reproduce something in isolation), call link_create then spawn_worker to launch a worker agent in an isolated git worktree that does it and reports back through the shared doc. (Guided flow: /sonar — Codex: the "sonar" skill.)
- **search_context(query, repo?, branch?)** — pull relevant context from your OWN past sessions (Claude + Codex history) instead of asking the user to re-paste.
- Each link has a shared doc at ~/.sonar/links/<id>/context.md that is the source of truth; collaborate via doc_append / doc_read, ping with post / wait.
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
  return `${installClaude(url)}\n${installCodex(url)}`;
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
  console.log(installClaude(url));
  console.log(installCodex(url));
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

function cmdHelp() {
  console.log(`sonar ${VERSION} — cross-session context bridge for Claude Code + Codex CLI

Daemon:
  sonar install        register MCP with Claude Code & Codex, install /sonar, start hub
  sonar start|stop|status
  sonar invite         print LAN URL + token + paste-ready setup for a teammate on the same network
  sonar daemon         run the hub in the foreground
  sonar port <N|auto>  change the hub port (re-registers with Claude/Codex); "auto" picks a free one

Terminal helpers (talk to the running hub):
  sonar create [title]
  sonar post <id> <message…>
  sonar read <id> [since_seq]
  sonar watch <id>     live-tail a link
  sonar search <query>
  sonar doc <id> [--open]              print (or open) the shared context doc
  sonar spawn <id> [claude|codex] <task…> [--headless]   dispatch a worker session on a link
  sonar wake <id> <label> [message…] [--force]   type a prompt into a live tmux pane to make a paused agent run again
  sonar attach                         attach to the sonar tmux session to watch agent panes
  sonar rm <id>                        delete a link and its doc
  sonar reindex                        rebuild the transcript search index
  sonar worktrees [prune <name|--all>] list / clean up worker git worktrees

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
    case 'reindex':
      return cmdReindex();
    case 'worktrees':
      return cmdWorktrees(rest);
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
