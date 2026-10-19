import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run } from './exec.js'
import { removeWorktree, worktrees } from './git.js'
import * as Trash from './trash.js'

// Keep the user's global git config (hooks, templates, signing) out of it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const g = (cwd, ...args) =>
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd })
const exists = (p) => fs.access(p).then(() => true, () => false)
const registered = async (repo) => (await worktrees(repo)).map((w) => w.path)
async function eventually(fn, ms = 15_000) {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

const roots = []
after(async () => { for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {}) })

/** A repo at `<tmp>/repo` with one worktree at `<tmp>/.worktrees/repo/feat` — the layout `worktreeDirFor` produces. */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pm-wt-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    const r = await g(repo, ...args); assert.equal(r.failed, false, r.stderr)
  }
  const wt = path.join(root, '.worktrees', 'repo', 'feat')
  const r = await g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt); assert.equal(r.failed, false, r.stderr)
  return { root, repo, wt }
}

test('a dirty worktree is unregistered at once; files go in the background; the branch stays', async () => {
  const { root, repo, wt } = await fixture()
  await fs.writeFile(path.join(wt, 'untracked.txt'), 'dirty')

  const t0 = Date.now()
  const result = await removeWorktree(repo, wt)
  assert.equal(result.failed, false, result.stderr)
  assert.ok(Date.now() - t0 < 5000, 'returns without waiting for the delete')

  assert.ok(result.trashed.startsWith(path.join(root, '.worktrees', '.trash') + path.sep), result.trashed)
  assert.equal(await exists(wt), false, 'old path is gone')
  assert.deepEqual(await registered(repo), [repo], 'git no longer lists it')
  assert.match((await g(repo, 'branch', '--list', 'feat')).stdout, /feat/, 'branch kept')
  assert.ok(await eventually(async () => !(await exists(result.trashed))), 'detached rm finished')
})

test('a locked worktree is refused without force and put back where git expects it', async () => {
  const { repo, wt } = await fixture()
  assert.equal((await g(repo, 'worktree', 'lock', wt)).failed, false)

  const refused = await removeWorktree(repo, wt)
  assert.equal(refused.failed, true)
  assert.match(refused.stderr, /locked/)
  assert.equal(await exists(wt), true, 'tree restored')
  assert.ok((await registered(repo)).includes(wt), 'still registered')

  const forced = await removeWorktree(repo, wt, { force: true })
  assert.equal(forced.failed, false, forced.stderr)
  assert.deepEqual(await registered(repo), [repo])
  assert.ok(await eventually(async () => !(await exists(forced.trashed))))
})

test('a path that is not a worktree falls through to git and reports its error', async () => {
  const { root, repo } = await fixture()
  const result = await removeWorktree(repo, path.join(root, 'nope'))
  assert.equal(result.failed, true)
  assert.match(result.stderr, /not a working tree|No such file/)
  assert.equal(await exists(path.join(root, '.worktrees', '.trash')), true, 'trash dir may exist')
  assert.deepEqual(await fs.readdir(path.join(root, '.worktrees', '.trash')), [], 'but nothing was stashed')
})

test('discard refuses anything outside .worktrees/.trash', async () => {
  const { root } = await fixture()
  assert.throws(() => Trash.discard(path.join(root, 'repo')), /refusing/)
  assert.throws(() => Trash.discard(path.join(root, '.worktrees', '.trash')), /refusing/)
  assert.throws(() => Trash.discard(path.join(root, '.worktrees', 'repo', 'feat')), /refusing/)
  assert.throws(() => Trash.discard(path.join(root, '.trash', 'x')), /refusing/)
})

test('sweep resumes leftovers and ignores repos with no trash', async () => {
  const { root, repo } = await fixture()
  const leftover = path.join(root, '.worktrees', '.trash', 'old-abc')
  await fs.mkdir(leftover, { recursive: true })
  await fs.writeFile(path.join(leftover, 'f'), 'x')
  assert.equal(await Trash.sweep([repo, path.join(root, 'no-such-repo')]), 1)
  assert.ok(await eventually(async () => !(await exists(leftover))))
})

test('run() names a timeout or a spawn failure instead of returning an empty error', async () => {
  const slow = await run('sleep', ['5'], { timeout: 1000 })
  assert.equal(slow.failed, true)
  assert.match(slow.stderr, /sleep timed out after 1s/)

  const missing = await run('pm-definitely-not-a-command', [])
  assert.equal(missing.failed, true)
  assert.match(missing.stderr, /ENOENT/)

  const plain = await run('sh', ['-c', 'exit 3'])
  assert.equal(plain.failed, true)
  assert.equal(plain.stderr, '', 'a plain non-zero exit keeps its empty stderr')
})
