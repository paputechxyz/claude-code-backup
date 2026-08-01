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

## Install

The CLI installs as `ccb` (short for **c**laude-**c**ode-**b**ackup). Requires Node.js 18+.

**One-line install into `~/.local/bin`** (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/paputechxyz/claude-code-backup/main/install.sh | bash
```

This downloads the latest self-contained release to `~/.local/bin/ccb`. Make sure
`~/.local/bin` is on your `$PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

**Via npm:**

```bash
npm i -g @paputechxyz/claude-code-backup   # exposes `ccb`
```

**From a local checkout** (builds a single-file bundle with esbuild):

```bash
git clone https://github.com/paputechxyz/claude-code-backup.git
cd claude-code-backup
just install        # → ~/.local/bin/ccb
```

## Quick start

```bash
ccb init
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
ccb run
# Or from local checkout:
just backup
```

## Test notifications

```bash
ccb notify-test
```

Sends a single test banner so you can verify desktop notifications work end-to-end (see [Notifications](#notifications)).

## Check status

```bash
ccb status
```

## Remove scheduler

```bash
ccb uninstall
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
├── .git/                     ← tracked by git, pushed to your private repo
├── .gitignore
├── .lock                     ← pidfile (held during a run; prevents overlap)
├── latest/                   ← stable active backup used for Git tracking
│   ├── global/
│   │   ├── memory/           ← all global memories
│   │   ├── skill/            ← all global skills (full dirs)
│   │   ├── mcp/              ← each MCP server as individual .json
│   │   ├── config/           ← CLAUDE.md, settings.json
│   │   ├── rule/             ← all rules
│   │   ├── plan/
│   │   ├── agent/
│   │   ├── command/
│   │   └── plugin/
│   ├── -home-user-myproject/
│   │   ├── memory/           ← project-specific memories
│   │   ├── skill/            ← project-specific skills
│   │   ├── mcp/
│   │   ├── config/           ← project CLAUDE.md, settings
│   │   └── session/          ← conversation history
│   └── backup-summary.json
├── backup-YYYY-MM-DD_HH-mm-ss/ ← up to 100 timestamped local backups (not git tracked)
├── config.json
└── backup.log
```

Each backup overwrites `latest/` so git only tracks the diff, not full copies. Your git history is your version history.

## Restoration

You can automatically restore everything back to their original destinations from your latest backup.

```bash
# Preview what will be restored (Dry Run):
ccb restore --dry-run
# Or from local checkout:
just restore-dry-run

# Run full restoration (requires interactive confirmation):
ccb restore
# Or from local checkout:
just restore

# Force run restoration (bypasses warning prompt):
ccb restore --force
# Or from local checkout:
just restore-force
```

### Restore a specific version
Beside the `latest/` directory, up to 100 local timestamped backups are kept inside `~/.claude-backups/` (e.g. `backup-YYYY-MM-DD_HH-mm-ss`). You can restore from a specific version by folder name:

```bash
ccb restore --version backup-2026-07-29_16-56-39
# Or from local checkout:
just restore-version backup-2026-07-29_16-56-39
```

## First-time setup on a new machine

If you are setting up on a completely new computer:

1. Clone your private backup repository directly to `~/.claude-backups`:
   ```bash
   git clone git@github.com:you/claude-backup.git ~/.claude-backups
   ```
2. Navigate to your checkout directory and initialize the background scheduler:
   ```bash
   just init
   ```
   Or run the CLI initialization directly:
   ```bash
   ccb init
   ```

## Scheduler details

**Linux (systemd):** User-level timer with `Persistent=true`. Runs on boot (5 min delay) and at your configured interval. Catches up missed runs if the machine was off.

**macOS (launchd):** LaunchAgent at `~/Library/LaunchAgents/com.paputechxyz.claude-code-backup.plist` with `RunAtLoad=true` and `StartInterval=<seconds>`. Same behavior as systemd, except missed ticks during sleep are **not** caught up — the next tick fires from wake time.

**Detecting failures:** the LaunchAgent sets `process.exitCode = 1` on push failure or fatal error, so `LastExitStatus` in `launchctl list | grep claude-code-backup` reflects real outcome (`0` = success, non-zero = failed). Combined with `backup.log`, this gives you three layers of monitoring:

```bash
ccb status   # lastRun, lastCopied, lastErrors
launchctl list | grep claude-code-backup     # PID (empty = idle), LastExitStatus
tail -100 ~/.claude-backups/backup.log       # full output of scheduled runs
```

**Duplicate-schedule detection:** `init` scans `~/Library/LaunchAgents/`, `/Library/LaunchAgents/`, `launchctl list`, `crontab -l`, and (on Linux) `systemctl --user list-units --type=timer` for any existing schedule that references this tool. If found, you get a `y/N` prompt before installing another one.

## A note on the scheduler path

The installed scheduler bakes the CLI's own absolute path into `ProgramArguments` (launchd) /
`ExecStart` (systemd) at `init` time:

- If you installed via `curl`/`just install`/`npm i -g`, that path is the stable `ccb`
  binary (e.g. `~/.local/bin/ccb`) — self-contained, safe to keep.
- If you instead run `node bin/cli.mjs init` straight from a git checkout, the schedule
  points at `bin/cli.mjs` inside that checkout, so **don't move or delete the checkout**
  afterward or scheduled runs will break.

Either way the node binary path is also captured (`process.execPath`) at install time, so
upgrading Node under nvm may require re-running `init` (or `ccb interval <hours>`).

## Requirements

- Node.js 18+
- Git
- A private GitHub repo (create one first)
- macOS: `brew install terminal-notifier` (optional but recommended — better notification icon and source attribution)

## Built with

Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer).
