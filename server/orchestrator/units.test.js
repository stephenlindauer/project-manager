import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { layer, loadMachine, loadRepo, resolvePipeline, discover } from './config.js'
import { DEFAULT_SETS, resolveSet, settingsFor, ruleFor, SIDE_EFFECT_DENY } from './permissions.js'
import { claudeLauncher, parseTranscript, sq } from './runner.js'
import { createRunStore } from './runstore.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pm-orch-cfg-'))

test('layers merge deeply and remember where each value came from', () => {
  const prov = {}
  const cfg = layer({}, { limits: { a: 1, b: 2 }, list: [1] }, 'defaults', prov)
  layer(cfg, { limits: { b: 3 }, list: [9, 9] }, 'machine', prov)
  assert.deepEqual(cfg, { limits: { a: 1, b: 3 }, list: [9, 9] })
  assert.equal(prov['limits.a'], 'defaults')
  assert.equal(prov['limits.b'], 'machine')
  assert.equal(prov.list, 'machine')
})

test('machine config: defaults, then pm.config.json, then orchestrator/machine.json', () => {
  const root = tmp()
  const dir = path.join(root, 'orchestrator')
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true })
  fs.writeFileSync(path.join(root, 'pm.config.json'), JSON.stringify({ orchestrator: { enabled: true, limits: { activeSessions: 5, wip: 9 } } }))
  fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ limits: { wip: 2 } }))
  fs.writeFileSync(path.join(dir, 'repos', 'thing.json'), JSON.stringify({ ship: { merge: { by: 'app', method: 'squash' } }, verify: ['npm test'] }))
  const m = loadMachine({ root, dir })
  assert.equal(m.enabled, true)
  assert.equal(m.limits.activeSessions, 5)
  assert.equal(m.limits.wip, 2)
  assert.equal(m.limits.fixRounds, 3)
  assert.equal(m.provenance['limits.wip'], 'orchestrator/machine.json')
  assert.equal(m.provenance['limits.fixRounds'], 'app defaults')

  const repo = loadRepo(m, '/somewhere/thing')
  assert.equal(repo.ship.merge.by, 'app')
  assert.equal(repo.ship.ci, 'required', 'untouched defaults survive')
  assert.equal(repo.provenance['ship.merge.method'], 'orchestrator/repos/thing.json')
  assert.equal(loadRepo(m, '/somewhere/other').ship.merge.by, 'me')
})

test('with no config at all the orchestrator is off', (t) => {
  // PM_ORCH overrides every file layer, and a run started by the orchestrator
  // inherits it — "no config" has to mean no env switch either.
  const inherited = process.env.PM_ORCH
  delete process.env.PM_ORCH
  t.after(() => { if (inherited !== undefined) process.env.PM_ORCH = inherited })
  const root = tmp()
  assert.equal(loadMachine({ root, dir: path.join(root, 'orchestrator') }).enabled, false)
})

const kinds = (impls) => new Map(Object.entries(impls).map(([name, impl]) => [name, { name, impl }]))
const KINDS = kinds({
  intake: { owns: (s) => (s.branch === false ? [] : ['branch']) },
  work: {},
  pr: { owns: () => ['pr'] },
  watch: { owns: () => ['ci'] },
  merge: { owns: (_s, { hasWatch }) => (hasWatch ? [] : ['ci']) },
  deploy: {},
})

test('a pipeline needs exactly one owner per side effect', () => {
  const ok = resolvePipeline('ship', { stages: [{ kind: 'intake' }, { kind: 'work' }, { kind: 'pr' }, { kind: 'merge' }] }, { kinds: KINDS })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.owners, { branch: ['intake'], status: [], pr: ['pr'], ci: ['merge'] })

  const skill = { kind: 'work', name: 'ship-skill', owns: ['branch', 'pr', 'ci', 'status'] }
  const both = resolvePipeline('x', { stages: [{ kind: 'intake' }, skill, { kind: 'merge' }] }, { kinds: KINDS })
  assert.match(both.errors.join('\n'), /"branch" has two owners: intake and ship-skill/)
  assert.match(both.errors.join('\n'), /"ci" has two owners/)

  const fixed = resolvePipeline('x', { stages: [{ kind: 'intake', branch: false }, skill, { kind: 'merge', waitOnly: true, owns: [] }] }, {
    kinds: kinds({ ...Object.fromEntries(KINDS), merge: { impl: null } , ...{ merge: { owns: (s) => (s.waitOnly ? [] : ['ci']) } } }),
  })
  assert.deepEqual(fixed.errors, [])

  const twoStatus = resolvePipeline('x', { stages: [{ kind: 'intake', branch: false }, skill] }, {
    kinds: KINDS, source: { name: 'clickup', writes: true, statusSync: true },
  })
  assert.match(twoStatus.errors.join('\n'), /"status" has two owners: ship-skill and source:clickup/)

  const none = resolvePipeline('x', { stages: [{ kind: 'intake' }, { kind: 'work' }, { kind: 'merge', waitOnly: true }] }, {
    kinds: kinds({ ...Object.fromEntries([...KINDS].map(([k, v]) => [k, v.impl])), merge: {} }),
  })
  assert.match(none.errors.join('\n'), /"pr" has no owner/)
})

test('unknown kinds and dangling loop targets are reported', () => {
  const r = resolvePipeline('x', { stages: [{ kind: 'intake' }, { kind: 'mystery', onFail: 'nowhere' }] }, { kinds: KINDS })
  assert.match(r.errors.join('\n'), /unknown kind "mystery"/)
  assert.match(r.errors.join('\n'), /onFail names "nowhere"/)
})

test('a machine adapter overrides the repo one by name and can wrap it', async () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'sources'))
  fs.writeFileSync(path.join(dir, 'sources', 'manual.js'),
    'export default (base) => ({ ...base, wrapped: true, name: "manual" })\n')
  fs.writeFileSync(path.join(dir, 'sources', 'private.js'), 'export default { name: "private" }\n')
  const found = await discover('sources', dir)
  assert.equal(found.get('manual').impl.wrapped, true)
  assert.equal(typeof found.get('manual').impl.fetch, 'function', 'the wrapped adapter keeps the base methods')
  assert.match(found.get('manual').origin, /^orchestrator\/sources\/manual\.js$/)
  assert.match(found.get('manual').wraps, /^server\/orchestrator\/sources\/manual\.js$/)
  assert.equal(found.get('private').impl.name, 'private')
})

test('permission sets: read cannot edit, work cannot push, skill gets back only what it lists', () => {
  const read = settingsFor(DEFAULT_SETS, 'read')
  assert.ok(read.permissions.deny.includes('Edit'))
  assert.ok(!read.permissions.allow.includes('Edit'))

  const work = settingsFor(DEFAULT_SETS, 'work', { extraAllow: ['Edit(//w/**)', 'Bash(npm test:*)'] })
  assert.ok(work.permissions.allow.includes('Edit(//w/**)'))
  assert.ok(work.permissions.allow.includes('Bash(git commit:*)'))
  for (const d of SIDE_EFFECT_DENY) assert.ok(work.permissions.deny.includes(d), `work denies ${d}`)
  assert.equal(work.permissions.defaultMode, 'dontAsk')

  const skill = settingsFor(DEFAULT_SETS, 'skill', { extraAllow: ['Bash(git push:*)'] })
  assert.ok(skill.permissions.allow.includes('Bash(git push:*)'))
  assert.ok(!skill.permissions.deny.includes('Bash(git push:*)'))
  assert.equal(resolveSet(DEFAULT_SETS, 'skill').edits, 'worktree')
  assert.throws(() => resolveSet(DEFAULT_SETS, 'nope'), /unknown permission set/)
})

test('a denied call becomes an exact rule', () => {
  assert.equal(ruleFor({ tool: 'Bash', input: { command: 'make gen' } }), 'Bash(make gen)')
  assert.equal(ruleFor({ tool: 'Write', input: { file_path: '/a/b.txt' } }), 'Edit(//a/b.txt)')
  assert.equal(ruleFor({ tool: 'mcp__x__y', input: {} }), 'mcp__x__y')
})

test('the launcher denies instead of prompting, and resumes by id', () => {
  const fresh = claudeLauncher({ dir: '/r/sessions', n: 3, cwd: "/w/it's", sessionId: 'abc', hasSchema: true, hasSystem: true })
  assert.match(fresh, /--permission-mode dontAsk --permission-prompts none/)
  assert.match(fresh, /--session-id 'abc'/)
  assert.match(fresh, /cd '\/w\/it'\\''s'/)
  assert.match(fresh, /< "\$D\/3\.prompt\.md" > "\$D\/3\.jsonl" 2> "\$D\/3\.err"/)
  assert.match(fresh, /mv "\$D\/3\.exit\.tmp" "\$D\/3\.exit"/)
  assert.match(claudeLauncher({ dir: '/r', n: 1, cwd: '/w', sessionId: 'abc', resume: true }), /--resume 'abc'/)
  assert.equal(sq("a'b"), `'a'\\''b'`)
})

test('a transcript yields the answer, the denials and the spend; a cut-off one is not finished', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ]
  const cut = parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"resu')
  assert.equal(cut.finished, false)
  assert.equal(cut.lastActivity, 'Bash: npm test')

  lines.push({
    type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'x',
    structured_output: { status: 'done', summary: 'ok' }, total_cost_usd: 0.5,
    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm x' } }],
  })
  const t = parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'))
  assert.equal(t.finished, true)
  assert.equal(t.tokens, 10)
  assert.deepEqual(t.structured, { status: 'done', summary: 'ok' })
  assert.deepEqual(t.denials, [{ tool: 'Bash', input: { command: 'rm x' } }])
})

test('the run store survives a torn last line and tracks an effect through intent and result', () => {
  const store = createRunStore(path.join(tmp(), 'runs'))
  const run = store.save({ id: 'r1', createdAt: 1, sessions: [] })
  assert.equal(store.load('r1').id, 'r1')
  assert.equal(store.effectState('r1', 'pr', 'open').state, 'none')
  store.append('r1', { type: 'intent', effect: 'pr', key: 'open' })
  assert.equal(store.effectState('r1', 'pr', 'open').state, 'open')
  fs.appendFileSync(path.join(store.dirOf('r1'), 'events.jsonl'), '{"type":"resu')
  assert.equal(store.effectState('r1', 'pr', 'open').state, 'open')
  fs.appendFileSync(path.join(store.dirOf('r1'), 'events.jsonl'), '\n')
  store.append('r1', { type: 'result', effect: 'pr', key: 'open', value: { number: 3 } })
  assert.deepEqual(store.effectState('r1', 'pr', 'open'), { state: 'done', value: { number: 3 } })
  assert.equal(store.loadAll().length, 1)
  assert.ok(run.updatedAt)
})
