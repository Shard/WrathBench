#!/bin/bash
# Claude Code web sessions ship whatever Bun the base image has; the repo pins
# one (.bun-version), and a mismatched Bun fails `bun install --frozen-lockfile`
# on the lockfile format before any test can run. Install the pinned Bun from
# GitHub releases (bun.sh's installer is blocked by some egress proxies), put it
# on the session PATH, and install workspace deps. Local sessions are untouched.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

PINNED="$(tr -d '[:space:]' < .bun-version)"
BUN_DIR="$HOME/.bun/bin"
BUN="$BUN_DIR/bun"

version_of() { "$1" --version 2>/dev/null || true; }

if [ "$(version_of "$BUN")" != "$PINNED" ]; then
  SYSTEM_BUN="$(command -v bun || true)"
  if [ -n "$SYSTEM_BUN" ] && [ "$(version_of "$SYSTEM_BUN")" = "$PINNED" ]; then
    mkdir -p "$BUN_DIR"
    ln -sf "$SYSTEM_BUN" "$BUN"
  else
    case "$(uname -m)" in
      x86_64) TARGET="linux-x64" ;;
      aarch64 | arm64) TARGET="linux-aarch64" ;;
      *)
        echo "session-start: unsupported arch $(uname -m); install Bun $PINNED manually" >&2
        exit 1
        ;;
    esac
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL --retry 3 -o "$TMP/bun.zip" \
      "https://github.com/oven-sh/bun/releases/download/bun-v${PINNED}/bun-${TARGET}.zip"
    unzip -oq "$TMP/bun.zip" -d "$TMP"
    mkdir -p "$BUN_DIR"
    install -m 0755 "$TMP/bun-${TARGET}/bun" "$BUN"
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$BUN_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

"$BUN" install --frozen-lockfile
echo "session-start: bun $("$BUN" --version) ready, workspace deps installed"
