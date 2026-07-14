# Changelog

Notable changes, newest first. Entries under **[Unreleased]** are auto-appended from commit subjects by `.githooks/post-commit` (enable in a clone with `git config core.hooksPath .githooks`); edit them freely and roll them under a version heading at release time.

## [Unreleased]
- **2026-07-14** — Add `sonar reconnect` + self-heal a wiped ~/.sonar (hook file, guarded command)
- **2026-07-13** — Add an agent self-help runbook (~/.sonar/AGENTS.md) so agents unstick themselves
- **2026-07-13** — Surface the real network error (and the fix) when the CLI cannot reach the hub
- **2026-07-13** — Add nudge: a Stop hook that auto-resumes agents on link activity, no tmux needed
- **2026-07-09** — Fix review findings: dispatch race, stale re-arm assignee, and exposed-mode gating
- **2026-07-09** — Add autopilot (self-executing task board), watches (event-driven wake), and brief (session-start catch-up)
- **2026-06-05** — Teach the agent commands about coordination + remote teammates
- **2026-06-05** — Make the tunnel a managed background service (start/status/stop)
- **2026-06-05** — Remote teammates: ephemeral tunnel + revocable per-member tokens
- **2026-06-04** — Add claim enforcement, task dependencies, and quality-gate hooks
- **2026-06-04** — Cancel a long-poll waiter when its client disconnects
- **2026-06-04** — Fix bugs found in a full-codebase audit
- **2026-06-04** — Add coordination primitives: claims, task board, git presence
- **2026-06-04** — Add sonar_help: a capabilities directory agents can look up
- **2026-06-04** — Bound the shared doc: compact + section reads, Log rotation, terse pings
- **2026-06-04** — Share one hub across machines: LAN bind + token auth + remote-exec guard
- **2026-06-03** — Show a green/red connection light on each participant in the doc viewer
- **2026-06-03** — Wake a paused agent by typing into its live tmux pane
- **2026-06-03** — Date every changelog entry
- **2026-06-03** — Menu bar: read the changelog from a What's new button in the header
- **2026-06-03** — Add CHANGELOG.md and auto-append post-commit changelog hook
- **2026-06-03** — Workers: checkpoint cadence + live status/heartbeat in the menu bar (running / stalled / finished, ⚙ chip + Workers panel, finish notifications)
- **2026-06-03** — Menu bar: surface links, in-popover doc viewer with a "what changed" feed, unread notifications + badge, and a piggyback "you have unread" nudge on agent tool calls
- **2026-06-02** — Add configurable ports with auto-fallback (`sonar port <N|auto>`, re-registers with Claude Code + Codex)
- **2026-06-02** — Genericize examples; finalize `.gitignore` for public release
- **2026-06-02** — sonar: cross-session collaboration hub for Claude Code + Codex (initial)
