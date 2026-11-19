import fs from 'node:fs'
import { git, run as exec } from '../../exec.js'
import { prState } from '../lib.js'

/**
 * Gate: a stage that waits for me. One card, one decision.
 *
 * What the card shows is set by the stage's `shows`:
 *   record: "plan"            that record's fields (or just the ones in `fields`)
 *   explainBack: true         a fresh session's account of the diff: what it
 *                             does, the mechanism and the file that owns it,
 *                             what was true before, and the three questions a
 *                             reviewer is most likely to ask
 *   findings: true            what review fixed and what it left open
 *   decisions: true           choices the workers made without me
 *
 * Choices: approve, send back with a note, take over. Over a record with
 * items the card offers a choice per item instead (`itemChoices`, e.g. build /
 * park / drop); an item the validator blocked cannot take the first one.
 *
 * Auto-pass. A task may ask for a gate to pass by itself (`gateAutoPass`
 * override) — never when the record's validator said `never_auto_pass`. And a
 * gate I already approved does not ask again when the run comes back through
 * it on a fix loop that started after it (a CI fix).
 */
export default {
  kind: 'gate',

  async step(ctx) {
    const { run, stage, state: st } = ctx
    const shows = stage.shows ?? {}
    const rec = shows.record ? run.records?.[shows.record] : null
    const epochs = (run.gateEpoch ??= {})
    const approved = (run.gateApproved ??= {})

    if (approved[stage.id] && run.loop) return { done: true, note: 'already approved; passing a fix through' }

    const auto = run.overrides?.gateAutoPass
    if ((auto === true || auto === stage.id || (Array.isArray(auto) && auto.includes(stage.id))) && stage.autoPass !== 'never') {
      if (!rec?.neverAutoPass) { approved[stage.id] = true; return { done: true, note: 'auto-passed for this task' } }
    }

    // The explain-back is written before the card exists, from the diff alone.
    let explain = null
    if (shows.explainBack) {
      const w = await ctx.worker('explain', {
        role: 'explain-back', set: 'read', fresh: true, model: stage.model,
        schema: {
          type: 'object',
          properties: {
            what: { type: 'string' }, mechanism: { type: 'string' }, owner_file: { type: 'string' }, before: { type: 'string' },
            questions: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } },
          },
          required: ['what', 'mechanism', 'before', 'questions'],
        },
        prompt: () => [
          'Explain a change to the person who has to answer for it. You have not seen it being written and must work from the diff alone.',
          `Read it with: git diff ${run.worktree?.baseSha ?? run.worktree?.base ?? 'HEAD~1'}..HEAD`,
          '',
          'Put in `output`:',
          '- what: what the change does, in plain words, two or three sentences',
          '- mechanism: the mechanism it touches',
          '- owner_file: the one file that owns that mechanism',
          '- before: what was true before this change',
          '- questions: the three questions a reviewer is most likely to ask, each with its answer',
          '',
          'Do not edit anything. If the diff does not tell you something, say so rather than guessing.',
        ].join('\n'),
      })
      if (w.outcome) return w.outcome
      explain = w.out
    }

    let key = `gate:${stage.id}:${epochs[stage.id] ?? 0}`
    const items = rec?.items?.length && stage.itemChoices?.length ? rec.items : null
    const record = rec ? readJson(rec.file) : null
    let a = ctx.answer(key)
    // I took the run over from this card and have handed it back: that answer
    // is spent, and the gate asks again about the work as it now stands.
    if (a?.choice === 'take-over') {
      epochs[stage.id] = (epochs[stage.id] ?? 0) + 1
      key = `gate:${stage.id}:${epochs[stage.id]}`
      a = ctx.answer(key)
    }

    if (!a) {
      const card = buildCard(ctx, { key, record, rec, explain, items })
      return { inbox: card }
    }

    if (a.choice === 'send-back') {
      epochs[stage.id] = (epochs[stage.id] ?? 0) + 1
      approved[stage.id] = false
      const to = stage.sendBackTo ?? null
      return { fail: { reasons: [a.note ? `Sent back at ${stage.id}: ${a.note}` : `Sent back at ${stage.id} with no note. Re-check the work against the brief.`] }, to, uncounted: true }
    }
    // Approving the gate over a draft PR is what makes it ready for the team.
    // Sharing it with them stays a manual step.
    if (stage.marksReady && run.pr?.number) {
      const cwd = run.worktree?.dir ?? run.repoPath
      const ready = await ctx.effect('ready', String(run.pr.number), {
        describe: `mark #${run.pr.number} ready for review`,
        check: async () => { const pr = await prState(cwd, run.pr.number); return pr.error ? undefined : (pr.isDraft ? null : true) },
        act: async () => {
          const r = await exec('gh', ['pr', 'ready', String(run.pr.number)], { cwd, timeout: 60_000 })
          if (r.failed && !/already/i.test(r.stderr)) throw new Error(`gh pr ready failed: ${r.stderr.trim()}`)
          return true
        },
      })
      if (ready.outcome) return ready.outcome
    }

    approved[stage.id] = true
    if (items) {
      // Per-item choices: remembered on the run for the hand-off stage.
      const first = stage.itemChoices[0]
      const picked = {}
      for (const it of items) {
        const c = a.items?.[it.id] ?? stage.itemChoices.at(-1)
        picked[it.id] = it.outcome === 'block' && c === first ? stage.itemChoices[1] ?? stage.itemChoices.at(-1) : c
      }
      ;(run.choices ??= {})[shows.record] = picked
    }
    // A note on approval is a direction for whoever works next, so it joins the brief.
    if (a.note && !st.noted) {
      ctx.writeFile('brief.md', `${ctx.brief().trimEnd()}\n\n## Note added at ${stage.id}\n\n${a.note}\n`)
      st.noted = true
    }
    st.approvedAt = Date.now()
    return { done: true, note: a.note ? `approved: ${a.note}` : 'approved' }
  },
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

function buildCard(ctx, { key, record, rec, explain, items }) {
  const { run, stage } = ctx
  const shows = stage.shows ?? {}
  const body = []
  const detail = []

  if (record) {
    const fields = shows.fields ?? Object.keys(record).filter((k) => typeof record[k] !== 'object').slice(0, 8)
    for (const f of fields) if (record[f] !== undefined) body.push(`${label(f)}: ${show(record[f])}`)
    detail.push(`# ${shows.record}\n${JSON.stringify(record, null, 2)}`)
    if (rec?.neverAutoPass) body.push('This one never auto-passes: the call is yours.')
  }
  if (explain) {
    body.push(explain.what, `Mechanism: ${explain.mechanism}${explain.owner_file ? ` (${explain.owner_file})` : ''}`, `Before: ${explain.before}`)
    detail.push(`# Likely reviewer questions\n${(explain.questions ?? []).map((q) => `Q: ${q.q}\nA: ${q.a}`).join('\n\n')}`)
  }
  if (shows.findings && run.review) {
    const open = run.review.open ?? []
    body.push(`Review: ${run.review.fixed ?? 0} blocking finding${run.review.fixed === 1 ? '' : 's'} fixed, ${open.length} left open.`)
    if (open.length) detail.push(`# Findings left open\n${open.map((f) => `[${f.severity}${f.by?.length > 1 ? ', both reviewers' : ''}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} — ${f.title}\n${f.explanation ?? ''}`).join('\n\n')}`)
  }
  if (shows.decisions) {
    const decisions = ctx.events().filter((e) => e.type === 'decision')
    if (decisions.length) {
      body.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} made without you.`)
      detail.push(`# Decisions\n${decisions.map((d) => `${d.what} → ${d.chose}${d.why ? ` (${d.why})` : ''}`).join('\n')}`)
    }
  }

  const card = {
    key, type: 'gate',
    title: `${stage.title ?? label(stage.id)}: ${run.task.title}`,
    body: body.filter(Boolean).join('\n\n'),
    detail: detail.join('\n\n') || null,
    freeText: false,
    choices: [
      { id: 'approve', label: items ? 'Submit' : 'Approve' },
      { id: 'send-back', label: 'Send back' },
      { id: 'take-over', label: 'Take over' },
    ],
    recommended: 'approve',
  }
  if (items) {
    card.items = items.map((it) => {
      const entry = itemOf(record, it.id)
      return {
        id: it.id,
        label: entry ? summarise(entry, shows.itemFields) : it.id,
        blocked: it.outcome === 'block',
        reasons: it.reasons,
        choices: it.outcome === 'block' ? stage.itemChoices.slice(1) : stage.itemChoices,
        recommended: it.outcome === 'block' ? stage.itemChoices[1] ?? stage.itemChoices.at(-1) : stage.itemChoices[0],
      }
    })
  }
  return card
}

const label = (s) => String(s).replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** The list entry a validator item refers to: any array in the record with a matching `id`. */
function itemOf(record, id) {
  for (const v of Object.values(record ?? {})) {
    if (Array.isArray(v)) {
      const hit = v.find((x) => x && typeof x === 'object' && String(x.id) === String(id))
      if (hit) return hit
    }
  }
  return null
}

function summarise(entry, fields) {
  const keys = fields ?? Object.keys(entry).filter((k) => k !== 'id' && typeof entry[k] !== 'object').slice(0, 4)
  return `${entry.id}: ${keys.map((k) => `${k} ${show(entry[k])}`).join(' · ')}`
}

/** The diff's size, for a "fix ready to push" card. Shared with the pr stage. */
export async function diffStat(cwd, from, to = 'HEAD') {
  const r = await git(cwd, ['diff', '--stat', `${from}..${to}`])
  return r.failed ? '' : r.stdout.trim()
}
