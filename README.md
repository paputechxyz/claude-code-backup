# Claude Code Backup

Automatic backup of **all** your Claude Code settings to GitHub. One command to set up; then
it runs on boot and every few hours in the background.

The CLI is `ccb` (short for **c**laude-**c**ode-**b**ackup).

## What gets backed up

Everything Claude Code stores across your machine — not just `~/.claude/`, but every project
directory you've ever opened Claude Code in:

memories · skills (full dirs) · MCP server configs · rules · agents · commands ·
`CLAUDE.md` files · settings · plans · sessions · plugins

## Install

Requires **Node.js 18+**. Published on npm as
[`@paputechxyz/claude-code-backup`](https://www.npmjs.com/package/@paputechxyz/claude-code-backup).

```bash
npm i -g @paputechxyz/claude-code-backup     # recommended
```

Or install the self-contained bundle into `~/.local/bin` (no npm):

```bash
curl -fsSL https://raw.githubusercontent.com/paputechxyz/claude-code-backup/main/install.sh | bash
# ensure ~/.local/bin is on your PATH:
export PATH="$HOME/.local/bin:$PATH"         # add to ~/.zshrc or ~/.bashrc
```

Verify it's working:

```bash
ccb --help
```

## Get started

You need a **private GitHub repo** to back up into — create an empty one first, then:

```bash
ccb init
```

`init` will:
1. Scan your Claude Code settings and show what it found
2. Ask for your GitHub repo URL (it wires up the git remote for you)
3. Ask your backup interval (default: every 4 hours)
4. Install a background scheduler (LaunchAgent on macOS, systemd timer on Linux)
5. Run the first backup immediately

That's it — from now on backups run automatically and push to your repo. If a schedule
already exists you'll get a `y/N` prompt before another is installed.

## Everyday commands

```bash
ccb run             # back up right now
ccb status          # last run time, items copied, any errors
ccb list            # list saved backups (newest first) you can restore
ccb interval 6      # change the schedule (hours)
ccb uninstall       # remove the scheduler (your backups stay put)
ccb notify-test     # fire a test macOS notification banner
```

Every run fires a macOS banner (`✓ Backed up N items`, `⚠️` on push failure, `✗` on error).
For a nicer icon: `brew install terminal-notifier` (optional).

## Restore

Restore everything back to its original locations from your latest backup:

```bash
ccb restore --dry-run     # preview what would change (safe)
ccb restore               # restore (asks for confirmation)
ccb restore --force       # skip the confirmation prompt
```

To restore an older snapshot, pick a name from `ccb list` and pass it:

```bash
ccb list
ccb restore --version backup-2026-07-29_16-56-39
```

## Set up on a new machine

Clone your existing backup repo into place, then re-arm the scheduler:

```bash
git clone git@github.com:you/your-backup-repo.git ~/.claude-backups
ccb init
```

## How it works

Backups live in `~/.claude-backups/` — a git repo pushed to your private GitHub repo:

- `latest/` — the current snapshot git tracks (each run overwrites it, so git history *is*
  your version history). Organized by scope: `global/`, then one folder per project, each
  split into `memory/`, `skill/`, `mcp/`, `config/`, etc.
- `backup-YYYY-MM-DD_HH-mm-ss/` — up to 100 timestamped local snapshots (not pushed) that
  `ccb list` / `ccb restore --version` read from.

A pidfile lock (`~/.claude-backups/.lock`) keeps a manual `ccb run` from colliding with a
scheduled run. On a push failure the commit is kept and the scheduler exits non-zero, so
`ccb status` and your repo history reflect the true state.

## Requirements

- Node.js 18+ and Git
- A private GitHub repo (create one first)
- macOS: `brew install terminal-notifier` (optional — nicer notifications)

## Links

- **Contributing / cutting a release:** see [RELEASING.md](RELEASING.md)
- Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer)
