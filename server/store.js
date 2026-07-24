import { EventEmitter } from 'node:events'
import path from 'node:path'
import { scanProjects, idFor } from './scanner.js'
import * as G from './git.js'

/**
 * In-memory index of every project and its worktrees. Refreshed on a timer and
 * on demand; changes are pushed to clients over SSE so the sidebar badges stay
 * live without the UI polling 40 repos itself.
 */
class Store extends EventEmitter {
  constructor() {
    super()
    this.projects = []
    this.byId = new Map()
    this.scanning = false
    this.lastScan = null
  }

  /** Flat list of every navigable node (a repo's main worktree + linked ones). */
  get nodes() {
    const out = []
    for (const p of this.projects) {
      if (!p.worktrees.length) { out.push({ ...p, worktreeId: p.id, cwd: p.path }); continue }
      for (const w of p.worktrees) out.push(this.nodeFor(p, w))
    }
    return out
  }

  nodeFor(project, worktree) {
    return {
      id: worktree.id,
      projectId: project.id,
      name: project.name,
      group: project.group,
      branch: worktree.branch,
      label: worktree.isMain ? project.name : worktree.name,
      isMain: worktree.isMain,
      cwd: worktree.path,
      isGit: project.isGit,
      status: worktree.status,
      lastCommit: worktree.lastCommit,
      mtime: worktree.mtime ?? project.mtime,
      activityAt: worktree.activityAt ?? project.mtime ?? null,
    }
  }

  find(nodeId) {
    for (const p of this.projects) {
      for (const w of p.worktrees) {
        if (w.id === nodeId) return { project: p, worktree: w }
      }
      if (p.id === nodeId) return { project: p, worktree: p.worktrees[0] ?? null }
    }
    return null
  }

  /** Full rescan of the filesystem, then a git refresh of everything found. */
  async rescan() {
    if (this.scanning) return this.projects
    this.scanning = true
    try {
      const dirs = await scanProjects()
      this.projects = await Promise.all(dirs.map(async (d) => {
        const worktrees = d.isGit ? await G.worktrees(d.path) : []
        return {
          ...d,
          worktrees: (worktrees.length ? worktrees : [{
            path: d.path, branch: null, isMain: true, name: d.name,
          }]).map((w) => ({
            ...w, id: idFor(w.path), status: null, lastCommit: null, activityAt: null,
          })),
        }
      }))
      this.byId = new Map(this.projects.map((p) => [p.id, p]))
      this.lastScan = Date.now()
      this.emit('projects', this.projects)
      await this.refreshAll()
      return this.projects
    } finally {
      this.scanning = false
    }
  }

  /**
   * Load git state for one worktree and derive its activity timestamp.
   *
   * "Activity" is the newer of the last commit and the newest edit to a file
   * that is currently dirty — so a project you have been editing all day without
   * committing still sorts to the top, while a clean repo is dated by its
   * history rather than by whenever a build last touched the directory.
   */
  async hydrate(worktree) {
    const [status, lastCommit] = await Promise.all([
      G.status(worktree.path),
      G.lastCommit(worktree.path),
    ])
    worktree.status = status
    worktree.lastCommit = lastCommit

    const committed = lastCommit?.committedAt ? Date.parse(lastCommit.committedAt) : 0
    const edited = await G.newestFileMtime(worktree.path, status?.files ?? [])
    worktree.activityAt = Math.max(committed || 0, edited || 0) || null
    return worktree
  }

  /** Refresh git status for one worktree and notify listeners. */
  async refreshNode(nodeId) {
    const hit = this.find(nodeId)
    if (!hit?.worktree) return null
    const { project, worktree } = hit
    if (!project.isGit) return this.nodeFor(project, worktree)
    await this.hydrate(worktree)
    const node = this.nodeFor(project, worktree)
    this.emit('node', node)
    return node
  }

  /**
   * Refresh every worktree, bounded to a handful of concurrent git processes so
   * a rescan of 40+ repos doesn't stampede the machine.
   */
  async refreshAll({ concurrency = 8 } = {}) {
    const targets = []
    for (const p of this.projects) {
      if (!p.isGit) continue
      for (const w of p.worktrees) targets.push([p, w])
    }

    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const [, worktree] = targets[cursor++]
        await this.hydrate(worktree)
      }
    })
    await Promise.all(workers)
    this.emit('nodes', this.nodes)
    return this.nodes
  }

  /** Map an arbitrary path back to the node that owns it. */
  nodeForPath(p) {
    const resolved = path.resolve(p)
    return this.nodes.find((n) => n.cwd === resolved) ?? null
  }
}

export const store = new Store()
