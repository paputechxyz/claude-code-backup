# Claude Code Backup

Backup of **all** your Claude Code settings to GitHub. One command to set up, then `ccb run`
whenever you want a snapshot — with an opt-in scheduler if you want it automated.

The CLI is `ccb` (short for **c**laude-**c**ode-**b**ackup).

> ⚠️ **On a managed/corporate Mac, read [Security software and the scheduler](#security-software-and-the-scheduler)
> before running `ccb schedule`.** Endpoint security has been observed deleting the `node`
> binary in response to the background scheduler. Plain `ccb run` is unaffected.

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
3. Run the first backup immediately

Backups are **manual by default** (`ccb run`). To also run them in the background:

```bash
ccb schedule 4      # every 4 hours + on boot
```

That installs a LaunchAgent on macOS or a systemd user timer on Linux. Read the next
section first if this is a work machine.

## Security software and the scheduler

**`ccb schedule` can get your `node` binary quarantined by endpoint security. `ccb run`
cannot — it never touches launchd.**

This is a real, reproduced incident, not a theoretical concern. On a Mac running
**SentinelOne**, installing the background scheduler caused the agent to delete
`~/.nvm/versions/node/<version>/bin/node` within the same second the LaunchAgent loaded —
leaving `node` and `npm` broken machine-wide (`env: node: No such file or directory`), and
killing the running process out from under the terminal. It happened twice, reproducibly.

**Why.** The scheduler writes a LaunchAgent whose `ProgramArguments[0]` is your Node
binary, with `RunAtLoad` set. When Node is version-managed, that path lives in a hidden,
user-writable directory (`~/.nvm/…`, `~/.volta/…`, `~/.asdf/…`) and the binary is not
signed by the OS vendor. A launchd persistence entry pointing at an unsigned interpreter in
a dot-directory is close enough to how macOS adware persists that behavioural engines treat
the *interpreter* as the malware payload — so they quarantine it and remove the plist.
Nothing lands in `~/.Trash` or the macOS quarantine database, because these products use
their own quarantine store. That is what makes it so confusing to diagnose.

**What `ccb` does about it.** Since this was found, the scheduler is **opt-in** — `ccb init`
no longer installs one. `ccb schedule` also checks for known agents (SentinelOne,
CrowdStrike Falcon, Microsoft Defender, Carbon Black, Cortex XDR, Sophos, ESET, Trend
Micro, Elastic Endpoint) and refuses rather than risking your toolchain:

```
⛔ Endpoint security detected: SentinelOne
   Refusing to install a LaunchAgent...
```

**If you want it anyway,** get `ccb` (and your Node binary path) allowlisted by whoever
runs your security console first, then override:

```bash
ccb schedule 4 --force-scheduler
```

**If your Node is already broken by this,** the version directory is left half-emptied, and
`nvm install` will silently fall back to a ~10-minute source build because its `mv` fails
on the leftover `bin`/`lib`/`include`/`share`. Remove the directory first:

```bash
rm -rf ~/.nvm/versions/node/v24.18.1     # the affected version
nvm install 24 && nvm alias default 24   # seconds, from cache
```

**Prefer no launchd at all?** Skip the scheduler and trigger `ccb run` from something you
already control — a shell alias, a git hook, or your existing task runner. You lose only
the automatic trigger, not any backup capability.

## Everyday commands

```bash
ccb run             # back up right now
ccb status          # last run time, items copied, any errors
ccb list            # list saved backups (newest first) you can restore
ccb schedule 4      # install the background scheduler (opt-in)
ccb interval 6      # change the schedule (hours)
ccb uninstall       # remove the scheduler (your backups stay put)
ccb notify-test     # fire a test macOS notification banner
```

Interactive runs fire a macOS banner (`✓ Backed up N items`, `⚠️` on push failure, `✗` on
error). For a nicer icon: `brew install terminal-notifier` (optional).

`ccb init` accepts `--schedule` to set up the scheduler in the same pass; without it, init
only prepares the repo and takes the first backup.

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

Clone your existing backup repo into place, then re-run init:

```bash
git clone git@github.com:you/your-backup-repo.git ~/.claude-backups
ccb init
ccb schedule 4    # optional — see the security section first
```

## How it works

Backups live in `~/.claude-backups/` — a git repo pushed to your private GitHub repo:

- `latest/` — the current snapshot git tracks (each run replaces it, so git history *is*
  your version history). Organized by scope: `global/`, then one folder per project, each
  split into `memory/`, `skill/`, `mcp/`, `config/`, etc.
- `backup-YYYY-MM-DD_HH-mm-ss/` — up to 100 timestamped local snapshots (not pushed) that
  `ccb list` / `ccb restore --version` read from.

Each run builds into a staging directory (`.latest.tmp/`) and swaps it into place only
once the export succeeds, so an interrupted or failed backup leaves your previous snapshot
intact rather than destroying it up front.

Project scopes are resolved from the real paths Claude Code records in `~/.claude.json`.
The directory names under `~/.claude/projects/` are a lossy encoding — `/`, `.` and `_` all
collapse to `-` — so decoding them alone silently dropped any project whose path contained
a dot (e.g. `workspace.nosync`) from every backup.

A pidfile lock (`~/.claude-backups/.lock`) keeps a manual `ccb run` from colliding with a
scheduled run, and is released on `SIGINT`/`SIGTERM` as well as normal exit. On a push
failure the commit is kept and the run exits non-zero, so `ccb status` and your repo
history reflect the true state.

## Requirements

- Node.js 18+ and Git
- A private GitHub repo (create one first)
- macOS: `brew install terminal-notifier` (optional — nicer notifications)

## Troubleshooting

**`env: node: No such file or directory` after installing the scheduler.**
Your security software quarantined the Node binary — see
[Security software and the scheduler](#security-software-and-the-scheduler) for the fix.

**Scheduled backups silently stopped.**
The scheduler records an absolute path to the Node binary that installed it. Upgrading or
pruning a version-managed Node (nvm/fnm/volta/asdf) invalidates it. `ccb schedule` warns
when it detects this; re-run `ccb schedule` after changing Node versions.

**`ccb status` says the scheduler isn't installed.**
Expected — it's opt-in as of the change described above. Run `ccb schedule` to install one.

**Backups only commit locally, never push.**
No git remote is configured. Add one:
`git -C ~/.claude-backups remote add origin git@github.com:you/your-backup-repo.git`

## Links

- **Contributing / cutting a release:** see [RELEASING.md](RELEASING.md)
- Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer)
