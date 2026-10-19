import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from './config.js'
import { childEnv } from './exec.js'

/**
 * Staging area for removed worktrees.
 *
 * Deleting a JS worktree means unlinking hundreds of thousands of files —
 * minutes of work that must not sit inside an HTTP request or an exec
 * timeout. So a removal *renames* the tree into `<parent>/.worktrees/.trash/`
 * (instant on one volume), git unregisters it, and a detached `rm -rf`
 * reclaims the space on its own schedule. The scanner never walks
 * `.worktrees`, so nothing in here shows up as a project.
 */
export const TRASH_DIR = '.trash'

/** `<parent>/.worktrees/.trash` for a repo at `<parent>/<repo>` — same volume as its worktrees. */
export const trashRootFor = (repoPath) =>
  path.join(path.dirname(repoPath), config.worktreeDirName, TRASH_DIR)

/**
 * Move `dir` into the repo's trash. `dest` is null when the rename is not
 * possible (another volume, a missing path); the caller then falls back to
 * letting git delete in place.
 */
export async function stash(repoPath, dir) {
  const root = trashRootFor(repoPath)
  const dest = path.join(root, `${path.basename(dir)}-${Date.now().toString(36)}`)
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.rename(dir, dest)
  } catch (error) {
    return { dest: null, error }
  }
  return { dest, error: null }
}

/**
 * Delete one trashed entry with a detached `rm -rf`: it survives a server
 * restart and never blocks a request. Refuses any path that is not directly
 * inside a `.worktrees/.trash/` directory — this is the one place the app
 * deletes a tree it did not just create, so the guard is deliberately dumb.
 */
export function discard(entry) {
  const p = path.resolve(entry)
  const parent = path.dirname(p)
  const inTrash = path.basename(parent) === TRASH_DIR &&
    path.basename(path.dirname(parent)) === config.worktreeDirName &&
    path.basename(p) && !['.', '..'].includes(path.basename(p))
  if (!inTrash) throw new Error(`refusing to delete outside ${config.worktreeDirName}/${TRASH_DIR}: ${p}`)
  const child = spawn('rm', ['-rf', '--', p], { detached: true, stdio: 'ignore', env: childEnv() })
  child.on('error', () => { /* nothing to report to; the boot sweep retries */ })
  child.unref()
  return p
}

/** Finish deletes a previous server instance started. Returns how many it resumed. */
export async function sweep(repoPaths) {
  let n = 0
  for (const root of new Set(repoPaths.map(trashRootFor))) {
    let entries
    try { entries = await fs.readdir(root) } catch { continue }
    for (const e of entries) {
      try { discard(path.join(root, e)); n++ } catch { /* not ours to touch */ }
    }
  }
  return n
}
