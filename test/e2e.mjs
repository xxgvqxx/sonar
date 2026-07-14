// End-to-end smoke test: boots an ISOLATED hub (temp SONAR_DIR, temp HOME so the indexer
// finds nothing, SONAR_AUTOPILOT_DRY so dispatch never launches real agents) and drives
// the real MCP + REST surfaces: watches, autopilot dispatch/cascade/cap, and brief.
//
//   node --disable-warning=ExperimentalWarning test/e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 40000 + Math.floor(Math.random() * 20000); // avoid collisions with a real hub / parallel runs
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-e2e-'));
const FAKE_REPO = path.join(DIR, 'fakerepo');
fs.mkdirSync(FAKE_REPO, { recursive: true });

let failures = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond || !extra ? '' : `\n      ${extra}`}`);
  if (!cond) failures++;
};

const api = async (method, route, body) => {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${await res.text()}`);
  return res.json();
};

// ---- boot an isolated hub ---------------------------------------------------
const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'cli.ts'), 'daemon'], {
  env: {
    ...process.env,
    HOME: DIR, // indexer looks under $HOME/.claude + $HOME/.codex → nothing to index
    SONAR_DIR: path.join(DIR, '.sonar'),
    SONAR_PORT: String(PORT),
    SONAR_AUTOPILOT_DRY: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonLog = '';
daemon.stdout.on('data', (d) => (daemonLog += d));
daemon.stderr.on('data', (d) => (daemonLog += d));

const cleanup = () => {
  try {
    daemon.kill();
  } catch {}
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const h = await fetch(`${BASE}/health`);
    if (h.ok) {
      up = true;
      break;
    }
  } catch {}
  await sleep(250);
}
if (!up) {
  console.error(`hub never came up. daemon log:\n${daemonLog}`);
  process.exit(1);
}
console.log(`hub up on :${PORT} (data: ${DIR})`);

// ---- MCP client -------------------------------------------------------------
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return (r.content || []).map((c) => c.text || '').join('\n');
};

// ---- 1. new tools are registered ---------------------------------------------
console.log('\n[1] tool registration');
{
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['watch', 'unwatch', 'autopilot', 'brief']) ok(tools.includes(t), `tool "${t}" registered`);
  const help = await call('sonar_help', {});
  ok(/autopilot/.test(help) && /watch\(/.test(help) && /brief\(/.test(help), 'sonar_help mentions the new capabilities');
}

// ---- 2. link + watch(message) fires and wakes --------------------------------
console.log('\n[2] watches: message event');
const created = await call('link_create', { label: 'a@x', agent: 'claude', cwd: FAKE_REPO, title: 'e2e' });
const LINK = (created.match(/link:\s+(\w+)/) || [])[1];
ok(!!LINK, `link created (${LINK})`);
{
  const w = await api('POST', `/api/links/${LINK}/watches`, { label: 'a@x', event: 'message' });
  ok(w.id > 0, `watch #${w.id} armed via REST`);
  await call('link_join', { link_id: LINK, label: 'b@y', agent: 'codex', cwd: FAKE_REPO });
  await call('post', { link_id: LINK, from: 'b@y', body: 'hello from b' });
  const msgs = await api('GET', `/api/links/${LINK}/messages`);
  const fired = msgs.find((m) => m.from_label === 'sonar' && m.body.includes('a@x') && m.body.includes('watch'));
  ok(!!fired, 'watch fired → targeted 📣 message posted', JSON.stringify(msgs.map((m) => m.body)));
  const active = await api('GET', `/api/links/${LINK}/watches`);
  ok(active.length === 0, 'one-shot watch deactivated after firing');
  // own actions never fire own watches
  await api('POST', `/api/links/${LINK}/watches`, { label: 'a@x', event: 'message' });
  await call('post', { link_id: LINK, from: 'a@x', body: 'my own message' });
  const still = await api('GET', `/api/links/${LINK}/watches`);
  ok(still.length === 1, "poster's own watch did not fire on their own message");
  await api('DELETE', `/api/links/${LINK}/watches/${still[0].id}`);
}

// ---- 3. autopilot: dispatch, cascade, watch(task_done) ------------------------
console.log('\n[3] autopilot (dry-run): dispatch + cascade');
{
  const on = await call('autopilot', { link_id: LINK, from: 'a@x', on: true, cwd: FAKE_REPO, max: 2 });
  ok(/Autopilot ON/i.test(on), 'autopilot enabled via MCP');

  const t1 = await call('task_add', { link_id: LINK, from: 'a@x', title: 'build the thing' });
  ok(/dispatched it \(dry-run/i.test(t1), 'unassigned ready task #1 dispatched on add', t1);

  const st1 = await api('GET', `/api/links/${LINK}/autopilot`);
  ok(st1.inflight.some((t) => t.num === 1 && t.assignee === 'claude@task-1'), 'task #1 in flight, reserved for claude@task-1');

  const t2 = await call('task_add', { link_id: LINK, from: 'a@x', title: 'deploy the thing', depends_on: [1] });
  ok(/blocked/i.test(t2), 'dependent task #2 starts blocked (not dispatched)');

  await call('watch', { link_id: LINK, from: 'a@x', event: 'task_done', arg: '2' });

  await call('task_update', { link_id: LINK, num: 1, from: 'claude@task-1', status: 'doing' });
  const done1 = await call('task_update', { link_id: LINK, num: 1, from: 'claude@task-1', status: 'done' });
  ok(/Unblocked #2/.test(done1), 'finishing #1 unblocked #2');
  ok(/Autopilot dispatched: #2 \(dry-run\)/.test(done1), 'cascade: #2 dispatched the moment it unblocked', done1);

  const done2 = await call('task_update', { link_id: LINK, num: 2, from: 'claude@task-2', status: 'done' });
  ok(/now done/.test(done2), 'task #2 completed');
  const msgs = await api('GET', `/api/links/${LINK}/messages`);
  ok(
    msgs.some((m) => m.from_label === 'sonar' && m.body.includes('task_done 2')),
    'watch(task_done #2) fired on completion'
  );
}

console.log('\n[4] autopilot: concurrency cap + re-arm');
{
  await call('autopilot', { link_id: LINK, from: 'a@x', on: true, cwd: FAKE_REPO, max: 1 });
  await call('task_add', { link_id: LINK, from: 'a@x', title: 'cap test A' }); // #3
  await call('task_add', { link_id: LINK, from: 'a@x', title: 'cap test B' }); // #4
  const st = await api('GET', `/api/links/${LINK}/autopilot`);
  ok(st.inflight.length === 1 && st.inflight[0].num === 3, 'cap: only #3 in flight with max=1', JSON.stringify(st));
  ok(st.ready.some((t) => t.num === 4), 'cap: #4 waits undispatched');
  await call('task_update', { link_id: LINK, num: 3, from: 'claude@task-3', status: 'done' });
  const st2 = await api('GET', `/api/links/${LINK}/autopilot`);
  ok(st2.inflight.some((t) => t.num === 4), 'finishing #3 pulled #4 into flight');

  // re-arm: with autopilot OFF, resetting to todo must clear the dispatch reservation AND the
  // minted @task-4 assignee (else the retry would mis-route down the wake/ping path).
  const off = await call('autopilot', { link_id: LINK, from: 'a@x', on: false });
  ok(/OFF/i.test(off), 'autopilot disabled');
  await call('task_update', { link_id: LINK, num: 4, from: 'a@x', status: 'todo' });
  const st3 = await api('GET', `/api/links/${LINK}/autopilot`);
  const t4 = st3.ready.find((t) => t.num === 4);
  ok(!!t4, 'reset to todo re-arms the task');
  ok(t4 && !t4.assignee, 'minted @task-4 assignee cleared on re-arm');
  const on2 = await call('autopilot', { link_id: LINK, from: 'a@x', on: true, cwd: FAKE_REPO, max: 1 });
  ok(/#4 \(dry-run/.test(on2), 're-armed #4 re-dispatches as a fresh worker', on2);
  await call('autopilot', { link_id: LINK, from: 'a@x', on: false });
}

// ---- 5. brief -----------------------------------------------------------------
console.log('\n[5] brief');
{
  await call('doc_append', { link_id: LINK, from: 'a@x', section: 'Decisions', text: 'We will ship the fake thing on Tuesday.' });
  await call('doc_append', { link_id: LINK, from: 'a@x', section: 'Open questions', text: 'Who owns the deploy key?' });
  const viaRest = await api('GET', `/api/brief?cwd=${encodeURIComponent(FAKE_REPO)}`);
  ok(viaRest.repo === 'fakerepo', `repo derived from cwd (${viaRest.repo})`);
  ok(viaRest.links.some((l) => l.id === LINK), 'active link matched to the repo');
  const l = viaRest.links.find((l) => l.id === LINK);
  ok(l && /deploy key/.test(l.open_questions || ''), 'open questions surfaced');
  ok(l && /Tuesday/.test(l.decisions || ''), 'decisions surfaced');
  ok(l && l.open_tasks.some((t) => t.num === 4), 'open task #4 surfaced');
  const viaMcp = await call('brief', { cwd: FAKE_REPO });
  ok(/^BRIEF/.test(viaMcp) && viaMcp.includes(LINK) && /deploy key/.test(viaMcp), 'MCP brief tool renders the same picture');
}

// ---- 6. question/answer watch events -------------------------------------------
console.log('\n[6] watches: answer event');
{
  await call('watch', { link_id: LINK, from: 'a@x', event: 'answer' });
  await call('doc_append', { link_id: LINK, from: 'b@y', section: 'Answers', text: 'b@y holds the deploy key.' });
  const msgs = await api('GET', `/api/links/${LINK}/messages`);
  ok(
    msgs.some((m) => m.from_label === 'sonar' && m.body.includes('(answer)') && m.body.includes('a@x')),
    'watch(answer) fired when an Answer landed'
  );
}

// ---- 7. unwatch ownership -------------------------------------------------------
console.log('\n[7] unwatch ownership');
{
  const armed = await call('watch', { link_id: LINK, from: 'a@x', event: 'message' });
  const wid = Number((armed.match(/Watch #(\d+)/) || [])[1]);
  ok(wid > 0, `watch #${wid} armed`);
  const foreign = await call('unwatch', { link_id: LINK, from: 'b@y', id: wid });
  ok(/No matching watch/.test(foreign), "another participant cannot remove someone else's watch by id");
  const own = await call('unwatch', { link_id: LINK, from: 'a@x', id: wid });
  ok(/Removed 1/.test(own), 'owner can remove their own watch');
}

// ---- 8. nudge: unread report, read(from) cursor advance, hold-until-reply -------
console.log('\n[8] nudge (Stop-hook auto-resume)');
{
  const NUDGE_REPO = path.join(DIR, 'nudgerepo');
  fs.mkdirSync(NUDGE_REPO, { recursive: true });
  const made = await call('link_create', { label: 'claude@nud', agent: 'claude', cwd: NUDGE_REPO, title: 'nudge-e2e' });
  const L2 = (made.match(/link:\s+(\w+)/) || [])[1];
  ok(!!L2, `nudge link created (${L2})`);
  await call('link_join', { link_id: L2, label: 'codex@nud', agent: 'codex', cwd: NUDGE_REPO });

  // codex posts → the claude participant in that cwd has unread
  await call('post', { link_id: L2, from: 'codex@nud', body: 'question for claude' });
  const r1 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude' });
  ok(
    r1.attention.length === 1 && r1.attention[0].label === 'claude@nud' && r1.attention[0].unread >= 1,
    'nudge reports unread for the claude participant',
    JSON.stringify(r1)
  );
  ok(r1.candidates.some((c) => c.link_id === L2 && c.label === 'claude@nud'), 'candidate participations listed');

  // links filter scopes the check (how the hook excludes links this session never touched)
  const rf = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude', links: ['zzzz'], hold_ms: 5000 });
  ok(rf.attention.length === 0 && rf.candidates.length === 0 && rf.held === false, 'links filter excludes non-participating sessions (no block, no hold)');
  const rf2 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude', links: [L2] });
  ok(rf2.attention.length === 1, 'links filter passes the participating link through');

  // the poster's own agent has nothing unread (own messages excluded)
  const r2 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'codex' });
  ok(r2.attention.length === 0, "poster's own nudge is quiet (own messages don't count)");

  // read(from=…) advances the cursor → nudge goes quiet
  await call('read', { link_id: L2, from: 'claude@nud' });
  const r3 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude' });
  ok(r3.attention.length === 0, 'read(from=me) marks messages as seen — nudge goes quiet');

  // claude replies (now awaiting a reply) → a held nudge resolves the moment codex posts
  await call('post', { link_id: L2, from: 'claude@nud', body: 'answer for codex' });
  const held = api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude', hold_ms: 8000 });
  await sleep(600);
  await call('post', { link_id: L2, from: 'codex@nud', body: 'follow-up from codex' });
  const t0 = Date.now();
  const r4 = await held;
  ok(r4.held === true && r4.attention.length === 1 && r4.attention[0].unread >= 1, 'held nudge resolved by the peer reply', JSON.stringify(r4));
  ok(Date.now() - t0 < 5000, 'hold resolved promptly (did not run out the window)');

  // not awaiting a reply (peer spoke last) + nothing unread → returns immediately, no hold
  await call('read', { link_id: L2, from: 'claude@nud' });
  const t1 = Date.now();
  const r5 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'claude', hold_ms: 5000 });
  ok(r5.held === false && r5.attention.length === 0 && Date.now() - t1 < 2000, 'no hold when the peer spoke last and nothing is unread');

  // awaiting a reply that never comes → hold runs its window, then returns empty
  await call('read', { link_id: L2, from: 'codex@nud' });
  const t2 = Date.now();
  const r6 = await api('POST', '/api/nudge', { cwd: NUDGE_REPO, agent: 'codex', hold_ms: 2000 });
  ok(r6.held === true && r6.attention.length === 0 && Date.now() - t2 >= 1800, 'hold times out quietly when no reply lands');

  // unknown cwd → no candidates, instant empty
  const r7 = await api('POST', '/api/nudge', { cwd: path.join(DIR, 'nowhere'), agent: 'claude', hold_ms: 5000 });
  ok(r7.attention.length === 0 && r7.held === false, 'cwd with no active links is instantly quiet');
}

await client.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
