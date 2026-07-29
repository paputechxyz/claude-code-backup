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
