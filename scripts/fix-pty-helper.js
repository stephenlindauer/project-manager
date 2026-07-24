#!/usr/bin/env node
/**
 * node-pty ships its prebuilt `spawn-helper` without the executable bit, because
 * npm does not preserve file modes inside published tarballs. Without +x every
 * pty.spawn() fails with a bare "posix_spawnp failed." Re-apply it after install.
 *
 * See https://github.com/microsoft/node-pty/issues/582
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds')

let fixed = 0
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if (mode & 0o111) continue
    fs.chmodSync(helper, mode | 0o755)
    fixed++
  }
  if (fixed) console.log(`[pm] made ${fixed} node-pty spawn-helper(s) executable`)
} catch (err) {
  if (err.code !== 'ENOENT') throw err
}
