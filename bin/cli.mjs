#!/usr/bin/env node

/**
 * claude-code-backup CLI
 *
 * Commands:
 *   init          — Interactive setup: create backup repo, configure remote, first backup
 *   schedule      — Install the background scheduler (opt-in)
 *   run           — Run a backup now (scan + export + commit + push)
 *   status        — Show last backup info and scheduler status
 *   interval      — Change backup interval and reinstall scheduler
 *   uninstall     — Remove scheduled backup (keeps backup data)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, access, open, readdir, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Absolute path to this file. `new URL(import.meta.url).pathname` looks
// equivalent but stays percent-encoded, so a home directory containing a space
// produced a scheduler entry pointing at a file that doesn't exist.
const CLI_PATH = fileURLToPath(import.meta.url);

const exec = promisify(execFile);
const HOME = homedir();
const BACKUP_DIR = join(HOME, ".claude-backups");
const CONFIG_PATH = join(BACKUP_DIR, "config.json");
const LOCK_PATH = join(BACKUP_DIR, ".lock");
const NOTIFY_TITLE = "Claude Backup";
// Set to a bundle ID (e.g. "com.apple.Terminal") to brand the notification source.
// Empty = use terminal-notifier's own attribution.
const NOTIFY_SENDER = "";

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  if (!process.argv.includes("--quiet")) {
    process.stdout.write(msg + "\n");
  }
}

// One readline for the whole process. Creating a fresh interface per prompt
// meant the first one buffered every line already sitting on a piped stdin, so
// later prompts saw EOF — and each open/close cycle toggles the TTY in and out
// of raw mode, which leaves the terminal without echo if we exit mid-prompt.
let _rl = null;
// Set once stdin is exhausted. Reopening a readline on a closed stdin just
// closes again, so every later prompt takes its default instead of throwing.
let _stdinDone = false;

function prompts() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout });
    _rl.once("close", () => {
      _stdinDone = true;
      _rl = null;
    });
  }
  return _rl;
}

// Release stdin so the process can exit once we're done asking things.
function closePrompts() {
  _stdinDone = true;
  if (_rl) _rl.close();
  _rl = null;
}

function ask(question) {
  // EOF (piped/closed stdin, ^D) fires 'close' and the question callback never
  // runs. Without this the promise hangs forever and node exits with "Detected
  // unsettled top-level await", abandoning setup half-done.
  if (_stdinDone) return Promise.resolve("");

  const rl = prompts();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish("");
    rl.once("close", onClose);
    rl.question(question, (answer) => finish(answer.trim()));
  });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await mkdir(BACKUP_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Notifications ────────────────────────────────────────────────────

async function notify(title, message, isError = false) {
  const sound = isError ? "Basso" : "Glass";
  const trunc = (s) => String(s).slice(0, 200);
  const args = [
    "-title", trunc(title),
    "-message", trunc(message),
    "-sound", sound,
    "-group", "claude-code-backup",
  ];
  if (NOTIFY_SENDER) args.push("-sender", NOTIFY_SENDER);

  try {
    await exec("terminal-notifier", args);
    return;
  } catch { /* fall through to osascript */ }

  // Fallback: osascript (shows as "Script Editor" in Notification Center)
  const esc = (s) => String(s).replace(/["\\]/g, " ").slice(0, 200);
  try {
    await exec("osascript", [
      "-e",
      `display notification "${esc(message)}" with title "${esc(title)}" sound name "${sound}"`,
    ]);
  } catch { /* never fail the backup over a notification */ }
}

// ── Concurrency lock ─────────────────────────────────────────────────

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock() {
  await mkdir(BACKUP_DIR, { recursive: true });
  try {
    const fh = await open(LOCK_PATH, "wx"); // fails if exists
    await fh.writeFile(String(process.pid));
    await fh.close();
    _holdsLock = true;
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale-lock recovery: if the holder PID is no longer alive, steal the lock
    try {
      const existing = await readFile(LOCK_PATH, "utf-8");
      const pid = parseInt(existing.trim(), 10);
      if (pid && !processAlive(pid)) {
        await writeFile(LOCK_PATH, String(process.pid));
        _holdsLock = true;
        return true;
      }
    } catch {}
    return false;
  }
}

let _holdsLock = false;

function releaseLock() {
  if (!_holdsLock) return;
  _holdsLock = false;
  try { rmSync(LOCK_PATH, { force: true }); } catch {}
}

// A killed run used to leave its pidfile behind: `finally` doesn't run on
// SIGINT/SIGTERM. Stale-lock recovery eventually cleans that up, but only once
// the PID is dead *and* unrecycled, so drop the lock on the way out instead.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    closePrompts();
    process.exit(130);
  });
}
process.on("exit", releaseLock);

// ── Commands ─────────────────────────────────────────────────────────

async function cmdInit() {
  const { scan } = await import("../src/scanner.mjs");
  const { isGitRepo, initRepo, addRemote } = await import("../src/git-sync.mjs");

  log("🔍 Scanning Claude Code settings...\n");

  const data = await scan();
  const scopeCount = data.scopes.length;
  const itemCount = data.items.length;

  log(`Found ${itemCount} items across ${scopeCount} scopes:`);
  for (const [cat, count] of Object.entries(data.counts)) {
    if (cat === "total") continue;
    log(`  ${cat}: ${count}`);
  }
  log("");

  // Create backup directory
  await mkdir(BACKUP_DIR, { recursive: true });

  // Git repo setup
  if (!(await isGitRepo(BACKUP_DIR))) {
    log("Initializing git repo in ~/.claude-backups/");
    await initRepo(BACKUP_DIR);

    // Write .gitignore
    await writeFile(
      join(BACKUP_DIR, ".gitignore"),
      [
        "# Don't track timestamped backups — only latest/",
        "backup-*/",
        "*.log",
        "config.json",
        ".lock",
        ".latest.tmp/",
        "",
      ].join("\n")
    );
  }

  // Remote setup
  const { hasRemote, getRemoteUrl } = await import("../src/git-sync.mjs");
  if (await hasRemote(BACKUP_DIR)) {
    const url = await getRemoteUrl(BACKUP_DIR);
    log(`Git remote already configured: ${url}`);
    const change = await ask("Change remote? (y/N): ");
    if (change.toLowerCase() === "y") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const newUrl = await ask("GitHub repo URL (SSH or HTTPS): ");
      await exec("git", ["remote", "set-url", "origin", newUrl], { cwd: BACKUP_DIR });
      log(`Remote updated to: ${newUrl}`);
    }
  } else {
    const repoUrl = await ask("GitHub repo URL (e.g. git@github.com:you/claude-backup.git): ");
    if (repoUrl) {
      await addRemote(BACKUP_DIR, repoUrl);
      log(`Remote added: ${repoUrl}`);
    } else {
      log("Skipping remote setup. Run 'git remote add origin <url>' in ~/.claude-backups/ later.");
    }
  }

  // Scheduler setup — opt-in. Installing a LaunchAgent is the one genuinely
  // invasive thing this tool does, and on an EDR-managed machine it can get the
  // node binary it points at quarantined. `init` now only sets up the repo and
  // takes a backup; scheduling is a separate, deliberate step.
  log("");
  const wantSchedule = process.argv.includes("--schedule");
  let interval = 4;

  if (wantSchedule) {
    const intervalStr = await ask("Backup interval in hours (default: 4): ");
    interval = parseInt(intervalStr) || 4;
  }

  // Save config
  await saveConfig({
    interval,
    installedAt: new Date().toISOString(),
    schedulerSkipped: !wantSchedule,
  });

  // We're done asking questions — hand stdin back before doing any real work,
  // so a failure below can't strand the terminal in readline's raw mode.
  closePrompts();

  // Run the first backup BEFORE installing any scheduler. The LaunchAgent sets
  // RunAtLoad, so `launchctl load` fires a second `ccb run` the instant it is
  // installed. Installing first meant that job raced this one over the same
  // ~/.claude-backups — and exportLatest opens by deleting latest/, so each
  // process would wipe files the other was still copying.
  log("\nRunning first backup...\n");
  await cmdRun();

  const scheduled = wantSchedule ? await installSchedule(interval) : false;

  log("\n✓ Setup complete! Your Claude Code settings are backed up.");
  log("  Backup location: ~/.claude-backups/latest/");
  if (scheduled) {
    log(`  Auto-backup: every ${interval} hours + on boot`);
  } else {
    log("  Auto-backup: not installed — run 'ccb run', or 'ccb schedule' to automate");
  }
}

/**
 * Install the background scheduler, refusing on machines running endpoint
 * security unless explicitly forced. Returns true if a schedule was installed.
 */
async function installSchedule(intervalHours) {
  const { install, detectExistingSchedule, detectSecurityAgents } =
    await import("../src/scheduler.mjs");
  const force = process.argv.includes("--force-scheduler");
  const cliPath = CLI_PATH;
  const nodePath = process.execPath;

  const agents = await detectSecurityAgents();
  if (agents.length > 0 && !force) {
    log(`\n⛔ Endpoint security detected: ${agents.join(", ")}`);
    log("   Refusing to install a LaunchAgent. A scheduled job pointing at an");
    log(`   unsigned interpreter (${nodePath})`);
    log("   looks like malware persistence to these agents — one has been seen");
    log("   quarantining the node binary itself, breaking node system-wide.");
    log("\n   Use 'ccb run' manually, or ask IT to allowlist this first, then");
    log("   re-run with:  ccb schedule --force-scheduler");
    return false;
  }

  // The scheduler bakes this absolute path into the LaunchAgent/systemd unit.
  // Under nvm/fnm/volta/asdf that path contains a version number and vanishes
  // the moment the user upgrades or prunes that version, leaving a scheduled
  // job that fails silently forever.
  if (/\/(\.nvm|\.fnm|\.volta|\.asdf)\//.test(nodePath)) {
    log(`\n⚠️  Scheduling against a version-managed Node: ${nodePath}`);
    log("   If you remove or upgrade this Node version, re-run 'ccb schedule'");
    log("   — otherwise scheduled backups stop silently.");
  }

  const existing = await detectExistingSchedule(cliPath);
  if (existing.length > 0 && !force) {
    log("\n⚠️  Existing backup schedule(s) detected:");
    for (const f of existing) {
      log(`   - ${f.type}${f.path ? ` (${f.path})` : ""}: ${f.detail}`);
    }
    log("   Leaving it alone. Re-run with --force-scheduler to add another.");
    return false;
  }

  try {
    const result = await install(nodePath, cliPath, intervalHours);
    log(`\nScheduler installed (every ${intervalHours}h + on boot)`);
    if (result.timerPath) log(`  Service: ${result.timerPath}`);
    if (result.plistPath) log(`  LaunchAgent: ${result.plistPath}`);
    return true;
  } catch (err) {
    log(`\nFailed to install scheduler: ${err.message}`);
    log("You can run backups manually with: ccb run");
    return false;
  }
}

async function cmdSchedule() {
  const hours = parseInt(process.argv[3], 10) || (await loadConfig()).interval || 4;
  const installed = await installSchedule(hours);
  if (installed) {
    const config = await loadConfig();
    config.interval = hours;
    config.schedulerSkipped = false;
    await saveConfig(config);
  }
}

async function cmdRun() {
  const { exportLatest } = await import("../src/exporter.mjs");
  const { commitAndPush } = await import("../src/git-sync.mjs");
  const interactive = !!process.stdout.isTTY;
  const ts = () => new Date().toISOString().slice(0, 16).replace("T", " ");

  // Concurrency guard
  if (!(await acquireLock())) {
    log("Another backup is already running — skipping.");
    if (interactive) {
      await notify(NOTIFY_TITLE, `⊘ Another run is in progress; skipping.`, true);
    }
    return;
  }

  try {
    if (interactive) {
      await notify(NOTIFY_TITLE, `▶ Started • ${ts()}`);
    }

    log("Scanning and exporting...");
    const { backupRoot, copied, errors } = await exportLatest(BACKUP_DIR);
    log(`Exported ${copied} items to ${backupRoot}`);
    if (errors.length > 0) {
      log(`Warnings: ${errors.length} items failed to export`);
      for (const err of errors.slice(0, 5)) log(`  - ${err}`);
    }

    log("Committing...");
    const result = await commitAndPush(BACKUP_DIR);
    log(result.message);

    await saveConfig({
      ...(await loadConfig()),
      lastRun: new Date().toISOString(),
      lastCopied: copied,
      lastErrors: errors.length,
    });

    // Classify outcome and notify
    if (result.committed && !result.pushed) {
      await notify(NOTIFY_TITLE, `⚠️ Push failed: ${result.message}`, true);
      process.exitCode = 1;
    } else if (errors.length > 0) {
      await notify(
        NOTIFY_TITLE,
        `⚠️ ${copied} items backed up, ${errors.length} export warnings`,
        true,
      );
    } else {
      const verb = result.committed ? `Backed up ${copied} items` : "No-op";
      await notify(NOTIFY_TITLE, `✓ ${verb} • ${ts()}`);
    }
  } catch (err) {
    log(`FATAL: ${err.message}`);
    await notify(NOTIFY_TITLE, `✗ ${err.message}`, true);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

async function cmdStatus() {
  const { status } = await import("../src/scheduler.mjs");
  const config = await loadConfig();

  if (config.lastRun) {
    const ago = Math.round((Date.now() - new Date(config.lastRun).getTime()) / 60000);
    log(`Last backup: ${config.lastRun} (${ago} min ago)`);
    log(`  Items backed up: ${config.lastCopied || "unknown"}`);
    log(`  Errors: ${config.lastErrors || 0}`);
  } else {
    log("No backup has been run yet.");
  }

  log(`\nBackup interval: every ${config.interval || "unknown"}h`);

  log("\nScheduler status:");
  const s = await status();
  log(s);

  // Check git status
  const { isGitRepo, hasRemote, getRemoteUrl } = await import("../src/git-sync.mjs");
  if (await isGitRepo(BACKUP_DIR)) {
    log("\nGit repo: ~/.claude-backups/");
    if (await hasRemote(BACKUP_DIR)) {
      log(`Remote: ${await getRemoteUrl(BACKUP_DIR)}`);
    } else {
      log("Remote: not configured");
    }
  } else {
    log("\nGit repo: not initialized. Run 'claude-code-backup init' first.");
  }
}

async function cmdInterval() {
  const hours = parseInt(process.argv[3], 10);
  if (!hours || hours <= 0) {
    log("Usage: ccb interval <hours>");
    process.exitCode = 1;
    return;
  }

  // Routed through installSchedule so changing the interval can't quietly
  // reintroduce a LaunchAgent on a machine where we refused to install one.
  const installed = await installSchedule(hours);

  const config = await loadConfig();
  config.interval = hours;
  config.schedulerSkipped = !installed;
  await saveConfig(config);
  if (installed) log(`Scheduler updated to run every ${hours}h`);
}

async function cmdUninstall() {
  const { remove } = await import("../src/scheduler.mjs");
  await remove();
  log("Scheduler removed. Backup data preserved in ~/.claude-backups/");
}

async function cmdRestore() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const versionIdx = process.argv.indexOf("--version");
  const version = versionIdx !== -1 ? process.argv[versionIdx + 1] : null;

  if (!dryRun && !force) {
    const targetName = version || "latest";
    log(`⚠️  WARNING: This will overwrite existing local configurations, memories, skills, and plans with backup version '${targetName}'.`);
    const answer = await ask("Are you sure you want to proceed? (y/N): ");
    // An empty answer also covers EOF on a non-interactive stdin — refuse to
    // overwrite the user's live config when nobody actually confirmed.
    if (answer.toLowerCase() !== "y") {
      log("Restore aborted.");
      closePrompts();
      return;
    }
  }
  closePrompts();

  const { restoreAll } = await import("../src/restorer.mjs");
  log(dryRun ? `🔍 Previewing restore of version '${version || "latest"}' (dry-run)...` : `⏳ Restoring files from version '${version || "latest"}'...`);

  try {
    const { restoredCount, mcpServersToMerge } = await restoreAll(BACKUP_DIR, { dryRun, version }, (msg) => {
      log(msg);
    });

    log(`\n✓ Restore complete! Restored ${restoredCount} files.`);

    if (mcpServersToMerge.length > 0) {
      log("\n💡 Manual MCP Merges Required:");
      log("The following MCP configurations were found in the backup. You will need to manually copy or merge their settings into your MCP host configuration:");
      for (const mcp of mcpServersToMerge) {
        if (mcp.scope === "global") {
          log(`  - Server '${mcp.name}' (Global) -> Merge config from '${mcp.path}' into ~/.claude.json`);
        } else {
          log(`  - Server '${mcp.name}' (Project: ${mcp.scope}) -> Merge config from '${mcp.path}' into ${mcp.scope}/.mcp.json`);
        }
      }
    }
  } catch (err) {
    log(`✗ Restore failed: ${err.message}`);
  }
}

async function cmdList() {
  if (!(await exists(BACKUP_DIR))) {
    log("No backups found. Run 'ccb init' to set up backups.");
    return;
  }

  // Collect the "latest" snapshot plus every timestamped historical folder.
  const dirents = await readdir(BACKUP_DIR, { withFileTypes: true });
  const historical = dirents
    .filter((e) => e.isDirectory() && e.name.startsWith("backup-"))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first (folder names sort chronologically)

  const hasLatest = dirents.some((e) => e.isDirectory() && e.name === "latest");
  const ordered = [...(hasLatest ? ["latest"] : []), ...historical];

  if (ordered.length === 0) {
    log("No backups yet. Run 'ccb run' to create one.");
    return;
  }

  // Local time so the column matches the local timestamps in folder names.
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) =>
    d instanceof Date && !isNaN(d)
      ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      : "unknown";

  // Gather display info for each backup.
  const rows = [];
  for (const name of ordered) {
    const dir = join(BACKUP_DIR, name);
    let items = "?";
    let when = null;
    try {
      const summary = JSON.parse(await readFile(join(dir, "backup-summary.json"), "utf-8"));
      items = summary.copied ?? summary.totalItems ?? "?";
      if (summary.exportedAt) when = new Date(summary.exportedAt);
    } catch {}
    if (!when) {
      const m = name.match(/^backup-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
      if (m) when = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
      else { try { when = (await stat(dir)).mtime; } catch {} }
    }
    rows.push({ name, when: fmtDate(when), items: String(items) });
  }

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  log(`Backups in ~/.claude-backups (${rows.length}):\n`);
  log(`  ${"NAME".padEnd(nameW)}  ${"WHEN".padEnd(16)}  ITEMS`);
  for (const r of rows) {
    const tag = r.name === "latest" ? "  (current)" : "";
    log(`  ${r.name.padEnd(nameW)}  ${r.when.padEnd(16)}  ${r.items.padStart(5)}${tag}`);
  }

  const example = historical[0] || "latest";
  log(`\nRestore a specific version with:`);
  log(`  ccb restore --version ${example}`);
}

async function cmdNotifyTest() {
  log("Sending test notification...");
  await notify(
    NOTIFY_TITLE,
    "✓ Test notification — if you can read this, banners are working",
  );
  log("Sent. Check Notification Center.");
}

// ── Help ─────────────────────────────────────────────────────────────

// Command catalog — drives both dispatch (below) and the help output, so the
// two never drift. `args` is the positional-argument hint shown next to the
// name; `flags` documents the options each command accepts.
const COMMANDS = {
  init: {
    summary: "Set up backup repo and take the first backup (interactive).",
    flags: [
      ["--schedule", "Also install the background scheduler (off by default)"],
      ["--force-scheduler", "Install even if security software or another schedule is present"],
    ],
  },
  schedule: {
    args: "[hours]",
    summary: "Install the background scheduler (default: 4h).",
    flags: [["--force-scheduler", "Install even if security software or another schedule is present"]],
  },
  run: { summary: "Run backup now (scan + export + commit + push)." },
  status: { summary: "Show last backup info and scheduler status." },
  interval: { args: "<hours>", summary: "Change backup interval and reinstall scheduler." },
  list: { summary: "List available backups you can restore." },
  restore: {
    summary: "Restore settings from a backup (latest by default).",
    flags: [
      ["--version <folder>", "Restore a specific historical backup instead of latest"],
      ["--dry-run", "Preview what would be restored without writing anything"],
      ["--force", "Skip the overwrite confirmation prompt"],
    ],
  },
  uninstall: { summary: "Remove scheduled backup (keeps backup data)." },
  "notify-test": { summary: "Send a test notification banner." },
};

// Short label for the overview list, e.g. "ccb interval <hours>".
function label(name) {
  const spec = COMMANDS[name];
  return `ccb ${name}${spec.args ? ` ${spec.args}` : ""}`;
}

// Help must print even under --quiet, so write directly instead of via log().
function out(msg = "") {
  process.stdout.write(msg + "\n");
}

function printRootHelp() {
  out("ccb — Automatic backup of all Claude Code settings\n");
  out("Usage:");
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => label(n).length));
  for (const name of names) {
    out(`  ${label(name).padEnd(width)}  ${COMMANDS[name].summary}`);
  }
  out("\nRun 'ccb <command> --help' for details on a command.");
  out("\nYour skills, memories, rules, MCP configs, and settings — all safe.");
}

function printCommandHelp(name) {
  const spec = COMMANDS[name];
  if (!spec) return printRootHelp();
  out(`${spec.summary}\n`);
  out(`Usage:\n  ${label(name)}${spec.flags?.length ? " [options]" : ""}`);
  if (spec.flags?.length) {
    out("\nOptions:");
    const width = Math.max(...spec.flags.map(([f]) => f.length));
    for (const [flag, desc] of spec.flags) {
      out(`  ${flag.padEnd(width)}  ${desc}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

// A --help/-h flag anywhere must show help and never run the command — several
// subcommands have side effects (run, restore, uninstall), so silently
// ignoring the flag and executing was both surprising and unsafe.
if (args.includes("--help") || args.includes("-h")) {
  // Target = first non-flag token, so `ccb restore --help` documents restore
  // while a bare `ccb --help` shows the overview.
  const target = args.find((a) => !a.startsWith("-"));
  if (target && COMMANDS[target]) printCommandHelp(target);
  else printRootHelp();
  process.exit(0);
}

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "run":
    await cmdRun();
    break;
  case "status":
    await cmdStatus();
    break;
  case "schedule":
    await cmdSchedule();
    break;
  case "interval":
    await cmdInterval();
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  case "list":
    await cmdList();
    break;
  case "restore":
    await cmdRestore();
    break;
  case "notify-test":
    await cmdNotifyTest();
    break;
  case "help":
    // `ccb help [command]` mirrors the --help flag.
    printCommandHelp(args[1]);
    break;
  default:
    printRootHelp();
    break;
}
