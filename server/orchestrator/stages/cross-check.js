import fs from 'node:fs'
import path from 'node:path'
import { runSlot, slotsFor } from '../slots.js'

/**
 * Cross-check: a second model redoes a record's calculation, step by step,
 * from the same stored data — and code compares the two.
 *
 * Two models can give very different totals for the same thing, and totals
 * hide where they differ. So the comparison is per step:
 *
 *   - the second model gets the question and the record's data references,
 *     and the *names* of the items and steps. Never the first model's numbers.
 *   - it returns the same steps shape
 *   - a step that differs by more than a set factor (start: 1.5×) is marked
 *   - the next gate shows only the marked steps, with both values and sources
 *
 * It applies to any record whose items carry `steps: [{ name, value, source }]`.
 * This stage never blocks: it marks. What to do about a marked step is mine
 * to decide at the gate.
 */

const ANSWER = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'number' }, source: { type: 'string' } },
              required: ['name', 'value', 'source'],
            },
          },
        },
        required: ['id', 'steps'],
      },
    },
  },
  required: ['items'],
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

/** The record's list whose entries carry calculation steps. */
export function stepItems(record, field = null) {
  const lists = field ? [record?.[field]] : Object.values(record ?? {})
  for (const v of lists) {
    if (Array.isArray(v) && v.some((x) => x && Array.isArray(x.steps))) return v.filter((x) => Array.isArray(x.steps))
  }
  return []
}

/** Compare two step lists per item. Pure, so the rule can be tested without a model. */
export function compare(first, second, tolerance = 1.5) {
  const marked = []
  let compared = 0
  const byId = new Map((second ?? []).map((i) => [String(i.id), i]))
  for (const item of first) {
    const other = byId.get(String(item.id))
    const theirs = new Map((other?.steps ?? []).map((s) => [String(s.name).toLowerCase(), s]))
    for (const step of item.steps) {
      const b = theirs.get(String(step.name).toLowerCase())
      if (!b) { marked.push({ item: String(item.id), step: step.name, first: step, second: null, why: 'the second model gave no value for this step' }); continue }
      compared++
      const x = Number(step.value)
      const y = Number(b.value)
      let why = null
      let ratio = null
      if (!Number.isFinite(x) || !Number.isFinite(y)) why = 'one of the values is not a number'
      else if (x === y) continue
      else if (x === 0 || y === 0 || Math.sign(x) !== Math.sign(y)) why = 'one is zero or they have opposite signs'
      else {
        ratio = Math.max(Math.abs(x), Math.abs(y)) / Math.min(Math.abs(x), Math.abs(y))
        if (ratio > tolerance) why = `differs by ${ratio.toFixed(2)}×, over the ${tolerance}× tolerance`
      }
      if (why) marked.push({ item: String(item.id), step: step.name, first: step, second: b, ratio, why })
    }
  }
  return { marked, compared }
}

export default {
  kind: 'cross-check',

  async step(ctx) {
    const { run, stage } = ctx
    const name = stage.record
    const rec = run.records?.[name]
    if (!rec) return { pause: `cross-check names record "${name}", which this run has not produced.` }
    const record = readJson(rec.file)
    const first = stepItems(record, stage.stepsIn)
    if (!first.length) return { done: true, note: `record "${name}" has no calculation steps to cross-check` }

    const [slot] = slotsFor(ctx, stage.slot)
    if (!slot) return { pause: `cross-check names reviewer slot "${stage.slot}", which is not configured.` }
    const refs = record[stage.dataRefs ?? 'data_refs'] ?? []

    const r = await runSlot(ctx, slot, 'second', {
      role: `cross-check:${slot.name}`, schema: ANSWER, model: stage.model,
      extraAllow: stage.allow ?? [],
      shape: '{ "items": [{ "id", "steps": [{ "name", "value", "source" }] }] }',
      prompt: () => [
        'Redo a calculation independently. Another analyst has already done it; you are not shown their numbers, and must not look for them.',
        `Do not read ${rec.file} or any other file in ${path.dirname(rec.file)}.`,
        `\n## The question\n\n${run.task.title}\n\n${ctx.brief().trim()}`,
        `\n## The stored data to work from\n\n${(Array.isArray(refs) ? refs : [refs]).map((x) => `- ${x}`).join('\n') || '(none listed)'}`,
        '\n## What to compute',
        '',
        'For each item below, give a value for each named step, and say where each value came from (the file and what you read in it).',
        ...first.map((i) => `- item \`${i.id}\`: ${i.steps.map((s) => `\`${s.name}\``).join(', ')}`),
        '',
        'Use the stored data only; do not pull new data. If a step cannot be computed from it, leave that step out rather than guessing.',
        'Put the answer in `output.items`, each with its `id` and `steps` (name, value, source). Do not edit anything.',
      ].join('\n'),
    })
    if (r.outcome) return r.outcome

    const { marked, compared } = compare(first, r.out?.items ?? [], stage.tolerance ?? 1.5)
    const file = path.join(ctx.runDir, 'records', `${name}.crosscheck.json`)
    fs.writeFileSync(file, JSON.stringify({ tolerance: stage.tolerance ?? 1.5, slot: slot.name, compared, marked, second: r.out?.items ?? [] }, null, 2))
    ;(run.crosscheck ??= {})[name] = { file, compared, marked: marked.length }
    return { done: true, note: `${marked.length} of ${compared + marked.filter((m) => !m.second).length} steps marked` }
  },
}
