#!/usr/bin/env node
/**
 * Example validator for the evidence record of an investigation. It prints an
 * outcome per cause, so the estimate gate can offer build / park / drop for
 * each one and a blocked cause cannot be sent to Build.
 *
 * Every number below is a placeholder. Set your own.
 */
import fs from 'node:fs'
import path from 'node:path'

const MIN_TRACES = 20          // traces read per cause before it counts
const SPIKE_SHARE = 0.2        // one actor above this share makes the cause a spike
const FLOOR = 100              // a cause whose low end is below this is not worth building
const MIN_DAYS = 1             // whole days in the window

const file = process.argv[2]
const record = JSON.parse(fs.readFileSync(file, 'utf8'))
const failures = []

// The pool must have been counted first: it is its own record, written by the stage before this one.
const pool = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'pool.json'), 'utf8')) } catch { return null } })()
if (!pool) failures.push('there is no pool record; the pool is counted before any cause is named')
else if (pool.pool_total !== record.pool_total) failures.push(`pool_total (${record.pool_total}) does not match the pool record (${pool.pool_total})`)

if ((record.window?.days ?? 0) < MIN_DAYS) failures.push(`the window must cover at least ${MIN_DAYS} whole day(s)`)
const shares = (record.causes ?? []).reduce((a, c) => a + c.share, 0)
if (shares > 1.001) failures.push(`cause shares add up to ${shares.toFixed(2)}, more than the whole pool`)
for (const ref of record.data_refs ?? []) if (!fs.existsSync(ref)) failures.push(`data_refs names a file that does not exist: ${ref}`)

const items = (record.causes ?? []).map((c) => {
  const reasons = []
  if (c.low > c.high) failures.push(`${c.id}: low is above high`)
  if (c.low === c.high) failures.push(`${c.id}: give a low–high range, not one number`)
  if (c.traces_read !== (c.trace_ids ?? []).length) failures.push(`${c.id}: traces_read is ${c.traces_read} but ${c.trace_ids?.length ?? 0} trace ids are listed`)
  if (c.basis !== 'seen in trace') reasons.push('inferred from code, not seen in a trace')
  if (c.traces_read < MIN_TRACES) reasons.push(`only ${c.traces_read} traces read; the minimum is ${MIN_TRACES}`)
  if (c.top_actor_share > SPIKE_SHARE) reasons.push(`one actor is ${Math.round(c.top_actor_share * 100)}% of it: a spike, to be priced without that actor`)
  if (c.low < FLOOR) reasons.push(`low end ${c.low} is below the floor of ${FLOOR}`)
  return { id: c.id, outcome: reasons.length ? 'block' : 'pass', reasons }
})

console.log(JSON.stringify({ ok: failures.length === 0, never_auto_pass: true, failures, items }))
process.exit(failures.length ? 1 : 0)
