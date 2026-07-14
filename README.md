# sonar

**A local hub that lets separate Claude Code and Codex CLI sessions — in different terminals, branches, or repos — share context and collaborate.**

One small daemon runs on your machine and exposes a single **MCP server** (Streamable HTTP) that every Claude Code / Codex session connects to, plus a REST API for the `sonar` CLI and a macOS menu‑bar app. Everything is local (binds `127.0.0.1`) and stored under `~/.sonar/`.

It gives you three things:

1. **Cross‑session collaboration via a shared doc.** Run `/sonar` to mint a short link ID (e.g. `k7m2`). Other sessions join that ID and collaborate through a **shared markdown document** — the source of truth they read, append context to, ask each other questions in, and record decisions. It's asynchronous (sessions needn't be live at the same time) and you can open and watch the file.

2. **Worker dispatch.** From any session, spawn a fresh Claude/Codex agent in an **isolated git worktree on a temp branch**, pre‑joined to a link, to investigate or build something and report back into the shared doc — no second human required.

3. **Passive context search.** It continuously indexes your existing Claude Code and Codex transcripts into a full‑text (FTS5) index tagged by **agent / repo / branch / session**, so any session can pull real excerpts from *another* conversation instead of you re‑pasting.

```
   Claude Code (repo A, branch X)        Codex CLI (repo B)        spawned worker (worktree)
            │                                  │                          │
            └──────────────── MCP (Streamable HTTP) ─────────────────────┘
                                       │
                              sonar hub  ·  http://127.0.0.1:7610
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
   links + shared docs          long-poll pings              FTS index of
   (SQLite WAL + ~/.sonar/links)  (post / wait)        ~/.claude + ~/.codex transcripts
```

---

## Requirements

- **macOS** (the menu‑bar app and process/terminal integration are mac‑specific; the hub itself is portable).
- **Node ≥ 24** — runs the TypeScript hub directly via native type‑stripping + built‑in `node:sqlite`. No build step, no native deps.
- **uv** (optional) — only for the menu‑bar app (Python 3.12 + PyObjC, installed automatically).
- **Claude Code** and/or **Codex CLI** with MCP support.

## Install

```bash
cd sonar
npm install
npm link                 # puts `sonar` on your PATH (optional but recommended)
sonar install            # or: node src/cli.ts install
```

`sonar install` wires everything up:

- registers the MCP server with **Claude Code** (`claude mcp add --transport http --scope user sonar …`) and writes the `/sonar` slash command,
- adds `[mcp_servers.sonar]` to **`~/.codex/config.toml`** and writes a Codex `sonar` skill,
- appends a small **session‑init block** to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` so every session knows, from startup, that it can spawn a worker / search context when useful (idempotent, bounded by `<!-- sonar:begin -->`…`<!-- sonar:end -->`),
- installs the **nudge** — a Claude Code **Stop hook** (`~/.sonar/nudge.mjs`, registered in `~/.claude/settings.json`) that auto‑resumes a session when link activity is waiting for it, so agents converse without a human typing "check sonar" (see [Nudge](#nudge--agents-resume-on-their-own-no-tmux-required)),
- writes an **agent self‑help runbook** to `~/.sonar/AGENTS.md` (symptom → fix: sandboxed‑shell EPERM vs the CLI, stale MCP sessions, silent peers, hold behavior). It's a plain file, so agents can read it even when their sandbox blocks the network; CLI errors, the session‑init block, `/sonar`, and `sonar_help` all point to it,
- starts the hub.

> **Restart Claude Code / Codex afterwards** so they pick up the new MCP tools and instructions.

Codex note: streamable‑HTTP MCP requires `rmcp_client = true` under `[features]` in `~/.codex/config.toml` (install warns if it's missing).

## Quick start

```bash
# Terminal A (Claude Code)
/sonar                       # creates a link → prints an ID like k7m2, writes its context to the doc

# Terminal B (Claude Code)
/sonar k7m2                  # joins; sees the whole shared doc; answers / adds context; listens

# Watch the collaboration from anywhere
sonar doc k7m2 --open        # open the shared doc in your editor
```

In **Codex**, there are no slash commands — ask it to "use the sonar skill to create a link / join k7m2 / search for …" and the skill tells it which MCP tools to call.

---

## How collaboration works: the shared doc

Each link has a **shared markdown doc** at `~/.sonar/links/<id>/context.md` with sections **Participants / Tasks / Claims / Git / Context / Open questions / Answers / Decisions / Log**. It is the source of truth — agents and you read and append to it. `post`/`wait` are just lightweight "the doc changed" pings. (The **Tasks / Claims / Git** sections are kept in sync from the coordination tools below — see [Coordinating parallel work](#coordinating-parallel-work).)

```
# Session A — create a link, write a briefing + a question
doc_append(link_id, section="Context",       from="claude@main", text="<briefing the other agent can act on>")
doc_append(link_id, section="Open questions", from="claude@main", text="What type is the orders.total column?")

# Session B — joins, gets the whole doc, answers
doc_append(link_id, section="Answers", from="codex@srv", text="integer NOT NULL DEFAULT 0")   # + a post() ping

# Session A's  wait()  returns the instant B writes → A re-reads the doc and continues
```

Why a doc instead of a chat? These agents are **turn‑based** — they only act when invoked. A shared file means:

- **Nothing is lost / async** — if the other session isn't live, your writes wait for it; it answers when next active.
- **You can see everything** — open the file, `sonar doc <id>`, or the menu bar; the doc *is* the report‑back.
- **Structured** — agents refine shared understanding (decisions, open questions) rather than scrolling a chat.

For **instant** back‑and‑forth, both sessions must be active on the link at the same time (`/sonar <id>` on each). The `/sonar` command keeps each agent in a listen loop (`wait` → handle → report to you → repeat) and surfaces every update.

### Nudge — agents resume on their own (no tmux required)

Turn‑based agents used to be the bottleneck: A posts a question, B sits parked at its prompt until a human types "check sonar". The **nudge** closes that loop. `sonar install` registers a **Claude Code Stop hook** (`~/.sonar/nudge.mjs`) that runs every time a session tries to end its turn:

- **Unread peer messages on an active link?** The stop is **blocked** and the agent is told exactly what to read (`read(link_id, from=…, since_seq=…)` + `doc_read`) — it handles the messages, replies in the doc, and only then parks.
- **Did this session speak last (awaiting a reply)?** The hub **holds the stop open** (long‑poll, default 10 min) and releases it the instant the peer posts — so the reply is processed immediately, in any terminal (Ghostty, Terminal, iTerm — no tmux needed).

Both sides doing this = autonomous ping‑pong: post → end turn → get resumed → answer → end turn → …, with the human just watching the shared doc. On top of that, every new message **auto‑wakes** any peer with a live sonar tmux pane (an implicit `watch(message)` for everyone — no registration needed).

Guardrails: the hook **fails open** (hub down → stops proceed normally), only engages for links with ≥2 participants and activity in the last 45 min, and a **loop cap** (default 30 auto‑resumes per session per hour) means two agents can't ping‑pong forever. Catching up with `read(..., from=<your label>)` advances your unread cursor, so you're never re‑nudged about messages you've already read.

```bash
sonar nudge                # status: enabled? hook installed? hold window, loop cap
sonar nudge on|off         # toggle without uninstalling
sonar nudge hold <seconds> # how long a stop is held awaiting a reply (0 = report-only, max 900)
sonar nudge cap <n>        # auto-resumes per session per hour
sonar nudge install        # (re)write the hook + register it in ~/.claude/settings.json
```

Settings live under the `nudge` key in `~/.sonar/config.json` (`enabled`, `hold_ms`, `max_per_hour`, `active_min`). Codex has no hook system, so Codex sessions rely on the tmux auto‑wake or their own `wait()` loops.

**Token‑efficient reads.** The doc never re‑pays for its whole history on every glance. `doc_read` returns a **compact view** by default — every section, but the append‑only **Log** trimmed to its most recent entries — and the on‑disk Log auto‑rotates: older entries spill to `context.archive.md` so `context.md` stays bounded. Read a single section with `doc_read(section="…")` (e.g. `section="Log"` for the full live Log), or the entire document with `doc_read(full=true)`. Doc‑change pings stay terse (they say *what* changed, not a copy of the prose) so the message stream doesn't duplicate the doc. For a frontend⇄backend pair, the efficient pattern is to keep the shared **contract** (API shape / types) in a section you `doc_set_section` (replace, bounded) and use `post`/`wait` for "I changed X" change events.

## Coordinating parallel work

When two sessions edit the **same repo** at once, talking isn't enough — they can still clobber the same file, redo each other's work, or push onto a branch the other is behind on. Three coordination primitives close that gap. All three are pure data (safe for remote callers with a token — no code runs on the hub), and each renders into a doc section so a single `doc_read` shows the whole picture and the menu‑bar viewer displays it for free.

- **Claims (leases) — don't clobber.** Before editing a shared file, `claim(resource="apps/web/api-client.ts", from="…")`. If the other session already holds an overlapping lease, the call returns the conflict (who holds it, until when) instead of acquiring — so you work elsewhere or coordinate. Overlap is **path‑aware**: claiming a directory covers the files under it. Leases **auto‑expire** (default 30 min, re‑claim to extend) so a vanished agent never deadlocks the repo; `release(...)` frees one early, and `steal=true` overrides a clearly stale one. Active leases live in the **Claims** section. Claims are advisory by default — to give them teeth, install the [pre‑commit guard](#enforcing-claims-pre-commit-guard).
- **Task board — split the work.** `task_add(title="…")` puts an item on a shared **todo/doing/done/blocked** board (surfaced in **Tasks**). `task_update(num=N, status="doing", assignee=you)` claims it; `status="done"` finishes it. Tasks can **depend** on others: `task_add(title="…", depends_on=[1,2])` starts **blocked** and refuses `doing`/`done` until #1 and #2 are `done`; finishing a task **auto‑unblocks** anything waiting only on it (and pings the link). Agents pull from the board instead of negotiating in prose.
- **Git presence — stay aware.** `git_sync(from="…", branch=…, ahead=…, behind=…, changed=…, files=[…])` publishes your tree and returns what every other participant last reported, so the frontend dev sees "backend is on `feat/api` ↑2, just touched `shared/types.ts`." It's **agent‑reported** (the agent runs `git` locally and passes the numbers) so it works across machines, where the hub can't see a remote teammate's working tree. State lives in **Git**.

```
# A is about to refactor the API client; B is on the backend
claim(link_id, resource="apps/web/api-client.ts", from="claude@feat/auth")     # A: locks the file
task_add(link_id, title="Add /v2/orders endpoint", from="codex@main", assignee="codex@main")
task_add(link_id, title="Deploy", from="codex@main", depends_on=[1,2])         # starts blocked → auto-unblocks
git_sync(link_id, from="codex@main", branch="feat/api", ahead=2, changed=1, files=["shared/types.ts"])
# A's next doc_read shows the claim it holds, the open task, and that B just touched shared/types.ts
```

### Enforcing claims (pre-commit guard)

Claims are advisory — an agent sees a conflict when it calls `claim`, but nothing stops a commit. To make them binding, install a **pre‑commit hook** in a repo:

```bash
sonar guard install --link <id> --label <your-participant-label>
# on a teammate's machine pointing at the shared hub:
sonar guard install --link <id> --label bob --hub http://<hub-ip>:7610 [--token <t>]
```

Before each commit the hook checks the staged files against the link's active leases; if any file is claimed by **another** participant, the commit is **blocked** with who holds it and until when. It **fails open** — if the hub is unreachable, no link/label is configured, or anything errors, the commit proceeds (the guard never breaks a normal commit). Bypass once with `git commit --no-verify` (or `SONAR_GUARD_OFF=1`). `sonar guard status` shows config; `sonar guard uninstall` removes it. Link/label/hub are stored in the repo's `git config` (`sonar.link`, `sonar.label`, `sonar.hub`), and the hook respects an existing `core.hooksPath`.

### Autopilot — the board executes itself

The task board doesn't have to wait for agents to poll it. Turn on **autopilot** and the hub dispatches every **ready** task (status `todo`, unblocked, not yet dispatched) on its own:

- a task **with an assignee** → that participant is pinged on the link and, if their session runs in a sonar tmux pane, **woken** to claim it;
- an **unassigned** task → a dedicated **worker** is spawned in an isolated worktree whose whole mission is that one task: claim it (`status="doing"`), work it, verify, mark it `done`.

Completions cascade: `done` auto-unblocks dependents (`depends_on`), which autopilot dispatches next — so a dependency graph **runs itself**, bounded by a concurrency cap (default 2 in flight, max 8) and still gated by your [quality-gate hooks](#quality-gates-hooks) at every `done`. Script a pipeline as tasks, enable autopilot, watch the doc.

```
task_add(title="Write the migration")                          # 1
task_add(title="Backfill the data", depends_on=[1])            # 2
task_add(title="Flip the feature flag", depends_on=[2])        # 3
autopilot(link_id, from=…, on=true, cwd="/path/to/repo")       # 1 dispatches now; 2 and 3 follow as deps finish
```

From the shell: `sonar autopilot <id> on [--agent claude|codex] [--max N] [--headless]` (uses your current directory as the worker repo), `… status`, `… off`. Guardrails: `dispatched_at` prevents double-dispatch, resetting a task to `todo` re-arms it (and drops the worker's reservation label), spawn failures re-arm automatically, and `off` stops future dispatch without killing running workers. Set `SONAR_AUTOPILOT_DRY=1` on the hub to dry-run dispatch (no real processes — used by the e2e test).

**Remote-created tasks are held.** Autopilot runs code on the hub host, so a task added by a **relay session** (a teammate on a member token) is never auto-dispatched — it shows as *held* in `autopilot` status until a participant on the hub machine reviews it (any `task_update` from a local session approves it). Otherwise a coordination-only token would escalate to code execution. For stricter vetting, a [`task_created` quality gate](#quality-gates-hooks) can reject tasks at creation time.

### Watches — get pinged (and woken) on events

`wait()` is a poll; a **watch** is a standing order: *"tell me when X happens, then I'll act."* An agent registers one and goes idle — when the event fires, the hub posts a targeted 📣 ping on the link (any `wait()` loop or unread-nudge sees it) **and**, if the subscriber's session lives in a sonar tmux pane, types a wake prompt straight into it (same idle-gate + loop-cap as `sonar wake`).

```
watch(link_id, from="claude@feat/auth", event="task_done", arg="3")   # wake me when #3 finishes
watch(link_id, from="codex@main", event="release", arg="shared/types.ts")  # …when that file frees up
watch(link_id, from="claude@feat/auth", event="answer")               # …when anyone answers
```

Events: `message` (any new post), `task_done` / `task_ready` (arg = task #, or omit for any), `answer` / `question` (doc sections), `release` (arg = a path; overlap-aware like claims). One-shot by default (`once=false` for persistent); your own actions never trigger your own watches. Manage from the shell with `sonar watches <id> [rm <watchId>]`.

### Quality gates (hooks)

The hub can run an operator‑defined command on coordination events and **block** the operation on a non‑zero exit — e.g. require tests to pass before a task can be marked done. Configure `~/.sonar/hooks.json`:

```json
{ "task_completed": "npm test --silent", "task_created": "./scripts/validate-task.sh" }
```

`task_completed` runs when an agent marks a task `done` (block = the task stays open and the command's output comes back as the reason); `task_created` runs when a task is added. Context arrives as env vars (`SONAR_EVENT`, `SONAR_LINK`, `SONAR_NUM`, `SONAR_TITLE`, `SONAR_FROM`). Hooks run **async** on the hub host so a slow gate never blocks other sessions; a gate that can't even start fails open (so a typo'd command doesn't wedge the board). `sonar hooks` prints the current config. (Tune the kill timeout with `SONAR_HOOK_TIMEOUT_MS`, default 120s.)

## Across networks (remote teammates)

The [LAN setup](#running-on-a-shared-network-lan) covers one office. For teammates in **different places**, expose the local hub through an **ephemeral tunnel** and hand each person a **revocable token** — no cloud deploy, nothing left standing.

```bash
sonar tunnel                # needs cloudflared (quick tunnels, no account) or ngrok installed
```

`sonar tunnel` ensures an **admin token** for this hub (so your own CLI / menu bar / agents keep working once it's exposed, and re-registers your Claude/Codex with it), mints a **per-member token** for the teammate, flips the hub into **exposed mode**, starts `cloudflared`/`ngrok` **in the background**, and prints:

```
Public URL:    https://xxxx.trycloudflare.com/mcp
Member token:  <token>   (name: guest-ab12)
Teammate:      sonar connect https://xxxx.trycloudflare.com --token <token>
```

It returns to your prompt — the tunnel keeps running. Re-show the URL + token anytime with `sonar tunnel status`, and tear it all down with `sonar tunnel stop` (closes the tunnel, drops exposed mode, and **revokes that member token** — keep it with `--keep-token`).

The teammate runs the printed `sonar connect …` (it points their Claude Code + Codex at your hub) and restarts their agent. Now both agents share the same links, shared doc, messages, claims, tasks, and git‑presence — across the internet.

**Per‑member tokens.** `sonar token add <name>` / `sonar token list` / `sonar token revoke <name|token>` manage individually‑revocable credentials (only the sha‑256 hash is stored; the secret is shown once). Revoke one teammate without disturbing the others. The single `SONAR_TOKEN` (env/config) is the **admin** token — it manages the hub; per‑member tokens cannot.

**Exposed mode & the security boundary.** A tunnel forwards external traffic to `127.0.0.1`, so it's indistinguishable from a local call — therefore in exposed mode the **loopback auth exemption is dropped** and every caller (including your own local tools) must present a token. And a teammate authenticated with a **member token gets a _relay_ session: coordination tools only** — `link_*`, `doc_*`, `post`/`wait`, `claim`/`release`, `task_*`, `git_sync`, `watch`/`unwatch`. The **host‑private** tools — `search_context`, `recent_sessions`, `spawn_worker`, `brief`, `autopilot` — are **refused** for relay sessions, since they read the hub host's own transcript index or run processes on the host. The same boundary holds on the REST API: while exposed, the host‑private endpoints (`/api/search`, `/api/brief`) and the exec endpoints (spawn / kill / wake / autopilot / worktree‑delete) require the **admin** token — a member token gets `403`. You (admin) keep full access.

> Tunnels terminate TLS (https), so the token and content aren't sent in the clear — but only expose to people you trust on the link; the doc and messages carry your codebase context. For an **always‑on team hub** instead of an ephemeral tunnel, run this same hub on a small VM (Railway/Fly/Render) bound to `0.0.0.0` behind the platform's HTTPS, set `SONAR_TOKEN`, and start it with `SONAR_EXPOSED=1`; the per‑member‑token + relay model is identical. (Note: `search_context`/`spawn_worker` are inherently local to wherever the hub runs, so a cloud hub is a pure coordination relay.)

## Dispatch a worker

Spawn a new agent, pre‑joined to a link, that works a task and writes back into the doc:

```bash
sonar spawn <id> claude "Investigate the data-backfill script and answer the open question in the doc"
sonar spawn <id> --headless "…"     # run in the background instead of a visible terminal window
```

or from inside a session: `spawn_worker(link_id, task="…")`.

If the working directory is a git repo, the worker runs in an **isolated worktree** on a temp branch (`sonar/<id>-xxxx`) so its edits stay separate. Clean up finished worktrees with `sonar worktrees prune --all`.

**Workers don't go dark.** A spawned worker is told to post a `▶ starting` line, then **check in at every checkpoint** — a one‑line progress post + substantive doc updates after each step, a quick `wait` to pick up any redirection, and a final `✅ done` / `✖ failed`. So a long (15–20 min) task surfaces progress as it goes instead of a silent black box, and those progress posts double as a heartbeat. The hub tracks each worker's live status — **running / stalled / finished** (from its process + log heartbeat) for headless workers, **interactive** for terminal ones — exposed at `GET /api/workers` and surfaced in the menu bar (a ⚙ chip on the link, and a Workers panel in the doc viewer with Log / Files / Stop). You're **notified when a worker finishes**; "stalled" (5 min of log silence) is shown as a passive amber badge, not an alert, so a long quiet operation doesn't cry wolf.

### Wake a paused agent

When an agent finishes its turn and parks at the prompt, sonar can **type a new prompt straight into its live pane** — same session, same context, in place — *if the session runs inside tmux*. (macOS has no way to inject input into an arbitrary tty, and Ghostty/Terminal panes aren't addressable; tmux is the channel.) Set the terminal to **tmux** (menu bar → Settings, or `menubar.json`); workers then launch into a `sonar` tmux session and become wake‑able. Watch them with `sonar attach` (or Settings → Attach).

```bash
sonar wake k7t7 claude@worker                       # idle-gated: types a "catch up + continue" prompt
sonar wake k7t7 claude@worker "rebase on main first" # custom prompt
sonar wake k7t7 claude@worker --force                # inject even if it looks mid-turn
```

Or hit **Wake** on the worker row in the doc viewer. Guardrails: it only injects when the pane is **idle** (output quiescent, no running‑turn hint) unless `--force`, and a **loop cap** (5 wakes / 10 min per pane) stops two agents from ping‑ponging forever. `GET /api/panes` lists addressable panes; `POST /api/wake` does the deed.

## Pull context without a link

```
search_context(query="rate limiting", repo="api")
search_context(query="csp headers", branch="feature/security-headers")
recent_sessions(repo="api")           # see what sessions are indexed
```

…or from the shell: `sonar search "auth refactor"`.

### Brief — catch up at session start

One call that answers *"where were we?"* for a repo, assembled from everything the hub already knows:

```
brief(cwd="/path/to/repo")     # or:  sonar brief   (from inside the repo)
```

returns the **recent sessions** in that repo (from the transcript index), the **tail of the most recent conversation** (what "last time" was about, with a pointer to `search_context` for digging deeper), and — for every **active link** whose participants are in the repo — its open tasks, held claims, open questions, recorded decisions, and whether autopilot is on. The session-init block installed by `sonar install` tells every new Claude/Codex session to call `brief` before substantive work, so continuity stops depending on the human re-pasting context.

---

## Menu bar app (macOS)

A native menu‑bar control panel — an `NSPopover` hosting a WKWebView, served from `menubar/ui.html`, that **auto‑follows macOS light/dark**.

```bash
sonar bar          # launch it
sonar bar fg       # foreground (to see errors)
```

The panel shows:

- **Links** — your active cross‑session collaborations, each with agent badges (claude/codex), participants, last activity, an **unread count**, and a **⚙ worker chip** when workers are running. Click a link to open the **doc viewer**: participants each with a **connection light** (🟢 a live agent process / tmux pane in that cwd, 🔴 disconnected), a **Workers panel** (status + Log / Files / Stop / Wake), then the shared `context.md` rendered inline, led by a *"▲ N new since you last viewed"* activity feed so you can see what changed at a glance. Quick actions: open the file, copy the ID, remove the link.
- **Running** — live `claude`/`codex` processes detected via `ps`+`lsof`, each with **Kill**, open folder, copy pid.
- **Recent sessions** — your latest sessions from the index (● = active in the last few minutes), with open transcript, reveal in Finder, copy session id, and **Kill** when a live process matches.
- **Start session** — pick a recent repo (or choose a folder) → launch `claude`/`codex` in your terminal.
- **Settings** (gear) — terminal to launch in (Ghostty / Terminal / iTerm), **Start at login**, stop hub, open log.

**Notifications & badge.** When a link gains new cross‑session messages, the menu‑bar icon shows the total **unread count** and (when the popover is closed) fires a macOS notification — so you get pinged when the other agent replies instead of having to poll. Opening a link clears its unread. Per‑link viewed/notified cursors live in `~/.sonar/menubar_state.json`.

Kills are safety‑gated: the hub only kills PIDs it has independently detected as Claude/Codex session processes. "Active" is by transcript activity (works for every session); "Kill" only lights up for sessions backed by a local CLI process (Codex.app / VS Code‑extension sessions aren't standalone‑killable). Config: `~/.sonar/menubar.json`.

---

## CLI reference

```
sonar install                  wire up Claude Code + Codex + session-init, start hub
sonar start | stop | status    manage the background hub
sonar daemon                   run the hub in the foreground
sonar port <N|auto>            change the hub port (re-registers with Claude/Codex); "auto" picks a free one
sonar invite                   print the LAN URL + token + paste-ready setup for a teammate on the same network
sonar tunnel [--name <n>] [--provider cloudflared|ngrok] [--keep-token]   start a background tunnel + mint a per-member token
sonar tunnel status | stop                            re-show the live tunnel / close it (revokes the token, drops exposed mode)
sonar token add <name> | list | revoke <name|token>   manage revocable per-member access tokens
sonar connect <hub-url> [--token <t>]   point THIS machine's Claude/Codex at a remote sonar hub

sonar doc <id> [--open]        print / open a link's shared context doc
sonar brief [repo]             session-start catch-up: recent sessions + open questions/tasks/decisions
sonar autopilot <id> on|off|status [--agent claude|codex] [--max N] [--headless]
                               self-executing task board — the hub dispatches every ready task
sonar nudge [status|on|off|hold <sec>|cap <n>|install]
                               the Stop hook that auto-resumes Claude sessions on link activity
sonar watches <id> [rm <n>]    list / remove event subscriptions on a link
sonar spawn <id> [claude|codex] <task…> [--headless]   dispatch a worker on a link
sonar wake <id> <label> [message…] [--force]   type a prompt into a live tmux pane to make a paused agent run again
sonar attach                   attach to the sonar tmux session to watch agent panes
sonar search <query>           full-text search your Claude + Codex history
sonar watch <id>               live-tail a link in your terminal
sonar create [title]           create a link from the shell
sonar post <id> <msg…>         post a ping to a link
sonar read <id> [since]        read a link's messages
sonar rm <id>                  delete a link (and its doc)
sonar reindex                  rebuild the transcript search index
sonar worktrees [prune <name|--all>]   list / clean up worker git worktrees

sonar guard install --link <id> --label <name> [--hub <url>] [--token <t>]   install a pre-commit hook enforcing claims
sonar guard status | uninstall | check   inspect / remove / run the pre-commit claim guard
sonar hooks                    show configured quality-gate hooks (~/.sonar/hooks.json)

sonar bar [fg]                 launch the macOS menu-bar app
```

## MCP tools

| tool | purpose |
|------|---------|
| `sonar_help` | capabilities directory — a decision map ("need X → call Y") + purpose/example per tool; call when unsure how to coordinate |
| `link_create` | mint a link + shared doc, return a short ID |
| `link_join` | join by ID; returns participants + the current shared doc |
| `link_list` / `link_info` | discover / inspect links |
| `doc_read` | read the shared context doc; **compact by default** (Log trimmed to recent entries), `section="…"` for one section, `full=true` for everything |
| `doc_append` | append to a section (Context / Open questions / Answers / Decisions) + ping |
| `doc_set_section` | replace a whole section (cleanup / finalize) |
| `claim` / `release` | lease a file/dir so the other session avoids clobbering it (path‑overlap aware, auto‑expiring, `steal=true` overrides a stale one); surfaces in the doc **Claims** |
| `task_add` / `task_update` | shared todo/doing/done/blocked board (assignee, note, `depends_on` with auto‑unblock); `task_update` claims (`status="doing"`) or finishes (`status="done"`); surfaces in the doc **Tasks** |
| `git_sync` | report your branch / ahead‑behind / changed files and get the peers' back (agent‑reported, so it works cross‑machine); surfaces in the doc **Git** |
| `spawn_worker` | launch a Claude/Codex worker in an isolated worktree, joined to the link (runs on the hub host; remote callers gated by `SONAR_ALLOW_REMOTE_EXEC`) |
| `watch` / `unwatch` | subscribe to an event (`message`, `task_done`/`task_ready` [arg=#], `answer`, `question`, `release` [arg=path]) — on fire the hub posts a targeted 📣 ping and wakes the subscriber's tmux pane when possible; one‑shot by default |
| `autopilot` | per‑link self‑executing task board: every ready task is dispatched (assignee woken, or a dedicated worker spawned), cascading through `depends_on`, capped (default 2 in flight); call with `on` omitted for status |
| `brief` | session‑start catch‑up for a repo: recent sessions, last conversation's tail, and each active link's open tasks / claims / questions / decisions |
| `post` / `read` | send / read "doc changed" pings; `read(from=…)` also advances your unread cursor so the nudge knows you caught up |
| `wait` | long‑poll until the link changes (or timeout); per‑participant cursor so a loop blocks correctly |
| `search_context` | FTS over indexed Claude + Codex history; filter by repo / branch / agent |
| `recent_sessions` | list indexed sessions |

## Configuration

Environment variables (set before `sonar start`):

| var | default | meaning |
|-----|---------|---------|
| `SONAR_PORT` | `7610` | hub port |
| `SONAR_DIR` | `~/.sonar` | data directory (db, pid, logs, links, worktrees) |
| `SONAR_INDEX_DAYS` | `45` | only index transcripts modified within this many days |
| `SONAR_INDEX_POLL_MS` | `4000` | how often transcripts are rescanned |
| `SONAR_HOST` | `127.0.0.1` | bind address; set `0.0.0.0` to expose on the LAN |
| `SONAR_TOKEN` | _(none)_ | **admin** token (also read from `config.json`); manages the hub. Per‑member tokens are added with `sonar token add` |
| `SONAR_EXPOSED` | _(off)_ | start in exposed mode (require a token from every caller, incl. loopback); auto‑on under a LAN bind, and toggled live by `sonar tunnel` |
| `SONAR_ALLOW_REMOTE_EXEC` | _(off)_ | permit code‑exec endpoints/tools for remote callers (off by default; only `1`/`true`/`yes`/`on` enable) |
| `SONAR_HOOK_TIMEOUT_MS` | `120000` | max runtime for a quality‑gate hook before it's killed (and treated as a block) |
| `SONAR_AUTOPILOT_DRY` | _(off)_ | autopilot dispatch becomes a dry‑run (no processes launched) — safe mode / used by `npm run test:e2e` |
| `SONAR_GUARD_OFF` | _(off)_ | when set, the pre‑commit claim guard skips its check (commit proceeds) |

**Port resolution:** `SONAR_PORT` env → `~/.sonar/config.json` (written by `sonar port`) → `7610`. If the port is taken, `sonar install` automatically falls back to the next free one, and `sonar start` points you to `sonar port auto`. Changing the port **re-registers the MCP URL** with Claude Code and Codex and the menu bar follows it automatically — so it stays consistent everywhere.

Menu‑bar settings live in `~/.sonar/menubar.json` (terminal, agents, active window, recent count, icon).

### Running on a shared network (LAN)

By default the hub is loopback‑only (single machine). To let two people on the **same network** — say a frontend dev and a backend dev — point their agents at **one shared hub**, run the hub on one machine bound to the LAN:

```bash
SONAR_HOST=0.0.0.0 sonar start     # auto-generates + persists a shared token, prints it
sonar invite                       # prints the LAN URL, token, and paste-ready Claude/Codex setup
```

The other machine registers that URL with the token (the `invite` output gives the exact command). Then both sessions `link_join` the same ID and collaborate through the shared doc / messages exactly as on one machine — the store‑and‑forward model (durable SQLite + per‑participant cursors + long‑poll) already makes this async, so neither side has to be live at the same instant.

**Auth model:** with no token configured the hub stays loopback‑only and unauthenticated (unchanged). Once a token exists, **loopback callers are exempt** (the local CLI / menu bar keep working with zero friction) and **remote callers must present** `Authorization: Bearer <token>` (or `X-Sonar-Token`). The **code‑exec surface** — `spawn_worker` and the spawn/kill/wake/worktree‑delete endpoints, which run processes on the *hub* machine — is refused for remote callers even with a valid token, unless you opt in with `SONAR_ALLOW_REMOTE_EXEC=1`. Local agents on the hub machine can always spawn.

## How it works

- **One daemon, many clients.** A single Node process serves the MCP endpoint (`/mcp`) to all sessions and a REST API for the CLI/menu bar. Shared state (SQLite WAL + an in‑memory waiter/cursor registry) lives in that one process, so cross‑session delivery is in‑process and immediate.
- **Indexer.** Tails `~/.claude/projects/*/*.jsonl` and `~/.codex/sessions/**/*.jsonl` incrementally (byte‑accurate offsets) into an FTS5 table tagged by agent/repo/branch/session. Claude logs carry the git branch per line; Codex logs don't (filter Codex context by repo). `sonar reindex` rebuilds from scratch.
- **Long‑poll with a read cursor.** `wait(from=X)` blocks until a newer message arrives; a per‑participant cursor means a `wait` loop advances naturally instead of re‑returning the backlog.

## Limitations

- **Turn‑based agents.** The nudge (Stop hook) auto‑resumes Claude sessions in any terminal — at turn end they're re‑prompted about unread link activity, and a session awaiting a reply is held and released the moment it lands. What it can't do is re‑prompt a session that already parked *before* the message arrived and whose hold window ran out; that gap is covered by tmux auto‑wake (`sonar wake` / auto‑wake need the session under tmux — a bare Ghostty pane can't be injected into), by the next human prompt, or by the shared doc whenever the session is next active. Codex has no hook system, so Codex sessions rely on tmux auto‑wake or `wait()` loops.
- **Codex branch tagging.** Codex transcripts record `cwd` but not the git branch — branch filtering in search is exact only for Claude sessions.
- **Indexing window.** Only the last `SONAR_INDEX_DAYS` of transcripts are indexed; the first run backfills in the background.
- **Loopback by default; opt‑in LAN.** Binds `127.0.0.1` with no auth out of the box. To share a hub across machines on a trusted network, set `SONAR_HOST=0.0.0.0` (which requires a token for remote callers — see [Running on a shared network](#running-on-a-shared-network-lan)). The token keeps strangers off the wifi out; it does not isolate trusted teammates from each other. Don't expose the hub on an untrusted network.
- **Workers run on the hub host.** `spawn_worker` / `wake` manipulate processes and git worktrees on the machine the hub runs on — so a remote teammate can't spawn a worker onto *their* machine (it lands on the hub's), and remote exec stays gated behind `SONAR_ALLOW_REMOTE_EXEC`.
- **Headless worker mode** (`--headless`) relies on auto‑approving tools in the worker's isolated worktree; the interactive (visible terminal) path is the tested default.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) is maintained automatically. A tracked git hook (`.githooks/post-commit`) appends each commit's subject to the **[Unreleased]** section and folds it into that same commit, so the changelog never drifts from history. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

Write a clear commit subject and it becomes the changelog line; edit `CHANGELOG.md` freely and roll **[Unreleased]** under a version heading at release time. The hook skips merge/rebase/cherry-pick commits and subjects prefixed `Merge`, `Revert`, `Release`, or `changelog:`.

Read it any time from the menu bar — the **What's new** button (📋) in the top banner renders the changelog in plain English without leaving the app.

## Project layout

```
sonar/
  src/
    cli.ts        CLI + daemon lifecycle + install
    server.ts     HTTP server: MCP (/mcp) + REST (/api/*)
    tools.ts      MCP tool definitions
    core.ts       links, messages, long-poll waiters + read cursors, claims/tasks(+deps)/git-presence, watches + autopilot config
    watch.ts      watch delivery: fire matching subscriptions (targeted ping + best-effort tmux wake)
    autopilot.ts  self-executing task board: dispatch ready tasks (spawn a worker / wake the assignee), capped + cascading
    brief.ts      session-start briefing: recent sessions + last-conversation tail + active links' state for a repo
    hooks.ts      operator quality-gate hooks (task_created/task_completed) run on the hub
    tokens.ts     per-member revocable access tokens (hashed; for tunnel/remote callers)
    docs.ts       shared markdown doc read/append/section (compact + section reads, Log rotation→context.archive.md)
    spawn.ts      worker dispatch (git worktree + terminal/headless launch) + worker registry/status
    tmux.ts       launch sessions in tmux + wake a paused pane (send-keys, idle-gated)
    sessions.ts   process detection (ps/lsof), session listing, safe kill
    indexer.ts    incremental transcript → FTS5 indexing
    db.ts         SQLite schema (node:sqlite)
    config.ts     paths / port / env
  menubar/
    sonar_bar.py  native menu-bar host (PyObjC: NSStatusItem + NSPopover + WKWebView)
    ui.html       the menu-bar UI (auto light/dark)
    pyproject.toml
  test/
    e2e.mjs       smoke test: isolated hub + real MCP/REST calls (watches, autopilot dry-run, brief) — npm run test:e2e
  .githooks/
    post-commit   auto-appends commit subjects to CHANGELOG.md
  CHANGELOG.md
  README.md
```

## Uninstall

```bash
sonar stop
launchctl unload -w ~/Library/LaunchAgents/com.sonar.menubar.plist 2>/dev/null   # if "Start at login" was on
claude mcp remove sonar -s user
rm -f ~/.claude/commands/sonar.md ~/Library/LaunchAgents/com.sonar.menubar.plist
rm -rf ~/.codex/skills/sonar ~/.sonar
# then remove, by hand:
#   • the [mcp_servers.sonar] block from ~/.codex/config.toml
#   • the <!-- sonar:begin --> … <!-- sonar:end --> block from ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
npm rm -g sonar   # if you ran `npm link`
```
