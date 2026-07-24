#!/usr/bin/env bash
#
# Build the client and restart the macOS service.
#
#   scripts/macos/deploy.sh          # npm run build, then restart
#   scripts/macos/deploy.sh --no-build
#
# `npm run start` serves the prebuilt dist/, so client changes are invisible
# until this runs. Installs the LaunchAgent on first use.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="$REPO/scripts/macos/service.sh"

info() { printf '\033[36m%s\033[0m %s\n' "[pm]" "$*"; }

if [[ "${1:-}" != "--no-build" ]]; then
  info "building client…"
  (cd "$REPO" && npm run build)
fi

if bash "$SERVICE" status >/dev/null 2>&1; then
  bash "$SERVICE" restart
else
  info "service not installed yet — installing"
  bash "$SERVICE" install
fi
