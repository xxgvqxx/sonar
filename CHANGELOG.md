# Changelog

Notable changes, newest first. Entries under **[Unreleased]** are auto-appended from commit subjects by `.githooks/post-commit` (enable in a clone with `git config core.hooksPath .githooks`); edit them freely and roll them under a version heading at release time.

## [Unreleased]
- Menu bar: read the changelog from a What's new button in the header
- Add CHANGELOG.md and auto-append post-commit changelog hook
- Workers: checkpoint cadence + live status/heartbeat in the menu bar (running / stalled / finished, ⚙ chip + Workers panel, finish notifications)
- Menu bar: surface links, in-popover doc viewer with a "what changed" feed, unread notifications + badge, and a piggyback "you have unread" nudge on agent tool calls
- Add configurable ports with auto-fallback (`sonar port <N|auto>`, re-registers with Claude Code + Codex)
- Genericize examples; finalize `.gitignore` for public release
- sonar: cross-session collaboration hub for Claude Code + Codex (initial)
