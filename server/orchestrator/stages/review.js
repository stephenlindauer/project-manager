import fs from 'node:fs'
import path from 'node:path'
import { git } from '../../exec.js'
import { resolveIn } from '../config.js'
import { runSlot, slotsFor } from '../slots.js'

/**
 * Review: fresh sessions that never saw the code being written check the diff
 * against the team's rules, before any person does.
 *
 * Reviewer slots. Each slot is a model and a runner, not a fixed product; a
 * machine can run one, two or none (`reviewers` on the stage or the machine).
 *   { "name": "claude", "runner": "claude", "model": null }
 *   { "name": "second", "runner": "command", "command": "…" }
 * A `command` reviewer is any program: it reads the prompt from the file in
 * $PM_REVIEW_PROMPT, and prints (or writes to $PM_REVIEW_OUT) the same JSON a
 * Claude reviewer returns. That is how a second model is plugged in without
 * this app knowing its CLI.
 *
 * House rules. A per-repo checklist named in the repo file: rule files to
 * read, review skills to follow, and an optional mined list.
 *
 * Merging findings. A finding both reviewers flag is shown first; one flagged
 * by a single reviewer is shown marked lower. Only findings at or above the
 * blocking severity stop the run. One rule is not a judgement call and is
 * checked by code: deleting a test file always blocks.
 */

const ORDER = ['nit', 'minor', 'major', 'blocking']
const rank = (s) => Math.max(0, ORDER.indexOf(String(s).toLowerCase()))

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ORDER }, file: { type: 'string' }, line: { type: 'integer' },
          confidence: { type: 'number' }, title: { type: 'string' }, explanation: { type: 'string' },
        },
        required: ['severity', 'title', 'explanation'],
      },
    },
    tests_weakened: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings'],
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.[a-z]+$/i

export default {
  kind: 'review',

  async step(ctx) {
    const { run, stage, state: st } = ctx
    const wt = run.worktree
    if (!wt) return { pause: 'There is no worktree to review.' }
    const active = slotsFor(ctx)
    const from = wt.baseSha ?? wt.base

    const prompt = () => reviewPrompt(ctx, from)
    const results = []
    let waiting = false
    for (const slot of active) {
      const r = await runSlot(ctx, slot, `r-${slot.name}`, {
        role: `reviewer:${slot.name}`, schema: FINDINGS, prompt, model: stage.model,
        shape: '{ "findings": [{ "severity", "file", "line", "confidence", "title", "explanation" }], "tests_weakened": [] }',
      })
      // Start every slot before waiting on any: they review in parallel.
      if (r.outcome) {
        if (!r.outcome.wait) return r.outcome
        waiting = true
        continue
      }
      const o = r.out ?? {}
      results.push({ slot: slot.name, out: { findings: Array.isArray(o.findings) ? o.findings : [], tests_weakened: o.tests_weakened ?? [] } })
    }
    if (waiting) return { wait: true }

    const merged = merge(results)
    // Not a judgement call, so not left to a reviewer: a deleted test file blocks.
    const deleted = await git(wt.dir, ['diff', '--name-only', '--diff-filter=D', `${from}..HEAD`])
    for (const f of deleted.stdout.split('\n').filter((x) => x && TEST_FILE.test(x))) {
      merged.unshift({ severity: 'blocking', file: f, title: 'A test file was deleted', explanation: `${f} was removed by this change. Deleting or weakening tests is always blocking.`, by: ['code'] })
    }
    for (const r of results) {
      for (const t of r.out.tests_weakened ?? []) {
        merged.unshift({ severity: 'blocking', title: 'A test was weakened', explanation: t, by: [r.slot] })
      }
    }

    const blockAt = rank(stage.blockAt ?? 'blocking')
    const blocking = merged.filter((f) => rank(f.severity) >= blockAt)
    const review = (run.review ??= { rounds: 0, fixed: 0, open: [] })
    review.rounds++
    fs.writeFileSync(path.join(ctx.runDir, `review-${review.rounds}.json`), JSON.stringify({ results, merged }, null, 2))

    if (blocking.length) {
      st.blocked = blocking.length
      review.pending = blocking.length
      return {
        fail: {
          reasons: blocking.map((f) => `[${f.severity}${f.by.length > 1 ? ', flagged by both reviewers' : ''}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title}\n${f.explanation}`),
        },
      }
    }
    // What the last round blocked on and this round no longer finds was fixed.
    review.fixed += review.pending ?? 0
    review.pending = 0
    review.open = merged
    return { done: true, note: `${merged.length} finding${merged.length === 1 ? '' : 's'} left open, none blocking` }
  },
}

function reviewPrompt(ctx, from) {
  const { run, repo } = ctx
  const rules = []
  for (const r of repo.houseRules ?? []) {
    if (typeof r === 'string') rules.push(`- Read and apply: ${r}`)
    else if (r.skill) rules.push(`- Follow the review skill /${r.skill}`)
    else if (r.file) rules.push(`- Read and apply: ${r.file}`)
    else if (r.mined) {
      const text = readOr(resolveIn(ctx.machine, r.mined))
      if (text.trim()) rules.push(`- Rules learned from earlier reviews of this repo:\n${text.trim()}`)
    }
  }
  const plan = Object.entries(run.records ?? {}).map(([name, r]) => `- ${name}: ${r.file}`)
  return [
    'Review a change before a teammate does. You did not write it and have not seen it being written.',
    `Read the diff with: git diff ${from}..HEAD   (and git log ${from}..HEAD for the commits)`,
    '',
    `## The task\n\n${run.task.title}\n\n${ctx.brief().trim()}`,
    rules.length ? `\n## House rules\n\n${rules.join('\n')}` : '\n## House rules\n\nThe repository\'s own CLAUDE.md and conventions.',
    plan.length ? `\n## Records for this run\n\n${plan.join('\n')}\nIf a record names precedent changes, check the diff against them.` : '',
    '',
    '## What to return',
    '',
    'Put in `output` a `findings` list. For each: severity (blocking, major, minor, nit), file, line, confidence 0–1, a short title, and an explanation a busy author can act on.',
    '"blocking" means a teammate would be right to stop the PR for it: a bug, a broken rule, a missing case the task named.',
    'If any test was deleted or made to assert less, list each in `tests_weakened`.',
    'Report only what you checked in the code. No praise, no summary of the change. An empty list is a valid answer.',
    'Do not edit anything.',
  ].join('\n')
}

const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

/**
 * One list from several reviewers. Two findings are the same finding when
 * they are in the same file within a few lines of each other; the merged one
 * keeps the higher severity and names both reviewers. Flagged-by-both first.
 */
export function merge(results) {
  const out = []
  for (const { slot, out: r } of results) {
    for (const f of r.findings ?? []) {
      const same = out.find((o) => o.file && f.file && o.file === f.file && !o.by.includes(slot) &&
        (o.line == null || f.line == null || Math.abs(o.line - f.line) <= 5))
      if (same) {
        same.by.push(slot)
        if (rank(f.severity) > rank(same.severity)) same.severity = f.severity
        same.explanation = `${same.explanation}\n\n(${slot}) ${f.explanation}`
      } else {
        out.push({ severity: f.severity, file: f.file ?? null, line: f.line ?? null, confidence: f.confidence ?? null, title: f.title, explanation: f.explanation, by: [slot] })
      }
    }
  }
  return out.sort((a, b) => b.by.length - a.by.length || rank(b.severity) - rank(a.severity))
}
