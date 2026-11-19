import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { loadMachine, loadRepo, discover, resolvePipeline, EFFECTS } from './config.js'
import { createEngine } from './engine.js'
import { createRunStore } from './runstore.js'
import { tmuxRunner, readFrom, sessionFiles, jobFiles, tail } from './runner.js'
import { resolveSet } from './permissions.js'
import { classify } from '../claude-phase.js'

/**
 * Orchestrator mode, as the rest of the server sees it: one object with a
 * router, an event emitter and a few hooks. Off unless `orchestrator.enabled`
 * is set in pm.config.json — with no config the app behaves exactly as it did
 * before this existed.
 *
 * Every route here is mounted under `/api`, behind `requireAuth`. Starting a
 * run starts an agent with a shell, so none of this may ever sit outside it.
 */
export async function createOrchestrator({ app = {}, interactiveWorking, claudeCommand, playSound } = {}) {
  const machine = loadMachine()
  const router = express.Router()
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    res.status(400).json({ error: String(err?.message ?? err) })
  })

  if (!machine.enabled) {
    router.get('/orch/meta', (_req, res) => res.json({ enabled: false }))
    return { enabled: false, router, machine, hook: () => false, ownedDirs: () => new Map(), on: () => {}, off: () => {}, snapshot: () => null, start: () => {} }
  }

  fs.mkdirSync(path.join(machine.dir, 'runs'), { recursive: true })
  const [kinds, sources, checks] = await Promise.all([
    discover('stages', machine.dir), discover('sources', machine.dir), discover('checks', machine.dir),
  ])
  const store = createRunStore(path.join(machine.dir, 'runs'))
  const repoOf = (repoPath) => loadRepo(machine, repoPath)

  /** "Allow always": widen one permission set in orchestrator/machine.json, and in memory. */
  async function allowAlways(setName, rule) {
    const file = path.join(machine.dir, 'machine.json')
    let json = {}
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first write */ }
    const sets = (json.permissionSets ??= {})
    const set = (sets[setName] ??= {})
    // The file holds only what this machine adds; the base rules stay in code.
    set.allow = [...new Set([...(set.allow ?? machine.permissionSets[setName]?.allow ?? []), rule])]
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
    const live = machine.permissionSets[setName]
    if (live) live.allow = [...new Set([...(live.allow ?? []), rule])]
  }

  const toasts = []
  const engine = createEngine({
    machine, kinds, sources, checks, store, runner: tmuxRunner,
    deps: {
      loadRepo: repoOf, app, interactiveWorking, claudeCommand, allowAlways,
      notify(event, { run, card }) {
        // Only what needs me makes noise. A worker finishing a step does not.
        const loud = card ? card.blocking !== false : event === 'run-done'
        if (!loud) return
        const toast = {
          id: `${Date.now()}-${toasts.length}`, runId: run.id, event,
          title: card ? card.title : `Done: ${run.task.title}`,
          task: run.task.title, at: Date.now(),
        }
        engine.events.emit('toast', toast)
        playSound?.(card ? 'waiting' : 'done')
      },
    },
  })

  // ------------------------------------------------------------ views

  const FINAL = new Set(['done', 'abandoned', 'released'])

  function summary(run) {
    const stage = run.stages[run.stageIndex] ?? null
    const st = stage ? run.stageState[stage.id] ?? {} : {}
    const live = run.sessions.filter((s) => s.status === 'running')
    const open = run.inbox.filter((c) => !c.answer)
    return {
      id: run.id, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt, endedAt: run.endedAt ?? null,
      task: run.task, repoName: run.repoName, repoPath: run.repoPath, pipeline: run.pipeline,
      stages: run.stages.map((s) => ({ id: s.id, kind: s.kind })),
      stageIndex: run.stageIndex, stageId: stage?.id ?? null,
      note: live[0]?.activity ?? st.waitingOn ?? null,
      working: live.length,
      attempts: Object.values(run.attempts).reduce((a, b) => a + b, 0),
      spend: run.spend, pr: run.pr, worktree: run.worktree,
      nodeId: run.worktree?.dir ? app.nodeIdFor?.(run.worktree.dir) ?? null : null,
      cards: open.length, blocking: open.filter((c) => c.blocking).length,
    }
  }

  const snapshot = () => ({
    runs: engine.list().map(summary).sort((a, b) => b.createdAt - a.createdAt),
    inbox: engine.inbox().sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt),
    limits: { ...engine.limits(), max: machine.limits },
  })

  // A burst of ticks must not become a burst of SSE frames.
  let pending = null
  engine.events.on('change', () => {
    if (pending) return
    pending = setTimeout(() => { pending = null; engine.events.emit('snapshot', snapshot()) }, 150)
  })

  // ------------------------------------------------------- starting a run

  /** Only trusted pieces reach a session. A brief is a prompt to an agent with a shell. */
  function briefFrom(task) {
    const trusted = (task.pieces ?? []).filter((p) => p.trusted)
    const dropped = (task.pieces ?? []).length - trusted.length
    const text = trusted.map((p) => (p.kind === 'body' ? p.text : `**${p.kind} from ${p.author}:**\n${p.text}`)).join('\n\n')
    return { text, dropped }
  }

  async function startRun({ repoPath, sourceName = null, input, pipeline = null, overrides = {} }) {
    if (!repoPath) throw new Error('a repository is required')
    const repo = repoOf(repoPath)
    const name = sourceName ?? repo.source ?? 'manual'
    const sourceCfg = machine.sources[name]
    if (!sourceCfg) throw new Error(`no task source "${name}" is configured`)
    const adapter = sources.get(sourceCfg.adapter ?? name)?.impl
    if (!adapter) throw new Error(`task source adapter "${sourceCfg.adapter ?? name}" was not found`)

    const task = await adapter.fetch(input, sourceCfg)
    const { text, dropped } = briefFrom(task)
    if (!text.trim()) throw new Error('the task has no content from a trusted author')
    const fromTask = (await adapter.overrides?.(task, sourceCfg)) ?? {}
    const typed = task.type ? (sourceCfg.pipelines?.[task.type] ?? (machine.pipelines[task.type] ? task.type : null)) : null
    return engine.createRun({
      task: { id: task.id ?? null, title: task.title, url: adapter.link(task), type: task.type ?? null, ref: adapter.ref(task), untrusted: dropped },
      repoPath, sourceName: name, brief: text,
      pipeline: pipeline ?? typed,
      overrides: { ...fromTask, ...overrides },
    })
  }

  // ----------------------------------------------------------- hooks

  /**
   * A hook event from a session the engine started (it carries the run
   * marker). It updates the run's card and nothing else: no status record,
   * no toast, no sound. A worker's `Stop` is the end of one step, not
   * something for me.
   */
  function hook(body) {
    const run = engine.get(String(body.orchRun ?? ''))
    if (!run) return true // ours, but the run is gone: still not a sidebar event
    const sess = run.sessions.find((s) => String(s.n) === String(body.orchSession))
    if (!sess || sess.status !== 'running') return true
    if (body.event === 'PreToolUse' || body.event === 'PostToolUse') {
      const c = classify(body.tool, body.toolHint)
      const activity = c ? `${c.phase}${body.toolHint ? ` · ${String(body.toolHint).slice(0, 120)}` : ''}` : null
      if (activity && activity !== sess.activity) { sess.activity = activity; engine.events.emit('change', run) }
    }
    return true
  }

  // ------------------------------------------------------------ rules

  function rules(repoPath) {
    const repo = repoPath ? repoOf(repoPath) : null
    const sourceName = repo?.source ?? 'manual'
    const sourceCfg = machine.sources[sourceName] ?? {}
    const pipelines = Object.entries(machine.pipelines).map(([name, p]) => {
      const r = resolvePipeline(name, p, {
        kinds, source: { name: sourceName, writes: Boolean(sourceCfg.writes), statusSync: Boolean(sourceCfg.statusSync) },
      })
      return {
        name, errors: r.errors, origin: machine.provenance[`pipelines.${name}.stages`] ?? null,
        stages: r.stages.map((s) => ({ id: s.id, kind: s.kind, gate: s.kind === 'gate', skill: s.skill ?? null })),
        owners: Object.fromEntries(EFFECTS.map((e) => [e, r.owners[e] ?? []])),
      }
    })
    const adapters = (map) => [...map.values()].map((a) => ({ name: a.name, origin: a.origin ?? null, wraps: a.wraps ?? null, error: a.error ?? null }))
    const { provenance, errors, dir, root, permissionSets, ...values } = machine
    return {
      dir, errors: [...errors, ...(repo?.errors ?? [])],
      machine: { values: redact(values), provenance },
      repo: repo ? { name: repo.name, values: (({ provenance: _p, errors: _e, ...v }) => v)(repo), provenance: repo.provenance } : null,
      pipelines,
      permissionSets: Object.fromEntries(Object.keys(permissionSets).map((n) => {
        try { return [n, resolveSet(permissionSets, n)] } catch (err) { return [n, { error: err.message }] }
      })),
      stages: adapters(kinds), sources: adapters(sources), checks: adapters(checks),
    }
  }

  /** Source configs can hold API keys. The Rules screen shows that one is set, never what it is. */
  function redact(v, key = '') {
    if (Array.isArray(v)) return v.map((x) => redact(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]))
    return typeof v === 'string' && /key|token|secret|password/i.test(key) ? '•••' : v
  }

  // ----------------------------------------------------------- routes

  router.get('/orch/meta', wrap((_req, res) => res.json({
    enabled: true,
    errors: machine.errors,
    sources: Object.entries(machine.sources).map(([name, s]) => ({ name, adapter: s.adapter ?? name, queue: Boolean(sources.get(s.adapter ?? name)?.impl?.queue) })),
    pipelines: Object.keys(machine.pipelines),
  })))

  router.get('/orch/state', wrap((_req, res) => res.json(snapshot())))

  router.get('/orch/rules', wrap((req, res) => {
    const repoPath = req.query.projectId ? app.projectPath?.(String(req.query.projectId)) : null
    res.json(rules(repoPath))
  }))

  router.post('/orch/runs', wrap(async (req, res) => {
    const body = req.body ?? {}
    const repoPath = app.projectPath?.(String(body.projectId ?? ''))
    if (!repoPath) return res.status(404).json({ error: 'unknown project' })
    const run = await startRun({
      repoPath, sourceName: body.source ?? null, pipeline: body.pipeline || null,
      input: body.input ?? { brief: body.brief, title: body.title, type: body.type },
      overrides: body.overrides ?? {},
    })
    res.json({ ok: true, run: summary(run) })
  }))

  const runOr404 = (req, res) => {
    const run = engine.get(req.params.id)
    if (!run) res.status(404).json({ error: 'unknown run' })
    return run
  }

  router.get('/orch/runs/:id', wrap((req, res) => {
    const run = runOr404(req, res); if (!run) return
    const events = engine.eventsOf(run.id)
    res.json({
      ...summary(run),
      sessions: run.sessions,
      inbox: run.inbox,
      attemptsByStage: run.attempts,
      stageState: Object.fromEntries(Object.entries(run.stageState).map(([id, st]) => [id, { waitingOn: st.waitingOn ?? null, pr: st.pr ?? null, summary: st.summary ?? null }])),
      overrides: run.overrides,
      summary: run.summary ?? null,
      brief: store.readFile(run.id, 'brief.md'),
      events: events.slice(-400),
      records: listRecords(run.id),
    })
  }))

  function listRecords(id) {
    try {
      return fs.readdirSync(path.join(store.dirOf(id), 'records')).map((name) => ({ name, content: store.readFile(id, path.join('records', name)) }))
    } catch { return [] }
  }

  /** The live transcript: a tail of the session's file, reduced to what a person reads. */
  router.get('/orch/runs/:id/sessions/:n', wrap((req, res) => {
    const run = runOr404(req, res); if (!run) return
    const n = Number(req.params.n)
    if (!run.sessions.some((s) => s.n === n)) return res.status(404).json({ error: 'unknown session' })
    const files = sessionFiles(store.dirOf(run.id), n)
    const { offset, lines } = readFrom(files.transcript, Number(req.query.offset) || 0)
    const items = []
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'assistant') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'text', text: c.text })
          else if (c.type === 'tool_use') items.push({ kind: 'tool', name: c.name, input: brief(c.input) })
        }
      } else if (e.type === 'user') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'tool_result' && c.is_error) items.push({ kind: 'error', text: String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 400) })
        }
      } else if (e.type === 'result') {
        items.push({ kind: 'result', text: e.structured_output?.summary ?? e.result ?? '', status: e.structured_output?.status ?? e.subtype })
      }
    }
    res.json({ offset, items, prompt: Number(req.query.offset) ? null : store.readFile(run.id, path.join('sessions', `${n}.prompt.md`)), err: tail(files.err, 800) })
  }))

  const brief = (input = {}) => {
    const v = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? input.url ?? ''
    return String(v).slice(0, 300)
  }

  router.get('/orch/runs/:id/jobs/:n', wrap((req, res) => {
    const run = runOr404(req, res); if (!run) return
    res.json({ log: tail(jobFiles(store.dirOf(run.id), Number(req.params.n)).log, 20_000) })
  }))

  router.post('/orch/runs/:id/cards/:card', wrap(async (req, res) => {
    const run = runOr404(req, res); if (!run) return
    await engine.answer(run.id, req.params.card, String(req.body?.choice ?? ''), req.body?.note ? String(req.body.note).slice(0, 4000) : null)
    res.json({ ok: true })
  }))

  router.post('/orch/runs/:id/control', wrap(async (req, res) => {
    const run = runOr404(req, res); if (!run) return
    await engine.control(run.id, String(req.body?.action ?? ''))
    res.json({ ok: true, run: summary(run) })
  }))

  return {
    enabled: true, router, machine, engine, hook, snapshot, startRun, rules,
    ownedDirs: () => engine.ownedDirs(),
    on: (ev, fn) => engine.events.on(ev, fn),
    off: (ev, fn) => engine.events.off(ev, fn),
    start() {
      const live = engine.boot()
      engine.start()
      return {
        live,
        problems: [...machine.errors, ...[...kinds.values(), ...sources.values(), ...checks.values()].filter((a) => a.error).map((a) => a.error)],
      }
    },
    FINAL,
  }
}
