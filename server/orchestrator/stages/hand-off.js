import fs from 'node:fs'
import path from 'node:path'
import { resolveIn } from '../config.js'

/**
 * Hand-off: turn what I chose at the gate into what happens next.
 *
 * For a record with items (an investigation's causes), each item I marked
 * with the stage's `choice` (default: the first of the gate's item choices,
 * "build") becomes a new run of `pipeline`, with the record attached as its
 * evidence. Every other item gets a row in the ledger, so a cause that was
 * parked or dropped is on record with the reason it was not built.
 *
 * Each new run and each ledger row goes through `ctx.effect`, keyed by the
 * item: a restart half-way through creates only the ones still missing.
 */
export default {
  kind: 'hand-off',

  async step(ctx) {
    const { run, stage } = ctx
    const name = stage.record
    const rec = run.records?.[name]
    const picks = run.choices?.[name]
    if (!rec || !picks) return { pause: `hand-off needs record "${name}" and the choices made for it at a gate with itemChoices.` }
    const record = JSON.parse(fs.readFileSync(rec.file, 'utf8'))
    const build = stage.choice ?? 'build'
    const entries = Object.values(record).find((v) => Array.isArray(v) && v.some((x) => x && picks[String(x.id)] !== undefined)) ?? []
    const made = []

    for (const [id, choice] of Object.entries(picks)) {
      const entry = entries.find((x) => String(x.id) === id) ?? { id }
      if (choice === build) {
        const child = await ctx.effect('hand-off', id, {
          describe: `start a ${stage.pipeline ?? 'code-change'} run for "${id}"`,
          check: async () => ctx.app.childRun?.(run.id, id) ?? null,
          act: async () => ctx.app.startChild({
            parent: run, item: id, pipeline: stage.pipeline ?? null,
            title: `${run.task.title}: ${entry.title ?? entry.name ?? id}`,
            brief: [
              `${run.task.title}: ${entry.title ?? entry.name ?? id}`,
              '',
              `This task came out of an investigation (run ${run.id}). Build the fix for one of its causes: \`${id}\`.`,
              '',
              '## The evidence for this cause',
              '',
              '```json', JSON.stringify(entry, null, 2), '```',
              '',
              `The full record is attached to this run as \`${name}.json\`.`,
              '',
              '## The original question',
              '',
              ctx.brief().trim(),
            ].join('\n'),
            records: { [name]: rec.file },
          }),
        })
        if (child.outcome) return child.outcome
        made.push(child.value)
      } else if (stage.ledger) {
        const row = await ctx.effect('ledger', id, {
          describe: `ledger row for "${id}" (${choice})`,
          // An append cannot be read back reliably by key in a file a person
          // also edits, so look for this run's own marker.
          check: async () => {
            const text = readOr(resolveIn(ctx.machine, stage.ledger))
            return text.includes(`"run":"${run.id}","item":${JSON.stringify(id)}`) ? true : null
          },
          act: async () => {
            const file = resolveIn(ctx.machine, stage.ledger)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.appendFileSync(file, `${JSON.stringify({ run: run.id, item: id, at: new Date().toISOString(), task: run.task.title, url: run.task.url ?? null, choice, entry })}\n`)
            return true
          },
        })
        if (row.outcome) return row.outcome
      }
    }
    return { done: true, note: `${made.length} run${made.length === 1 ? '' : 's'} started` }
  },
}

const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
