# default: List all available recipes
default:
    @just --list

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

