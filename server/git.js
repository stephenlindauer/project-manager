import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from './exec.js'

/**
 * Field separator for --format strings, written as the git escape `%x1f`.
 * It must never be a literal NUL: argv strings are NUL-terminated, so execve
 * would silently truncate the format at the first field.
 */
const SEP = '\x1f'
const FSEP = '%x1f'
/** Record separator emitted by git's -z output modes. */
const NUL = '\0'

/** Branch, upstream, ahead/behind and per-file change counts in one call. */
export async function status(cwd) {
  const { stdout, failed } = await git(cwd, [
    'status', '--porcelain=v2', '--branch', '--ahead-behind',
  ])
  if (failed) return null

  const out = {
    branch: null, upstream: null, ahead: 0, behind: 0,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0, detached: false,
    /** Paths of dirty files, used to date the working tree. Bounded, see below. */
    files: [],
  }

  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim()
      out.branch = head === '(detached)' ? null : head
      out.detached = head === '(detached)'
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice(18).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.slice(12).match(/\+(\d+)\s+-(\d+)/)
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') out.staged++
      if (xy[1] !== '.') out.unstaged++
      out.files.push(pathFromEntry(line))
    } else if (line.startsWith('u ')) {
      out.conflicted++
      out.files.push(pathFromEntry(line))
    } else if (line.startsWith('? ')) {
      out.untracked++
      out.files.push(line.slice(2))
    }
  }
  out.files = out.files.filter(Boolean).slice(0, MAX_DATED_FILES)
  return out
}

/** How many dirty files we're willing to stat when dating a working tree. */
const MAX_DATED_FILES = 48

/**
 * Pull the path out of a porcelain-v2 changed/unmerged entry. The leading field
 * count is fixed per record type and the path is the remainder, so paths
 * containing spaces survive. Renames append the original path after a tab.
 */
function pathFromEntry(line) {
  const fields = line.startsWith('1 ') ? 8 : line.startsWith('2 ') ? 9 : 10
  const parts = line.split(' ')
  return parts.slice(fields).join(' ').split('\t')[0]
}

/**
 * Newest mtime among the given working-tree paths — how recently you actually
 * edited this project, as opposed to when you last committed.
 */
export async function newestFileMtime(cwd, files = []) {
  const times = await Promise.all(files.map(async (f) => {
    try { return (await fs.stat(path.join(cwd, f))).mtimeMs } catch { return 0 }
  }))
  const newest = Math.max(0, ...times)
  return newest || null
}

export async function lastCommit(cwd) {
  const fmt = ['%H', '%h', '%an', '%aI', '%cI', '%s'].join(FSEP)
  const { stdout, failed } = await git(cwd, ['log', '-1', `--format=${fmt}`])
  if (failed || !stdout.trim()) return null
  const [sha, short, author, authoredAt, committedAt, subject] =
    stdout.trim().split(SEP)
  return { sha, short, author, authoredAt, committedAt, subject }
}

/**
 * All worktrees for a repo. The first entry reported by git is always the main
 * worktree; linked worktrees follow.
 */
export async function worktrees(cwd) {
  const { stdout, failed } = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (failed) return []
  const list = []
  let cur = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur)
      cur = { path: line.slice(9), branch: null, head: null, bare: false, detached: false, locked: false }
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line.startsWith('locked')) {
      cur.locked = true
    }
  }
  if (cur) list.push(cur)
  return list.map((w, i) => ({
    ...w,
    isMain: i === 0,
    name: w.branch || (w.head ? w.head.slice(0, 7) : path.basename(w.path)),
  }))
}

export async function branches(cwd) {
  const fmt = ['%(refname:short)', '%(committerdate:iso-strict)', '%(objectname:short)'].join(SEP)
  const { stdout, failed } = await git(cwd, [
    'for-each-ref', '--sort=-committerdate', '--count=200',
    `--format=${fmt}`, 'refs/heads',
  ])
  if (failed) return []
  return stdout.split('\n').filter(Boolean).map((l) => {
    const [name, date, sha] = l.split(SEP)
    return { name, date, sha }
  })
}

/** Best guess at the repo's integration branch, for worktree/PR bases. */
export async function defaultBranch(cwd) {
  const head = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (!head.failed && head.stdout.trim()) {
    return head.stdout.trim().replace('refs/remotes/origin/', '')
  }
  for (const candidate of ['main', 'master', 'develop']) {
    const r = await git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
    if (!r.failed && r.stdout.trim()) return candidate
  }
  return null
}

export async function remoteUrl(cwd) {
  const { stdout, failed } = await git(cwd, ['remote', 'get-url', 'origin'])
  return failed ? null : stdout.trim()
}

/**
 * Files changed relative to HEAD, split by staged / unstaged / untracked.
 * Used by the Changes tab.
 */
export async function changedFiles(cwd) {
  const parse = (stdout) => {
    const parts = stdout.split(NUL).filter(Boolean)
    const files = []
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]
      if (/^[RC]/.test(code)) {
        files.push({ status: code[0], from: parts[++i], path: parts[++i] })
      } else {
        files.push({ status: code[0], path: parts[++i] })
      }
    }
    return files
  }

  const [staged, unstaged, untracked, stat] = await Promise.all([
    git(cwd, ['diff', '--cached', '--name-status', '-z']),
    git(cwd, ['diff', '--name-status', '-z']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(cwd, ['diff', 'HEAD', '--shortstat']),
  ])

  return {
    staged: staged.failed ? [] : parse(staged.stdout),
    unstaged: unstaged.failed ? [] : parse(unstaged.stdout),
    untracked: untracked.failed
      ? []
      : untracked.stdout.split(NUL).filter(Boolean).map((p) => ({ status: '?', path: p })),
    summary: stat.stdout.trim(),
  }
}

export async function fileDiff(cwd, file, { staged = false } = {}) {
  const args = ['diff', '--no-color', '--unified=3']
  if (staged) args.push('--cached')
  args.push('--', file)
  const { stdout } = await git(cwd, args)
  if (stdout.trim()) return stdout
  // Untracked files have nothing to diff against; synthesise one from /dev/null.
  const { stdout: untracked } = await git(cwd, [
    'diff', '--no-color', '--unified=3', '--no-index', '--', '/dev/null', file,
  ])
  return untracked
}

/** Recent commits for the Summary tab timeline. */
export async function recentCommits(cwd, limit = 10) {
  const fmt = ['%h', '%an', '%aI', '%s'].join(FSEP)
  const { stdout, failed } = await git(cwd, ['log', `-${limit}`, `--format=${fmt}`])
  if (failed) return []
  return stdout.split('\n').filter(Boolean).map((l) => {
    const [short, author, date, subject] = l.split(SEP)
    return { short, author, date, subject }
  })
}

export async function addWorktree(repoPath, { branch, base, dir }) {
  const exists = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const args = ['worktree', 'add']
  if (exists.failed || !exists.stdout.trim()) {
    args.push('-b', branch, dir)
    if (base) args.push(base)
  } else {
    args.push(dir, branch)
  }
  return git(repoPath, args, { timeout: 120_000 })
}

export async function removeWorktree(repoPath, dir, { force = false } = {}) {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(dir)
  return git(repoPath, args)
}

export const fetchAll = (cwd) =>
  git(cwd, ['fetch', '--all', '--prune'], { timeout: 60_000 })
