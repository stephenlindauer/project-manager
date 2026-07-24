import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import pty from 'node-pty'

const LOG_BYTES = 256 * 1024
const SHELL = process.env.SHELL || '/bin/zsh'

/**
 * Long-running dev processes (dev servers, watchers, test runners) started from
 * the Tasks tab. Each runs in its own pty so colour output survives, and its log
 * is buffered for replay when you switch back to the tab.
 */
class Runner extends EventEmitter {
  constructor({ key, nodeId, cwd, name, command }) {
    super()
    this.setMaxListeners(0)
    Object.assign(this, { key, nodeId, cwd, name, command })
    this.log = ''
    this.proc = null
    this.startedAt = null
    this.exitCode = null
    this.ports = new Set()
  }

  get running() { return Boolean(this.proc) }

  append(data) {
    this.log = (this.log + data).slice(-LOG_BYTES)
    for (const m of data.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g)) {
      this.ports.add(Number(m[1]))
    }
    this.emit('data', data)
  }

  start() {
    if (this.proc) return
    this.log = ''
    this.ports.clear()
    this.exitCode = null
    this.startedAt = Date.now()
    try {
      this.proc = pty.spawn(SHELL, ['-lic', this.command], {
        name: 'xterm-256color',
        cols: 160,
        rows: 40,
        cwd: this.cwd,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      })
    } catch (err) {
      // Reported into the log rather than thrown; this runs inside a request
      // handler where an uncaught throw would kill the server.
      this.append(`\r\n\x1b[31mFailed to start: ${err?.message ?? err}\x1b[0m\r\n`)
      this.exitCode = -1
      this.emit('state', this.summary())
      return
    }
    this.proc.onData((d) => this.append(d))
    this.proc.onExit(({ exitCode }) => {
      this.proc = null
      this.exitCode = exitCode
      this.emit('state', this.summary())
    })
    this.emit('state', this.summary())
  }

  stop() {
    if (!this.proc) return
    // SIGINT first so dev servers get to clean up their ports and child procs.
    try { this.proc.kill('SIGINT') } catch { /* already gone */ }
    const proc = this.proc
    setTimeout(() => { try { proc?.kill('SIGKILL') } catch { /* gone */ } }, 3000)
  }

  summary() {
    return {
      key: this.key, nodeId: this.nodeId, name: this.name, command: this.command,
      running: this.running, startedAt: this.startedAt, exitCode: this.exitCode,
      ports: [...this.ports],
    }
  }
}

const runners = new Map()

export function getRunner({ nodeId, cwd, name, command }) {
  const key = `${nodeId}:${name}`
  let r = runners.get(key)
  if (!r) {
    r = new Runner({ key, nodeId, cwd, name, command })
    runners.set(key, r)
  }
  r.command = command || r.command
  r.cwd = cwd || r.cwd
  return r
}

export const runnersFor = (nodeId) =>
  [...runners.values()].filter((r) => r.nodeId === nodeId).map((r) => r.summary())

export const allRunners = () => [...runners.values()].map((r) => r.summary())

export function stopNode(nodeId) {
  for (const r of runners.values()) if (r.nodeId === nodeId) r.stop()
}

/** Scripts we offer to run, discovered from the project's own manifest. */
export async function discoverScripts(cwd) {
  const out = []
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'))
    const pm = await detectPackageManager(cwd)
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      out.push({ name, script, command: `${pm} run ${name}`, source: 'package.json' })
    }
  } catch { /* not a node project */ }

  const others = [
    ['Cargo.toml', [['run', 'cargo run'], ['test', 'cargo test']]],
    ['go.mod', [['run', 'go run ./...'], ['test', 'go test ./...']]],
    ['Makefile', [['make', 'make']]],
  ]
  for (const [marker, cmds] of others) {
    try {
      await fs.access(path.join(cwd, marker))
      for (const [name, command] of cmds) out.push({ name, command, source: marker })
    } catch { /* marker absent */ }
  }
  return out
}

async function detectPackageManager(cwd) {
  const checks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun']]
  for (const [file, pm] of checks) {
    try { await fs.access(path.join(cwd, file)); return pm } catch { /* next */ }
  }
  return 'npm'
}

export { runners }
