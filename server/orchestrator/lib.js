import fs from 'node:fs'
import { run, git } from '../exec.js'
import { resolveIn } from './config.js'

/** Small helpers shared by stage kinds. Nothing here keeps state. */

export const out = (r) => r.stdout.trim()
export const err = (r) => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`)

export async function headSha(cwd) {
  const r = await git(cwd, ['rev-parse', 'HEAD'])
  return r.failed ? null : out(r)
}

export async function commitsAhead(cwd, base) {
  const r = await git(cwd, ['rev-list', '--count', `${base}..HEAD`])
  return r.failed ? 0 : Number(out(r)) || 0
}

export async function dirtyFiles(cwd) {
  const r = await git(cwd, ['status', '--porcelain'])
  return r.failed ? [] : r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3))
}

const PR_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,mergedAt,statusCheckRollup,reviews'

/**
 * One PR's state, for the stages that wait on it. Asking for
 * `statusCheckRollup` is fine here — it is one PR, not the repo-wide list
 * that overruns GitHub's budget.
 */
export async function prState(cwd, ref) {
  const r = await run('gh', ['pr', 'view', ...(ref == null ? [] : [String(ref)]), '--json', PR_FIELDS], { cwd, timeout: 30_000 })
  if (r.failed) return { error: err(r), missing: /no pull requests found|could not resolve/i.test(r.stderr) }
  let pr
  try { pr = JSON.parse(r.stdout) } catch { return { error: 'gh returned something that is not JSON' } }
  const checks = (pr.statusCheckRollup ?? []).map((c) => ({
    name: c.name ?? c.context ?? 'check',
    state: (c.conclusion || c.state || c.status || '').toUpperCase(),
  }))
  const bad = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
  const good = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
  const latest = new Map()
  for (const rv of pr.reviews ?? []) if (rv.author?.login) latest.set(rv.author.login, rv.state)
  return {
    number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision || null,
    head: pr.headRefOid, headRef: pr.headRefName, baseRef: pr.baseRefName, mergedAt: pr.mergedAt ?? null,
    checks,
    failed: checks.filter((c) => bad.has(c.state)).map((c) => c.name),
    pending: checks.filter((c) => !bad.has(c.state) && !good.has(c.state)).map((c) => c.name),
    approvals: [...latest.values()].filter((s) => s === 'APPROVED').length,
    changesRequested: [...latest.values()].some((s) => s === 'CHANGES_REQUESTED'),
  }
}

/** Don't ask GitHub every tick. True when `key` is due; schedules the next. */
export function due(state, key, everyMs) {
  const now = Date.now()
  const at = (state.due ??= {})
  if ((at[key] ?? 0) > now) return false
  at[key] = now + everyMs
  return true
}

/** A stage's prompt: inline text, or a markdown file beside the machine config. */
export function promptText(machine, value) {
  if (!value) return null
  if (/\.md$/.test(value) && !value.includes('\n')) {
    try { return fs.readFileSync(resolveIn(machine, value), 'utf8') } catch { return null }
  }
  return value
}

/** The opening every worker prompt shares: what the task is. */
export function taskHeader(ctx) {
  const { task } = ctx.run
  const lines = [`# Task: ${task.title}`]
  if (task.url) lines.push(task.url)
  lines.push('', '## Brief', '', ctx.brief().trim(), '')
  return lines.join('\n')
}
