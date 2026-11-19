import fs from 'node:fs'
import path from 'node:path'
import { childEnv, run } from '../exec.js'

/**
 * Orchestrator sessions and commands run inside detached tmux sessions and
 * report through files, never through a pipe to this process.
 *
 * The server restarts on every deploy and on every edit to its own code; a
 * process it spawned directly would die with it. A tmux session does not. So
 * each headless `claude` (and each verify or deploy command) gets its own
 * session named `pm-orch-<runId>-<n>`, writes its output to a file in the
 * run's folder, and leaves its exit code in a file beside it. The engine reads
 * those files, which is all a freshly booted server needs to pick a run up
 * where the last one left it.
 *
 * Rules that keep this safe:
 *  - Only `pm-orch-` sessions are ever killed here. `pm-claude-…` and friends
 *    hold a person's work and are not this module's to touch.
 *  - The size is fixed and generous. A session is never sized from a measured
 *    element (see "Never size a terminal from a hidden element").
 *  - The environment is `childEnv()`, written to a 0600 file the launcher
 *    sources under `env -i` and then deletes. tmux would otherwise hand the
 *    process whatever environment its server was started with.
 */

export const PREFIX = 'pm-orch-'
export const tmuxName = (runId, n) => `${PREFIX}${runId}-${n}`

const COLS = '200'
const ROWS = '50'

/** Single-quote a string for /bin/sh. */
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * Set when this server was itself started from inside a Claude Code session
 * (a dev server in a Claude tab). A nested `claude` must not inherit them.
 */
const NESTED = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'TMUX', 'TMUX_PANE']

const envScript = (env) =>
  Object.entries(env)
    .filter(([k]) => !NESTED.includes(k))
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v != null)
    .map(([k, v]) => `export ${k}=${sq(v)}`)
    .join('\n') + '\n'

/** The flags that make a headless `claude` deny at once instead of prompting. */
export const HEADLESS_FLAGS = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
]

/** The launcher script for one Claude session. Pure, so it can be tested. */
export function claudeLauncher({ dir, n, cwd, command = 'claude', sessionId, resume = false, model, effort, hasSchema, hasSystem }) {
  const f = (ext) => `"$D/${n}.${ext}"`
  const args = [
    ...HEADLESS_FLAGS,
    '--settings', f('settings.json'),
    resume ? '--resume' : '--session-id', sq(sessionId),
  ]
  if (model) args.push('--model', sq(model))
  if (effort) args.push('--effort', sq(effort))
  if (hasSchema) args.push('--json-schema', `"$(cat ${f('schema.json')})"`)
  if (hasSystem) args.push('--append-system-prompt', `"$(cat ${f('system.md')})"`)
  return [
    '#!/bin/sh',
    `D=${sq(dir)}`,
    `. ${f('env')} && rm -f ${f('env')}`,
    `cd ${sq(cwd)} || { echo 97 > ${f('exit')}; exit 0; }`,
    `${command} ${args.join(' ')} < ${f('prompt.md')} > ${f('jsonl')} 2> ${f('err')}`,
    `echo $? > ${f('exit.tmp')} && mv ${f('exit.tmp')} ${f('exit')}`,
    '',
  ].join('\n')
}

export function commandLauncher({ dir, n, cwd, cmd }) {
  const f = (ext) => `"$D/${n}.${ext}"`
  return [
    '#!/bin/sh',
    `D=${sq(dir)}`,
    `. ${f('env')} && rm -f ${f('env')}`,
    `cd ${sq(cwd)} || { echo 97 > ${f('exit')}; exit 0; }`,
    `( ${cmd} ) > ${f('log')} 2>&1 < /dev/null`,
    `echo $? > ${f('exit.tmp')} && mv ${f('exit.tmp')} ${f('exit')}`,
    '',
  ].join('\n')
}

async function launch(name, script) {
  const result = await run('tmux', [
    'new-session', '-d', '-s', name, '-x', COLS, '-y', ROWS,
    `env -i /bin/sh ${sq(script)}`,
  ])
  return result.failed ? { ok: false, error: result.stderr.trim() || 'tmux new-session failed' } : { ok: true }
}

/**
 * Start a headless Claude session. Everything it needs is written into
 * `<runDir>/sessions/` first; the tmux session ends when the process exits.
 */
export async function startSession({
  runDir, runId, n, cwd, prompt, settings, schema = null, system = null,
  sessionId, resume = false, model = null, effort = null, command = 'claude', env = {},
}) {
  const dir = path.join(runDir, 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const w = (ext, content, mode) => fs.writeFileSync(path.join(dir, `${n}.${ext}`), content, mode ? { mode } : undefined)
  w('prompt.md', prompt)
  w('settings.json', JSON.stringify(settings, null, 2))
  if (schema) w('schema.json', JSON.stringify(schema))
  if (system) w('system.md', system)
  w('env', envScript(childEnv({
    ...env, PM_ORCH_RUN: runId, PM_ORCH_SESSION: String(n), PM_PROJECT_DIR: cwd, TERM: 'xterm-256color',
  })), 0o600)
  const script = path.join(dir, `${n}.sh`)
  fs.writeFileSync(script, claudeLauncher({
    dir, n, cwd, command, sessionId, resume, model, effort, hasSchema: Boolean(schema), hasSystem: Boolean(system),
  }), { mode: 0o700 })
  const name = tmuxName(runId, n)
  const started = await launch(name, script)
  return { ...started, tmux: name }
}

/** Start a plain command the same way (verify, deploy, a command stage). */
export async function startJob({ runDir, runId, n, cwd, cmd, env = {} }) {
  const dir = path.join(runDir, 'jobs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${n}.env`), envScript(childEnv({ ...env, PM_ORCH_RUN: runId, PM_PROJECT_DIR: cwd })), { mode: 0o600 })
  const script = path.join(dir, `${n}.sh`)
  fs.writeFileSync(script, commandLauncher({ dir, n, cwd, cmd }), { mode: 0o700 })
  const name = tmuxName(runId, `job-${n}`)
  const started = await launch(name, script)
  return { ...started, tmux: name }
}

/** `=name` is tmux for an exact match; a bare name would match a prefix. */
export async function alive(name) {
  const result = await run('tmux', ['has-session', '-t', `=${name}`])
  return !result.failed
}

/** Kill one of our own sessions. Refuses anything not named `pm-orch-…`. */
export async function kill(name) {
  if (!String(name).startsWith(PREFIX)) return false
  const result = await run('tmux', ['kill-session', '-t', `=${name}`])
  return !result.failed
}

export async function listOurs() {
  const result = await run('tmux', ['list-sessions', '-F', '#{session_name}'])
  if (result.failed) return []
  return result.stdout.split('\n').filter((s) => s.startsWith(PREFIX))
}

/** The exit code a launcher left behind, or null while it is still running. */
export function exitCode(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(n) ? n : 1
  } catch { return null }
}

export const sessionFiles = (runDir, n) => {
  const base = path.join(runDir, 'sessions', String(n))
  return { transcript: `${base}.jsonl`, err: `${base}.err`, exit: `${base}.exit` }
}
export const jobFiles = (runDir, n) => {
  const base = path.join(runDir, 'jobs', String(n))
  return { log: `${base}.log`, exit: `${base}.exit` }
}

export function tail(file, bytes = 4000) {
  try {
    const stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const len = Math.min(bytes, stat.size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, stat.size - len)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

// ------------------------------------------------------------ transcripts

/**
 * What a finished (or cut-off) `--output-format stream-json` transcript says.
 * `denials` is every tool call the permission set refused; `structured` is the
 * `--json-schema` answer. A transcript with no `result` line means the process
 * died mid-turn.
 */
export function parseTranscript(text) {
  const out = {
    sessionId: null, model: null, finished: false, isError: false, subtype: null,
    text: null, structured: null, denials: [], tokens: 0, costUsd: 0, turns: 0, lastActivity: null,
  }
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'system' && e.subtype === 'init') {
      out.sessionId = e.session_id ?? out.sessionId
      out.model = e.model ?? out.model
    } else if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') out.lastActivity = activityOf(c)
        else if (c.type === 'text' && c.text?.trim()) out.lastActivity = c.text.trim().split('\n')[0].slice(0, 160)
      }
    } else if (e.type === 'result') {
      out.finished = true
      out.isError = Boolean(e.is_error)
      out.subtype = e.subtype ?? null
      out.text = typeof e.result === 'string' ? e.result : null
      out.structured = e.structured_output ?? null
      out.sessionId = e.session_id ?? out.sessionId
      out.turns = e.num_turns ?? 0
      out.costUsd = e.total_cost_usd ?? 0
      const u = e.usage ?? {}
      out.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      out.denials = (e.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input ?? {} }))
    }
  }
  return out
}

function activityOf(c) {
  const i = c.input ?? {}
  const hint = i.command ?? i.file_path ?? i.pattern ?? i.skill ?? i.description ?? ''
  return `${c.name}${hint ? `: ${String(hint).split('\n')[0].slice(0, 140)}` : ''}`
}

/** Transcript lines from a byte offset, for the live view. Returns the new offset. */
export function readFrom(file, offset = 0, max = 256 * 1024) {
  try {
    const stat = fs.statSync(file)
    if (offset >= stat.size) return { offset: stat.size, lines: [] }
    const len = Math.min(max, stat.size - offset)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, offset)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    if (cut < 0) return { offset, lines: [] }
    const lines = text.slice(0, cut).split('\n').filter(Boolean)
    return { offset: offset + Buffer.byteLength(text.slice(0, cut + 1)), lines }
  } catch { return { offset, lines: [] } }
}

/** The runner as one object, so the engine can be handed a fake in tests. */
export const tmuxRunner = { startSession, startJob, alive, kill, exitCode, sessionFiles, jobFiles, parseTranscript, tail, listOurs }
