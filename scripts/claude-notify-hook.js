#!/usr/bin/env node
/**
 * Claude Code Stop / Notification hook → Project Manager.
 *
 * Claude Code pipes the hook payload in on stdin; we forward the bits that
 * identify the session to the local API, which turns it into a sidebar
 * indicator, a toast, and a sound. Installed into ~/.claude/settings.json by
 * `npm run install-hooks`.
 *
 * Rules of engagement, all of them the same rule: never get in the user's way.
 * The hook is configured `async`, so Claude does not wait on it, and *every*
 * failure path here exits 0 with no output. A missing server, a stale token, no
 * network — none of that is a reason to put an error in someone's session.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 2000

const quit = () => process.exit(0)

/** Port and scheme have to match the server's own config resolution. */
function endpoint() {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(path.join(root, 'pm.config.json'), 'utf8'))
  } catch { /* defaults below */ }
  const port = process.env.PM_PORT || file.port || 5274
  const tls = process.env.PM_HTTPS ?? file.https?.enabled
  const scheme = tls && !['0', 'false', 'no', ''].includes(String(tls).toLowerCase())
    ? 'https' : 'http'
  return { url: `${scheme}://127.0.0.1:${port}/api/claude-hook`, tokenFile: file.notify?.tokenFile }
}

function readToken(configured) {
  const file = process.env.PM_HOOK_TOKEN_FILE || configured || path.join(root, '.pm-hook-token')
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return null }
}

/**
 * The tmux session name, when this Claude is running inside one of the app's
 * panes — `pm-claude-<nodeId>` names the node outright, which beats matching on
 * cwd if the shell has wandered into a subdirectory.
 */
function tmuxSession() {
  if (!process.env.TMUX) return null
  try {
    const args = ['display-message', '-p']
    if (process.env.TMUX_PANE) args.push('-t', process.env.TMUX_PANE)
    args.push('#{session_name}')
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 1000 }).trim() || null
  } catch { return null }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let payload = {}
  try { payload = JSON.parse(raw) } catch { /* fall through with cwd only */ }

  const { url, tokenFile } = endpoint()
  const token = readToken(tokenFile)
  if (!token) quit() // server has never booted, so there is nothing to notify

  const body = JSON.stringify({
    event: payload.hook_event_name ?? 'Stop',
    cwd: payload.cwd || process.cwd(),
    session: tmuxSession(),
    message: payload.message ?? null,
  })

  // Self-signed certs are the norm for the https option here, and this request
  // never leaves loopback. Node prints a security warning for the opt-out;
  // dropping the default warning handler keeps this hook's stderr empty, which
  // is the one thing it must be — anything written here can end up in front of
  // the user mid-session.
  if (url.startsWith('https:')) {
    process.removeAllListeners('warning')
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pm-hook-token': token },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {})
}

main().then(quit, quit)
