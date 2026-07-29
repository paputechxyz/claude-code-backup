/**
 * restorer.mjs — Restore all Claude Code customizations from the backup.
 */

import { readdir, mkdir, copyFile, access, stat, readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { homedir, platform } from "node:os";
import { resolveEncodedProjectPath } from "./scanner.mjs";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function getAutoMemoryDirectory() {
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const content = await readFile(join(CLAUDE_DIR, f), "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.autoMemoryDirectory) {
        return parsed.autoMemoryDirectory;
      }
    } catch {}
  }
  return null;
}

async function copyRecursive(src, dest, dryRun, logFn) {
  const s = await stat(src);
  if (s.isDirectory()) {
    if (!dryRun) {
      await mkdir(dest, { recursive: true });
    }
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(join(src, entry.name), join(dest, entry.name), dryRun, logFn);
    }
  } else {
    logFn(src, dest);
    if (!dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
  }
}

export async function restoreAll(backupDir, options = {}, logFn = () => {}) {
  const latestDir = options.version ? join(backupDir, options.version) : join(backupDir, "latest");
  if (!(await exists(latestDir))) {
    throw new Error(`Backup directory '${options.version || "latest"}' not found at ${latestDir}`);
  }

  const dryRun = !!options.dryRun;
  const autoMemDir = await getAutoMemoryDirectory();

  const entries = await readdir(latestDir, { withFileTypes: true });
  let restoredCount = 0;
  const mcpServersToMerge = [];

  const logCopy = (src, dest) => {
    const relSrc = relative(latestDir, src);
    const readableDest = dest.replace(HOME, "~");
    logFn(`  [Copy] ${relSrc} -> ${readableDest}`);
    restoredCount++;
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (entry.name === "global") {
      logFn("\nProcessing global backups...");
      const globalDir = join(latestDir, "global");
      const cats = await readdir(globalDir, { withFileTypes: true });

      for (const cat of cats) {
        if (!cat.isDirectory()) continue;
        const srcCatDir = join(globalDir, cat.name);

        let destBaseDir;
        if (cat.name === "config") destBaseDir = CLAUDE_DIR;
        else if (cat.name === "memory") destBaseDir = join(CLAUDE_DIR, "memory");
        else if (cat.name === "skill") destBaseDir = join(CLAUDE_DIR, "skills");
        else if (cat.name === "plan") destBaseDir = join(CLAUDE_DIR, "plans");
        else if (cat.name === "rule") destBaseDir = join(CLAUDE_DIR, "rules");
        else if (cat.name === "command") destBaseDir = join(CLAUDE_DIR, "commands");
        else if (cat.name === "agent") destBaseDir = join(CLAUDE_DIR, "agents");
        else if (cat.name === "plugin") destBaseDir = join(CLAUDE_DIR, "plugins", "cache");
        else if (cat.name === "mcp") {
          // MCP configs need to be merged manually
          const mcpFiles = await readdir(srcCatDir);
          for (const f of mcpFiles) {
            if (f.endsWith(".json")) {
              mcpServersToMerge.push({
                scope: "global",
                name: f.replace(".json", ""),
                path: join(srcCatDir, f),
              });
            }
          }
          continue;
        } else {
          continue;
        }

        const items = await readdir(srcCatDir);
        for (const item of items) {
          const srcPath = join(srcCatDir, item);
          const destPath = join(destBaseDir, item);
          await copyRecursive(srcPath, destPath, dryRun, logCopy);
        }
      }
    } else {
      // Project folder
      const encodedName = entry.name;
      let realPath = await decodeProjectPath(encodedName);
      if (!realPath) {
        logFn(`\n⚠️  Could not resolve local folder path for project '${encodedName}'. Skipping project.`);
        continue;
      }

      logFn(`\nProcessing project backups for '${realPath}'...`);
      const projBackupDir = join(latestDir, encodedName);
      const cats = await readdir(projBackupDir, { withFileTypes: true });

      for (const cat of cats) {
        if (!cat.isDirectory()) continue;
        const srcCatDir = join(projBackupDir, cat.name);

        let destBaseDir;
        if (cat.name === "config") {
          // Project configs are stored relative to project root
          destBaseDir = realPath;
        } else if (cat.name === "memory") {
          destBaseDir = autoMemDir ? join(realPath, autoMemDir) : join(realPath, ".claude", "memory");
        } else if (cat.name === "skill") {
          destBaseDir = join(realPath, ".claude", "skills");
        } else if (cat.name === "session") {
          destBaseDir = join(CLAUDE_DIR, "projects", encodedName);
        } else if (cat.name === "mcp") {
          const mcpFiles = await readdir(srcCatDir);
          for (const f of mcpFiles) {
            if (f.endsWith(".json")) {
              mcpServersToMerge.push({
                scope: realPath,
                name: f.replace(".json", ""),
                path: join(srcCatDir, f),
              });
            }
          }
          continue;
        } else {
          continue;
        }

        const items = await readdir(srcCatDir);
        for (const item of items) {
          const srcPath = join(srcCatDir, item);
          const destPath = join(destBaseDir, item);
          await copyRecursive(srcPath, destPath, dryRun, logCopy);
        }
      }
    }
  }

  return { restoredCount, mcpServersToMerge };
}

async function decodeProjectPath(encoded) {
  let directPath = "/" + encoded.replace(/^-/, "").split("-").join("/");
  if (await exists(directPath)) {
    return directPath;
  }
  return await resolveEncodedProjectPath(encoded);
}
