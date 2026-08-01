#!/usr/bin/env bash
#
# install.sh — download the latest `ccb` (claude-code-backup) release into ~/.local/bin
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/paputechxyz/claude-code-backup/main/install.sh | bash
#
set -euo pipefail

REPO="paputechxyz/claude-code-backup"
ASSET="ccb.mjs"
BIN_DIR="${CCB_BIN_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/ccb"

err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
info() { printf '\033[32m==>\033[0m %s\n' "$*"; }

# ── Preflight ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "node is not installed. Install Node.js 18+ first: https://nodejs.org"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js 18+ required (found $(node --version))."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required."
  exit 1
fi

# ── Resolve download URL ─────────────────────────────────────────────
# Use the stable "latest release" redirect so we don't need the GitHub API.
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

info "Downloading ${ASSET} from latest release..."
mkdir -p "$BIN_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP"; then
  err "Download failed. Has a release been published yet? ($URL)"
  exit 1
fi

# Sanity-check the artifact looks like our CLI.
if ! head -n1 "$TMP" | grep -q '#!/usr/bin/env node'; then
  err "Downloaded file does not look like the ccb binary."
  exit 1
fi

mv "$TMP" "$BIN_PATH"
trap - EXIT
chmod +x "$BIN_PATH"

info "Installed $BIN_PATH"
"$BIN_PATH" >/dev/null 2>&1 || true  # warm/verify it runs

# ── PATH hint ────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n\033[33mnote:\033[0m %s is not on your PATH. Add this to your shell profile:\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\nRun \033[1mccb\033[0m to get started, or \033[1mccb init\033[0m for first-time setup.\n'
