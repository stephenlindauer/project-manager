#!/usr/bin/env node
/**
 * Claude Code hook → Project Manager.
 *
 * Claude Code pipes the hook payload in on stdin; we forward the event name,
 * the bits that identify the session, and a trimmed slice of what Claude is
 * doing to the local API. Stop and Notification become a sidebar badge, a
 * toast, and a sound; UserPromptSubmit, PreToolUse and PostToolUse drive the
 * live "working · <phase>" badge; SessionEnd retires it. Installed into
 * ~/.claude/settings.json by `npm run install-hooks`.
 *
 * Rules of engagement, all of them the same rule: never get in the user's way.
 * The hook is configured `async`, so Claude does not wait on it, and *every*
 * failure path here exits 0 with no output. A missing server, a stale token, no
 * network — none of that is a reason to put an error in someone's session.
 *
 * Debugging: if `.pm-hook-dump.jsonl` exists in the repo root, every raw payload
 * is appended to it (gitignored). Delete the file to stop. This is the only way
 * to see what a given Claude Code version actually sends.
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

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * The part of `tool_input` that says what the tool is *for*, per tool. Whole
 * inputs can be large (a Write carries the file), and the server only needs a
 * one-line hint to classify the phase and label the badge.
 */
function toolHint(name, input) {
  if (!input || typeof input !== 'object') return null
  switch (name) {
    case 'Bash': return str(input.command, 200)
    case 'Skill': return str(input.skill, 80)
    case 'Agent': case 'Task': return str(input.description, 120) ?? str(input.subagent_type, 80)
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': case 'Read':
      return str(input.file_path ?? input.notebook_path, 200)
    case 'Grep': return str(input.pattern, 120)
    case 'Glob': return str(input.pattern, 120)
    case 'WebFetch': return str(input.url, 200)
    case 'WebSearch': return str(input.query, 120)
    default: return null
  }
}

function dump(raw) {
  const file = path.join(root, '.pm-hook-dump.jsonl')
  try {
    if (!fs.existsSync(file)) return
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), raw })}\n`)
  } catch { /* debugging aid only */ }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  dump(raw)

  let payload = {}
  try { payload = JSON.parse(raw) } catch { /* fall through with cwd only */ }

  const { url, tokenFile } = endpoint()
  const token = readToken(tokenFile)
  if (!token) quit() // server has never booted, so there is nothing to notify

  const body = JSON.stringify({
    event: payload.hook_event_name ?? 'Stop',
    cwd: payload.cwd || process.cwd(),
    session: tmuxSession(),
    sessionId: str(payload.session_id, 80),
    message: str(payload.message, 240),
    // Notification: what kind of prompt is up (permission_prompt, idle_prompt…).
    notificationType: str(payload.notification_type, 60),
    // PreToolUse / PostToolUse: what is being run, trimmed to a hint.
    tool: str(payload.tool_name, 80),
    toolHint: toolHint(payload.tool_name, payload.tool_input),
    // UserPromptSubmit: what you asked for. Field name has moved between
    // versions, so accept both.
    prompt: str(payload.text ?? payload.prompt, 200),
    // Stop: Claude's closing words, for the "ready" badge's tooltip.
    lastMessage: str(payload.last_assistant_message, 400),
    transcriptPath: str(payload.transcript_path, 400),
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
