import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from './engine.js'
import { createRunStore } from './runstore.js'
import { APP_DEFAULTS, REPO_DEFAULTS } from './config.js'
import * as R from './runner.js'

/**
 * A runner that starts nothing: a "session" is alive until the test writes its
 * transcript and exit file, exactly the files the real launcher leaves.
 */
function fakeRunner() {
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

function setup({ stages, kinds: extraKinds = {}, limits = {}, deps = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-orch-'))
  const store = createRunStore(path.join(dir, 'runs'))
  const runner = fakeRunner()
  const machine = structuredClone(APP_DEFAULTS)
  machine.limits = { ...machine.limits, ...limits }
  machine.pipelines.t = { stages }
  const impls = {
    pass: { step: async () => ({ done: true }) },
    work: {
      fixable: true,
      owns: (s) => (s.name ? [] : ['branch']),
      step: async (ctx) => {
        const w = await ctx.worker('main', { prompt: 'do the work' })
        if (w.outcome) return w.outcome
        ctx.state.out = w.out
        return { done: true }
      },
    },
    ...extraKinds,
  }
  const kinds = new Map(Object.entries(impls).map(([name, impl]) => [name, { name, impl }]))
  const make = () => createEngine({
    machine, kinds, sources: new Map(), store, runner,
    deps: { loadRepo: (p) => ({ ...structuredClone(REPO_DEFAULTS), name: 'repo', path: p }), ...deps },
  })
  const engine = make()
  const start = () => engine.createRun({ task: { ref: 'T-1', title: 'Test' }, repoPath: '/tmp/repo', pipeline: 't', brief: 'brief' })
  return { engine, store, runner, machine, make, start, dir }
}

const done = (summary = 'ok', extra = {}) => ({ structured: { status: 'done', summary, ...extra } })

test('a run advances through its stages and finishes', async () => {
  const { engine, start } = setup({ stages: [{ kind: 'pass' }, { kind: 'pass' }] })
  const run = start()
  await engine.tick()
  assert.equal(run.state, 'done')
  assert.equal(run.stageIndex, 2)
  assert.deepEqual(run.stages.map((s) => s.id), ['pass', 'pass-2'])
})

test('a worker session runs to done and the stage advances', async () => {
  const { engine, runner, store, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  assert.equal(runner.started.length, 1)
  assert.equal(run.state, 'active')
  assert.match(runner.started[0].settings.permissions.allow.join(' '), /Edit\(\/\/tmp\/repo\/\*\*\)/)
  assert.equal(runner.started[0].settings.permissions.defaultMode, 'dontAsk')

  runner.finish(store.dirOf(run.id), run.id, 1, done('built it', { decisions: [{ what: 'name', chose: 'foo' }] }))
  await engine.tick()
  assert.equal(run.state, 'done')
  assert.equal(run.sessions[0].status, 'finished')
  assert.equal(run.spend.tokens, 100)
  assert.ok(store.events(run.id).some((e) => e.type === 'decision' && e.chose === 'foo'))
})

test('a question ends the session; the answer resumes the same conversation', async () => {
  const { engine, runner, store, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, {
    structured: { status: 'question', summary: 'need a call', question: { text: 'Blue or green?', options: ['blue', 'green'], recommended: 'blue' } },
  })
  await engine.tick()
  assert.equal(run.state, 'waiting')
  const [card] = engine.inbox()
  assert.equal(card.type, 'question')
  assert.equal(card.recommended, 'blue')
  assert.equal(runner.started.length, 1, 'nothing runs while the question is open')

  await engine.answer(run.id, card.id, 'green', 'match the header')
  await engine.tick()
  assert.equal(runner.started.length, 2)
  assert.equal(runner.started[1].resume, true)
  assert.equal(runner.started[1].sessionId, runner.started[0].sessionId)
  assert.match(runner.started[1].prompt, /green[\s\S]*match the header/)

  runner.finish(store.dirOf(run.id), run.id, 2, done())
  await engine.tick()
  assert.equal(run.state, 'done')
})

test('a refused call the worker got past is noted on the run, with no card', async () => {
  const { engine, runner, store, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, { ...done(), denials: [{ tool: 'Bash', input: { command: 'curl example.com' } }] })
  await engine.tick()
  assert.equal(run.state, 'done')
  assert.equal(run.inbox.length, 0)
  assert.deepEqual(run.refused.map((r) => [r.stageId, r.set, r.rule]), [['work', 'work', 'Bash(curl example.com)']])
})

test('a blocked worker waits for the permission card and resumes with the rule allowed', async () => {
  const { engine, runner, store, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, {
    structured: { status: 'blocked', summary: 'stuck', blocked_on: 'need to run the generator' },
    denials: [{ tool: 'Bash', input: { command: 'make gen' } }],
  })
  await engine.tick()
  assert.equal(run.state, 'waiting')
  const [card] = engine.inbox()
  assert.equal(card.blocking, true)
  assert.equal(card.rule, 'Bash(make gen)')

  await engine.answer(run.id, card.id, 'once')
  await engine.tick()
  const resumed = runner.started[1]
  assert.equal(resumed.resume, true)
  assert.ok(resumed.settings.permissions.allow.includes('Bash(make gen)'))
  assert.match(resumed.prompt, /Now permitted: Bash\(make gen\)/)
})

test('"allow always" is handed to the machine config', async () => {
  const saved = []
  const { engine, runner, store, start } = setup({
    stages: [{ kind: 'work' }], deps: { allowAlways: async (set, rule) => saved.push([set, rule]) },
  })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, {
    structured: { status: 'blocked', summary: 's' }, denials: [{ tool: 'Bash', input: { command: 'make gen' } }],
  })
  await engine.tick()
  await engine.answer(run.id, engine.inbox()[0].id, 'always')
  assert.deepEqual(saved, [['work', 'Bash(make gen)']])
})

test('a session that vanished is resumed, not restarted', async () => {
  const { engine, runner, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  runner.vanish(run.id, 1)
  await engine.tick()
  assert.equal(run.sessions[0].status, 'vanished')
  assert.equal(runner.started.length, 2)
  assert.equal(runner.started[1].resume, true)
  assert.equal(runner.started[1].sessionId, runner.started[0].sessionId)
  assert.match(runner.started[1].prompt, /interrupted/)
})

test('a session that keeps dying pauses the run into the inbox', async () => {
  const { engine, runner, start } = setup({ stages: [{ kind: 'work' }], limits: { fixRounds: 1 } })
  const run = start()
  await engine.tick()
  runner.vanish(run.id, 1)
  await engine.tick()
  runner.vanish(run.id, 2)
  await engine.tick()
  assert.equal(run.state, 'waiting')
  assert.equal(engine.inbox()[0].type, 'paused')
})

test('a failed check sends the run back to the worker with the failures, then pauses at the cap', async () => {
  let verdicts = [['lint failed'], ['still failing'], ['again']]
  const { engine, runner, store, start } = setup({
    stages: [{ kind: 'work' }, { kind: 'check' }],
    limits: { fixRounds: 2 },
    kinds: { check: { step: async () => (verdicts.length ? { fail: { reasons: verdicts.shift() } } : { done: true }) } },
  })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, done())
  await engine.tick()
  // check failed → back to work, resuming the worker's conversation
  assert.equal(run.stages[run.stageIndex].id, 'work')
  assert.equal(runner.started.length, 2)
  assert.equal(runner.started[1].resume, true)
  assert.match(runner.started[1].prompt, /lint failed/)

  runner.finish(store.dirOf(run.id), run.id, 2, done())
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 3, done())
  await engine.tick()
  assert.equal(run.state, 'waiting', 'third failure is over the cap of 2')
  const card = engine.inbox().find((c) => c.type === 'paused')
  assert.match(card.body, /again/)

  verdicts = []
  await engine.answer(run.id, card.id, 'retry')
  await engine.tick()
  assert.equal(run.state, 'done')
})

test('the active-session limit queues new work', async () => {
  const { engine, runner, store, start } = setup({ stages: [{ kind: 'work' }], limits: { activeSessions: 1 } })
  const a = start()
  const b = start()
  await engine.tick()
  assert.equal(runner.started.length, 1)
  runner.finish(store.dirOf(a.id), a.id, 1, done())
  await engine.tick()
  await engine.tick()
  assert.equal(runner.started.length, 2)
  assert.equal(runner.started[1].runId, b.id)
})

test('the spend cap pauses before the next session, once', async () => {
  const { engine, runner, store, start } = setup({
    stages: [{ kind: 'work' }, { kind: 'work', name: 'more' }], limits: { spendPerRun: 50 },
  })
  const run = start()
  await engine.tick()
  runner.finish(store.dirOf(run.id), run.id, 1, done())
  await engine.tick()
  assert.equal(run.state, 'waiting')
  assert.equal(run.stages[run.stageIndex].id, 'more', 'the finished session was kept')
  await engine.answer(run.id, engine.inbox()[0].id, 'retry')
  await engine.tick()
  assert.equal(runner.started.length, 2)
})

test('an effect interrupted between intent and result is checked, never blindly repeated', async () => {
  let acts = 0
  let reality = 'unknown'
  const { engine, store, start, make } = setup({
    stages: [{ kind: 'fx' }],
    kinds: {
      fx: {
        step: async (ctx) => {
          const e = await ctx.effect('pr', 'open', {
            describe: 'open the PR',
            check: async () => (reality === 'unknown' ? undefined : reality),
            act: async () => { acts++; return { number: 7 } },
          })
          if (e.outcome) return e.outcome
          ctx.run.pr = e.value
          return { done: true }
        },
      },
    },
  })
  const run = start()
  // Simulate the crash: the intent was written, the result never was.
  store.append(run.id, { type: 'intent', effect: 'pr', key: 'open' })

  await engine.tick()
  assert.equal(run.state, 'waiting')
  assert.equal(engine.inbox()[0].type, 'effect')
  assert.equal(acts, 0)

  // A fresh server, and this time GitHub answers: the PR exists.
  reality = { number: 42 }
  const again = make()
  again.boot()
  const loaded = again.get(run.id)
  loaded.state = 'active'
  loaded.inbox = []
  await again.tick()
  assert.equal(acts, 0, 'the PR was not opened a second time')
  assert.deepEqual(loaded.pr, { number: 42 })
  assert.equal(loaded.state, 'done')
})

test('an effect that did not happen is done; one that did is not repeated', async () => {
  let acts = 0
  const { engine, start } = setup({
    stages: [{ kind: 'fx' }, { kind: 'fx' }],
    kinds: {
      fx: {
        step: async (ctx) => {
          const e = await ctx.effect('push', 'abc123', { check: async () => null, act: async () => { acts++; return 'pushed' } })
          return e.outcome ?? { done: true }
        },
      },
    },
  })
  const run = start()
  await engine.tick()
  assert.equal(run.state, 'done')
  assert.equal(acts, 1, 'the second stage found the result line')
})

test('a restarted server re-adopts a session that is still running', async () => {
  const { engine, runner, store, start, make } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  engine.stop()

  const again = make()
  assert.equal(again.boot(), 1)
  await again.tick()
  assert.equal(runner.started.length, 1, 'no second session')
  runner.finish(store.dirOf(run.id), run.id, 1, done())
  await again.tick()
  assert.equal(again.get(run.id).state, 'done')
})

test('a job runs across ticks and reports its exit code', async () => {
  const seen = []
  const { engine, runner, store, start } = setup({
    stages: [{ kind: 'cmd' }],
    kinds: {
      cmd: {
        step: async (ctx) => {
          const j = await ctx.job('test', { cmd: 'npm test' })
          if (j.state !== 'done') return { wait: true }
          seen.push(j.code)
          return j.code === 0 ? { done: true } : { fail: { reasons: [j.tail] }, to: 'cmd' }
        },
      },
    },
  })
  const run = start()
  await engine.tick()
  assert.equal(runner.jobs.length, 1)
  await engine.tick()
  assert.equal(run.state, 'active')
  runner.finishJob(store.dirOf(run.id), run.id, 1, 0, 'ok')
  await engine.tick()
  assert.deepEqual(seen, [0])
  assert.equal(run.state, 'done')
})

test('pause stops only this run\'s sessions and resume picks the conversation back up', async () => {
  const { engine, runner, start } = setup({ stages: [{ kind: 'work' }] })
  const run = start()
  await engine.tick()
  await engine.control(run.id, 'pause')
  assert.equal(run.state, 'paused')
  assert.equal(runner.live.size, 0)
  assert.equal(run.sessions[0].status, 'stopped')
  await engine.control(run.id, 'resume')
  await engine.tick()
  assert.equal(runner.started[1].resume, true)
})

test('a pipeline that cannot run is refused when the run is created', () => {
  const { start } = setup({ stages: [{ kind: 'nope' }] })
  assert.throws(start, /unknown kind "nope"/)
})

test('tracker writes follow the run, never block it, and are not repeated after a restart', async () => {
  const writes = []
  let fail = false
  let open = true
  const { engine, store, start, make } = setup({
    stages: [{ kind: 'hold' }, { kind: 'pr' }, { kind: 'merge' }],
    kinds: {
      hold: { step: async () => (open ? { done: true } : { wait: true }) },
      pr: { owns: () => ['pr', 'branch'], step: async (ctx) => { ctx.run.pr = { number: 1, url: 'https://x/pr/1' }; return { done: true } } },
      merge: { owns: () => ['ci'], step: async () => ({ done: true }) },
    },
    deps: { sourceWrite: async (run, event) => { if (fail) throw new Error('tracker down'); writes.push(event.type); return ['status'] } },
  })
  const run = start()
  await engine.tick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(writes, ['started', 'pr', 'merged', 'done'])
  assert.equal(run.state, 'done')
  assert.equal(store.effectState(run.id, 'source-write', 'pr').state, 'done')

  // A write that fails is logged and the run carries on.
  fail = true
  const second = start()
  await engine.tick()
  await new Promise((r) => setImmediate(r))
  assert.equal(second.state, 'done')
  assert.ok(store.events(second.id).some((e) => e.type === 'error' && /tracker down/.test(e.message)))

  // An interrupted write is skipped, not sent twice.
  fail = false
  open = false
  const again = make()
  again.boot()
  const third = again.createRun({ task: { ref: 'T-3', title: 'Third' }, repoPath: '/tmp/repo', pipeline: 't', brief: 'b' })
  await again.tick()
  await new Promise((r) => setImmediate(r))
  store.append(third.id, { type: 'intent', effect: 'source-write', key: 'pr' })
  const before = writes.length
  open = true
  await again.tick()
  await new Promise((r) => setImmediate(r))
  assert.ok(!writes.slice(before).includes('pr'), 'the interrupted "pr" write was not repeated')
  assert.ok(store.events(third.id).some((e) => e.type === 'source-write-skipped'))
})
