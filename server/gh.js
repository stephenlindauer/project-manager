import { run } from './exec.js'

let ghAvailable = null

export async function detectGh() {
  if (ghAvailable !== null) return ghAvailable
  const { failed } = await run('gh', ['--version'])
  ghAvailable = !failed
  return ghAvailable
}

const jsonOr = (result, fallback) => {
  if (result.failed || !result.stdout.trim()) return fallback
  try { return JSON.parse(result.stdout) } catch { return fallback }
}

/** Open PRs for the repo, plus the PR for the current branch if there is one. */
export async function pullRequests(cwd) {
  if (!(await detectGh())) return { available: false, prs: [] }
  const fields = 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,state,reviewDecision,statusCheckRollup'
  const result = await run('gh', ['pr', 'list', '--limit', '30', '--json', fields], {
    cwd, timeout: 25_000,
  })
  const prs = jsonOr(result, []).map(normalisePr)
  return { available: true, prs, error: result.failed ? result.stderr.trim() : null }
}

export async function currentPr(cwd) {
  if (!(await detectGh())) return null
  const fields = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName'
  const result = await run('gh', ['pr', 'view', '--json', fields], { cwd, timeout: 25_000 })
  const pr = jsonOr(result, null)
  return pr ? normalisePr(pr) : null
}

/** Collapse GitHub's per-check rollup into a single pass/fail/pending verdict. */
function normalisePr(pr) {
  const checks = pr.statusCheckRollup ?? []
  let passed = 0, failed = 0, pending = 0
  for (const c of checks) {
    const state = c.conclusion || c.state || ''
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) passed++
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state)) failed++
    else pending++
  }
  const checkState = failed ? 'failing' : pending ? 'pending' : checks.length ? 'passing' : 'none'
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author?.login ?? null,
    head: pr.headRefName,
    base: pr.baseRefName,
    updatedAt: pr.updatedAt ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    checks: { state: checkState, passed, failed, pending, total: checks.length },
  }
}

export async function createPr(cwd, { title, body, base, draft }) {
  if (!(await detectGh())) return { ok: false, error: 'gh CLI not found' }
  const args = ['pr', 'create', '--title', title, '--body', body ?? '']
  if (base) args.push('--base', base)
  if (draft) args.push('--draft')
  const result = await run('gh', args, { cwd, timeout: 60_000 })
  return result.failed
    ? { ok: false, error: result.stderr.trim() || result.stdout.trim() }
    : { ok: true, url: result.stdout.trim() }
}
