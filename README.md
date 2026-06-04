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

Each link has a **shared markdown doc** at `~/.sonar/links/<id>/context.md` with sections **Context / Open questions / Answers / Decisions / Log**. It is the source of truth — agents and you read and append to it. `post`/`wait` are just lightweight "the doc changed" pings.

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

**Token‑efficient reads.** The doc never re‑pays for its whole history on every glance. `doc_read` returns a **compact view** by default — every section, but the append‑only **Log** trimmed to its most recent entries — and the on‑disk Log auto‑rotates: older entries spill to `context.archive.md` so `context.md` stays bounded. Read a single section with `doc_read(section="…")` (e.g. `section="Log"` for the full live Log), or the entire document with `doc_read(full=true)`. Doc‑change pings stay terse (they say *what* changed, not a copy of the prose) so the message stream doesn't duplicate the doc. For a frontend⇄backend pair, the efficient pattern is to keep the shared **contract** (API shape / types) in a section you `doc_set_section` (replace, bounded) and use `post`/`wait` for "I changed X" change events.

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

sonar doc <id> [--open]        print / open a link's shared context doc
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
| `spawn_worker` | launch a Claude/Codex worker in an isolated worktree, joined to the link (runs on the hub host; remote callers gated by `SONAR_ALLOW_REMOTE_EXEC`) |
| `post` / `read` | send / read "doc changed" pings |
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
| `SONAR_TOKEN` | _(none)_ | shared access token required of remote callers (also read from `config.json`) |
| `SONAR_ALLOW_REMOTE_EXEC` | _(off)_ | permit code‑exec endpoints/tools for remote callers (off by default) |

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

- **Turn‑based agents.** Instant back‑and‑forth needs both sessions live at once; otherwise the shared doc holds everything for whenever the other side is next active. Spawned workers are the autonomous path, and `sonar wake` (tmux) can re‑prompt a paused session in place — but only sessions launched under tmux are wake‑able; a bare Ghostty pane can't be injected into.
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
    core.ts       links, messages, long-poll waiters + read cursors
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
