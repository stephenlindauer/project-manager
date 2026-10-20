import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, toSession, createStatusWebhook } from './status-webhook.js'

const quiet = { log() {}, warn() {} }
const where = { a1: { project: 'alpha', branch: 'main' }, b2: { project: 'beta', branch: 'feat' } }
const rec = (nodeId, state, extra = {}) =>
  ({ nodeId, state, phase: null, detail: null, task: 'fix it', at: Date.UTC(2026, 9, 19, 12), ...extra })

function harness({ records = [], include, ok = true, fail = false } = {}) {
  const cfg = parseConfig({ url: 'https://hooks.example/status', token: 'tok', reporter: 'studio', include })
  const calls = []
  let state = records
  const wh = createStatusWebhook(cfg, {
    list: () => state,
    lookup: (id) => where[id] ?? null,
    log: quiet,
    fetchFn: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      if (fail) throw new Error('ECONNREFUSED')
      return { ok, status: ok ? 200 : 500 }
    },
  })
  return { wh, calls, set: (r) => { state = r } }
}

test('parseConfig: off without a usable url, include flags default to true', () => {
  assert.equal(parseConfig(undefined), null)
  assert.equal(parseConfig({}), null)
  const prev = console.warn; console.warn = () => {}
  try { assert.equal(parseConfig({ url: 'ftp://x' }), null) } finally { console.warn = prev }
  const c = parseConfig({ url: 'https://x.test/h', token: 't', reporter: 'r', include: { task: false } })
  assert.deepEqual(c.include, { repo: true, branch: true, task: false, activity: true })
  assert.equal(c.token, 't')
  assert.equal(c.reporter, 'r')
})

test('toSession maps states and omits excluded fields entirely', () => {
  const all = { repo: true, branch: true, task: true, activity: true }
  assert.deepEqual(toSession(rec('a1', 'working', { phase: 'editing' }), where.a1, all), {
    id: 'pm-claude-a1', project: 'alpha', branch: 'main', task: 'fix it',
    state: 'running', activity: 'editing', updated: '2026-10-19T12:00:00.000Z',
  })
  assert.equal(toSession(rec('a1', 'done'), where.a1, all).state, 'idle')
  assert.equal(toSession(rec('a1', 'waiting', { detail: 'Allow Bash?' }), where.a1, all).activity, 'Allow Bash?')
  assert.equal(toSession(rec('a1', 'ended'), where.a1, all).state, 'ended')

  const none = { repo: false, branch: false, task: false, activity: false }
  const s = toSession(rec('a1', 'working', { phase: 'editing' }), where.a1, none)
  assert.deepEqual(Object.keys(s).sort(), ['id', 'state', 'updated'])
})

test('heartbeat POSTs the full snapshot with a bearer token', async () => {
  const { wh, calls } = harness({ records: [rec('a1', 'working', { phase: 'testing' }), rec('b2', 'done')] })
  assert.equal(await wh.start(60_000), true)
  wh.stop()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hooks.example/status')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
  assert.equal(calls[0].body.reporter, 'studio')
  assert.deepEqual(calls[0].body.sessions.map((s) => [s.id, s.state]),
    [['pm-claude-a1', 'running'], ['pm-claude-b2', 'idle']])
})

test('include flags strip fields from the wire payload', async () => {
  const { wh, calls } = harness({ records: [rec('a1', 'working')], include: { repo: false, task: false } })
  await wh.tick()
  const [s] = calls[0].body.sessions
  assert.equal('project' in s, false)
  assert.equal('task' in s, false)
  assert.equal(s.branch, 'main')
})

test('state changes trigger a send; phase-only refreshes do not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { wh, calls } = harness()
  wh.onStatus([rec('a1', 'working', { phase: 'reading' })])
  t.mock.timers.tick(300)
  await Promise.resolve()
  assert.equal(calls.length, 1)

  wh.onStatus([rec('a1', 'working', { phase: 'editing' })])
  t.mock.timers.tick(300)
  assert.equal(calls.length, 1, 'a new phase is not a state change')

  wh.onStatus([rec('a1', 'done')])
  wh.onStatus([rec('a1', 'waiting')])
  t.mock.timers.tick(300)
  await Promise.resolve()
  assert.equal(calls.length, 2, 'a burst is coalesced into one POST')
  assert.equal(calls[1].body.sessions[0].state, 'waiting')
})

test('a vanished session is reported ended until a POST succeeds', async () => {
  const h = harness({ records: [rec('a1', 'done')], ok: false })
  await h.wh.tick()
  h.set([])
  await h.wh.tick()
  assert.deepEqual(h.calls[1].body.sessions.map((s) => s.state), ['ended'])
  await h.wh.tick()
  assert.equal(h.calls[2].body.sessions.length, 1, 'kept after a failed POST')

  const ok = harness({ records: [rec('a1', 'done')] })
  await ok.wh.tick()
  ok.set([])
  await ok.wh.tick()
  assert.equal(ok.calls[1].body.sessions[0].state, 'ended')
  await ok.wh.tick()
  assert.deepEqual(ok.calls[2].body.sessions, [], 'reported once after delivery')
})

test('a failing endpoint never throws', async () => {
  const { wh, calls } = harness({ records: [rec('a1', 'working')], fail: true })
  assert.equal(await wh.tick(), false)
  assert.doesNotThrow(() => wh.onStatus([rec('a1', 'done')]))
  assert.equal(calls.length, 1)
  wh.stop()
})

test('extra headers go out with every POST; content-type and the bearer token stay ours', async () => {
  const cfg = parseConfig({
    url: 'https://hooks.example/status', token: 'tok', reporter: 'studio',
    headers: { 'X-Proxy-Id': 'abc', 'Authorization': 'nope', 'Content-Type': 'text/plain', 'X-Number': 5 },
  })
  assert.deepEqual(cfg.headers, { 'x-proxy-id': 'abc', authorization: 'nope', 'content-type': 'text/plain' })
  const calls = []
  const wh = createStatusWebhook(cfg, {
    list: () => [], lookup: () => null, log: quiet,
    fetchFn: async (url, init) => { calls.push(init); return { ok: true, status: 200 } },
  })
  await wh.send()
  assert.equal(calls[0].headers['x-proxy-id'], 'abc')
  assert.equal(calls[0].headers.authorization, 'Bearer tok')
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.equal(calls[0].headers['x-number'], undefined)
  assert.deepEqual(parseConfig({ url: 'https://hooks.example/status' }).headers, {})
})
