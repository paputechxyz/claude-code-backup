#!/usr/bin/env node

/**
 * claude-code-backup CLI
 *
 * Commands:
 *   init          — Interactive setup: create backup repo, configure remote, install scheduler
 *   run           — Run a backup now (scan + export + commit + push)
 *   status        — Show last backup info and scheduler status
 *   uninstall     — Remove scheduled backup (keeps backup data)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, access, open } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
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
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale-lock recovery: if the holder PID is no longer alive, steal the lock
    try {
      const existing = await readFile(LOCK_PATH, "utf-8");
      const pid = parseInt(existing.trim(), 10);
      if (pid && !processAlive(pid)) {
        await writeFile(LOCK_PATH, String(process.pid));
        return true;
      }
    } catch {}
    return false;
  }
}

function releaseLock() {
  try { rmSync(LOCK_PATH, { force: true }); } catch {}
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdInit() {
  const { scan } = await import("../src/scanner.mjs");
  const { isGitRepo, initRepo, addRemote } = await import("../src/git-sync.mjs");
  const { install } = await import("../src/scheduler.mjs");

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

  // Scheduler setup
  log("");
  const forceScheduler = process.argv.includes("--force-scheduler");

  // Detect any existing schedule that could collide
  const { detectExistingSchedule } = await import("../src/scheduler.mjs");
  const cliPath = new URL(import.meta.url).pathname;
  const existing = await detectExistingSchedule(cliPath);

  let skipSchedulerInstall = false;
  if (existing.length > 0 && !forceScheduler) {
    log("⚠️  Existing backup schedule(s) detected:");
    for (const f of existing) {
      log(`   - ${f.type}${f.path ? ` (${f.path})` : ""}: ${f.detail}`);
    }
    const proceed = await ask("Install another schedule anyway? (y/N): ");
    if (proceed.toLowerCase() !== "y") {
      log("Skipping scheduler install. Existing schedule will keep firing.");
      skipSchedulerInstall = true;
    }
  }

  let interval = 4;
  if (!skipSchedulerInstall) {
    const intervalStr = await ask("Backup interval in hours (default: 4): ");
    interval = parseInt(intervalStr) || 4;
  }

  const nodePath = process.execPath;

  if (!skipSchedulerInstall) {
    try {
      const result = await install(nodePath, cliPath, interval);
      log(`\nScheduler installed (every ${interval}h + on boot)`);
      if (result.timerPath) log(`  Service: ${result.timerPath}`);
      if (result.plistPath) log(`  LaunchAgent: ${result.plistPath}`);
    } catch (err) {
      log(`\nFailed to install scheduler: ${err.message}`);
      log("You can run backups manually with: npx @paputechxyz/claude-code-backup run");
    }
  }

  // Save config
  await saveConfig({
    interval,
    installedAt: new Date().toISOString(),
    schedulerSkipped: skipSchedulerInstall,
  });

  // Run first backup
  log("\nRunning first backup...\n");
  await cmdRun();

  log("\n✓ Setup complete! Your Claude Code settings are backed up.");
  log("  Backup location: ~/.claude-backups/latest/");
  if (!skipSchedulerInstall) {
    log(`  Auto-backup: every ${interval} hours + on boot`);
  } else {
    log("  Auto-backup: handled by previously-installed schedule");
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
    if (answer.toLowerCase() !== "y") {
      log("Restore aborted.");
      return;
    }
  }

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

async function cmdNotifyTest() {
  log("Sending test notification...");
  await notify(
    NOTIFY_TITLE,
    "✓ Test notification — if you can read this, banners are working",
  );
  log("Sent. Check Notification Center.");
}

// ── Main ─────────────────────────────────────────────────────────────

const command = process.argv[2];

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
  case "uninstall":
    await cmdUninstall();
    break;
  case "restore":
    await cmdRestore();
    break;
  case "notify-test":
    await cmdNotifyTest();
    break;
  default:
    log("claude-code-backup — Automatic backup of all Claude Code settings\n");
    log("Usage:");
    log("  claude-code-backup init        Set up backup repo + schedule");
    log("  claude-code-backup run         Run backup now");
    log("  claude-code-backup status      Show backup status");
    log("  claude-code-backup restore     Restore settings from the latest backup (use --version <folder> to restore historical version)");
    log("  claude-code-backup uninstall   Remove scheduled backup");
    log("  claude-code-backup notify-test Send a test notification banner\n");
    log("Your skills, memories, rules, MCP configs, and settings — all safe.");
    break;
}
