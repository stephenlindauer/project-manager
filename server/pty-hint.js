/**
 * Picks the hint shown under a failed pty spawn.
 *
 * node-pty reports several unrelated failures as the same bare
 * `posix_spawnp failed`. The one we can tell apart cheaply is its bundled
 * `spawn-helper`: npm drops the executable bit on install, and
 * `npm run postinstall` puts it back. When the helper is present and
 * executable that advice is wrong — the usual cause is then a reinstall of
 * dependencies underneath a running session, and reopening the tab clears it.
 *
 * Kept apart from terminals.js so it can be tested without loading node-pty.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PTY_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty',
)

export const HINT_POSTINSTALL = 'If this persists, run: npm run postinstall'
export const HINT_REOPEN = 'Dependencies were probably just reinstalled — reopen this tab'

/** The directories node-pty loads its native module from, in its own order. */
function nativeDirs(root, platform = process.platform, arch = process.arch) {
  return [
    path.join(root, 'build', 'Release'),
    path.join(root, 'build', 'Debug'),
    path.join(root, 'prebuilds', `${platform}-${arch}`),
  ]
}

/**
 * True when the `spawn-helper` node-pty would use is a file with an executable
 * bit. node-pty takes the helper from the directory it loaded `pty.node` from,
 * so that directory is the one checked. Never throws: any doubt is `false`,
 * which keeps the postinstall hint.
 */
export function spawnHelperUsable(root = PTY_ROOT) {
  try {
    const dir = nativeDirs(root).find((d) => fs.existsSync(path.join(d, 'pty.node')))
    if (!dir) return false
    const stat = fs.statSync(path.join(dir, 'spawn-helper'))
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * The hint text for a spawn error, or '' when the error is not a
 * `posix_spawnp` failure. `helperUsable` is a function so the filesystem is
 * only touched for the errors that need it. Never throws — it is called from
 * inside a WebSocket handler, where a throw takes the server down.
 */
export function spawnFailureHint(err, helperUsable = spawnHelperUsable) {
  try {
    if (!String(err?.message ?? err).includes('posix_spawnp')) return ''
    return helperUsable() ? HINT_REOPEN : HINT_POSTINSTALL
  } catch {
    return HINT_POSTINSTALL
  }
}
