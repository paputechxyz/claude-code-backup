# Claude Code Backup

Automatic backup of all your Claude Code settings to GitHub. One command to set up, runs on boot and every few hours.

## What gets backed up

Everything Claude Code stores across your machine, not just `~/.claude/`:

- **Memories** (127 files across 8 scopes in my setup)
- **Skills** (full directories, recursively)
- **MCP server configs** (every .mcp.json, .claude.json, settings-embedded servers)
- **Rules, Agents, Commands** (.md files)
- **CLAUDE.md files** (global + every project)
- **Settings** (settings.json, settings.local.json)
- **Plans** (.md files)
- **Sessions** (.jsonl conversation files)
- **Plugins** (cached plugin directories)

It uses the same scanner as [Claude Code Organizer](https://github.com/mcpware/claude-code-organizer) to discover items across all scopes (global + every project directory you've ever opened Claude Code in).

## Quick start

```bash
npx @paputechxyz/claude-code-backup init
```

This will:
1. Scan your Claude Code settings and show what it found
2. Ask for your GitHub repo URL
3. Check for any existing backup schedule (launchd/systemd/cron) and warn if found
4. Ask your preferred backup interval (default: every 4 hours)
5. Install a systemd timer (Linux) or LaunchAgent (macOS)
6. Run the first backup immediately

If an existing schedule is detected, you'll get a `y/N` prompt before a new one is installed (default: skip). Pass `--force-scheduler` to bypass the prompt for scripted setups.

## Manual backup

```bash
npx @paputechxyz/claude-code-backup run
```

## Test notifications

```bash
npx @paputechxyz/claude-code-backup notify-test
```

Sends a single test banner so you can verify desktop notifications work end-to-end (see [Notifications](#notifications)).

## Check status

```bash
npx @paputechxyz/claude-code-backup status
```

## Remove scheduler

```bash
npx @paputechxyz/claude-code-backup uninstall
```

This only removes the scheduled task. Your backup data stays in `~/.claude-backups/`.

## Notifications

Every backup run fires a macOS notification banner:

| Outcome | Title | Body | Sound |
|---|---|---|---|
| Pushed clean | `Claude Backup` | `✓ Backed up N items • timestamp` | Glass |
| No-op (nothing to commit) | `Claude Backup` | `✓ No-op • timestamp` | Glass |
| Push failed (commit ok) | `Claude Backup` | `⚠️ Push failed: …` | Basso |
| Export warnings | `Claude Backup` | `⚠️ N items, M warnings` | Basso |
| Fatal error | `Claude Backup` | `✗ <error message>` | Basso |
| Already running | `Claude Backup` | `⊘ Another run in progress` | Basso |
| Started (manual runs only) | `Claude Backup` | `▶ Started • timestamp` | Glass |

Notifications use [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) if installed, falling back to `osascript` otherwise.

```bash
brew install terminal-notifier   # recommended — better source attribution + icon
```

The visible title is always `Claude Backup`. To change the source attribution (icon + "from app" label in System Settings), edit `NOTIFY_SENDER` at the top of `bin/cli.mjs`:

```js
const NOTIFY_SENDER = "";                          // default: terminal-notifier branding
const NOTIFY_SENDER = "com.apple.Terminal";        // spoof Terminal.app icon
```

Customize the title text via `NOTIFY_TITLE` in the same file.

The `▶ Started` banner only fires when stdout is a TTY (i.e. interactive terminal runs). Scheduled runs from launchd/systemd stay silent until success/failure so you get ~6 banners/day at the 4h cadence, not double that.

If banners don't appear, enable them in **System Settings → Notifications → terminal-notifier** (or **Script Editor** if you're on the osascript fallback). Sounds play regardless of banner settings.

## Concurrency

A pidfile lock at `~/.claude-backups/.lock` prevents two backup runs from racing:

- Atomic create-or-fail (`open(..., "wx")`)
- If the holder PID is no longer alive, the lock is stolen automatically (stale-lock recovery)
- If a run is in progress, the second invocation exits cleanly with a `⊘` notification (interactive runs only) and no error code

This protects against the case where a manual `run` coincides with a scheduled 4h tick — git's own index lock catches true commit collisions, but the export step (`rm latest/ && cp …`) is not safe under concurrency without this guard.

## How it works

```
~/.claude-backups/
├── .git/                    ← tracked by git, pushed to your private repo
├── .gitignore
├── .lock                    ← pidfile (held during a run; prevents overlap)
├── latest/
│   ├── global/
│   │   ├── memory/          ← all global memories
│   │   ├── skill/           ← all global skills (full dirs)
│   │   ├── mcp/             ← each MCP server as individual .json
│   │   ├── config/          ← CLAUDE.md, settings.json
│   │   ├── rule/            ← all rules
│   │   ├── plan/
│   │   ├── agent/
│   │   ├── command/
│   │   └── plugin/
│   ├── -home-user-myproject/
│   │   ├── memory/          ← project-specific memories
│   │   ├── skill/           ← project-specific skills
│   │   ├── mcp/
│   │   ├── config/          ← project CLAUDE.md, settings
│   │   └── session/         ← conversation history
│   └── backup-summary.json
├── config.json
└── backup.log
```

Each backup overwrites `latest/` so git only tracks the diff, not full copies. Your git history is your version history.

## Restore on a new machine

```bash
git clone git@github.com:you/claude-backup.git ~/.claude-backups
# Then manually copy files back to their original locations
# (automated restore coming soon)
```

## Scheduler details

**Linux (systemd):** User-level timer with `Persistent=true`. Runs on boot (5 min delay) and at your configured interval. Catches up missed runs if the machine was off.

**macOS (launchd):** LaunchAgent at `~/Library/LaunchAgents/com.paputechxyz.claude-code-backup.plist` with `RunAtLoad=true` and `StartInterval=<seconds>`. Same behavior as systemd, except missed ticks during sleep are **not** caught up — the next tick fires from wake time.

**Detecting failures:** the LaunchAgent sets `process.exitCode = 1` on push failure or fatal error, so `LastExitStatus` in `launchctl list | grep claude-code-backup` reflects real outcome (`0` = success, non-zero = failed). Combined with `backup.log`, this gives you three layers of monitoring:

```bash
npx @paputechxyz/claude-code-backup status   # lastRun, lastCopied, lastErrors
launchctl list | grep claude-code-backup     # PID (empty = idle), LastExitStatus
tail -100 ~/.claude-backups/backup.log       # full output of scheduled runs
```

**Duplicate-schedule detection:** `init` scans `~/Library/LaunchAgents/`, `/Library/LaunchAgents/`, `launchctl list`, `crontab -l`, and (on Linux) `systemctl --user list-units --type=timer` for any existing schedule that references this tool. If found, you get a `y/N` prompt before installing another one.

## Run from a local checkout

If you'd rather not depend on npm:

```bash
git clone https://github.com/paputechxyz/claude-code-backup.git
cd claude-code-backup
node bin/cli.mjs init
```

The installed scheduler points `ProgramArguments` at the absolute path of `bin/cli.mjs` in your checkout, so **don't move or delete the checkout** after `init` or scheduled runs will break. The node binary path is also hardcoded (`process.execPath` at install time), so upgrading Node under nvm may require re-running `init`.

## Requirements

- Node.js 18+
- Git
- A private GitHub repo (create one first)
- macOS: `brew install terminal-notifier` (optional but recommended — better notification icon and source attribution)

## Built with

Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer).
