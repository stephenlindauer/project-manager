import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'

export const idFor = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)

async function exists(p) {
  try { await fs.stat(p); return true } catch { return false }
}

/**
 * Classify a directory. A `.git` *directory* is a normal repo; a `.git` *file*
 * means the dir is a linked worktree, which we must not list as its own
 * project — it belongs under its main repo instead.
 */
async function classify(dir) {
  const dotGit = path.join(dir, '.git')
  let gitKind = null
  try {
    const st = await fs.lstat(dotGit)
    gitKind = st.isDirectory() ? 'repo' : 'worktree'
  } catch { /* not a git dir */ }

  if (gitKind) return { kind: gitKind }

  for (const marker of config.projectMarkers) {
    if (await exists(path.join(dir, marker))) return { kind: 'plain', marker }
  }
  return { kind: null }
}

/**
 * Most recent mtime across a directory's immediate children — a cheap "last
 * touched" for projects with no git history to date them by. Build and
 * dependency directories are skipped: an `npm install` is not you working.
 */
async function lastTouched(dir, entries) {
  let newest = 0
  for (const e of entries) {
    if (e.name.startsWith('.') || config.ignoreDirs.has(e.name)) continue
    if (e.isSymbolicLink()) continue // dates the link target, not this project
    try {
      const st = await fs.stat(path.join(dir, e.name))
      if (st.mtimeMs > newest) newest = st.mtimeMs
    } catch { /* raced with a delete */ }
  }
  return newest || null
}

/**
 * Walk `projectsRoot` and return every project directory found, each tagged
 * with the group (immediate parent folder) it lives under. A directory that is
 * itself a project is never descended into — `punchup/` is not a project, so we
 * descend it and find the nine repos inside.
 */
export async function scanProjects() {
  const found = []

  async function walk(dir, depth, group) {
    if (depth > config.maxDepth) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }

    const info = await classify(dir)

    if (info.kind === 'worktree') return // surfaced via its main repo
    if (info.kind === 'repo' || info.kind === 'plain') {
      found.push({
        id: idFor(dir),
        name: path.basename(dir),
        path: dir,
        group,
        isGit: info.kind === 'repo',
        marker: info.marker ?? null,
        mtime: await lastTouched(dir, entries),
      })
      return
    }

    const childGroup = depth === 0 ? null : path.basename(dir)
    for (const e of entries) {
      // Real directories only. readdir reports symlinks via lstat, so a
      // symlink to a directory is not `isDirectory()` — following them would
      // list the same repo twice under two names (and could recurse forever).
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.')) continue
      if (config.ignoreDirs.has(e.name)) continue
      await walk(path.join(dir, e.name), depth + 1, childGroup)
    }
  }

  await walk(config.projectsRoot, 0, null)
  found.sort((a, b) =>
    (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name))
  return found
}

/** Where new worktrees for a repo live: `<parent>/.worktrees/<repo>/<branch>`. */
export function worktreeDirFor(repoPath, branch) {
  const parent = path.dirname(repoPath)
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return path.join(parent, config.worktreeDirName, path.basename(repoPath), slug)
}
