import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { run } from './exec.js'
import { store } from './store.js'
import * as G from './git.js'
import * as GH from './gh.js'
import { ATTENTION, loudest, verdictFor } from './ship-verdict.js'

/**
 * Ship verdicts: for every worktree, the one thing *you* have to do next to
 * get its pull requests merged — pushed to the sidebar as a static pill and a
 * "Ship" strip. See ship-verdict.js for the vocabulary.
 *
 * Data comes from ONE GraphQL search per tick — every open PR the viewer
 * authored, across every repo — rather than a `gh pr list` per project. Two
 * reasons: 40 projects is 40 processes, and `gh pr list --json
 * statusCheckRollup` expands to every check context per PR, the query shape
 * gh.js documents as overrunning GitHub's ~10s budget on a big CI matrix. The
 * search asks for the head commit's *aggregated* rollup state instead — one
 * scalar — so it costs a single rate-limit point and needs no cwd.
 *
 * PRs are matched to worktrees in memory: by repo (`owner/repo` from the
 * remote) and head branch, or, for a git-grok stack living on the integration
 * branch, by the `Pull Request:` trailers of the commits above origin. The
 * mapping re-runs on every `nodes` refresh, so a checkout shows within the
 * 20s git tick without another GitHub call.
 *
 * Failure handling is "keep the last good answer": a failed fetch leaves the
 * previous PR set in place and, after two misses, marks everything `stale` so
 * a `merge` from an hour ago is not mistaken for a current one. Nothing here
 * throws — a timer callback that throws takes the server down with it.
 *
 * Caveat: GitHub's search index trails a push by up to a minute, so a refresh
 * right after `git push` may still describe the previous head.
 */

export const events = new EventEmitter()
events.setMaxListeners(0)

const QUERY = `query($q: String!) {
  rateLimit { remaining resetAt }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest {
      number url title isDraft reviewDecision mergeStateStatus mergeable updatedAt
      headRefName baseRefName
      repository { nameWithOwner }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
}`
const SEARCH = 'is:pr is:open archived:false author:@me'

/** Consecutive failed fetches before the records are flagged stale. */
const STALE_AFTER = 2
/** `refresh()` calls closer together than this reuse the last tick. */
const REFRESH_THROTTLE_MS = 10_000
/** Stop polling when this few GraphQL points remain; the PRs tab needs them more. */
const RATE_LIMIT_FLOOR = 50
/** Most `git log` spawns one remap may make for grok detection. */
const MAX_STACK_SPAWNS = 8
const REMAP_DEBOUNCE_MS = 500

// ------------------------------------------------------------------ state

/** Last good PR set from GitHub, normalised. Survives failed ticks. */
let prs = []
let misses = 0
/** null until the first tick has asked. */
let available = null
let fetchedAt = null
let lastTickAt = 0
let rateLimitedUntil = 0
let warnedCap = false
const warned = new Set()

/** projectId -> { repo: 'owner/repo' | null, defaultBranch: string | null | undefined } */
const repoByProject = new Map()
/** nodeId -> { sha, numbers[] }: grok PR numbers, valid while HEAD is `sha`. */
const grokByNode = new Map()

let records = new Map()
let orphans = []
let lastFingerprint = ''

const warnOnce = (msg) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn('[ship]', msg)
}

// ------------------------------------------------------------------ fetch

function normalise(n) {
  return {
    repo: n.repository?.nameWithOwner ?? null,
    number: n.number,
    url: n.url,
    title: n.title,
    head: n.headRefName ?? null,
    base: n.baseRefName ?? null,
    isDraft: Boolean(n.isDraft),
    reviewDecision: n.reviewDecision ?? null,
    mergeStateStatus: n.mergeStateStatus ?? null,
    mergeable: n.mergeable ?? null,
    rollup: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    updatedAt: n.updatedAt ?? null,
  }
}

function miss(reason) {
  misses++
  // One line when it starts failing, one when it goes stale; then quiet. The
  // pills carry the stale state from there.
  if (misses === 1 || misses === STALE_AFTER) console.warn(`[ship] fetch failed (${misses}): ${reason}`)
  return false
}

/** One search. Replaces `prs` on success; leaves it alone on any failure. */
async function fetchPrs() {
  let payload
  if (config.gh.shipFixture) {
    try { payload = JSON.parse(await fs.readFile(config.gh.shipFixture, 'utf8')) }
    catch (e) { return miss(`fixture ${config.gh.shipFixture}: ${e.message}`) }
  } else {
    const result = await run('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=${SEARCH}`], { timeout: 30_000 })
    if (result.failed) return miss(result.stderr.trim().split('\n')[0] || `gh exited ${result.code}`)
    try { payload = JSON.parse(result.stdout) } catch { return miss('response was not JSON') }
  }

  const search = payload?.data?.search
  if (!Array.isArray(search?.nodes)) {
    return miss(payload?.errors?.map((e) => e.message).join('; ') || 'no search data in response')
  }
  // Partial data with errors alongside is still data; say so once and use it.
  if (Array.isArray(payload.errors) && payload.errors.length) {
    warnOnce(`partial response: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  const rl = payload.data.rateLimit
  if (rl && typeof rl.remaining === 'number' && rl.remaining < RATE_LIMIT_FLOOR) {
    rateLimitedUntil = Date.parse(rl.resetAt) || Date.now() + 60_000
    warnOnce(`rate limit low (${rl.remaining} left); pausing until ${rl.resetAt}`)
  }
  if (search.issueCount > search.nodes.length && !warnedCap) {
    warnedCap = true
    console.warn(`[ship] ${search.issueCount} open PRs, showing the ${search.nodes.length} most relevant`)
  }

  prs = search.nodes.filter((n) => n && typeof n.number === 'number').map(normalise).filter((p) => p.repo)
  misses = 0
  fetchedAt = Date.now()
  return true
}

// -------------------------------------------------------------------- map

/**
 * PR numbers a worktree owns through git-grok: the `Pull Request:` trailers on
 * its commits above origin. One `git log` per HEAD change, budgeted per remap.
 */
async function grokNumbers(project, info, worktree, allowSpawn) {
  const sha = worktree.lastCommit?.sha ?? null
  const hit = grokByNode.get(worktree.id)
  if (hit && hit.sha === sha) return hit.numbers
  // Out of budget this pass: a stale answer beats none, and the next remap
  // will get to it.
  if (!allowSpawn()) return hit?.numbers ?? []
  if (info.defaultBranch === undefined) info.defaultBranch = await G.defaultBranch(project.path)
  if (!info.defaultBranch) return []
  const commits = await G.stackCommits(worktree.path, `origin/${info.defaultBranch}`)
  const numbers = (commits ?? []).map((c) => c.pr).filter(Boolean)
  grokByNode.set(worktree.id, { sha, numbers })
  return numbers
}

const describe = (p, verdict) => ({
  number: p.number, url: p.url, title: p.title, head: p.head, base: p.base, verdict,
  rollup: p.rollup, mergeStateStatus: p.mergeStateStatus, reviewDecision: p.reviewDecision, isDraft: p.isDraft,
})

/** Rebuild `records` and `orphans` from `prs` and the current project index. */
async function remap() {
  const byRepo = new Map()
  for (const p of prs) {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, [])
    byRepo.get(p.repo).push(p)
  }

  const next = new Map()
  const matched = new Set()
  const knownRepos = new Set()
  let spawns = 0
  const allowSpawn = () => spawns++ < MAX_STACK_SPAWNS

  for (const project of store.projects) {
    if (!project.isGit) continue
    let info = repoByProject.get(project.id)
    if (!info) {
      info = { repo: await G.githubRepo(project.path), defaultBranch: undefined }
      repoByProject.set(project.id, info)
    }
    if (!info.repo) continue
    knownRepos.add(info.repo)
    const mine = byRepo.get(info.repo)
    if (!mine?.length) continue
    const heads = new Set(mine.map((p) => p.head))

    for (const w of project.worktrees) {
      let owned = w.branch ? mine.filter((p) => p.head === w.branch) : []
      if (!owned.length && (w.status?.ahead ?? 0) > 0) {
        const numbers = new Set(await grokNumbers(project, info, w, allowSpawn))
        if (numbers.size) owned = mine.filter((p) => numbers.has(p.number))
      }
      if (!owned.length) continue

      const items = owned.map((p) => describe(p, verdictFor({ ...p, baseIsMyOpenPr: heads.has(p.base) })))
      const verdict = loudest(items.map((i) => i.verdict))
      for (const p of owned) matched.add(`${p.repo}#${p.number}`)
      next.set(w.id, {
        nodeId: w.id,
        verdict,
        attention: ATTENTION.has(verdict),
        prs: items,
        updatedAt: owned.map((p) => p.updatedAt ?? '').sort().at(-1) || null,
        at: fetchedAt,
        stale: misses >= STALE_AFTER,
      })
    }
  }

  // PRs of yours in a repo we know about, but on a branch no worktree has
  // checked out. Listed so "what needs me" is not silently short.
  orphans = prs
    .filter((p) => knownRepos.has(p.repo) && !matched.has(`${p.repo}#${p.number}`))
    .map((p) => {
      const heads = new Set((byRepo.get(p.repo) ?? []).map((x) => x.head))
      const verdict = verdictFor({ ...p, baseIsMyOpenPr: heads.has(p.base) })
      return { repo: p.repo, number: p.number, title: p.title, url: p.url, head: p.head, verdict, attention: ATTENTION.has(verdict) }
    })

  records = next
  publish()
}

// Remaps overlap easily (a tick and a `nodes` event in the same second); run
// one at a time and fold any request that lands mid-run into a single rerun.
let remapping = null
let remapAgain = false
function scheduleRemap() {
  if (remapping) { remapAgain = true; return remapping }
  remapping = remap()
    .catch((e) => console.error('[ship] remap', e))
    .finally(() => {
      remapping = null
      if (remapAgain) { remapAgain = false; scheduleRemap() }
    })
  return remapping
}

let debounce = null
function remapSoon() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { debounce = null; scheduleRemap() }, REMAP_DEBOUNCE_MS)
  debounce.unref?.()
}

// ------------------------------------------------------------------- push

/** What the client sees. `available`/`stale` are facts about the whole set. */
export const statusList = () => ({
  available: Boolean(available),
  stale: misses >= STALE_AFTER,
  at: fetchedAt,
  nodes: [...records.values()],
  orphans,
})

/** Emit only when something other than the timestamp changed. */
function publish() {
  const list = statusList()
  const fingerprint = JSON.stringify(list, (k, v) => (k === 'at' ? undefined : v))
  if (fingerprint === lastFingerprint) return
  lastFingerprint = fingerprint
  events.emit('status', list)
}

// ------------------------------------------------------------------- loop

let inflight = null

async function tick() {
  lastTickAt = Date.now()
  if (!available) available = await GH.detectGh()
  if (!available) { records = new Map(); orphans = []; publish(); return }
  if (Date.now() < rateLimitedUntil) return
  await fetchPrs()
  // A failed fetch still remaps: `stale` may have flipped, and the worktrees
  // may have moved since the last good answer.
  await scheduleRemap()
}

const safeTick = () => {
  if (inflight) return inflight
  inflight = tick().catch((e) => console.error('[ship] tick', e)).finally(() => { inflight = null })
  return inflight
}

/** Begin polling. Call once, after the first project scan. */
export function start() {
  // Project ids can change on a rescan; the remote-URL cache is keyed by them.
  store.on('projects', () => repoByProject.clear())
  store.on('nodes', remapSoon)
  safeTick()
  setInterval(safeTick, config.gh.pollMs).unref()
}

/** Force a tick, unless one just happened. For the PRs tab's refresh button. */
export async function refresh() {
  if (Date.now() - lastTickAt < REFRESH_THROTTLE_MS) return { ok: true, skipped: true, at: fetchedAt }
  await safeTick()
  return { ok: true, skipped: false, at: fetchedAt }
}
