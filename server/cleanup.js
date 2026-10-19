import { git } from './exec.js'
import * as G from './git.js'

/**
 * Worktree cleanup: which linked worktrees hold nothing that is not already in
 * the integration branch (safe to purge), and which have simply gone quiet
 * (listed, never purged — they may hold unmerged work).
 *
 * "Merged" is decided against both `origin/<default>` and the local
 * `<default>`, since a branch merged locally but not yet pushed is still safe
 * in the main worktree. It covers each way a branch lands:
 *
 *  - fast-forward / merge commit: no commits on HEAD that the base lacks.
 *  - rebase-merge: every commit on HEAD has a patch-equivalent on the base
 *    (`git cherry` marks it `-`).
 *  - squash-merge: the branch's whole diff, as one synthetic commit on its
 *    merge base, has a patch-equivalent on the base. That commit is written
 *    with `commit-tree` and left dangling for gc; nothing points at it.
 *
 * "No commits the base lacks" also describes a worktree created five minutes
 * ago that has not committed yet. The branch reflog tells them apart: a
 * branch that only ever recorded "Created from" never had work of its own,
 * so it is `empty` — listed with the stale ones, never purged.
 */

/** Days of quiet before an unmerged worktree is called stale, unless the client asks otherwise. */
export const STALE_DAYS = 14

/**
 * The verdict for one worktree, from facts alone. Pure, so the table can be
 * tested without git.
 *
 * `merged` — nothing to lose; purgeable unless `holds` says otherwise.
 * `missing` — git still lists it but its directory is gone; purging prunes it.
 * `empty` — never committed on; nothing to lose, but likely brand new.
 * `open` — has work the base does not.
 */
export function classify(f) {
  const holds = []
  if (f.locked) holds.push('locked')
  if (f.dirty > 0) holds.push(`${f.dirty} uncommitted file${f.dirty === 1 ? '' : 's'}`)
  if (f.openPr) holds.push('open PR')
  if (f.claudeBusy) holds.push(`Claude is ${f.claudeBusy}`)
  if (f.taskRunning) holds.push('task running')

  if (f.prunable) return { verdict: 'missing', reason: 'directory is gone', holds: holds.filter((h) => h === 'locked') }

  const merged = f.bases.find((b) => b.ahead === 0 && f.hadCommits)
    ?? f.bases.find((b) => b.ahead > 0 && (b.rebased || b.squashed))
  if (merged) {
    const how = merged.ahead === 0 ? 'in' : merged.squashed ? 'squash-merged into' : 'rebased or squashed into'
    return { verdict: 'merged', reason: `${how} ${merged.ref}`, holds }
  }
  if (f.bases.some((b) => b.ahead === 0)) return { verdict: 'empty', reason: 'no commits of its own', holds }
  const ahead = Math.min(...f.bases.map((b) => b.ahead))
  return {
    verdict: 'open',
    reason: Number.isFinite(ahead) ? `${ahead} commit${ahead === 1 ? '' : 's'} not on ${f.defaultBranch ?? 'the default branch'}` : 'no default branch to compare with',
    holds,
  }
}

const lines = (s) => s.split('\n').filter(Boolean)

async function refExists(cwd, ref) {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return !r.failed && Boolean(r.stdout.trim())
}

/** How HEAD relates to one base: commits it lacks, and whether they landed by rebase or squash anyway. */
async function against(cwd, head, ref) {
  const count = await git(cwd, ['rev-list', '--count', `${ref}..${head}`])
  const ahead = count.failed ? Infinity : Number(count.stdout.trim())
  const out = { ref, ahead, rebased: false, squashed: false }
  if (!(ahead > 0) || !Number.isFinite(ahead)) return out

  const cherry = await git(cwd, ['cherry', ref, head])
  const marks = lines(cherry.stdout)
  out.rebased = !cherry.failed && marks.length > 0 && marks.every((l) => l.startsWith('-'))
  if (out.rebased) return out

  const base = await git(cwd, ['merge-base', ref, head])
  if (base.failed || !base.stdout.trim()) return out
  const synthetic = await git(cwd, [
    '-c', 'user.name=pm', '-c', 'user.email=pm@localhost', '-c', 'commit.gpgsign=false',
    'commit-tree', `${head}^{tree}`, '-p', base.stdout.trim(), '-m', 'pm cleanup probe',
  ])
  if (synthetic.failed) return out
  const squash = await git(cwd, ['cherry', ref, synthetic.stdout.trim()])
  out.squashed = !squash.failed && lines(squash.stdout)[0]?.startsWith('-') === true
  return out
}

/** True when the branch reflog records anything beyond its own creation. */
async function hadCommits(cwd, branch) {
  if (!branch) return false
  const r = await git(cwd, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--'])
  return !r.failed && lines(r.stdout).some((l) => !l.startsWith('branch: Created'))
}

async function upstreamGone(cwd, branch) {
  if (!branch) return false
  const r = await git(cwd, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`])
  return r.stdout.trim() === '[gone]'
}

/**
 * Git facts for one linked worktree. `repoPath` is the main checkout (refs are
 * shared, and it still exists when the worktree's own directory does not).
 */
export async function gather(repoPath, wt, defaultBranch) {
  const facts = {
    branch: wt.branch, locked: Boolean(wt.locked), prunable: Boolean(wt.prunable),
    defaultBranch, dirty: 0, bases: [], hadCommits: false, upstreamGone: false,
  }
  if (facts.prunable) return facts

  const status = await G.status(wt.path)
  // A worktree git cannot read is not one we can vouch for.
  facts.dirty = status ? status.staged + status.unstaged + status.untracked + status.conflicted : 1
  const head = wt.head ?? 'HEAD'

  const refs = defaultBranch ? [`origin/${defaultBranch}`, defaultBranch] : []
  const present = (await Promise.all(refs.map(async (r) => ((await refExists(repoPath, r)) ? r : null)))).filter(Boolean)
  // Skip the local default when it is the very branch checked out here.
  const bases = present.filter((r) => r !== wt.branch)
  ;[facts.bases, facts.hadCommits, facts.upstreamGone] = await Promise.all([
    Promise.all(bases.map((r) => against(repoPath, head, r))),
    hadCommits(repoPath, wt.branch),
    upstreamGone(repoPath, wt.branch),
  ])
  return facts
}

/** `git fetch --prune origin`, once per repo, so squash detection sees what GitHub merged. */
export async function fetchOrigin(repoPath) {
  const remotes = await git(repoPath, ['remote'])
  if (!lines(remotes.stdout).includes('origin')) return { ok: true, skipped: true }
  const r = await git(repoPath, ['fetch', '--prune', '--quiet', 'origin'], { timeout: 60_000 })
  return { ok: !r.failed, error: r.failed ? (r.stderr.trim().split('\n').pop() || 'fetch failed') : null }
}

/** Delete a branch whose work is already merged. `-D` because a squash-merge never looks merged to git. */
export const deleteBranch = (repoPath, branch) => git(repoPath, ['branch', '-D', branch])

/** `git worktree prune` for entries whose directory is gone. */
export const prune = (repoPath) => git(repoPath, ['worktree', 'prune'])

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool(items, n, fn) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}
