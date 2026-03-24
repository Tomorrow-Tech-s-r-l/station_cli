#!/usr/bin/env bash
set -euo pipefail

required_major=20

get_major() {
  if command -v node >/dev/null 2>&1; then
    node -v | sed -E 's/^v([0-9]+).*/\1/'
  fi
}

major="$(get_major || true)"
if [ -n "$major" ] && [ "$major" -ge "$required_major" ]; then
  echo "Node.js $major found."
  exit 0
fi

if ! command -v nvm >/dev/null 2>&1; then
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v nvm >/dev/null 2>&1; then
  echo "nvm not found after install. Restart VS Code and try again." >&2
  exit 1
fi

nvm install 20
nvm use 20

major="$(get_major || true)"
if [ -z "$major" ] || [ "$major" -lt "$required_major" ]; then
  echo "Node.js 20 not available after nvm install. Restart VS Code and try again." >&2
  exit 1
fi

echo "Node.js $major ready."
