import { EventEmitter } from 'node:events'
import os from 'node:os'
import pty from 'node-pty'
import { run } from './exec.js'
import { config } from './config.js'

const SCROLLBACK_BYTES = 512 * 1024
const SHELL = process.env.SHELL || '/bin/zsh'

/** Smallest size we treat as a genuine measurement rather than an unlaid-out pane. */
const MIN_COLS = 40
const MIN_ROWS = 10

/**
 * Terminal sessions have two interchangeable backends:
 *
 *  - `tmux` (preferred): the shell lives in a detached tmux session, so it
 *    survives server restarts and browser reloads, and can be attached from a
 *    real terminal with `tmux attach -t <name>`.
 *  - `pty` (fallback): a plain node-pty process owned by this server. Survives
 *    reloads but not restarts.
 *
 * Detection runs once at boot; `tmuxAvailable` is reported to the UI so it can
 * tell the user what they're getting.
 */
let tmuxAvailable = false

export async function detectTmux() {
  const { failed } = await run('tmux', ['-V'])
  tmuxAvailable = !failed
  return tmuxAvailable
}

export const backend = () => (tmuxAvailable ? 'tmux' : 'pty')

const sessionName = (nodeId, kind) => `pm-${kind}-${nodeId}`

class Session extends EventEmitter {
  constructor({ key, nodeId, kind, cwd }) {
    super()
    this.setMaxListeners(0)
    this.key = key
    this.nodeId = nodeId
    this.kind = kind
    this.cwd = cwd
    this.buffer = ''
    this.clients = 0
    // Clients with this pane actually on screen in a foreground browser tab.
    // `clients` cannot stand in for it: a terminal stays connected while its tab
    // is hidden, so it would report "being watched" for a pane nobody can see.
    this.viewers = 0
    this.lastActivity = Date.now()
    this.unread = false
    this.proc = null
    this.cols = 120
    this.rows = 32
  }

  append(data) {
    // Only the raw-pty backend needs a replay buffer. tmux repaints the whole
    // screen itself on attach, and replaying our copy on top of that repaint
    // corrupts full-screen TUIs: the stored bytes were drawn at whatever width
    // the old client had, so the frames overlap and box-drawing tears.
    if (!tmuxAvailable) {
      this.buffer += data
      if (this.buffer.length > SCROLLBACK_BYTES) {
        this.buffer = this.buffer.slice(-SCROLLBACK_BYTES)
      }
    }
    this.lastActivity = Date.now()
    if (this.clients === 0) this.unread = true
    this.emit('data', data)
  }

  /**
   * Create the detached tmux session if it doesn't exist and configure it for
   * embedding: no status bar (the app already shows the project and branch),
   * mouse scrolling, and window sizing driven by the attached client.
   *
   * `new-session -d -A` is idempotent — it attaches semantics without creating a
   * duplicate — and the launch command is only used when the session is new.
   */
  async ensureTmuxSession() {
    const name = sessionName(this.nodeId, this.kind)
    const launch = this.kind === 'claude' ? [config.claudeCommand] : []
    // Create at the client's real size: a session born at tmux's 80x24 default
    // paints its first frame at the wrong width before the resize lands.
    await run('tmux', [
      'new-session', '-d', '-A', '-s', name, '-c', this.cwd,
      '-x', String(this.cols), '-y', String(this.rows),
      ...launch,
    ])
    await Promise.all([
      run('tmux', ['set-option', '-t', name, 'status', 'off']),
      run('tmux', ['set-option', '-t', name, 'mouse', 'on']),
      run('tmux', ['set-option', '-t', name, 'history-limit', '50000']),
      run('tmux', ['set-window-option', '-t', name, 'aggressive-resize', 'on']),
      // Makes a mouse selection reachable from the browser. With `mouse on`,
      // tmux owns the drag and paints its own highlight, so xterm never creates
      // a browser selection — the text goes to tmux's paste buffer, which the
      // browser cannot read. `set-clipboard on` (the default is `external`,
      // which only forwards what *applications* send) makes tmux emit its own
      // copies as OSC 52, and Terminal.tsx writes those to the system clipboard.
      //
      // `-s`: set-clipboard is a server option with no session scope, so unlike
      // the options above this applies to every session on the tmux server,
      // including ones attached from a real terminal. OSC 52 is what those
      // terminals already expect, so the effect there is the same feature.
      run('tmux', ['set-option', '-s', 'set-clipboard', 'on']),
    ])
    return name
  }

  /**
   * Start (or re-attach to) the backing process. Spawn failures are reported
   * into the terminal rather than thrown: this runs inside a WebSocket event
   * handler, where an uncaught throw would take down the whole server.
   */
  async spawn() {
    if (this.proc) return this.proc
    const env = { ...process.env, TERM: 'xterm-256color', PM_PROJECT_DIR: this.cwd }
    const opts = {
      name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
    }

    try {
      if (tmuxAvailable) {
        const name = await this.ensureTmuxSession()
        // `-d` detaches every other client as we attach. Exactly one client per
        // session is essential: tmux sizes a window to its SMALLEST attached
        // client, so a second (or orphaned) client at a different size clamps
        // the window and the mismatched columns thrash on redraw — the "garbled
        // scrolling" and doubled-echo symptoms. It also reaps attach processes
        // orphaned by a previous server instance (node --watch restarts).
        this.proc = pty.spawn('tmux', ['-u', 'attach-session', '-d', '-t', name], opts)
      } else {
        const args = this.kind === 'claude' ? ['-lic', config.claudeCommand] : ['-l']
        this.proc = pty.spawn(SHELL, args, opts)
      }
    } catch (err) {
      const hint = String(err?.message ?? err).includes('posix_spawnp')
        ? '\r\n\x1b[90mIf this persists, run: npm run postinstall\x1b[0m'
        : ''
      this.append(`\r\n\x1b[31mFailed to start session: ${err?.message ?? err}\x1b[0m${hint}\r\n`)
      this.emit('exit')
      return null
    }

    this.proc.onData((d) => this.append(d))
    this.proc.onExit(() => {
      this.proc = null
      this.emit('exit')
    })
    return this.proc
  }

  write(data) {
    this.proc?.write(data)
  }

  /**
   * Apply a client-reported size. Degenerate values are ignored rather than
   * clamped: a hidden pane measures as zero, and silently rounding that up to a
   * tiny size once created 20-column tmux sessions whose output stayed mangled
   * in the scrollback forever.
   */
  resize(cols, rows) {
    const c = Math.trunc(Number(cols))
    const r = Math.trunc(Number(rows))
    if (!Number.isFinite(c) || !Number.isFinite(r) || c < MIN_COLS || r < MIN_ROWS) return false
    this.cols = c
    this.rows = r
    try { this.proc?.resize(c, r) } catch { /* process already gone */ }
    return true
  }

  async attach() {
    this.clients++
    this.unread = false
    await this.spawn()
  }

  detach() {
    this.clients = Math.max(0, this.clients - 1)
    // Under tmux the shell lives in the server, so dropping our attach client
    // costs nothing and stops a dead pty from holding the session's size hostage.
    if (this.clients === 0 && tmuxAvailable && this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  /** Fully terminate, including the backing tmux session. */
  async destroy() {
    try { this.proc?.kill() } catch { /* already dead */ }
    this.proc = null
    if (tmuxAvailable) {
      await run('tmux', ['kill-session', '-t', sessionName(this.nodeId, this.kind)])
    }
  }
}

const sessions = new Map()

export function getSession(nodeId, kind, cwd) {
  const key = `${nodeId}:${kind}`
  let s = sessions.get(key)
  if (!s) {
    s = new Session({ key, nodeId, kind, cwd })
    sessions.set(key, s)
  }
  s.cwd = cwd || s.cwd
  return s
}

/**
 * Kill this server's attach processes without destroying the tmux sessions
 * behind them. Called on exit so a `node --watch` restart doesn't leave orphaned
 * `tmux attach-session` clients hanging off the sessions.
 */
export function detachAll() {
  for (const s of sessions.values()) {
    try { s.proc?.kill() } catch { /* already gone */ }
    s.proc = null
    s.clients = 0
    s.viewers = 0
  }
}

export function sessionSummaries() {
  return [...sessions.values()].map((s) => ({
    key: s.key, nodeId: s.nodeId, kind: s.kind,
    alive: Boolean(s.proc), clients: s.clients,
    unread: s.unread, lastActivity: s.lastActivity,
  }))
}

/** True if someone has this session's pane on screen right now. */
export function isWatched(nodeId, kind) {
  return (sessions.get(`${nodeId}:${kind}`)?.viewers ?? 0) > 0
}

export async function killSession(nodeId, kind) {
  const key = `${nodeId}:${kind}`
  const s = sessions.get(key)
  if (!s) return false
  await s.destroy()
  sessions.delete(key)
  return true
}

/** Kill every session belonging to a node — used when removing a worktree. */
export async function killNode(nodeId) {
  for (const [key, s] of [...sessions]) {
    if (s.nodeId !== nodeId) continue
    await s.destroy()
    sessions.delete(key)
  }
}

export const platformShell = () => ({ shell: SHELL, home: os.homedir() })
