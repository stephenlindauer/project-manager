import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run } from './exec.js'
import { worktrees } from './git.js'
import { classify, gather } from './cleanup.js'

// Keep the user's global git config (hooks, templates, signing) out of it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const base = (over = {}) => ({
  locked: false, prunable: false, dirty: 0, openPr: false, claudeBusy: null, taskRunning: false,
  defaultBranch: 'main', hadCommits: true, bases: [{ ref: 'origin/main', ahead: 0, rebased: false, squashed: false }],
  ...over,
})

test('classify: the verdict table', () => {
  assert.equal(classify(base()).verdict, 'merged')
  assert.equal(classify(base()).reason, 'in origin/main')
  assert.equal(classify(base({ hadCommits: false })).verdict, 'empty')
  assert.equal(classify(base({ bases: [{ ref: 'origin/main', ahead: 2, rebased: false, squashed: true }] })).reason, 'squash-merged into origin/main')
  assert.equal(classify(base({ bases: [{ ref: 'origin/main', ahead: 2, rebased: true, squashed: false }] })).reason, 'rebased or squashed into origin/main')
  assert.equal(classify(base({ bases: [{ ref: 'origin/main', ahead: 3, rebased: false, squashed: false }] })).reason, '3 commits not on main')
  assert.equal(classify(base({ bases: [] })).verdict, 'open')
  assert.equal(classify(base({ prunable: true, dirty: 1 })).verdict, 'missing')
  // Merged into the local default but not origin's still counts.
  assert.equal(classify(base({ bases: [
    { ref: 'origin/main', ahead: 1, rebased: false, squashed: false },
    { ref: 'main', ahead: 0, rebased: false, squashed: false },
  ] })).reason, 'in main')
})

test('classify: live state holds a merged tree', () => {
  const { verdict, holds } = classify(base({ dirty: 2, openPr: true, claudeBusy: 'working', taskRunning: true, locked: true }))
  assert.equal(verdict, 'merged')
  assert.deepEqual(holds, ['locked', '2 uncommitted files', 'open PR', 'Claude is working', 'task running'])
  assert.deepEqual(classify(base({ prunable: true, openPr: true })).holds, [])
})

// ---------------------------------------------------------------- real git

const g = async (cwd, ...args) => {
  const r = await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd })
  assert.equal(r.failed, false, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const roots = []
after(async () => { for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {}) })

async function repo() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pm-clean-')))
  roots.push(root)
  const main = path.join(root, 'repo')
  await fs.mkdir(main)
  await g(main, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(main, 'a.txt'), 'a\n')
  await g(main, 'add', '.'); await g(main, 'commit', '-q', '-m', 'init')
  const add = async (branch) => {
    const dir = path.join(root, '.worktrees', branch)
    await g(main, 'worktree', 'add', '-q', '-b', branch, dir)
    return dir
  }
  const commit = async (dir, file, text) => {
    await fs.writeFile(path.join(dir, file), text)
    await g(dir, 'add', '.'); await g(dir, 'commit', '-q', '-m', `edit ${file}`)
  }
  const verdict = async (branch) => {
    const wt = (await worktrees(main)).find((w) => w.branch === branch)
    return classify({ ...(await gather(main, wt, 'main')), openPr: false, claudeBusy: null, taskRunning: false })
  }
  return { root, main, add, commit, verdict }
}

test('fast-forward, squash and rebase merges are merged; fresh and unmerged are not', async () => {
  const r = await repo()

  const ff = await r.add('ff')
  await r.commit(ff, 'ff.txt', 'ff\n')
  await g(r.main, 'merge', '-q', '--ff-only', 'ff')

  const sq = await r.add('sq')
  await r.commit(sq, 'sq1.txt', '1\n')
  await r.commit(sq, 'sq2.txt', '2\n')
  await g(r.main, 'merge', '-q', '--squash', 'sq'); await g(r.main, 'commit', '-q', '-m', 'squash sq')

  const rb = await r.add('rb')
  await r.commit(rb, 'rb.txt', 'rb\n')
  // Move main on first, or the pick lands on the same parent in the same
  // second and comes out as the very same commit.
  await r.commit(r.main, 'b.txt', 'b\n')
  await g(r.main, 'cherry-pick', 'rb')

  await r.add('fresh')

  const open = await r.add('open')
  await r.commit(open, 'open.txt', 'wip\n')

  const dirty = await r.add('dirty')
  await r.commit(dirty, 'd.txt', 'd\n')
  await g(r.main, 'merge', '-q', 'dirty')
  await fs.writeFile(path.join(dirty, 'scratch.txt'), 'unsaved')

  assert.deepEqual(await r.verdict('ff'), { verdict: 'merged', reason: 'in main', holds: [] })
  assert.deepEqual(await r.verdict('sq'), { verdict: 'merged', reason: 'squash-merged into main', holds: [] })
  assert.deepEqual(await r.verdict('rb'), { verdict: 'merged', reason: 'rebased or squashed into main', holds: [] })
  assert.equal((await r.verdict('fresh')).verdict, 'empty')
  assert.equal((await r.verdict('open')).verdict, 'open')
  assert.deepEqual(await r.verdict('dirty'), { verdict: 'merged', reason: 'in main', holds: ['1 uncommitted file'] })
})

test('a worktree whose directory is gone is missing', async () => {
  const r = await repo()
  const dir = await r.add('gone')
  await fs.rm(dir, { recursive: true, force: true })
  assert.equal((await r.verdict('gone')).verdict, 'missing')
})
