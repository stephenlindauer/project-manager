import { run } from './exec.js'
import * as G from './git.js'

let ghAvailable = null
let viewerLogin

/** The logged-in GitHub user, cached for the process lifetime ('' if unknown). */
export async function viewer() {
  if (viewerLogin !== undefined) return viewerLogin
  const result = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 })
  viewerLogin = result.failed ? '' : result.stdout.trim()
  return viewerLogin
}

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

const LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,url,state,reviewDecision'

/**
 * Open PRs for the repo, plus the PR for the current branch if there is one.
 *
 * Two calls on purpose. `statusCheckRollup` expands to up to 100 check
 * contexts per PR in one GraphQL query; on a repo with a large CI matrix
 * (a monorepo with ~100 checks per PR) 30 PRs of that push the query past
 * GitHub's ~10s budget and gh gets an empty body back ("unexpected end of
 * JSON input"). So checks are fetched only for the viewer's own PRs, which
 * is a handful, and the repo-wide list is fetched without them.
 */
export async function pullRequests(cwd) {
  if (!(await detectGh())) return { available: false, prs: [] }
  const [mine, all, login] = await Promise.all([
    run('gh', ['pr', 'list', '--author', '@me', '--limit', '100', '--json', `${LIST_FIELDS},statusCheckRollup`], { cwd, timeout: 25_000 }),
    run('gh', ['pr', 'list', '--limit', '30', '--json', LIST_FIELDS], { cwd, timeout: 25_000 }),
    viewer(),
  ])
  const byNumber = new Map()
  for (const pr of jsonOr(all, [])) byNumber.set(pr.number, normalisePr(pr, { checksKnown: false }))
  for (const pr of jsonOr(mine, [])) byNumber.set(pr.number, normalisePr(pr))
  const prs = [...byNumber.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const error = [mine, all].find((r) => r.failed)
  return { available: true, prs, viewer: login || null, error: error ? error.stderr.trim() : null }
}

export async function currentPr(cwd) {
  if (!(await detectGh())) return null
  const fields = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName'
  const result = await run('gh', ['pr', 'view', '--json', fields], { cwd, timeout: 25_000 })
  const pr = jsonOr(result, null)
  return pr ? normalisePr(pr) : null
}

/** Collapse GitHub's per-check rollup into a single pass/fail/pending verdict. */
function normalisePr(pr, { checksKnown = true } = {}) {
  const checks = pr.statusCheckRollup ?? []
  let passed = 0, failed = 0, pending = 0
  for (const c of checks) {
    const state = c.conclusion || c.state || ''
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) passed++
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state)) failed++
    else pending++
  }
  const checkState = !checksKnown ? 'unknown'
    : failed ? 'failing' : pending ? 'pending' : checks.length ? 'passing' : 'none'
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

// ------------------------------------------------------------------ stacks

const prView = async (cwd, args) => {
  const result = await run('gh', ['pr', 'list', '--state', 'open', '--limit', '5', '--json', `${LIST_FIELDS},statusCheckRollup`, ...args], { cwd, timeout: 20_000 })
  return jsonOr(result, []).map((pr) => normalisePr(pr))
}
const prsByHead = (cwd, ref) => prView(cwd, ['--head', ref])
const prsByBase = (cwd, ref) => prView(cwd, ['--base', ref])
async function prByNumber(cwd, number) {
  const result = await run('gh', ['pr', 'view', String(number), '--json', `${LIST_FIELDS},statusCheckRollup`], { cwd, timeout: 20_000 })
  const pr = jsonOr(result, null)
  return pr ? normalisePr(pr) : null
}

const MAX_HOPS = 15

/**
 * The stack the current worktree belongs to, bottom (nearest the integration
 * branch) to top. Two shapes are recognised:
 *
 *  - `branches`: chained feature branches, where each PR's base is the PR
 *    below it. Found by taking the PR whose head is the current branch and
 *    walking base links down and "PRs based on me" links up.
 *  - `grok`: git-grok, where every commit on local master is a PR and the
 *    commit carries a `Pull Request: <url>` trailer. Found from the trailers
 *    of the commits above the integration branch; commits without a trailer
 *    are listed too, as not yet pushed.
 *
 * `prs` is the already-fetched open-PR list, used as a cache so the common
 * case (a stack of your own PRs) costs no extra gh round trips; a hop it does
 * not cover is looked up individually.
 */
export async function stack(cwd, { branch, defaultBranch, prs = [] }) {
  const byHead = new Map(prs.map((p) => [p.head, p]))
  const byNumber = new Map(prs.map((p) => [p.number, p]))
  const remember = (pr) => { if (pr) { byHead.set(pr.head, pr); byNumber.set(pr.number, pr) } return pr }
  const headPr = async (ref) => byHead.get(ref) ?? remember((await prsByHead(cwd, ref))[0] ?? null)
  const numberPr = async (n) => byNumber.get(n) ?? remember(await prByNumber(cwd, n))

  const [wts, locals] = await Promise.all([G.worktrees(cwd), G.localBranchNames(cwd)])
  const annotate = (entry) => {
    const head = entry.head
    const wt = head ? wts.find((w) => w.branch === head) : null
    return {
      ...entry,
      current: Boolean(head) && head === branch,
      local: Boolean(head) && locals.includes(head),
      checkedOutAt: wt?.path ?? null,
    }
  }

  // git-grok shape first: it lives on the integration branch, so the branch
  // name says nothing and the commits are the only evidence.
  const upstreamBase = defaultBranch ? `origin/${defaultBranch}` : null
  const commits = upstreamBase ? await G.stackCommits(cwd, upstreamBase) : null
  if (commits?.some((c) => c.pr)) {
    const entries = await Promise.all(commits.map(async (c) => {
      const pr = c.pr ? await numberPr(c.pr) : null
      return annotate({ head: pr?.head ?? null, pr, commit: { sha: c.sha, short: c.short, subject: c.subject } })
    }))
    return { kind: 'grok', base: defaultBranch, entries, forks: [] }
  }

  if (!branch) return { kind: null, base: defaultBranch, entries: [], forks: [] }
  const anchor = await headPr(branch)
  if (!anchor) return { kind: null, base: defaultBranch, entries: [], forks: [] }

  // Down: follow base links until they land on something that is not a PR head.
  const chain = [anchor]
  let base = anchor.base
  for (let i = 0; i < MAX_HOPS && base && base !== defaultBranch; i++) {
    const below = await headPr(base)
    if (!below) break
    chain.unshift(below)
    base = below.base
  }

  // Up: PRs based on our head, then on theirs. A branch point keeps the most
  // recently updated child in the line and reports the rest as forks.
  const forks = []
  let top = anchor
  for (let i = 0; i < MAX_HOPS; i++) {
    let children = prs.filter((p) => p.base === top.head)
    if (!children.length) children = (await prsByBase(cwd, top.head)).map(remember)
    if (!children.length) break
    children.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    const [next, ...rest] = children
    forks.push(...rest.map((p) => ({ number: p.number, title: p.title, head: p.head, base: p.base, url: p.url })))
    chain.push(next)
    top = next
  }

  const entries = chain.map((pr) => annotate({ head: pr.head, pr, commit: null }))
  return { kind: 'branches', base, entries, forks }
}
