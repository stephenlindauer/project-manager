import fs from 'node:fs'
import path from 'node:path'
import { resolveIn } from '../config.js'
import { lastJson } from './record.js'
import { sq } from '../runner.js'

/**
 * Post-check: did the change move the number it said it would?
 *
 * The plan record carries the prediction — the metric, how to read it, the
 * baseline, a low–high predicted range, the earliest date the check can run.
 * This stage waits (the deploy stage before it has already confirmed the
 * change is live, not merely merged), reads the metric, and records
 * predicted against measured.
 *
 * Reading the metric. `read_with` in the record was written by a model, so
 * it is not handed to a shell: a session in the `read` permission set runs
 * it, which means only the machine's allowlisted read tools can execute. A
 * machine that would rather run its own command sets `command` on the stage;
 * it gets the record's path and prints `{ "measured": <number> }`.
 *
 * Below the threshold (start: half of predicted), the run goes to my inbox
 * with both numbers, and the card is only closed by writing the reason.
 * While it is open, `ctx.blockedAreas()` reports the area, and a record
 * stage in the same area waits — no new estimate until this one is explained.
 */

/** How much of the predicted change showed up. Pure, so the rule can be tested. */
export function verdict({ baseline, low, high, measured }, threshold = 0.5) {
  const predicted = (Number(low) + Number(high)) / 2 - Number(baseline)
  const actual = Number(measured) - Number(baseline)
  if (![predicted, actual].every(Number.isFinite)) return { ok: false, ratio: null, why: 'the prediction or the measurement is not a number' }
  if (predicted === 0) return { ok: true, ratio: null, why: 'the prediction was no change' }
  const ratio = actual / predicted
  return { ok: ratio >= threshold, ratio, predicted, actual }
}

export default {
  kind: 'post-check',

  async step(ctx) {
    const { run, stage, state: st } = ctx
    const rec = run.records?.[stage.record ?? 'plan']
    if (!rec) return { done: true, note: 'no record with a prediction; nothing to check' }
    const record = JSON.parse(fs.readFileSync(rec.file, 'utf8'))
    const p = record[stage.field ?? 'prediction']
    if (!p) return { done: true, note: 'the record carries no prediction' }

    // Wait for the configured time after the stage is reached (the deploy
    // check has passed by then), and never before the plan's own date.
    st.reachedAt ??= Date.now()
    const earliest = Date.parse(`${p.earliest_check}T00:00:00`)
    const due = Math.max(st.reachedAt + (stage.waitHours ?? 24) * 3_600_000, Number.isFinite(earliest) ? earliest : 0)
    if (Date.now() < due) {
      st.waitingOn = `the post-check, due ${new Date(due).toISOString().slice(0, 10)}`
      return { wait: true }
    }

    let measured = st.measured
    let how = st.how
    if (measured == null) {
      if (stage.command) {
        const j = await ctx.job('measure', { cmd: `${stage.command} ${sq(rec.file)}`, cwd: ctx.machine.dir, timeoutMs: (stage.timeoutMinutes ?? 15) * 60_000 })
        if (j.state !== 'done') return { wait: true }
        const printed = lastJson(readOr(path.join(ctx.runDir, 'jobs', `${st.j.measure.n}.log`)))
        if (j.code !== 0 || typeof printed?.measured !== 'number') return { pause: `The post-check command did not print { "measured": <number> }:\n\n${j.tail}` }
        measured = printed.measured
        how = stage.command
      } else {
        const w = await ctx.worker('measure', {
          role: 'post-check', set: 'read', fresh: true, noResolver: true, model: stage.model, extraAllow: stage.allow ?? [],
          schema: { type: 'object', properties: { measured: { type: 'number' }, how: { type: 'string' }, window: { type: 'string' } }, required: ['measured', 'how'] },
          prompt: () => [
            'Read one metric and report its current value. Do not change anything.',
            `\nMetric: ${p.metric}`,
            `How the plan says to read it: ${p.read_with}`,
            `Baseline: ${p.baseline} (${p.baseline_window ?? 'window not stated'})`,
            '\nRead it over a comparable window. Put the number in `output.measured`, and in `output.how` exactly what you ran and the window you used.',
            'If you cannot read it with the tools you have, finish with status "blocked" and say what you needed. Do not estimate.',
          ].join('\n'),
        })
        if (w.outcome) return w.outcome
        measured = w.out?.measured
        how = w.out?.how ?? null
        if (typeof measured !== 'number') return { pause: 'The post-check session did not return a number.' }
      }
      st.measured = measured
      st.how = how
      ctx.save()
    }

    const v = verdict({ ...p, measured }, stage.threshold ?? 0.5)
    const result = {
      run: run.id, at: new Date().toISOString(), task: run.task.title, url: run.task.url ?? null, pr: run.pr?.url ?? null,
      metric: p.metric, baseline: p.baseline, predicted: { low: p.low, high: p.high }, measured, ratio: v.ratio, ok: v.ok, how,
    }
    run.postCheck = result

    if (stage.ledger) {
      const row = await ctx.effect('ledger', 'post-check', {
        describe: 'write predicted against measured to the ledger',
        check: async () => (readOr(resolveIn(ctx.machine, stage.ledger)).includes(`"run":"${run.id}","at"`) ? true : null),
        act: async () => {
          const file = resolveIn(ctx.machine, stage.ledger)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.appendFileSync(file, `${JSON.stringify(result)}\n`)
          return true
        },
      })
      if (row.outcome) return row.outcome
    }

    if (v.ok) return { done: true, note: `measured ${measured} against a predicted ${p.low}–${p.high}` }

    const ask = ctx.ask({
      key: 'post-check', type: 'post-check',
      area: stage.area ?? run.repoName,
      title: `Below prediction: ${run.task.title}`,
      body: [
        `${p.metric}: predicted ${p.low}–${p.high} from a baseline of ${p.baseline}; measured ${measured}.`,
        v.ratio == null ? v.why : `That is ${Math.round(v.ratio * 100)}% of the predicted change.`,
        `No new estimate in "${stage.area ?? run.repoName}" passes until the reason is written here.`,
      ].join('\n\n'),
      detail: how,
      freeText: true,
      choices: [],
      recommended: null,
    })
    if (ask.outcome) return ask.outcome
    // The answer is the reason. It goes in the ledger beside the numbers.
    if (stage.ledger && !st.reasonLogged) {
      fs.appendFileSync(resolveIn(ctx.machine, stage.ledger), `${JSON.stringify({ run: run.id, reason: ask.answer.choice, at: new Date().toISOString() })}\n`)
      st.reasonLogged = true
      ctx.save()
    }
    run.postCheck.reason = ask.answer.choice
    return { done: true, note: `below prediction; reason recorded` }
  },
}

const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
