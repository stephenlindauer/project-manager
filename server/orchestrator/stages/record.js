import fs from 'node:fs'
import path from 'node:path'
import { resolveIn } from '../config.js'
import { check } from '../schema.js'
import { editsUnder, commandRule } from '../permissions.js'
import { promptText, taskHeader } from '../lib.js'
import { sq } from '../runner.js'

/**
 * Record: the model must show its work, and code checks it.
 *
 * A worker writes one JSON file — a plan, an evidence record — and the stage
 * is done only when that file passes two checks, neither of them a model:
 *
 *   schema      a JSON Schema file: shape, required fields, enums, counts
 *   validator   one command, named in config. It gets the record's path, exits
 *               0 on pass and prints a JSON result. This is where a machine's
 *               own rules live — windows, floors, coverage, concentration —
 *               in whatever language that machine likes.
 *
 * Validator result:
 *   { ok, never_auto_pass, failures: [...],
 *     items: [{ id, outcome: "pass" | "block", reasons: [...] }] }
 *
 * `items` gives an outcome per entry of a list (causes, options), so the next
 * gate can offer a choice per item and a blocked one cannot be sent on.
 *
 * When one thing must be computed before another, make them two record
 * stages: the second stage's validator can read the first record.
 */
export default {
  kind: 'record',
  fixable: true,

  async step(ctx) {
    const { stage, run, state: st } = ctx
    const name = stage.record ?? stage.name ?? 'record'
    const file = path.join(ctx.runDir, 'records', `${name}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })

    // A machine can hold new estimates in an area while an earlier one there
    // came in below prediction and nobody has written down why.
    if (stage.area && !st.w) {
      const held = ctx.blockedAreas().find((b) => b.area === stage.area && b.runId !== run.id)
      if (held) { st.waitingOn = `the reason for a post-check below prediction in "${stage.area}" (${held.task})`; return { wait: true } }
    }

    const schema = stage.schema ? readJson(resolveIn(ctx.machine, stage.schema)) : null
    if (stage.schema && !schema) return { pause: `The schema for record "${name}" could not be read: ${stage.schema}` }

    const earlier = Object.keys(run.records ?? {}).filter((r) => r !== name)
    const w = await ctx.worker('main', {
      role: `record:${name}`,
      set: stage.set ?? 'record',
      model: stage.model,
      // The record file, and any data folders this machine names for the stage.
      // Plus the repo's own checks: a plan that says "the test fails" should have run it.
      extraAllow: [
        `Edit(/${file})`, ...(stage.dataDirs ?? []).map((d) => editsUnder(resolveIn(ctx.machine, d))),
        ...(ctx.repo.verify ?? []).map(commandRule), ...(stage.allow ?? []),
      ],
      prompt: () => [
        taskHeader(ctx),
        promptText(ctx.machine, stage.prompt) ?? `## What to do\n\nProduce the "${name}" record for this task.`,
        '',
        `Write the record as one JSON file at:\n${file}`,
        'Do not change any other file. Every number in it must come from something you actually read or ran; say which in the record where it has a field for it.',
        schema ? `\nIt must fit this schema:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`` : '',
        earlier.length ? `\nEarlier records for this run are in ${path.dirname(file)}: ${earlier.map((r) => `${r}.json`).join(', ')}.` : '',
      ].join('\n'),
    })
    if (w.outcome) return w.outcome

    const again = (reasons) => { delete st.w; delete st.j; return { fail: { reasons }, to: stage.id } }

    let record
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
      return again([`The record file is missing or is not valid JSON (${err.code ?? err.message}). Write it to ${file}.`])
    }
    const shape = schema ? check(schema, record, name) : []
    if (shape.length) return again(shape.slice(0, 40).map((f) => `Schema: ${f}`))

    let result = { ok: true, never_auto_pass: false, failures: [], items: [] }
    if (stage.validator) {
      const cmd = `${stage.validator} ${sq(file)}`
      const j = await ctx.job('validate', { cmd, cwd: ctx.machine.dir, timeoutMs: (stage.timeoutMinutes ?? 10) * 60_000 })
      if (j.state !== 'done') return { wait: true }
      const printed = lastJson(readFile(path.join(ctx.runDir, 'jobs', `${st.j.validate.n}.log`)))
      if (!printed && j.code !== 0) return { pause: `The validator for record "${name}" failed without a result:\n\n${j.tail}` }
      result = { ok: j.code === 0, never_auto_pass: false, failures: [], items: [], ...(printed ?? {}) }
      if (j.code !== 0) result.ok = false
      if (!result.ok) {
        const reasons = [...(result.failures ?? [])]
        // Blocked items are not failures of the record: the record may be
        // right that a cause is too small. Only whole-record failures loop.
        if (!reasons.length) reasons.push(`The validator rejected the record:\n\n${j.tail}`)
        return again(reasons.map((r) => `Validator: ${r}`))
      }
    }

    fs.writeFileSync(path.join(ctx.runDir, 'records', `${name}.result.json`), JSON.stringify(result, null, 2))
    ;(run.records ??= {})[name] = {
      file, neverAutoPass: Boolean(result.never_auto_pass),
      items: (result.items ?? []).map((i) => ({ id: String(i.id), outcome: i.outcome === 'block' ? 'block' : 'pass', reasons: i.reasons ?? [] })),
    }
    return { done: true, note: `${name} passed its schema${stage.validator ? ' and validator' : ''}` }
  },
}

const readFile = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

/** The last JSON object a command printed, ignoring anything it logged around it. */
export function lastJson(text) {
  const s = String(text ?? '')
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0
    for (let i = end; i >= 0; i--) {
      if (s[i] === '}') depth++
      else if (s[i] === '{' && --depth === 0) {
        try { return JSON.parse(s.slice(i, end + 1)) } catch { break }
      }
    }
  }
  return null
}
