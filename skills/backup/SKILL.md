# /backup — Claude Code Settings Backup

Back up all Claude Code settings to GitHub. Scans every scope (global + all projects), exports memories, skills, rules, MCP configs, settings, plans, agents, commands, sessions, and plugins. Then commits and pushes to your configured backup repo.

## Usage

- `/backup` — Run a backup now
- `/backup init` — First-time setup (create repo, configure remote, install scheduler)
- `/backup status` — Show last backup time and scheduler status
- `/backup notify-test` — Send a test macOS notification banner

## What it does

1. **Scans** all Claude Code customizations across every scope (same scanner as Claude Code Organizer)
2. **Exports** 10 categories: memory, skill, mcp, config, rule, agent, command, plan, session, plugin
3. **Commits** changes to `~/.claude-backups/` git repo (guarded by a pidfile lock so concurrent runs can't race)
4. **Pushes** to your private GitHub repo
5. **Notifies** via macOS banner — `✓ Backed up N items` on success, `⚠️` on push failure, `✗ <error>` on fatal error

## Notifications

Every run fires a macOS banner titled **Claude Backup** with a status symbol in the body. Uses `terminal-notifier` if installed (`brew install terminal-notifier`), otherwise falls back to `osascript`. Sound: `Glass` on success, `Basso` on error.

Interactive terminal runs also fire a `▶ Started` banner so you can confirm the process kicked off. Scheduled runs from launchd/systemd stay quiet until success/failure (no banner spam).

Customize title or source attribution via `NOTIFY_TITLE` / `NOTIFY_SENDER` at the top of `bin/cli.mjs`.

## Concurrency

A pidfile lock at `~/.claude-backups/.lock` prevents two runs from racing. Stale locks (holder PID no longer alive) are auto-recovered. If a run is already in progress, the second call exits cleanly with no error.

## Setup (first time only)

```bash
npx @paputechxyz/claude-code-backup init
```

This creates `~/.claude-backups/`, asks for your GitHub repo URL, and installs a systemd timer (Linux) or LaunchAgent (macOS) for automatic backups. If an existing schedule is detected (any LaunchAgent, launchctl entry, crontab line, or systemd timer referencing this tool), you'll get a `y/N` prompt before installing another one.

## Requirements

- Node.js 18+
- A private GitHub repo
- `@paputechxyz/claude-code-backup` installed (`npm i -g @paputechxyz/claude-code-backup`)
- macOS: `brew install terminal-notifier` (optional but recommended)
