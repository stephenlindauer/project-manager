import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from './engine.js'
import { createRunStore } from './runstore.js'
import { APP_DEFAULTS, REPO_DEFAULTS, discover } from './config.js'
import { check } from './schema.js'
import { lastJson } from './stages/record.js'
import { merge } from './stages/review.js'
import { fakeRunner } from './testkit.js'

/** The real stage kinds, driven by a runner that starts nothing. */
async function setup({ stages, machine: extra = {}, overrides = {}, extraKinds = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-orch-st-'))
  const store = createRunStore(path.join(dir, 'runs'))
  const runner = fakeRunner()
  const machine = { ...structuredClone(APP_DEFAULTS), dir, ...extra }
  machine.pipelines.t = { stages }
  const kinds = await discover('stages', dir)
  kinds.set('start', { name: 'start', impl: { owns: (st) => (st.name ? [] : ['branch']), step: async () => ({ done: true }) } })
  for (const [name, impl] of Object.entries(extraKinds)) kinds.set(name, { name, impl })
  const checks = await discover('checks', dir)
  const engine = createEngine({
    machine, kinds, checks, sources: new Map(), store, runner,
    deps: { loadRepo: (p) => ({ ...structuredClone(REPO_DEFAULTS), name: 'repo', path: p }) },
  })
  const run = engine.createRun({ task: { ref: 'T-1', title: 'Fix it' }, repoPath: dir, pipeline: 't', brief: 'the brief', overrides })
  const runDir = store.dirOf(run.id)
  const finish = (n, structured, extra2 = {}) => runner.finish(runDir, run.id, n, { structured: { status: 'done', summary: 'ok', ...structured }, ...extra2 })
  return { engine, store, runner, machine, run, runDir, dir, finish }
}

const SCHEMA = {
  type: 'object', required: ['problem', 'fix_kind', 'causes'],
  properties: {
    problem: { type: 'string', minLength: 5 },
    fix_kind: { enum: ['root-cause', 'symptom'] },
    causes: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'share'], properties: { id: { type: 'string' }, share: { type: 'number', minimum: 0, maximum: 1 } } } },
  },
}

test('schema: failures are sentences a worker can act on', () => {
  assert.deepEqual(check(SCHEMA, { problem: 'It is slow', fix_kind: 'root-cause', causes: [{ id: 'a', share: 0.5 }] }), [])
  const bad = check(SCHEMA, { problem: 'no', fix_kind: 'guess', causes: [{ id: 'a', share: 2 }, { share: 0.1 }] }, 'plan')
  assert.deepEqual(bad, [
    'plan.problem must be at least 5 characters',
    'plan.fix_kind must be one of "root-cause", "symptom", but is "guess"',
    'plan.causes[0].share must be at most 1, but is 2',
    'plan.causes[1].id is required',
  ])
  assert.deepEqual(check({ type: 'array', minItems: 2 }, [1]), ['record needs at least 2 items, but has 1'])
  assert.deepEqual(check({ type: 'object', additionalProperties: false, properties: { a: {} } }, { a: 1, b: 2 }), ['record.b is not a field of this record'])
  assert.deepEqual(check({ type: 'number' }, 3), [])
  assert.deepEqual(check({ type: 'integer' }, 3.5), ['record must be integer, but is number'])
})

test('lastJson finds the result a validator printed after its own logging', () => {
  assert.deepEqual(lastJson('checking…\n{"ok":false,"failures":["x {y}"]}\n'), { ok: false, failures: ['x {y}'] })
  assert.equal(lastJson('no json here'), null)
})

async function recordSetup(extra = {}) {
  const s = await setup({
    stages: [
      { kind: 'start' },
      { kind: 'record', name: 'plan', record: 'plan', schema: 'plan.schema.json', validator: 'node validate.js' },
      { kind: 'gate', name: 'plan-gate', shows: { record: 'plan', fields: ['problem', 'fix_kind'] }, itemChoices: extra.itemChoices },
      { kind: 'start', name: 'after' },
    ],
    ...extra,
  })
  fs.writeFileSync(path.join(s.dir, 'plan.schema.json'), JSON.stringify(SCHEMA))
  s.file = path.join(s.runDir, 'records', 'plan.json')
  s.write = (record) => { fs.mkdirSync(path.dirname(s.file), { recursive: true }); fs.writeFileSync(s.file, typeof record === 'string' ? record : JSON.stringify(record)) }
  s.validate = (n, result, code = result.ok ? 0 : 1) => s.runner.finishJob(s.runDir, s.run.id, n, code, `log line\n${JSON.stringify(result)}\n`)
  return s
}
const GOOD = { problem: 'Logins time out', fix_kind: 'root-cause', causes: [{ id: 'retry-storm', share: 0.7 }, { id: 'cold-cache', share: 0.1 }] }

test('record: a missing file, then a wrong shape, then a validator failure each go back to the worker', async () => {
  const s = await recordSetup()
  const { engine, runner, run, finish } = s
  await engine.tick()
  assert.match(runner.started[0].prompt, /plan\.json/)
  assert.ok(runner.started[0].settings.permissions.allow.some((r) => r === `Edit(/${s.file})`), 'it may write the record file')
  assert.ok(!runner.started[0].settings.permissions.allow.includes('Edit'), 'and nothing else')

  finish(1)
  await engine.tick()
  assert.match(runner.started[1].prompt, /missing or is not valid JSON/)
  assert.equal(runner.started[1].resume, true)

  s.write({ problem: 'no', fix_kind: 'symptom', causes: [] })
  finish(2)
  await engine.tick()
  assert.match(runner.started[2].prompt, /Schema: plan\.problem must be at least 5 characters/)
  assert.match(runner.started[2].prompt, /Schema: plan\.causes needs at least 1 item/)

  s.write(GOOD)
  finish(3)
  await engine.tick()
  assert.equal(runner.jobs.length, 1)
  assert.match(runner.jobs[0].cmd, /^node validate\.js '.*plan\.json'$/)
  s.validate(1, { ok: false, failures: ['window must be whole UTC days'] })
  await engine.tick()
  assert.match(runner.started[3].prompt, /Validator: window must be whole UTC days/)
  assert.equal(run.attempts.plan, 3)
})

test('record → gate: the card shows the record, approval moves on', async () => {
  const s = await recordSetup()
  const { engine, run, finish } = s
  await engine.tick()
  s.write(GOOD); finish(1)
  await engine.tick()
  s.validate(1, { ok: true, never_auto_pass: false, items: [{ id: 'retry-storm', outcome: 'pass' }, { id: 'cold-cache', outcome: 'block', reasons: ['below the floor'] }] })
  await engine.tick()
  assert.equal(run.state, 'waiting')
  const [card] = engine.inbox()
  assert.equal(card.type, 'gate')
  assert.match(card.body, /Problem: Logins time out/)
  assert.match(card.body, /Fix kind: root-cause/)
  assert.match(card.detail, /retry-storm/)
  assert.deepEqual(card.choices.map((c) => c.id), ['approve', 'send-back', 'take-over'])
  assert.equal(card.items, undefined, 'no per-item choice unless the gate asks for one')

  await engine.answer(run.id, card.id, 'approve')
  await engine.tick()
  assert.equal(run.state, 'done')
})

test('gate: send back needs a note, is not a failed attempt, and asks again afterwards', async () => {
  const s = await recordSetup()
  const { engine, runner, run, finish } = s
  await engine.tick()
  s.write(GOOD); finish(1)
  await engine.tick()
  s.validate(1, { ok: true })
  await engine.tick()
  const first = engine.inbox()[0]
  await assert.rejects(engine.answer(run.id, first.id, 'send-back'), /say what to change/)
  await engine.answer(run.id, first.id, 'send-back', 'this is a symptom, find the cause')
  await engine.tick()
  assert.equal(run.stages[run.stageIndex].id, 'plan')
  assert.equal(run.attempts['plan-gate'] ?? 0, 0)
  assert.match(runner.started.at(-1).prompt, /this is a symptom, find the cause/)
  assert.equal(runner.started.at(-1).resume, true)

  finish(2)
  await engine.tick()
  s.validate(2, { ok: true })
  await engine.tick()
  const second = engine.inbox()[0]
  assert.notEqual(second.id, first.id, 'a fresh card, not the old answer replayed')
  await engine.answer(run.id, second.id, 'approve')
  await engine.tick()
  assert.equal(run.state, 'done')
})

test('gate: a task can auto-pass it, unless the validator says never', async () => {
  const yes = await recordSetup({ overrides: { gateAutoPass: true } })
  await yes.engine.tick()
  yes.write(GOOD); yes.finish(1)
  await yes.engine.tick()
  yes.validate(1, { ok: true, never_auto_pass: false })
  await yes.engine.tick()
  assert.equal(yes.run.state, 'done')
  assert.equal(yes.run.inbox.length, 0)

  const no = await recordSetup({ overrides: { gateAutoPass: true } })
  await no.engine.tick()
  no.write({ ...GOOD, fix_kind: 'symptom' }); no.finish(1)
  await no.engine.tick()
  no.validate(1, { ok: true, never_auto_pass: true })
  await no.engine.tick()
  assert.equal(no.run.state, 'waiting')
  assert.match(no.engine.inbox()[0].body, /never auto-passes/)
})

test('gate: a choice per item, and a blocked item cannot be sent on', async () => {
  const s = await recordSetup({ itemChoices: ['build', 'park', 'drop'] })
  const { engine, run, finish } = s
  await engine.tick()
  s.write(GOOD); finish(1)
  await engine.tick()
  s.validate(1, { ok: true, items: [{ id: 'retry-storm', outcome: 'pass' }, { id: 'cold-cache', outcome: 'block', reasons: ['below the floor'] }] })
  await engine.tick()
  const card = engine.inbox()[0]
  assert.deepEqual(card.items.map((i) => [i.id, i.blocked, i.choices, i.recommended]), [
    ['retry-storm', false, ['build', 'park', 'drop'], 'build'],
    ['cold-cache', true, ['park', 'drop'], 'park'],
  ])
  assert.match(card.items[0].label, /retry-storm: share 0\.7/)
  await engine.answer(run.id, card.id, 'approve', null, { 'retry-storm': 'build', 'cold-cache': 'build' })
  await engine.tick()
  assert.deepEqual(run.choices.plan, { 'retry-storm': 'build', 'cold-cache': 'park' })
})

test('take over holds the run; hand back re-enters at verify and the gate asks again', async () => {
  let verified = 0
  const s = await setup({
    stages: [{ kind: 'start' }, { kind: 'work', name: 'build', checks: [] }, { kind: 'verify' }, { kind: 'gate', name: 'pr-gate' }],
    extraKinds: { verify: { step: async () => { verified++; return { done: true } } } },
  })
  const { engine, runner, run, finish } = s
  await engine.tick()
  finish(1)
  await engine.tick()
  assert.equal(verified, 1)
  const card = engine.inbox()[0]
  await engine.answer(run.id, card.id, 'take-over')
  assert.equal(run.state, 'held')
  assert.equal(run.resumeSid, runner.started[0].sessionId, 'the conversation to continue by hand')
  await engine.tick()
  assert.equal(run.state, 'held', 'nothing runs while I hold it')

  await assert.rejects(engine.control(run.id, 'resume'), /not paused/)
  await engine.control(run.id, 'handback', 'I renamed the helper')
  await engine.tick()
  assert.equal(verified, 2, 'my edits go through the same checks')
  assert.match(s.store.readFile(run.id, 'brief.md'), /Note added at hand-back[\s\S]*I renamed the helper/)
  assert.equal(run.state, 'waiting')
  const again = engine.inbox()[0]
  assert.notEqual(again.id, card.id)
  await engine.answer(run.id, again.id, 'approve')
  await engine.tick()
  assert.equal(run.state, 'done')
})

test('release ends the run and leaves the worktree alone', async () => {
  const s = await setup({ stages: [{ kind: 'start' }, { kind: 'work', name: 'build', checks: [] }] })
  await s.engine.tick()
  await s.engine.control(s.run.id, 'takeover')
  assert.equal(s.runner.live.size, 0)
  await s.engine.control(s.run.id, 'release')
  assert.equal(s.run.state, 'released')
  assert.equal(s.engine.ownedDirs().size, 0)
})

test('resolver: agreeing with the worker continues the run; differing escalates with its view', async () => {
  const question = { status: 'question', summary: 'need a call', question: { text: 'Mock the clock or raise the timeout?', options: ['mock', 'raise'], recommended: 'mock' } }
  const a = await setup({ stages: [{ kind: 'start' }, { kind: 'work', name: 'build', checks: [] }], machine: { resolver: { enabled: true, model: null } } })
  await a.engine.tick()
  a.finish(1, question)
  await a.engine.tick()
  const resolver = a.runner.started[1]
  assert.equal(resolver.resume, false, 'a separate session')
  assert.match(resolver.prompt, /Mock the clock or raise the timeout\?/)
  assert.ok(!/recommend/i.test(resolver.prompt.split('## The options')[1].split('Put in')[0]), 'it is not shown the worker\'s preferred answer')
  assert.ok(resolver.settings.permissions.deny.includes('Edit'))
  a.finish(2, { output: { answer: 'mock', confident: true, why: 'the other tests already do' } })
  await a.engine.tick()
  assert.equal(a.run.inbox.length, 0)
  assert.equal(a.runner.started[2].resume, true)
  assert.match(a.runner.started[2].prompt, /Answer to your question: mock/)
  assert.ok(a.store.events(a.run.id).some((e) => e.type === 'decision' && e.by === 'resolver'))

  const b = await setup({ stages: [{ kind: 'start' }, { kind: 'work', name: 'build', checks: [] }], machine: { resolver: { enabled: true, model: null } } })
  await b.engine.tick()
  b.finish(1, question)
  await b.engine.tick()
  b.finish(2, { output: { answer: 'raise', confident: true, why: 'smaller' } })
  await b.engine.tick()
  assert.equal(b.run.state, 'waiting')
  const card = b.engine.inbox()[0]
  assert.equal(card.type, 'question')
  assert.match(card.body, /A second session looked at this and said: raise/)
})

test('review: findings both reviewers flag come first and keep the higher severity', () => {
  const merged = merge([
    { slot: 'a', out: { findings: [
      { severity: 'minor', file: 'x.js', line: 10, title: 'unused', explanation: 'A' },
      { severity: 'major', file: 'y.js', line: 5, title: 'race', explanation: 'A2' },
    ] } },
    { slot: 'b', out: { findings: [
      { severity: 'blocking', file: 'y.js', line: 8, title: 'race on write', explanation: 'B' },
      { severity: 'nit', file: 'z.js', line: 1, title: 'name', explanation: 'B2' },
    ] } },
  ])
  assert.deepEqual(merged.map((f) => [f.file, f.severity, f.by]), [
    ['y.js', 'blocking', ['a', 'b']],
    ['x.js', 'minor', ['a']],
    ['z.js', 'nit', ['b']],
  ])
})
