import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePipeline } from './config.js'
import { settingsFor, resolveSet, ruleFor, editsUnder } from './permissions.js'
import { newRunId } from './runstore.js'

/**
 * The orchestrator: a state machine that advances runs through their
 * pipeline, starts sessions, runs checks and enforces limits. It is plain
 * code. Claude does the thinking inside a stage, never the bookkeeping between
 * stages — "code decides when a stage is done" is the whole point.
 *
 * How a run moves. Each tick, every active run's current stage gets one
 * `step(ctx)` call, which must be safe to repeat: it looks at what is on disk
 * (a session's exit file, an effect's result line) and answers with one of
 *
 *   { done }      the stage is finished; advance
 *   { wait }      something is still running; ask again next tick
 *   { inbox }     raise a card and stop until I answer it
 *   { hold }      already waiting on cards raised earlier
 *   { fail }      a check failed; go back to the stage that can fix it,
 *                 up to the fix-round cap, then pause into the inbox
 *   { goto }      jump to a named stage without counting an attempt
 *   { pause }     stop and put the run in the inbox with a reason
 *
 * Because every step re-derives its position from files, a restarted server
 * needs no special recovery path: boot loads the runs and ticks.
 */

export const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'question', 'blocked'] },
    summary: { type: 'string' },
    question: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        recommended: { type: 'string' },
      },
      required: ['text', 'options'],
    },
    blocked_on: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { what: { type: 'string' }, chose: { type: 'string' }, why: { type: 'string' } },
        required: ['what', 'chose'],
      },
    },
  },
  required: ['status', 'summary'],
}

const INTERRUPTED = 'Your process was interrupted before it finished. Check the state of the working tree, ' +
  'then continue the same task from where you stopped. Do not redo work that is already done.'

/** What every worker is told about deciding, asking and being refused. */
const ONE_AT_A_TIME = 'A refusal applies to that one command, not to the whole tool. Each part of a compound command ' +
  '(`a; b && c | d`) is checked on its own, so one unlisted part refuses the lot: run commands separately and keep them plain.'

export function workerRules(machine, { ownsEffects = false, allowed = [] } = {}) {
  const lines = [
    'You are a worker inside an automated pipeline. Nobody is watching this session live.',
    '',
    'Deciding:',
    '- For routine choices, take your own recommended option and continue. List each such choice in `decisions`.',
    '- Stop and ask only for the cases below. To ask, finish with status "question", the options, and your recommendation.',
    ...machine.mustAsk.map((m) => `  - ${m}`),
    '',
    'Limits:',
  ]
  if (!ownsEffects) {
    lines.push('- You cannot push, open or merge a pull request, deploy, or write to a task tracker. ' +
      'The pipeline does those after you. Do not attempt them. Commit your work locally.')
  }
  const shell = allowed.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1).replace(/:\*$/, ' …'))
  if (shell.length) lines.push(`- Shell commands you may run: ${shell.join(', ')}. Anything else is refused at once; there is nobody to approve it.`)
  lines.push(
    `- ${ONE_AT_A_TIME}`,
    '- If a call is refused, do not reach the same effect another way. Continue without it if you can. ' +
      'Finish with status "blocked" only when the task cannot be completed without it, and say in `blocked_on` exactly what you needed.',
    '',
    'Finish with status "done" and a short summary of what you did.',
  )
  return lines.join('\n')
}

const FINAL = new Set(['done', 'abandoned', 'released'])

export function createEngine({ machine, kinds, sources, checks = new Map(), store, runner, deps = {} }) {
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const runs = new Map()
  const busy = new Set()
  let starting = 0
  let timer = null

  const loadRepo = deps.loadRepo ?? (() => { throw new Error('loadRepo not provided') })
  const notify = (event, payload) => { try { deps.notify?.(event, payload) } catch { /* never from here */ } }
  const changed = (run) => { store.save(run); events.emit('change', run) }
  const log = (run, event) => store.append(run.id, event)

  // ------------------------------------------------------------ limits

  const runningSessions = () => {
    let n = starting
    for (const r of runs.values()) for (const s of r.sessions) if (s.status === 'running') n++
    return n
  }

  function hasSlot() {
    const { activeSessions, totalActiveSessions } = machine.limits
    const mine = runningSessions()
    if (activeSessions && mine >= activeSessions) return false
    if (totalActiveSessions && mine + (deps.interactiveWorking?.() ?? 0) >= totalActiveSessions) return false
    return true
  }

  /** Runs waiting on me or on review: the count the queue respects. */
  const wip = () => [...runs.values()].filter((r) => r.state === 'waiting' || currentStage(r)?.kind === 'watch').length

  // -------------------------------------------------------------- runs

  const currentStage = (run) => run.stages[run.stageIndex] ?? null

  function createRun({ task, repoPath, pipeline: pipelineName, sourceName = 'manual', brief, overrides = {} }) {
    const repo = loadRepo(repoPath)
    const name = overrides.pipeline ?? pipelineName ?? repo.pipeline
    const sourceCfg = machine.sources[sourceName] ?? {}
    const resolved = resolvePipeline(name, machine.pipelines[name], {
      kinds, source: { name: sourceName, writes: Boolean(sourceCfg.writes), statusSync: Boolean(sourceCfg.statusSync) },
    })
    if (resolved.errors.length) throw new Error(`pipeline "${name}" cannot run: ${resolved.errors.join('; ')}`)

    const run = {
      id: newRunId(),
      createdAt: Date.now(),
      state: 'active',
      task: { source: sourceName, ...task },
      repoPath, repoName: repo.name,
      pipeline: name,
      // A snapshot: editing config must not change a run that is in flight.
      stages: resolved.stages,
      stageIndex: 0,
      stageState: {},
      attempts: {},
      feedback: null,
      workerSid: {},
      allowOnce: {},
      worktree: null,
      pr: null,
      sessions: [],
      jobSeq: 0,
      spend: { tokens: 0, usd: 0 },
      inbox: [],
      overrides,
    }
    store.save(run)
    store.writeFile(run.id, 'brief.md', brief ?? task.title ?? '')
    log(run, { type: 'created', pipeline: name, task: run.task })
    runs.set(run.id, run)
    events.emit('change', run)
    lifecycle(run, 'started')
    kick()
    return run
  }

  function finish(run, state, reason) {
    run.state = state
    run.endedAt = Date.now()
    log(run, { type: state, reason: reason ?? null })
    changed(run)
    if (state === 'done') notify('run-done', { run })
    if (state === 'done' || state === 'abandoned') lifecycle(run, state)
  }

  /**
   * Tell the task source something happened (started, pr, merged, done), for
   * a tracker with writes on. It never holds a run up: a write that fails is
   * logged, and one interrupted by a restart is skipped and noted rather than
   * sent a second time — a duplicate comment on a real tracker is worse than
   * a missing one.
   */
  function lifecycle(run, type, extra = {}) {
    if (!deps.sourceWrite) return
    const s = store.effectState(run.id, 'source-write', type)
    if (s.state === 'done') return
    if (s.state === 'open') {
      log(run, { type: 'source-write-skipped', event: type, reason: 'interrupted by a restart; not repeated' })
      log(run, { type: 'result', effect: 'source-write', key: type, value: 'skipped' })
      return
    }
    log(run, { type: 'intent', effect: 'source-write', key: type })
    Promise.resolve()
      .then(() => deps.sourceWrite(run, { type, ...extra }))
      .then((value) => log(run, { type: 'result', effect: 'source-write', key: type, value: value ?? null }))
      .catch((err) => {
        log(run, { type: 'intent-void', effect: 'source-write', key: type, error: String(err?.message ?? err) })
        log(run, { type: 'error', message: `tracker write "${type}" failed: ${err?.message ?? err}` })
      })
  }

  // ------------------------------------------------------------- inbox

  function raise(run, stage, card) {
    const existing = run.inbox.find((c) => c.key === card.key)
    if (existing) return existing
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      runId: run.id,
      stageId: stage?.id ?? null,
      blocking: true,
      createdAt: Date.now(),
      answer: null,
      ...card,
    }
    run.inbox.push(item)
    log(run, { type: 'card', stage: item.stageId, card: { id: item.id, key: item.key, type: item.type, title: item.title } })
    notify(`card-${item.type}`, { run, card: item })
    return item
  }

  const answerOf = (run, key) => run.inbox.find((c) => c.key === key)?.answer ?? null
  const openBlocking = (run) => run.inbox.some((c) => c.blocking && !c.answer)

  /** My answer to a card. Wakes the run once nothing blocking is left open. */
  async function answer(runId, cardId, choice, note = null, items = null) {
    const run = runs.get(runId)
    const card = run?.inbox.find((c) => c.id === cardId)
    if (!card) throw new Error('unknown card')
    if (card.answer) throw new Error('already answered')
    if (!choice) throw new Error('a choice is required')
    // A question may be answered in my own words; every other card is one of its buttons.
    if (!card.freeText && card.choices?.length && !card.choices.some((c) => c.id === choice)) throw new Error(`"${choice}" is not one of this card's choices`)
    if (choice === 'send-back' && card.type === 'gate' && !note) throw new Error('say what to change when sending a run back')
    card.answer = { choice, note: note || null, at: Date.now() }
    if (items && card.items) {
      // An item may only take one of the choices its card offered it.
      card.answer.items = Object.fromEntries(card.items.map((it) => [it.id, it.choices.includes(items[it.id]) ? items[it.id] : it.recommended]))
    }
    log(run, { type: 'answer', stage: card.stageId, card: card.id, key: card.key, choice, note: note || null })

    // "Take over" on any card puts the run in my hands at once. The stage
    // that raised the card treats the answer as void and asks afresh after
    // the hand-back.
    if (choice === 'take-over') { await hold(run); changed(run); return }

    if (card.type === 'paused') {
      if (choice === 'abandon') { await stopSessions(run); return finish(run, 'abandoned', 'abandoned from a paused card') }
      if (card.stageId) run.attempts[card.stageId] = 0
    }
    if (card.type === 'permission') await applyPermissionAnswer(run, card)
    if (run.state === 'waiting' && !openBlocking(run)) run.state = 'active'
    changed(run)
    kick()
  }

  /**
   * A permission card that did not stop its worker. "Allow always" widens the
   * machine's set; "allow once" permits the call for the rest of that stage,
   * or — when the run has moved on — can send the run back to it.
   */
  async function applyPermissionAnswer(run, card) {
    const { choice } = card.answer
    if (choice === 'deny' || !card.rule) return
    if (choice === 'always') {
      try { await deps.allowAlways?.(card.set, card.rule) } catch (err) {
        log(run, { type: 'error', message: `could not save "${card.rule}" to set ${card.set}: ${err.message}` })
      }
    }
    ;(run.allowOnce[card.stageId] ??= []).push(card.rule)
    if (choice === 'send-back' && card.stageId) {
      jump(run, card.stageId, { from: 'permission', reasons: [`This call is now permitted: ${card.rule}. Redo the part of the work that needed it.`] })
    }
  }

  /** "Allow always" for a call a worker was refused and got past, from the run's page. */
  async function allowRefused(runId, index) {
    const run = runs.get(runId)
    const r = run?.refused?.[index]
    if (!r) throw new Error('unknown refused call')
    await deps.allowAlways?.(r.set, r.rule)
    r.allowed = true
    log(run, { type: 'allow-always', set: r.set, rule: r.rule })
    changed(run)
  }

  // ------------------------------------------------------------ jumping

  /** Go (back) to a stage: everything from it to here runs again, with `feedback` for its worker. */
  function jump(run, stageId, feedback = null) {
    const target = run.stages.findIndex((s) => s.id === stageId)
    if (target < 0) throw new Error(`no stage "${stageId}"`)
    for (let i = target; i < run.stages.length; i++) delete run.stageState[run.stages[i].id]
    run.stageIndex = target
    run.feedback = feedback ? { ...feedback, at: Date.now() } : null
    log(run, { type: 'jump', to: stageId, feedback })
  }

  /** The stage that can fix a failure: the one named, or the nearest earlier stage that produces work. */
  function fixTarget(run, stage, named) {
    const want = named ?? stage.onFail
    if (want && run.stages.some((s) => s.id === want)) return want
    for (let i = run.stageIndex - 1; i >= 0; i--) {
      if (kinds.get(run.stages[i].kind)?.impl?.fixable) return run.stages[i].id
    }
    return stage.id
  }

  function pause(run, stage, reason, extra = {}) {
    raise(run, stage, {
      key: `paused:${stage?.id ?? 'run'}:${Date.now()}`,
      type: 'paused',
      title: `Paused at ${stage?.id ?? 'start'}`,
      body: reason,
      choices: [{ id: 'retry', label: 'Retry' }, { id: 'abandon', label: 'Abandon' }],
      recommended: 'retry',
      ...extra,
    })
    run.state = 'waiting'
    log(run, { type: 'paused', stage: stage?.id ?? null, reason })
  }

  // ------------------------------------------------------------ stepping

  async function stepRun(run) {
    if (run.state !== 'active' || busy.has(run.id)) return
    busy.add(run.id)
    try {
      // Stages that finish at once chain in one pass; the cap stops a
      // misbehaving pair of stages from spinning the process.
      for (let hop = 0; hop < 25 && run.state === 'active'; hop++) {
        const stage = currentStage(run)
        if (!stage) { finish(run, 'done'); break }
        const impl = kinds.get(stage.kind)?.impl
        let outcome
        try {
          if (!impl) throw new Error(`no stage kind "${stage.kind}"`)
          outcome = (await impl.step(makeCtx(run, stage))) ?? { wait: true }
        } catch (err) {
          outcome = { fail: { reasons: [`${stage.id} threw: ${err?.message ?? err}`] }, to: stage.id }
        }

        if (outcome.done) {
          log(run, { type: 'stage-done', stage: stage.id, note: outcome.note ?? null })
          if (stage.kind === 'pr' && run.pr) lifecycle(run, 'pr', { message: `PR opened: ${run.pr.url}` })
          if (stage.kind === 'merge') lifecycle(run, 'merged', { message: `Merged: ${run.pr?.url ?? ''}`.trim() })
          run.stageIndex++
          store.save(run)
          continue
        }
        if (outcome.goto) { jump(run, outcome.goto, outcome.feedback ?? null); store.save(run); continue }
        if (outcome.inbox) { raise(run, stage, outcome.inbox); run.state = 'waiting'; break }
        if (outcome.hold) { if (openBlocking(run)) run.state = 'waiting'; break }
        if (outcome.pause) { pause(run, stage, outcome.pause); break }
        if (outcome.fail && outcome.uncounted) {
          // My own "send back" is a direction, not a failed attempt.
          jump(run, fixTarget(run, stage, outcome.to), { from: stage.id, reasons: outcome.fail.reasons ?? [] })
          store.save(run)
          continue
        }
        if (outcome.fail) {
          const n = (run.attempts[stage.id] = (run.attempts[stage.id] ?? 0) + 1)
          const reasons = outcome.fail.reasons ?? ['failed']
          log(run, { type: 'stage-failed', stage: stage.id, attempt: n, reasons })
          const cap = machine.limits.fixRounds
          if (cap && n > cap) {
            pause(run, stage, `${stage.id} failed ${n} times. Last failure:\n\n${reasons.join('\n')}`)
            break
          }
          jump(run, fixTarget(run, stage, outcome.to), { from: stage.id, reasons })
          store.save(run)
          continue
        }
        break // wait
      }
    } finally {
      busy.delete(run.id)
      changed(run)
    }
  }

  // ---------------------------------------------------------------- ctx

  function makeCtx(run, stage) {
    const st = (run.stageState[stage.id] ??= {})
    const repo = loadRepo(run.repoPath)
    const runDir = store.dirOf(run.id)
    const ctx = {
      run, stage, state: st, repo, machine, runDir,
      /** The rest of the app: git, gh, the project index. Faked in tests. */
      app: deps.app ?? {},
      cwd: run.worktree?.dir ?? run.repoPath,
      source: sources.get(machine.sources[run.task.source]?.adapter ?? run.task.source)?.impl ?? null,
      sourceConfig: machine.sources[run.task.source] ?? {},
      feedback: run.feedback,
      log: (type, data = {}) => log(run, { type, stage: stage.id, ...data }),
      save: () => store.save(run),
      brief: () => store.readFile(run.id, 'brief.md') ?? '',
      writeFile: (rel, content) => store.writeFile(run.id, rel, content),
      readFile: (rel) => store.readFile(run.id, rel),
      answer: (key) => answerOf(run, key),
      events: () => store.events(run.id),
      /** Ask me. Returns `{ answer }` once answered, otherwise `{ outcome }` to return from step. */
      ask(card) {
        const a = answerOf(run, card.key)
        return a ? { answer: a } : { outcome: { inbox: card } }
      },
      /** A card that does not stop the run. */
      note: (card) => raise(run, stage, { blocking: false, ...card }),
      /**
       * Run a stage's `checks` list in order. `{ ok: true }`, `{ wait: true }`
       * while one is still running, or `{ ok: false, reasons }` at the first
       * that fails.
       */
      async check(list = []) {
        for (const [i, c] of list.entries()) {
          const settings = typeof c === 'string' ? { [c]: true } : c
          const name = Object.keys(settings).find((k) => checks.get(k)?.impl)
          if (!name) return { ok: false, reasons: [`unknown check ${JSON.stringify(c)}`] }
          const r = await checks.get(name).impl.run(ctx, settings, i)
          if (r.wait) return { wait: true }
          if (!r.ok) return { ok: false, reasons: r.reasons ?? [`check ${name} failed`] }
        }
        return { ok: true }
      },
      worker: (key, opts) => worker(ctx, key, opts),
      job: (key, opts) => job(ctx, key, opts),
      effect: (kind, key, fns) => effect(ctx, kind, key, fns),
    }
    return ctx
  }

  // ----------------------------------------------------------- sessions

  const sessionOf = (run, n) => run.sessions.find((s) => s.n === n)

  async function startOne(ctx, w, { role, prompt, set, schema, extraAllow, model, effort, ownsEffects }) {
    const { run, stage } = ctx
    const n = run.sessions.length + 1
    const resume = Boolean(w.sid)
    const sid = w.sid ?? crypto.randomUUID()
    const allow = [...(extraAllow ?? []), ...(run.allowOnce[stage.id] ?? [])]
    if (resolveSet(machine.permissionSets, set).edits === 'worktree') allow.push(editsUnder(ctx.cwd))
    const settings = settingsFor(machine.permissionSets, set, { extraAllow: allow })
    const full = schema
      ? { ...WORKER_SCHEMA, properties: { ...WORKER_SCHEMA.properties, output: schema } }
      : WORKER_SCHEMA

    starting++
    let started
    try {
      started = await runner.startSession({
        runDir: ctx.runDir, runId: run.id, n, cwd: ctx.cwd, prompt,
        settings, schema: full, system: workerRules(machine, { ownsEffects, allowed: settings.permissions.allow }),
        sessionId: sid, resume,
        model: model ?? machine.session.model, effort: effort ?? machine.session.effort,
        command: machine.session.command ?? deps.claudeCommand ?? 'claude',
      })
    } finally { starting-- }
    if (!started.ok) throw new Error(`could not start a session: ${started.error}`)

    run.sessions.push({
      n, sid, role, stageId: stage.id, set, resumed: resume, status: 'running',
      tmux: started.tmux, startedAt: Date.now(), endedAt: null, tokens: 0, usd: 0, activity: null,
    })
    w.n = n
    w.sid = sid
    w.phase = 'running'
    w.nextPrompt = null
    log(run, { type: 'session-start', stage: stage.id, n, role, resumed: resume })
    store.save(run)
  }

  /**
   * Run a worker to a finished answer, across as many sessions as it takes.
   *
   * A session never waits on a person: a question or a refused call it cannot
   * work around *ends* the session, the card goes to the inbox, and the answer
   * resumes the same conversation. A session whose process vanished is resumed
   * too, so work already done is not done twice.
   *
   * Returns `{ out, text }` when the worker is done, else `{ outcome }` for
   * the stage to return as-is.
   */
  async function worker(ctx, key, opts) {
    const { run, stage, state: st } = ctx
    const w = ((st.w ??= {})[key] ??= { phase: 'idle', tries: 0, sid: null, nextPrompt: null })
    const role = opts.role ?? 'worker'
    const set = opts.set ?? 'work'
    const memoKey = `${stage.id}:${key}`

    if (w.phase === 'done') return { out: w.out, text: w.text }

    if (w.phase === 'resolving') {
      const q = w.q
      const r = await worker(ctx, `${key}:resolver:${q.n}`, {
        role: 'resolver', set: 'read', fresh: true, noResolver: true, model: machine.resolver.model,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' }, confident: { type: 'boolean' }, why: { type: 'string' } },
          required: ['answer', 'confident', 'why'],
        },
        prompt: [
          'A worker on this task stopped to ask a question. Decide it from the code, the data and the rules in this repository.',
          `\n## The task\n\n${run.task.title}\n\n${store.readFile(run.id, 'brief.md') ?? ''}`,
          `\n## The question\n\n${q.text}`,
          `\n## The options\n\n${(q.options ?? []).map((o) => `- ${o}`).join('\n')}`,
          '\nPut in `output`: `answer` (one of the options, word for word), `confident` (true only if the repository settles it), and `why` in a sentence.',
          'If it depends on something only a person can decide, set confident to false. Do not ask a question of your own. Do not edit anything.',
        ].join('\n'),
      })
      if (r.outcome && !r.outcome.pause) return r
      const verdict = r.out ?? {}
      const agrees = verdict.confident === true && q.recommended && String(verdict.answer).trim() === String(q.recommended).trim()
      log(run, { type: 'resolver', stage: stage.id, question: q.text, answer: verdict.answer ?? null, confident: Boolean(verdict.confident), agrees: Boolean(agrees) })
      if (agrees) {
        log(run, { type: 'decision', stage: stage.id, by: 'resolver', what: q.text, chose: verdict.answer, why: verdict.why ?? null })
        w.nextPrompt = `Answer to your question: ${verdict.answer}\n\nContinue.`
        w.phase = 'idle'
      } else {
        // They differ, or the resolver is not sure: this one is mine.
        if (verdict.answer) w.q.summary = `${q.summary}\n\nA second session looked at this and said: ${verdict.answer}${verdict.confident ? '' : ' (not confident)'} — ${verdict.why ?? ''}`.trim()
        return askMe(w, stage, key)
      }
    }

    if (w.phase === 'question') {
      const a = answerOf(run, w.card)
      if (!a) return { outcome: { hold: true } }
      w.nextPrompt = `Answer to your question: ${a.choice}${a.note ? `\n\nNote: ${a.note}` : ''}\n\nContinue.`
      w.phase = 'idle'
    }

    if (w.phase === 'blocked') {
      const cards = run.inbox.filter((c) => w.cards.includes(c.key))
      if (cards.some((c) => !c.answer)) return { outcome: { hold: true } }
      const lines = cards.map((c) => (c.answer.choice === 'deny'
        ? `- Refused, and it stays refused: ${c.rule}`
        : `- Now permitted: ${c.rule}`))
      w.nextPrompt = `About the calls that were refused:\n${lines.join('\n')}\n\n${ONE_AT_A_TIME}\n\nContinue the task.`
      w.phase = 'idle'
    }

    if (w.phase === 'idle') {
      if (!hasSlot()) return { outcome: { wait: true, why: 'queued for a session slot' } }
      // The spend cap stops the next session from starting; it never throws
      // away one that already finished. One warning per run: "retry" on the
      // card is the go-ahead to keep spending.
      const cap = machine.limits.spendPerRun
      if (cap && run.spend.tokens > cap && !run.spendAcked) {
        run.spendAcked = true
        return { outcome: { pause: `This run has used ${run.spend.tokens.toLocaleString()} tokens, over its cap of ${cap.toLocaleString()}.` } }
      }
      let prompt = w.nextPrompt
      if (!prompt) {
        // A stage re-entered after a failed check resumes the conversation
        // that did the work, with the failures, rather than starting cold.
        const fb = run.feedback
        if (fb && !opts.fresh && run.workerSid[memoKey]) {
          w.sid = run.workerSid[memoKey]
          prompt = `A later check failed (${fb.from}). Fix these, then finish as before:\n\n${fb.reasons.map((r) => `- ${r}`).join('\n')}`
        } else {
          prompt = typeof opts.prompt === 'function' ? await opts.prompt({ feedback: fb }) : opts.prompt
        }
        if (fb) run.feedback = null
      }
      await startOne(ctx, w, { ...opts, role, set, prompt })
      return { outcome: { wait: true, why: 'session running' } }
    }

    // phase === 'running'
    const sess = sessionOf(run, w.n)
    const files = runner.sessionFiles(ctx.runDir, w.n)
    let code = runner.exitCode(files.exit)
    if (code === null) {
      if (await runner.alive(sess.tmux)) {
        const t = runner.parseTranscript(readOr(files.transcript))
        if (t.lastActivity && t.lastActivity !== sess.activity) sess.activity = t.lastActivity
        return { outcome: { wait: true, why: 'session running' } }
      }
      // It may have exited between the two looks.
      code = runner.exitCode(files.exit)
    }

    const t = runner.parseTranscript(readOr(files.transcript))
    sess.endedAt = Date.now()
    sess.tokens = t.tokens
    sess.usd = t.costUsd
    run.spend.tokens += t.tokens
    run.spend.usd += t.costUsd

    if (code === null || !t.finished || t.isError) {
      sess.status = code === null ? 'vanished' : 'failed'
      w.tries++
      log(run, { type: 'session-lost', stage: stage.id, n: w.n, status: sess.status, code, tail: runner.tail(files.err, 600) })
      if (machine.limits.fixRounds && w.tries > machine.limits.fixRounds) {
        return { outcome: { pause: `The ${role} session for ${stage.id} failed ${w.tries} times.\n\n${runner.tail(files.err, 600)}` } }
      }
      // Resume the same conversation; if the resume itself is what failed,
      // start a fresh one with the original prompt.
      if (sess.resumed && !t.sessionId) w.sid = null
      else w.nextPrompt = INTERRUPTED
      w.phase = 'idle'
      store.save(run)
      return worker(ctx, key, opts)
    }

    sess.status = 'finished'
    w.tries = 0
    run.workerSid[memoKey] = w.sid
    const out = t.structured ?? {}
    log(run, { type: 'session-end', stage: stage.id, n: w.n, status: out.status ?? null, summary: out.summary ?? null, tokens: t.tokens })
    for (const d of out.decisions ?? []) log(run, { type: 'decision', stage: stage.id, by: role, ...d })

    // A refused call only becomes a card when the worker could not go on
    // without it. The ones it got past are logged and shown on the run — a
    // card for each would bring back the confirmations this design removes
    // (the first real run raised four for harmless compound reads).
    const blocked = out.status === 'blocked'
    const cards = []
    for (const d of t.denials) {
      const rule = ruleFor(d)
      log(run, { type: 'refused', stage: stage.id, by: role, set, rule, blocked })
      if (!blocked) {
        ;(run.refused ??= []).push({ stageId: stage.id, set, rule, at: Date.now() })
        continue
      }
      const card = raise(run, stage, {
        key: `perm:${stage.id}:${rule}`,
        type: 'permission',
        title: `Refused: ${rule.slice(0, 160)}`,
        body: `The ${role} in ${stage.id} tried a call that its "${set}" permission set does not allow, and could not continue: ` +
          `${out.blocked_on ?? out.summary ?? ''}`,
        detail: rule,
        rule, set,
        choices: [
          { id: 'once', label: 'Allow once' },
          { id: 'always', label: 'Allow always' },
          { id: 'deny', label: 'Deny' },
        ],
        recommended: 'deny',
      })
      cards.push(card.key)
    }
    if (blocked) {
      if (!cards.length) return { outcome: { pause: `The ${role} in ${stage.id} is blocked: ${out.blocked_on ?? out.summary ?? 'no reason given'}` } }
      w.phase = 'blocked'
      w.cards = cards
      return { outcome: { hold: true } }
    }

    if (out.status === 'question' && out.question?.text) {
      w.q = { ...out.question, summary: out.summary ?? '', n: w.n }
      // Resolver before me: a separate session gets the question and the
      // options, not the worker's preferred answer. Its own sessions are
      // never resolved in turn.
      if (machine.resolver?.enabled && !opts.noResolver) {
        w.phase = 'resolving'
        store.save(run)
        return worker(ctx, key, opts)
      }
      return askMe(w, stage, key)
    }

    w.phase = 'done'
    w.out = out.output ?? out
    w.text = out.summary ?? t.text
    store.save(run)
    return { out: w.out, text: w.text, summary: out.summary ?? null }
  }

  function askMe(w, stage, key) {
    const q = w.q
    w.card = `q:${stage.id}:${key}:${q.n}`
    w.phase = 'question'
    return {
      outcome: {
        inbox: {
          key: w.card, type: 'question', title: q.text,
          body: q.summary ?? '',
          choices: (q.options ?? []).map((o) => ({ id: o, label: o })),
          recommended: q.recommended ?? null,
          freeText: true,
        },
      },
    }
  }

  const readOr = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }

  /**
   * What a worker needs from a failed command. The tail alone is often the
   * wrong end: a test runner prints its failure early and a page of passing
   * lines after it. So: the lines that look like failures, with a little
   * context, then the tail, then the path to the whole log.
   */
  function failureExcerpt(text, file) {
    const lines = text.split('\n')
    const hits = new Set()
    lines.forEach((l, i) => {
      if (/^not ok\b|\b(error|failed|failure|exception|assert)/i.test(l) && !/^ok\b|\b0 (failed|errors?)\b|# fail 0/.test(l)) {
        for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 8); k++) hits.add(k)
      }
    })
    const picked = [...hits].sort((a, b) => a - b).slice(0, 80).map((i) => lines[i]).join('\n')
    const tailText = lines.slice(-25).join('\n')
    return [picked && `Failing lines:\n${picked.slice(0, 4000)}`, `Last lines:\n${tailText.slice(-1500)}`, `Full output: ${file}`]
      .filter(Boolean).join('\n\n')
  }

  // --------------------------------------------------------------- jobs

  /**
   * Run a shell command in tmux and wait for it across ticks (and restarts).
   * `{ state: 'running' }`, then `{ state: 'done', code, tail }`. A command
   * that vanished without an exit code reports `{ state: 'lost' }` and is
   * forgotten, so the caller decides whether running it again is safe.
   */
  async function job(ctx, key, { cmd, cwd = ctx.cwd, timeoutMs = 30 * 60_000, env = {} }) {
    const { run, state: st } = ctx
    const jobs = (st.j ??= {})
    let j = jobs[key]
    if (!j) {
      const n = ++run.jobSeq
      const started = await runner.startJob({ runDir: ctx.runDir, runId: run.id, n, cwd, cmd, env })
      if (!started.ok) throw new Error(`could not start "${cmd}": ${started.error}`)
      j = jobs[key] = { n, tmux: started.tmux, cmd, startedAt: Date.now() }
      ctx.log('job-start', { key, cmd, n })
      store.save(run)
      return { state: 'running' }
    }
    if (j.code != null) return { state: 'done', code: j.code, tail: j.tail }
    const files = runner.jobFiles(ctx.runDir, j.n)
    let code = runner.exitCode(files.exit)
    if (code === null) {
      if (await runner.alive(j.tmux)) {
        if (Date.now() - j.startedAt > timeoutMs) {
          await runner.kill(j.tmux)
          code = 124
        } else return { state: 'running' }
      } else {
        code = runner.exitCode(files.exit)
        if (code === null) {
          delete jobs[key]
          ctx.log('job-lost', { key, cmd })
          return { state: 'lost' }
        }
      }
    }
    j.code = code
    j.tail = code === 0 ? runner.tail(files.log, 1500) : failureExcerpt(readOr(files.log), files.log)
    ctx.log('job-end', { key, cmd, code })
    store.save(run)
    return { state: 'done', code, tail: j.tail }
  }

  // ------------------------------------------------------------ effects

  /**
   * Do something that must not happen twice: a push, a PR, a merge, a tracker
   * write. An intent line goes to events.jsonl before, a result line after.
   * If the server stopped in between, the next call finds an intent with no
   * result and asks `check()` what actually happened instead of repeating it:
   *
   *   check() → a value      it did happen; record that and move on
   *   check() → null         it did not; safe to do now
   *   check() → undefined    cannot tell (or it threw) → my inbox
   *
   * Returns `{ value }`, or `{ outcome }` for the stage to return.
   */
  async function effect(ctx, kind, key, { check, act, describe }) {
    const { run, stage } = ctx
    const k = String(key)
    const s = store.effectState(run.id, kind, k)
    if (s.state === 'done') return { value: s.value }

    if (s.state === 'open') {
      const cardKey = `effect:${kind}:${k}`
      const a = answerOf(run, cardKey)
      let seen
      if (a?.choice === 'happened') seen = a.note ?? true
      else if (a?.choice === 'redo') seen = null
      else {
        try { seen = check ? await check() : undefined } catch { seen = undefined }
      }
      if (seen === undefined) {
        return {
          outcome: {
            inbox: {
              key: cardKey, type: 'effect',
              title: `Did this happen? ${describe ?? kind}`,
              body: `The server stopped while doing "${describe ?? kind}" in ${stage.id}, and its state cannot be read back. ` +
                'It will not be repeated on a guess.',
              choices: [{ id: 'happened', label: 'It happened' }, { id: 'redo', label: 'Do it now' }],
              recommended: null,
            },
          },
        }
      }
      if (seen !== null) {
        log(run, { type: 'result', effect: kind, key: k, value: seen, recovered: true })
        return { value: seen }
      }
      log(run, { type: 'intent-void', effect: kind, key: k })
    }

    log(run, { type: 'intent', effect: kind, key: k, stage: stage.id, describe: describe ?? null })
    let value
    try { value = (await act()) ?? true } catch (err) {
      // It reported failure, so nothing is half-recorded: void the intent and
      // let the stage fail in the ordinary way.
      log(run, { type: 'intent-void', effect: kind, key: k, error: String(err?.message ?? err) })
      throw err
    }
    log(run, { type: 'result', effect: kind, key: k, value })
    return { value }
  }

  // ------------------------------------------------------------ control

  /** Stop this run's sessions. Only `pm-orch-` sessions this engine started. */
  async function stopSessions(run) {
    for (const s of run.sessions) {
      if (s.status !== 'running') continue
      await runner.kill(s.tmux)
      s.status = 'stopped'
      s.endedAt = Date.now()
    }
    for (const st of Object.values(run.stageState)) {
      for (const w of Object.values(st.w ?? {})) {
        if (w.phase === 'running') { w.phase = 'idle'; w.nextPrompt = INTERRUPTED }
      }
      for (const [key, j] of Object.entries(st.j ?? {})) {
        if (j.code == null) { await runner.kill(j.tmux); delete st.j[key] }
      }
    }
  }

  /**
   * Take over: the run stops and stays stopped while I hold its worktree, so
   * two Claudes never edit the same files. `resumeSid` is the conversation to
   * continue by hand — the last worker's.
   */
  async function hold(run) {
    await stopSessions(run)
    run.state = 'held'
    run.heldAt = Date.now()
    const last = [...run.sessions].reverse().find((s) => /^(worker|skill:)/.test(s.role))
    run.resumeSid = last?.sid ?? null
    log(run, { type: 'takeover', sid: run.resumeSid })
  }

  /**
   * Hand back: the run re-checks the worktree as it now stands. It re-enters
   * at verify (or where it was, in a pipeline with no verify), so my edits go
   * through the same checks, reviewers and gates as a worker's.
   */
  function handBack(run, note) {
    if (run.state !== 'held') throw new Error('run is not held')
    if (note) {
      const brief = store.readFile(run.id, 'brief.md') ?? ''
      store.writeFile(run.id, 'brief.md', `${brief.trimEnd()}\n\n## Note added at hand-back\n\n${note}\n`)
    }
    const verify = run.stages.find((s) => s.kind === 'verify')
    const here = run.stages[run.stageIndex]
    const target = verify && run.stages.indexOf(verify) <= run.stageIndex ? verify.id : here?.id
    run.state = 'active'
    run.loop = null
    if (target) jump(run, target, null)
    log(run, { type: 'handback', note: note ?? null, to: target ?? null })
  }

  async function control(runId, action, arg = null) {
    const run = runs.get(runId)
    if (!run) throw new Error('unknown run')
    if (FINAL.has(run.state)) throw new Error(`run is ${run.state}`)
    if (action === 'takeover') {
      if (run.state === 'held') throw new Error('you already have this run')
      await hold(run)
      changed(run)
      return run
    }
    if (action === 'handback') {
      handBack(run, arg ? String(arg).slice(0, 2000) : null)
      changed(run)
      kick()
      return run
    }
    if (action === 'release') {
      await stopSessions(run)
      return finish(run, 'released', 'released: the worktree is now an ordinary project')
    }
    if (action === 'pause') {
      await stopSessions(run)
      run.state = 'paused'
    } else if (action === 'resume') {
      if (run.state !== 'paused') throw new Error('run is not paused')
      run.state = openBlocking(run) ? 'waiting' : 'active'
    } else if (action === 'abandon') {
      await stopSessions(run)
      return finish(run, 'abandoned', 'abandoned by hand')
    } else throw new Error(`unknown action "${action}"`)
    log(run, { type: action })
    changed(run)
    kick()
  }

  // --------------------------------------------------------------- loop

  async function tick() {
    await Promise.all([...runs.values()].filter((r) => r.state === 'active').map((r) => stepRun(r).catch((err) => {
      console.error(`[orch] ${r.id}: ${err?.stack ?? err}`)
    })))
  }

  let kicked = false
  function kick() {
    if (kicked) return
    kicked = true
    setImmediate(() => { kicked = false; tick().catch(() => {}) })
  }

  /** Load every run from disk. Unfinished ones simply continue on the next tick. */
  function boot() {
    for (const run of store.loadAll()) runs.set(run.id, run)
    const cutoff = Date.now() - (machine.retentionDays ?? 30) * 86_400_000
    for (const run of runs.values()) {
      if (FINAL.has(run.state) && (run.endedAt ?? run.updatedAt ?? 0) < cutoff && !run.trimmed) {
        store.trim(run.id)
        run.trimmed = true
        store.save(run)
      }
    }
    return [...runs.values()].filter((r) => !FINAL.has(r.state)).length
  }

  function start() {
    if (timer) return
    timer = setInterval(() => tick().catch(() => {}), machine.tickMs ?? 3000)
    timer.unref?.()
    kick()
  }

  const stop = () => { clearInterval(timer); timer = null }

  return {
    events, runs, boot, start, stop, tick, kick,
    createRun, answer, control, jump, stopSessions, finish, allowRefused, wip,
    get: (id) => runs.get(id) ?? null,
    list: () => [...runs.values()],
    inbox: () => [...runs.values()].flatMap((r) => (FINAL.has(r.state) ? [] : r.inbox.filter((c) => !c.answer))),
    limits: () => ({ running: runningSessions(), wip: wip(), hasSlot: hasSlot() }),
    /** Worktrees a live run owns: held from cleanup, marked in the tree. */
    ownedDirs: () => new Map([...runs.values()].filter((r) => !FINAL.has(r.state) && r.worktree?.dir).map((r) => [r.worktree.dir, r.id])),
    changed, log,
    eventsOf: (id) => store.events(id),
    pathIn: (id, rel) => path.join(store.dirOf(id), rel),
  }
}
