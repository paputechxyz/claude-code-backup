# default: List all available recipes
default:
    @just --list

# Bundle bin/cli.mjs into a single self-contained file at dist/ccb.mjs
build:
    npm run build

# Build and install the `ccb` binary into ~/.local/bin
install: build
    mkdir -p ~/.local/bin
    cp dist/ccb.mjs ~/.local/bin/ccb
    chmod +x ~/.local/bin/ccb
    @echo "Installed ~/.local/bin/ccb — ensure ~/.local/bin is on your PATH"

# Remove the installed `ccb` binary (leaves ~/.claude-backups untouched)
uninstall-bin:
    rm -f ~/.local/bin/ccb
    @echo "Removed ~/.local/bin/ccb"

# Create and push a release tag `v<version>` (defaults to package.json version) to trigger the release workflow
tag version=`node -p "require('./package.json').version"`:
    #!/usr/bin/env bash
    set -euo pipefail
    if git rev-parse "v{{version}}" >/dev/null 2>&1; then
      echo "Tag v{{version}} already exists — bump the version in package.json first."; exit 1
    fi
    git tag -a "v{{version}}" -m "Release v{{version}}"
    git push origin "v{{version}}"
    echo "Pushed v{{version}} — the release workflow will build, create the GitHub Release, and npm publish."
    echo "Watch it: gh run watch --repo paputechxyz/claude-code-backup"

# List available backups (newest first) that can be restored
list:
    node bin/cli.mjs list

# Dry-run restore to preview what files will be copied
restore-dry-run:
    node bin/cli.mjs restore --dry-run

# Restore backups with an interactive confirmation prompt before overwriting
restore:
    node bin/cli.mjs restore

# Restore backups and force-overwrite files without prompting
restore-force:
    node bin/cli.mjs restore --force

# Initialize the backup tool (sets up repository, remote, and registers background scheduler)
init:
    node bin/cli.mjs init

# Run a backup manually (scans, copies, and commits changes)
backup:
    node bin/cli.mjs run

# Show backup status and whether the scheduled job (launchd/systemd) is running
status:
    node bin/cli.mjs status

# Change the backup interval (hours) and reinstall the scheduled job (launchd/systemd)
interval hours:
    node bin/cli.mjs interval {{hours}}

# Restore a specific historical backup version by folder name
restore-version version:
    node bin/cli.mjs restore --version {{version}}

