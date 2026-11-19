import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HINT_POSTINSTALL, HINT_REOPEN, spawnFailureHint, spawnHelperUsable,
} from './pty-hint.js'

const spawnErr = new Error('posix_spawnp failed.')

test('a usable helper means the reinstall hint, not postinstall', () => {
  assert.equal(spawnFailureHint(spawnErr, () => true), HINT_REOPEN)
  assert.match(HINT_REOPEN, /reinstalled — reopen this tab/)
})

test('a missing or non-executable helper keeps the postinstall hint', () => {
  assert.equal(spawnFailureHint(spawnErr, () => false), HINT_POSTINSTALL)
  assert.match(HINT_POSTINSTALL, /npm run postinstall/)
})

test('other errors get no hint and never touch the filesystem', () => {
  const never = () => { throw new Error('should not be called') }
  assert.equal(spawnFailureHint(new Error('ENOENT: no such file'), never), '')
  assert.equal(spawnFailureHint(undefined, never), '')
  assert.equal(spawnFailureHint(null, never), '')
})

test('accepts a bare string error', () => {
  assert.equal(spawnFailureHint('posix_spawnp failed.', () => true), HINT_REOPEN)
})

test('never throws: a failing check falls back to postinstall', () => {
  const boom = () => { throw new Error('EACCES') }
  assert.equal(spawnFailureHint(spawnErr, boom), HINT_POSTINSTALL)
  const hostile = { get message() { throw new Error('getter') } }
  assert.equal(spawnFailureHint(hostile, () => true), HINT_POSTINSTALL)
})

test('spawnHelperUsable reads the helper beside the loaded pty.node', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pty-hint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // No node-pty at all.
  assert.equal(spawnHelperUsable(root), false)
  assert.equal(spawnHelperUsable(path.join(root, 'nope')), false)

  const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pty.node'), '')
  const helper = path.join(dir, 'spawn-helper')

  // Native module present, helper missing.
  assert.equal(spawnHelperUsable(root), false)

  // Helper present without the executable bit — how npm unpacks it.
  fs.writeFileSync(helper, '', { mode: 0o644 })
  assert.equal(spawnHelperUsable(root), false)

  fs.chmodSync(helper, 0o755)
  assert.equal(spawnHelperUsable(root), true)

  // A locally built module wins over the prebuild, as it does in node-pty.
  const built = path.join(root, 'build', 'Release')
  fs.mkdirSync(built, { recursive: true })
  fs.writeFileSync(path.join(built, 'pty.node'), '')
  assert.equal(spawnHelperUsable(root), false)
  fs.writeFileSync(path.join(built, 'spawn-helper'), '', { mode: 0o755 })
  assert.equal(spawnHelperUsable(root), true)
})
