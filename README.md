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
Published on npm: [`@paputechxyz/claude-code-backup`](https://www.npmjs.com/package/@paputechxyz/claude-code-backup).

**Via npm** (recommended — always the latest published version):

```bash
npm i -g @paputechxyz/claude-code-backup   # exposes `ccb`
```

**One-line install into `~/.local/bin`** (no npm needed — grabs the self-contained bundle
from the latest GitHub Release):

```bash
curl -fsSL https://raw.githubusercontent.com/paputechxyz/claude-code-backup/main/install.sh | bash
```

If you use the curl installer, make sure `~/.local/bin` is on your `$PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

**From a local checkout** (builds a single-file bundle with esbuild):

```bash
git clone https://github.com/paputechxyz/claude-code-backup.git
cd claude-code-backup
just install        # → ~/.local/bin/ccb
```

**Verify:**

```bash
ccb --help          # should print the command list
which ccb           # confirms it's on your PATH
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

### List available backups
Beside the `latest/` directory, up to 100 local timestamped backups are kept inside `~/.claude-backups/` (e.g. `backup-YYYY-MM-DD_HH-mm-ss`). List them (newest first) with:

```bash
ccb list
```

```
Backups in ~/.claude-backups (10):

  NAME                        WHEN              ITEMS
  latest                      2026-07-31 21:47     52  (current)
  backup-2026-07-31_21-47-44  2026-07-31 21:47     52
  backup-2026-07-31_16-32-25  2026-07-31 16:32     50
  ...

Restore a specific version with:
  ccb restore --version backup-2026-07-31_21-47-44
```

### Restore a specific version
Pick a `NAME` from `ccb list` and pass it by folder name:

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

## Releasing (maintainers)

Releases are cut by GitHub Actions on any pushed `v*` tag
(`.github/workflows/release.yml`). The job:

1. `npm ci` → `npm run build` — bundles `bin/cli.mjs` into a single self-contained
   `dist/ccb.mjs` via esbuild (`--bundle --platform=node --format=esm --target=node18`).
   All the `await import("../src/*.mjs")` calls get inlined, and `import.meta.url` stays
   native so the scheduler bakes in the installed binary's own path — no checkout dependency.
2. Verifies the bundle runs standalone.
3. Creates a GitHub Release and attaches `dist/ccb.mjs` (what `install.sh` downloads).
4. `npm publish --access public --provenance` to
   [`@paputechxyz/claude-code-backup`](https://www.npmjs.com/package/@paputechxyz/claude-code-backup).

To cut a release:

```bash
# 1. Bump the version in package.json, commit, and merge to main.
# 2. Tag it (reads the version from package.json) and push — this triggers the workflow:
just tag                 # tags vX.Y.Z from package.json and pushes it
just tag 0.3.1           # or pass an explicit version → v0.3.1
```

`just tag` refuses if the tag already exists (bump `package.json` first), creates an
annotated tag, pushes it, and prints a `gh run watch` command to follow the run.
A normal `git push` does **not** push tags — the `git push origin <tag>` is what triggers CI.

### npm publish setup & gotchas

The workflow reads an `NPM_TOKEN` repo secret (`gh secret set NPM_TOKEN --repo <owner/repo>`).
Getting the first publish to go through required getting three things right — if you fork
this or hit `E404`/`E403` on publish, check these:

- **The scope must be an npm org (or user) you own.** `@paputechxyz` is an npm
  **organization**; the package won't publish until that org exists. A first publish to a
  scope you don't own returns a misleading `404 Not Found - PUT .../@scope%2fname` (npm masks
  the permission denial as a 404), *not* a clear "create the org first".
- **The token must not have an IP allowlist.** A granular token with **Allowed IP ranges**
  set will be rejected from GitHub Actions runners (dynamic IPs) with
  `403 ... You may not perform that action from your current IP` — which again can surface on
  the runner as a `404` on the create-package write. Use a **Classic → Automation** token
  (no IP restriction, bypasses 2FA) or a granular token with the IP allowlist left empty.
- **Granular token scope.** If you do use a granular token, give it **Read and write** on
  packages and explicitly add the **`paputechxyz`** organization; a token minted before the
  org existed won't include it.
- Provenance (`--provenance`) needs `permissions: id-token: write` in the workflow (already set).

Quick local sanity check of a token without exposing it on the command line:

```bash
umask 077; printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > /tmp/nrc
npm whoami --userconfig /tmp/nrc     # prints your npm username on a good token
rm -f /tmp/nrc
```

## Built with

Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer).
