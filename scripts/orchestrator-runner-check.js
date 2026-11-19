#!/usr/bin/env node
/**
 * Orchestrator runner check — build step 1, and the first thing to run on any
 * new machine before turning orchestrator mode on.
 *
 *   node scripts/orchestrator-runner-check.js [--cwd <repo>] [--model haiku]
 *
 * It starts real headless `claude` sessions the way the engine does (detached
 * tmux, transcript and exit code in files) and checks everything the design
 * depends on:
 *
 *   1  user settings, skills and MCP servers load in a worker
 *   2  the project's CLAUDE.md loads (it does not in an untrusted directory)
 *   3  the session runs in tmux and leaves a transcript and an exit file
 *   4  a call outside the permission set is denied at once, with no prompt
 *   5  the denial is reported in the transcript
 *   6  the run marker reaches hook processes
 *   7  a question ends the session and the answer resumes it
 *   8  a session whose process was killed can be resumed
 *
 * It costs a few small model calls. Exit code 0 when every check passes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as R from '../server/orchestrator/runner.js'
import { settingsFor, DEFAULT_SETS } from '../server/orchestrator/permissions.js'
import { WORKER_SCHEMA, workerRules } from '../server/orchestrator/engine.js'
import { APP_DEFAULTS } from '../server/orchestrator/config.js'
import { run } from '../server/exec.js'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const cwd = path.resolve(arg('cwd', process.cwd()))
const model = arg('model', 'haiku')
const command = arg('command', 'claude')

const runId = `check${crypto.randomBytes(3).toString('hex')}`
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-orch-check-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

async function wait(n, { timeoutMs = 180_000, until = null } = {}) {
  const files = R.sessionFiles(runDir, n)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (until?.(files)) return { early: true, ms: Date.now() - t0 }
    const code = R.exitCode(files.exit)
    if (code !== null) return { code, ms: Date.now() - t0 }
    await sleep(500)
  }
  return { timedOut: true }
}
const transcript = (n) => { try { return fs.readFileSync(R.sessionFiles(runDir, n).transcript, 'utf8') } catch { return '' } }
const init = (n) => transcript(n).split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
  .find((e) => e?.type === 'system' && e.subtype === 'init')

if ((await run('tmux', ['-V'])).failed) {
  console.error('tmux is not installed; the orchestrator needs it.')
  process.exit(2)
}

console.log(`runner check in ${cwd} (model ${model})\n`)

// ---- session 1: settings, CLAUDE.md, denial, hook marker, question ----
const marker = path.join(runDir, 'hook-marker')
const denied = path.join(runDir, 'should-not-exist')
// The first `## ` heading: specific to this file, short enough to quote exactly.
const claudeMd = (() => {
  try { return fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8').split('\n').find((l) => l.startsWith('## '))?.slice(3).trim() ?? null } catch { return null }
})()
const system = workerRules(APP_DEFAULTS)
const settings = settingsFor(DEFAULT_SETS, 'read')
settings.hooks = {
  PreToolUse: [{ hooks: [{ type: 'command', command: `sh -c 'echo "$PM_ORCH_RUN:$PM_ORCH_SESSION" > ${R.sq(marker)}'` }] }],
}
const sid = crypto.randomUUID()
const s1 = await R.startSession({
  runDir, runId, n: 1, cwd, sessionId: sid, model, command, settings, schema: WORKER_SCHEMA, system,
  prompt: [
    'This is an automated check. Do these in order and continue after any refusal:',
    '1. Without using a tool: is a project CLAUDE.md (not the global one) in your context? Note the text of its first "## " heading, or NONE.',
    `2. Run this shell command: touch ${denied}`,
    '   It will be refused. That is expected and is not a blocker; do not report it as one.',
    '3. Run this shell command: git status --short',
    'Then finish with status "question" (not "blocked"). Put the heading text (or NONE) in `summary`, and in `question` ask "Proceed with A or B?" with options A and B, recommending A.',
  ].join('\n'),
})
check('3  starts in a detached tmux session', s1.ok && await R.alive(s1.tmux), s1.error)
const r1 = await wait(1)
const t1 = R.parseTranscript(transcript(1))
check('3  leaves a transcript and an exit file', r1.code === 0 && t1.finished, r1.timedOut ? 'timed out' : `exit ${r1.code}`)
check('3  the tmux session ends with the process', !(await R.alive(s1.tmux)))

const i1 = init(1)
const mcp = (i1?.mcp_servers ?? []).filter((m) => m.status === 'connected').map((m) => m.name)
check('1  user settings, skills and MCP servers load', Boolean(i1) && (i1.skills?.length ?? 0) > 0,
  `${i1?.skills?.length ?? 0} skills, ${mcp.length} MCP servers connected${mcp.length ? ` (${mcp.join(', ')})` : ''}, mode ${i1?.permissionMode}`)
if (claudeMd) {
  check('2  the project CLAUDE.md loads', (t1.structured?.summary ?? '').toLowerCase().includes(claudeMd.toLowerCase()),
    `expected "${claudeMd.slice(0, 60)}", worker reported "${(t1.structured?.summary ?? '').slice(0, 80)}". ` +
    'If it says NONE, Claude Code does not trust this directory: open `claude` there once interactively.')
} else {
  console.log(' --   2  no CLAUDE.md with a "## " heading in this directory; skipped')
}
check('4  an unlisted call is denied at once, without a prompt', !fs.existsSync(denied) && r1.ms < 120_000, `${Math.round((r1.ms ?? 0) / 1000)}s`)
check('5  the denial is reported in the transcript', t1.denials.some((d) => d.tool === 'Bash' && String(d.input.command).includes('touch')),
  JSON.stringify(t1.denials).slice(0, 160))
const mark = (() => { try { return fs.readFileSync(marker, 'utf8').trim() } catch { return null } })()
check('6  the run marker reaches hook processes', mark === `${runId}:1`, `hook saw "${mark}"`)
check('7  a question comes back as structured output', t1.structured?.status === 'question' && t1.structured.question?.options?.length === 2,
  JSON.stringify(t1.structured?.question ?? null))

// ---- session 2: resume with the answer ----
await R.startSession({
  runDir, runId, n: 2, cwd, sessionId: sid, resume: true, model, command, settings, schema: WORKER_SCHEMA,
  prompt: 'Answer to your question: B.\n\nDo nothing else. Finish with status "done" and a summary that says which option was chosen.',
})
const r2 = await wait(2)
const t2 = R.parseTranscript(transcript(2))
check('7  the answer resumes the same conversation', r2.code === 0 && t2.sessionId === sid && t2.structured?.status === 'done' && /\bB\b/.test(t2.structured.summary ?? ''),
  `session ${t2.sessionId === sid ? 'kept' : 'CHANGED'}; summary "${(t2.structured?.summary ?? '').slice(0, 80)}"`)

// ---- sessions 3 and 4: kill mid-turn, resume ----
const sid2 = crypto.randomUUID()
const code = String(crypto.randomInt(10000, 99999))
const sleepSettings = settingsFor(DEFAULT_SETS, 'read', { extraAllow: ['Bash(sleep:*)'] })
const s3 = await R.startSession({
  runDir, runId, n: 3, cwd, sessionId: sid2, model, command, settings: sleepSettings, schema: WORKER_SCHEMA,
  prompt: `Keep the number ${code} in mind; do not store it anywhere. Then run this shell command in the foreground: sleep 90`,
})
await wait(3, { timeoutMs: 90_000, until: () => transcript(3).includes('sleep 90') })
await sleep(2000)
await R.kill(s3.tmux)
await sleep(500)
check('8  killing the tmux session leaves no exit file', R.exitCode(R.sessionFiles(runDir, 3).exit) === null && !(await R.alive(s3.tmux)))
await R.startSession({
  runDir, runId, n: 4, cwd, sessionId: sid2, resume: true, model, command, settings, schema: WORKER_SCHEMA,
  prompt: 'Your process was interrupted. Run nothing. Finish with status "done" and put the number I gave you in `summary`.',
})
const r4 = await wait(4)
const t4 = R.parseTranscript(transcript(4))
check('8  a killed session resumes with its context', r4.code === 0 && t4.sessionId === sid2 && (t4.structured?.summary ?? '').includes(code),
  `summary "${(t4.structured?.summary ?? '').slice(0, 80)}"`)

// ---- second model ----
const codex = await run('sh', ['-lc', 'command -v codex'])
if (codex.failed) console.log(' --   second model: `codex` is not installed on this machine; its headless mode is unchecked')
else console.log(` --   second model: codex found at ${codex.stdout.trim()}; its headless check lands with the review stage`)

for (const name of await R.listOurs()) if (name.startsWith(`${R.PREFIX}${runId}-`)) await R.kill(name)
const failed = results.filter((r) => !r.ok)
const tokens = [t1, t2, t4].reduce((a, t) => a + t.tokens, 0)
console.log(`\n${results.length - failed.length}/${results.length} passed · ${tokens.toLocaleString()} tokens · files in ${runDir}`)
process.exit(failed.length ? 1 : 0)
