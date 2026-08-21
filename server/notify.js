import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { config } from './config.js'
import { run } from './exec.js'

/**
 * Attention signals raised by Claude Code's own hooks.
 *
 * A `Stop` hook fires when Claude finishes a turn and a `Notification` hook
 * fires when it is blocked waiting on you (a permission prompt, or an idle
 * prompt). `scripts/claude-notify-hook.js` posts both to /api/claude-hook,
 * which lands here.
 *
 * Two things come out of one signal: a *sticky* per-node state the sidebar
 * renders until you actually look at the session, and a *transient* toast the
 * browser slides in once. They are separate on purpose — a toast you missed
 * while making coffee must not be the only trace that Claude wants you.
 */

export const notifications = new EventEmitter()
notifications.setMaxListeners(0)

/** `waiting` outranks `done`: being blocked on you is the louder of the two. */
const RANK = { done: 1, waiting: 2 }
export const isState = (s) => s === 'waiting' || s === 'done'

/** nodeId -> { nodeId, state, message, at }. One entry per node, newest wins. */
const attention = new Map()

export const attentionList = () => [...attention.values()]

let toastSeq = 0

/**
 * Record a signal for a node.
 *
 * `watched` means a browser is looking at that node's Claude pane right now, in
 * a foreground tab. Then there is nothing to notify about — the user can see
 * Claude asking — so the signal is dropped entirely rather than merely muted.
 * Without this, every turn Claude finishes while you watch it work would ping.
 */
export function raise({ nodeId, state, message, watched }) {
  if (!nodeId || !isState(state)) return { delivered: false, reason: 'ignored' }
  if (watched) return { delivered: false, reason: 'watched' }

  const at = Date.now()
  const prev = attention.get(nodeId)
  // A later `done` must not quietly downgrade an unanswered `waiting`.
  const kept = prev && RANK[prev.state] > RANK[state] ? prev.state : state

  attention.set(nodeId, { nodeId, state: kept, message: message || null, at })
  notifications.emit('attention', attentionList())
  notifications.emit('toast', {
    id: `${at}-${++toastSeq}`, nodeId, state, message: message || null, at,
  })
  play(state)
  return { delivered: true, state: kept }
}

/** Drop a node's signal — called when a viewer actually attaches to its session. */
export function clear(nodeId) {
  if (!attention.delete(nodeId)) return false
  notifications.emit('attention', attentionList())
  return true
}

export function clearAll() {
  if (!attention.size) return
  attention.clear()
  notifications.emit('attention', attentionList())
}

// ------------------------------------------------------------------- sound

/**
 * A short macOS system sound, played on the machine running the server.
 *
 * `afplay` is fire-and-forget: a failure (no such sound, no audio device, not
 * macOS) is swallowed, because a notification that throws is worse than a
 * notification you cannot hear. The gap keeps a burst of signals — several
 * projects finishing at once — from stacking into a rattle.
 */
const MIN_GAP_MS = 1500
let lastPlayed = 0

function play(state) {
  if (!config.notify.sound) return
  if (os.platform() !== 'darwin') return
  const now = Date.now()
  if (now - lastPlayed < MIN_GAP_MS) return
  lastPlayed = now

  const name = config.notify.sounds[state]
  if (!name) return
  run('afplay', ['-v', String(config.notify.volume), `/System/Library/Sounds/${name}.aiff`])
    .catch(() => {})
}

// ------------------------------------------------------------------- token

/**
 * The hook runs as a detached local process with no session cookie, so
 * /api/claude-hook cannot sit behind `requireAuth`. It is gated on a shared
 * secret in a 0600 file instead (plus a loopback check in index.js). The token
 * is generated on first boot; the hook script reads the same file.
 */
let token = null

export function loadHookToken() {
  const file = config.notify.tokenFile
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) {
      // Repair permissions in case the file predates the 0600 write below.
      try { fs.chmodSync(file, 0o600) } catch { /* not ours to fix */ }
      token = existing
      return token
    }
  } catch { /* missing or unreadable — generate a fresh one */ }

  token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

export const hookToken = () => token
