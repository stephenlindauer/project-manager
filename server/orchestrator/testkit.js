import fs from 'node:fs'
import path from 'node:path'
import * as R from './runner.js'

/**
 * A runner that starts nothing: a "session" is alive until the test writes its
 * transcript and exit file, exactly the files the real launcher leaves.
 */
export function fakeRunner() {
  const live = new Set()
  const started = []
  const jobs = []
  return {
    live, started, jobs,
    async startSession(opts) {
      const tmux = R.tmuxName(opts.runId, opts.n)
      live.add(tmux)
      started.push({ ...opts, tmux })
      return { ok: true, tmux }
    },
    async startJob(opts) {
      const tmux = R.tmuxName(opts.runId, `job-${opts.n}`)
      live.add(tmux)
      jobs.push({ ...opts, tmux })
      return { ok: true, tmux }
    },
    alive: async (name) => live.has(name),
    kill: async (name) => live.delete(name),
    exitCode: R.exitCode, sessionFiles: R.sessionFiles, jobFiles: R.jobFiles,
    parseTranscript: R.parseTranscript, tail: R.tail,
    /** Finish session n of a run the way a real `claude -p` would. */
    finish(runDir, runId, n, { structured, denials = [], error = false, tokens = 100 } = {}) {
      const f = R.sessionFiles(runDir, n)
      fs.mkdirSync(path.dirname(f.transcript), { recursive: true })
      const lines = [
        { type: 'system', subtype: 'init', session_id: `sid-${n}`, model: 'test' },
        {
          type: 'result', subtype: error ? 'error' : 'success', is_error: error, session_id: `sid-${n}`,
          result: JSON.stringify(structured ?? {}), structured_output: structured ?? null,
          usage: { input_tokens: tokens, output_tokens: 0 }, total_cost_usd: 0.01,
          permission_denials: denials.map((d) => ({ tool_name: d.tool, tool_input: d.input })),
        },
      ]
      fs.writeFileSync(f.transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      fs.writeFileSync(f.exit, error ? '1\n' : '0\n')
      live.delete(R.tmuxName(runId, n))
    },
    vanish(runId, n) { live.delete(R.tmuxName(runId, n)) },
    finishJob(runDir, runId, n, code, logText = '') {
      const f = R.jobFiles(runDir, n)
      fs.mkdirSync(path.dirname(f.log), { recursive: true })
      fs.writeFileSync(f.log, logText)
      fs.writeFileSync(f.exit, `${code}\n`)
      live.delete(R.tmuxName(runId, `job-${n}`))
    },
  }
}
