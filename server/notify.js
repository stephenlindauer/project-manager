import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { config } from './config.js'
import { run } from './exec.js'
import { classify, promptPhase } from './claude-phase.js'

/**
 * What every Claude Code session is up to, as told by its own hooks.
 *
 * `scripts/claude-notify-hook.js` posts each hook event to /api/claude-hook,
 * which lands here as one record per node:
 *
 *   state   working  — mid-turn (UserPromptSubmit / PreToolUse / PostToolUse)
 *           waiting  — blocked on you: a permission prompt, a question
 *           done     — finished the turn and sitting at the prompt
 *   phase   one word for the current stretch of work while `working`
 *           ("editing", "testing", "watching CI", a skill name); see
 *           claude-phase.js. Null in the other states.
 *   detail  one line of specifics for the tooltip: the command or file for
 *           `working`, the prompt text for `waiting`, Claude's closing words
 *           for `done`.
 *   task    the first line of the prompt that started the current turn. Kept
 *           across the turn so a badge can say what all this work is *for*.
 *   seen    you have looked at the pane since the state was entered (or were
 *           looking when it happened). Unseen `waiting`/`done` is what the
 *           sidebar shouts about; seen ones stay as quiet labels.
 *
 * Two things come out of a `waiting`/`done` transition besides the record: a
 * *transient* toast the browser slides in once, and a sound. Both are skipped
 * when you are already watching the pane — you can see Claude asking — but the
 * record is still written, as `seen`, because the badge is a fact about the
 * session and not only a notification. (Before the badges existed the whole
 * signal was dropped, which left the pane you had just been looking at
 * showing nothing at all.)
 *
 * Failure mode this file guards against: a Claude that dies mid-turn (crash,
 * `kill -9`, terminal closed) never sends Stop, so a `working` record would
 * spin forever. Records not refreshed within their lease are swept; the lease
 * is longer for phases that legitimately go quiet (a CI watch, a long test
 * run) because those fire no hooks while they wait.
 */

export const notifications = new EventEmitter()
notifications.setMaxListeners(0)

export const isState = (s) => s === 'working' || s === 'waiting' || s === 'done'

/** nodeId -> status record. One per node, newest wins. */
const status = new Map()

/** What the client sees. `strong`/`phaseAt` are hysteresis bookkeeping, not state. */
export const statusList = () =>
  [...status.values()].map(({ strong: _s, phaseAt: _p, ...rec }) => rec)

const emit = () => notifications.emit('status', statusList())

let toastSeq = 0

/**
 * A weak phase (reading, an unclassified command) may only replace a strong one
 * once the strong one has been quiet this long. A Read in the middle of a
 * series of edits must not flip the badge to "reading" and back.
 */
const WEAK_TAKEOVER_MS = 20_000

/** A quick `done` right after `waiting` is the two hooks racing, not an answer. */
const RACE_MS = 3_000

const firstLine = (s, max = 200) =>
  typeof s === 'string' && s.trim() ? s.trim().split('\n')[0].slice(0, max) : null

function put(nodeId, patch, prev) {
  const rec = { nodeId, phase: null, detail: null, task: null, seen: false, strong: false, ...prev, ...patch }
  status.set(nodeId, rec)
  return rec
}

/**
 * Claude is working on this node. `tool`/`toolHint` come from PreToolUse and
 * PostToolUse; `prompt` from UserPromptSubmit, which also starts a new task.
 *
 * Refreshes are frequent — one per tool call — so only a visible change emits.
 */
export function working(nodeId, { tool = null, toolHint = null, prompt = null } = {}) {
  if (!nodeId) return false
  const prev = status.get(nodeId)
  const now = Date.now()
  const entering = !prev || prev.state !== 'working'

  let next = { state: 'working', at: now }
  if (entering) next.since = now

  if (prompt) {
    const p = promptPhase(prompt)
    next = { ...next, task: firstLine(prompt), phase: p.phase, strong: p.strong, phaseAt: now, detail: null }
  } else {
    const c = classify(tool, toolHint)
    if (c) {
      // Hysteresis: strong phases take over at once, weak ones only once the
      // previous phase has gone quiet (or was weak itself).
      const takeover = entering || c.strong || !prev.strong || prev.phase == null ||
        now - (prev.phaseAt ?? 0) > WEAK_TAKEOVER_MS
      if (takeover) next = { ...next, phase: c.phase, strong: c.strong, phaseAt: now, detail: toolHint }
    }
    if (entering && !c) next = { ...next, phase: 'working', strong: false, phaseAt: now }
  }
  const rec = put(nodeId, { ...next, seen: false }, prev)
  const visible = entering || !prev || prev.phase !== rec.phase || prev.detail !== rec.detail || prev.task !== rec.task
  if (visible) emit()
  return entering
}

/**
 * Claude stopped working: `done` for Stop, `waiting` for a Notification that
 * blocks on you. `watched` means a browser has the pane on screen in a
 * foreground tab, in which case the record is written as already seen and
 * neither toast nor sound fires — you are looking at Claude ask.
 */
export function settle({ nodeId, state, message, detail, watched, quiet = false }) {
  if (!nodeId || (state !== 'waiting' && state !== 'done')) return { delivered: false, reason: 'ignored' }
  const now = Date.now()
  const prev = status.get(nodeId)

  // A `done` landing right after an unanswered `waiting` is the two hooks
  // arriving out of order; the block is still up.
  if (state === 'done' && prev?.state === 'waiting' && now - prev.at < RACE_MS) {
    return { delivered: false, reason: 'race', state: prev.state }
  }

  const entering = !prev || prev.state !== state
  put(nodeId, {
    state, at: now,
    since: entering ? now : prev.since,
    phase: null, strong: false,
    detail: firstLine(detail ?? message, 400),
    seen: Boolean(watched),
  }, prev)
  emit()

  if (watched) return { delivered: false, reason: 'watched', state }
  if (quiet) return { delivered: true, reason: 'quiet', state }
  notifications.emit('toast', {
    id: `${now}-${++toastSeq}`, nodeId, state, message: firstLine(message, 240), at: now,
  })
  play(state)
  return { delivered: true, state }
}

/** You looked at the pane: keep the label, stop shouting. Called on attach and on view. */
export function seen(nodeId) {
  const rec = status.get(nodeId)
  if (!rec || rec.seen) return false
  status.set(nodeId, { ...rec, seen: true })
  emit()
  return true
}

/** The session is gone (SessionEnd, worktree removed): nothing to show. */
export function forget(nodeId) {
  if (!status.delete(nodeId)) return false
  emit()
  return true
}

export function clearAll() {
  if (!status.size) return
  status.clear()
  emit()
}

// ----------------------------------------------------------------- lease

/**
 * How long a `working` record may go without a hook before it is presumed
 * dead. Phases that block on something external fire nothing while they wait,
 * so they get an hour; everything else fifteen minutes — a tool-free turn
 * longer than that is rare enough to accept the false negative.
 */
const LEASE_MS = 15 * 60_000
const LONG_LEASE_MS = 60 * 60_000
const LONG_PHASES = new Set(['watching CI', 'testing', 'building', 'installing', 'delegating'])

function sweepStale() {
  const now = Date.now()
  let dropped = false
  for (const [id, r] of status) {
    if (r.state !== 'working') continue
    const lease = LONG_PHASES.has(r.phase) ? LONG_LEASE_MS : LEASE_MS
    if (now - r.at > lease) { status.delete(id); dropped = true }
  }
  if (dropped) emit()
}
setInterval(sweepStale, 60_000).unref()

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
