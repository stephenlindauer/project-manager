#!/usr/bin/env node
/**
 * Example validator for the plan record. A validator is any command: it gets
 * the record's path, exits 0 on pass, and prints one JSON result:
 *
 *   { ok, never_auto_pass, failures: [...], items: [{ id, outcome, reasons }] }
 *
 * The thresholds here are placeholders. This is where a machine's own rules
 * belong; replace them with yours.
 */
import fs from 'node:fs'

const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const failures = []

const p = record.prediction ?? {}
if (!(p.low <= p.high)) failures.push('prediction.low must not be above prediction.high: give a range, not one number')
if (p.low === p.high) failures.push('prediction is a single number. State a low and a high.')
// Compared as local calendar dates: `new Date()` is UTC and is already
// "tomorrow" for part of every evening.
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
if (!(String(p.earliest_check) > today)) failures.push(`prediction.earliest_check must be a date after today (${today})`)
for (const [i, pr] of (record.precedents ?? []).entries()) {
  if (!/\w/.test(pr.ref ?? '')) failures.push(`precedents[${i}].ref must name a real change (a commit, a PR)`)
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  // A plan that treats a symptom is a call for a person, whatever the task says.
  never_auto_pass: record.fix_kind === 'symptom',
  failures,
  items: [],
}))
process.exit(failures.length ? 1 : 0)
