#!/usr/bin/env bash
#
# macOS launchd service control for ProjectManager.
#
#   scripts/macos/service.sh install|uninstall|start|stop|restart|status|logs
#
# Installs a per-user LaunchAgent (not a system daemon): the app spawns tmux
# sessions and shells that must run as the logged-in user, with that user's
# environment and file permissions. A LaunchDaemon would run as root at boot
# with no user session to attach to.
#
# The Linux counterpart belongs in scripts/linux/ (systemd --user unit).
set -euo pipefail

LABEL="${PM_SERVICE_LABEL:-local.projectmanager}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ProjectManager"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m %s\n' "[pm]" "$*"; }

# ------------------------------------------------------------------ helpers

# The server reads scheme/host/port from env + pm.config.json, so ask the real
# config module rather than re-parsing the JSON here and drifting from it.
read_config() {
  node --input-type=module -e "
    import { config } from '$REPO/server/config.js'
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
    console.log([config.https.enabled ? 'https' : 'http', host, config.port].join(' '))
  "
}

url() {
  local scheme host port
  read -r scheme host port <<<"$(read_config)"
  echo "$scheme://$host:$port"
}

# launchd starts with a bare PATH, but the app shells out to git, gh, tmux and
# `claude` by name — and tmux sessions inherit this env. Bake the installing
# shell's PATH in, plus the usual suspects in case install ran from a stripped
# environment.
service_path() {
  local extra="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  printf '%s:%s:%s' "$(dirname "$(command -v node)")" "$PATH" "$extra" |
    awk -v RS=: '!seen[$0]++ && $0 != "" { printf "%s%s", sep, $0; sep=":" }'
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

installed() { [[ -f "$PLIST" ]]; }
loaded() { launchctl print "$TARGET" >/dev/null 2>&1; }

require_installed() {
  installed || die "not installed — run: scripts/macos/service.sh install"
}

# The node path is baked into the plist, so an nvm version bump silently points
# the agent at a node that no longer exists. Catch that here instead of leaving
# launchd to crash-loop.
check_node_drift() {
  local baked
  baked="$(/usr/bin/awk '/<string>.*\/node<\/string>/ { gsub(/.*<string>|<\/string>.*/, ""); print; exit }' "$PLIST" 2>/dev/null || true)"
  if [[ -n "$baked" && ! -x "$baked" ]]; then
    die "the installed service points at a node that no longer exists:
       $baked
       Re-run: scripts/macos/service.sh install"
  fi
}

# A manual `npm run start` holding the port makes the agent crash-loop with a
# confusing EADDRINUSE in the log. Say so up front.
warn_port_conflict() {
  local port pids
  port="$(read_config | awk '{print $3}')"
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  printf '\033[33mwarning\033[0m port %s is already in use (pid %s).\n' \
    "$port" "$(echo "$pids" | tr '\n' ' ' | sed 's/ $//')"
  echo "        If that is a manual \`npm run start\`, stop it or the service will crash-loop."
}

wait_for_health() {
  local u; u="$(url)"
  for _ in $(seq 1 30); do
    if curl -sk -o /dev/null --max-time 2 "$u/api/auth"; then
      info "listening at $u"
      return 0
    fi
    sleep 1
  done
  printf '\033[33mwarning\033[0m no response from %s after 30s — check: scripts/macos/service.sh logs\n' "$u"
  return 0
}

# ------------------------------------------------------------------ commands

cmd_install() {
  local node_bin
  node_bin="$(command -v node)" || die "node not found on PATH"
  [[ -d "$REPO/dist" ]] || info "dist/ missing — run \`npm run build\` (or scripts/macos/deploy.sh)"

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(printf '%s' "$LABEL" | xml_escape)</string>

  <key>ProgramArguments</key>
  <array>
    <string>$(printf '%s' "$node_bin" | xml_escape)</string>
    <string>$(printf '%s' "$REPO/server/index.js" | xml_escape)</string>
  </array>

  <!-- Required: pm.config.json may hold relative TLS cert paths, which the
       server reads relative to the working directory. -->
  <key>WorkingDirectory</key>
  <string>$(printf '%s' "$REPO" | xml_escape)</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOME</key>
    <string>$(printf '%s' "$HOME" | xml_escape)</string>
    <key>PATH</key>
    <string>$(service_path | xml_escape)</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <!-- Interactive keeps the agent off the low-priority background scheduler,
       so terminals stay responsive. -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <key>StandardOutPath</key>
  <string>$(printf '%s' "$LOG_DIR/server.out.log" | xml_escape)</string>
  <key>StandardErrorPath</key>
  <string>$(printf '%s' "$LOG_DIR/server.err.log" | xml_escape)</string>
</dict>
</plist>
PLIST_EOF

  warn_port_conflict
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  info "installed $LABEL"
  info "plist      $PLIST"
  info "logs       $LOG_DIR"
  wait_for_health
}

cmd_uninstall() {
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  info "uninstalled $LABEL (logs left in $LOG_DIR)"
  info "tmux sessions were not touched — they outlive the service."
}

cmd_start() {
  require_installed
  check_node_drift
  warn_port_conflict
  loaded || launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart "$TARGET" >/dev/null 2>&1 || true
  info "started $LABEL"
  wait_for_health
}

cmd_stop() {
  require_installed
  # bootout rather than `launchctl stop`: KeepAlive would immediately respawn it.
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  info "stopped $LABEL (tmux sessions keep running)"
}

cmd_restart() {
  require_installed
  check_node_drift
  if loaded; then
    launchctl kickstart -k "$TARGET" >/dev/null
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  info "restarted $LABEL"
  wait_for_health
}

cmd_status() {
  installed || { echo "not installed"; return 1; }
  if loaded; then
    launchctl print "$TARGET" |
      awk '/^\tstate = |^\tpid = |^\tlast exit code = |^\tpath = /{ sub(/^\t/,""); print }'
    echo "url = $(url)"
  else
    echo "installed but not loaded ($PLIST)"
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  tail -n 50 -F "$LOG_DIR/server.out.log" "$LOG_DIR/server.err.log"
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *)
    echo "usage: scripts/macos/service.sh {install|uninstall|start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
