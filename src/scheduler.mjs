/**
 * scheduler.mjs — Install/remove systemd timer (Linux) or launchd plist (macOS).
 */

import { writeFile, mkdir, unlink, readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HOME = homedir();

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

const SERVICE_NAME = "claude-code-backup";

// ── Linux (systemd user timer) ──────────────────────────────────────

function systemdDir() {
  return join(HOME, ".config", "systemd", "user");
}

function serviceContent(nodePath, cliPath) {
  return `[Unit]
Description=Claude Code Backup — scan and push settings to GitHub

[Service]
Type=oneshot
ExecStart=${nodePath} ${cliPath} run --quiet
Environment=HOME=${HOME}
`;
}

function timerContent(intervalHours) {
  return `[Unit]
Description=Claude Code Backup Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=${intervalHours}h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

async function installSystemd(nodePath, cliPath, intervalHours) {
  const dir = systemdDir();
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, `${SERVICE_NAME}.service`),
    serviceContent(nodePath, cliPath)
  );
  await writeFile(
    join(dir, `${SERVICE_NAME}.timer`),
    timerContent(intervalHours)
  );

  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.timer`]);

  return {
    servicePath: join(dir, `${SERVICE_NAME}.service`),
    timerPath: join(dir, `${SERVICE_NAME}.timer`),
  };
}

async function removeSystemd() {
  try {
    await exec("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.timer`]);
  } catch {}
  const dir = systemdDir();
  try { await unlink(join(dir, `${SERVICE_NAME}.service`)); } catch {}
  try { await unlink(join(dir, `${SERVICE_NAME}.timer`)); } catch {}
  try { await exec("systemctl", ["--user", "daemon-reload"]); } catch {}
}

async function statusSystemd() {
  try {
    const { stdout } = await exec("systemctl", [
      "--user", "status", `${SERVICE_NAME}.timer`, "--no-pager",
    ]);
    return stdout;
  } catch (err) {
    return err.stdout || err.stderr || "Timer not installed";
  }
}

// ── macOS (launchd plist) ───────────────────────────────────────────

function launchdDir() {
  return join(HOME, "Library", "LaunchAgents");
}

function plistLabel() {
  return `com.paputechxyz.${SERVICE_NAME}`;
}

function plistContent(nodePath, cliPath, intervalSeconds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>run</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.claude-backups/backup.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.claude-backups/backup.log</string>
</dict>
</plist>
`;
}

async function installLaunchd(nodePath, cliPath, intervalHours) {
  const dir = launchdDir();
  await mkdir(dir, { recursive: true });
  const plistPath = join(dir, `${plistLabel()}.plist`);
  await writeFile(plistPath, plistContent(nodePath, cliPath, intervalHours * 3600));

  try {
    await exec("launchctl", ["unload", plistPath]);
  } catch {}
  await exec("launchctl", ["load", plistPath]);

  return { plistPath };
}

async function removeLaunchd() {
  const plistPath = join(launchdDir(), `${plistLabel()}.plist`);
  try { await exec("launchctl", ["unload", plistPath]); } catch {}
  try { await unlink(plistPath); } catch {}
}

async function statusLaunchd() {
  try {
    const { stdout } = await exec("launchctl", ["list", plistLabel()]);
    return stdout;
  } catch {
    return "LaunchAgent not installed";
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Install scheduled backup.
 * @param {string} nodePath - Full path to node binary
 * @param {string} cliPath - Full path to cli.mjs
 * @param {number} intervalHours - Backup interval in hours (default: 4)
 */
export async function install(nodePath, cliPath, intervalHours = 4) {
  if (platform() === "darwin") {
    return installLaunchd(nodePath, cliPath, intervalHours);
  }
  return installSystemd(nodePath, cliPath, intervalHours);
}

/**
 * Remove scheduled backup.
 */
export async function remove() {
  if (platform() === "darwin") {
    return removeLaunchd();
  }
  return removeSystemd();
}

/**
 * Get scheduler status.
 */
export async function status() {
  if (platform() === "darwin") {
    return statusLaunchd();
  }
  return statusSystemd();
}

// ── Existing schedule detection ─────────────────────────────────────

/**
 * Detect any existing backup schedule that could collide with a fresh install.
 * Checks per-user LaunchAgents, system LaunchAgents, loaded launchd jobs,
 * crontab entries, and (on Linux) systemd user timers.
 *
 * Returns an array of findings: [{ type, detail, path? }]
 */
export async function detectExistingSchedule(cliPath) {
  const findings = [];
  const serviceLabel = `com.paputechxyz.${SERVICE_NAME}`;
  const legacyLabel = `com.mcpware.${SERVICE_NAME}`;

  // 1. Our own plist (current or legacy label) in per-user LaunchAgents
  const userAgentsDir = join(HOME, "Library", "LaunchAgents");
  if (platform() === "darwin") {
    try {
      const files = await readdir(userAgentsDir);
      for (const f of files) {
        if (!f.endsWith(".plist")) continue;
        const fullPath = join(userAgentsDir, f);
        const content = await readFile(fullPath, "utf-8").catch(() => "");
        const isOurs = f === `${serviceLabel}.plist` || f === `${legacyLabel}.plist`;
        const mentionsUs = content.includes(SERVICE_NAME) || (cliPath && content.includes(cliPath));
        if (isOurs) {
          findings.push({ type: "launchd-ours", path: fullPath, detail: `Our LaunchAgent is already installed (${f})` });
        } else if (mentionsUs) {
          findings.push({ type: "launchd-other", path: fullPath, detail: `Another plist references claude-code-backup: ${f}` });
        }
      }
    } catch {}

    // 2. System-wide LaunchAgents (admin-installed)
    const systemAgentsDir = "/Library/LaunchAgents";
    try {
      const files = await readdir(systemAgentsDir);
      for (const f of files) {
        if (!f.endsWith(".plist")) continue;
        const fullPath = join(systemAgentsDir, f);
        const content = await readFile(fullPath, "utf-8").catch(() => "");
        if (content.includes(SERVICE_NAME) || (cliPath && content.includes(cliPath))) {
          findings.push({ type: "launchd-system", path: fullPath, detail: `System-level LaunchAgent references claude-code-backup: ${f}` });
        }
      }
    } catch {}

    // 3. Currently loaded launchd jobs
    try {
      const { stdout } = await exec("launchctl", ["list"]);
      for (const line of stdout.split("\n")) {
        if (line.includes(SERVICE_NAME)) {
          const cols = line.trim().split(/\s+/);
          const label = cols[cols.length - 1];
          findings.push({ type: "launchd-loaded", detail: `Loaded launchd job: ${label}` });
        }
      }
    } catch {}

    // 4. Crontab entries
    try {
      const { stdout } = await exec("crontab", ["-l"]);
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.includes(SERVICE_NAME) || (cliPath && trimmed.includes(cliPath))) {
          findings.push({ type: "crontab", detail: `crontab entry: ${trimmed.slice(0, 100)}` });
        }
      }
    } catch {} // exit 1 = no crontab, ignore
  }

  // 5. Linux: systemd user timers
  if (platform() === "linux") {
    try {
      const { stdout } = await exec("systemctl", ["--user", "list-units", "--type=timer"]);
      for (const line of stdout.split("\n")) {
        if (line.includes(SERVICE_NAME)) {
          findings.push({ type: "systemd-timer", detail: `systemd user timer active: ${line.trim().slice(0, 100)}` });
        }
      }
    } catch {}
  }

  return findings;
}
