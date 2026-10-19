import { test } from 'node:test'
import assert from 'node:assert/strict'
import { store } from './store.js'

const wt = (id, isMain = false) =>
  ({ id, path: `/p/${id}`, branch: id, isMain, name: id, status: null, lastCommit: null, activityAt: null })

test('forgetWorktree drops one linked worktree, keeps main, and notifies once', () => {
  store.projects = [
    { id: 'p1', name: 'p1', path: '/p/p1', group: null, isGit: true, worktrees: [wt('main', true), wt('feat')] },
    { id: 'p2', name: 'p2', path: '/p/p2', group: null, isGit: true, worktrees: [wt('m2', true)] },
  ]
  const events = []
  store.on('projects', (p) => events.push(p))

  assert.equal(store.forgetWorktree('feat'), true)
  assert.equal(store.find('feat'), null)
  assert.deepEqual(store.nodes.map((n) => n.id), ['main', 'm2'])
  assert.equal(events.length, 1)

  assert.equal(store.forgetWorktree('main'), false, 'a main worktree is the project; never dropped')
  assert.equal(store.forgetWorktree('nope'), false)
  assert.equal(events.length, 1, 'no event when nothing changed')
})
