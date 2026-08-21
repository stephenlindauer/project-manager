export type GitStatus = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  detached: boolean
  files?: string[]
}

export type Commit = {
  sha?: string
  short: string
  author: string
  authoredAt?: string
  committedAt?: string
  date?: string
  subject: string
}

export type Worktree = {
  id: string
  path: string
  branch: string | null
  name: string
  isMain: boolean
  status: GitStatus | null
  lastCommit: Commit | null
}

export type Project = {
  id: string
  name: string
  path: string
  group: string | null
  isGit: boolean
  marker: string | null
  mtime: number | null
  worktrees: Worktree[]
}

export type Node = {
  id: string
  projectId: string
  name: string
  group: string | null
  branch: string | null
  label: string
  isMain: boolean
  cwd: string
  isGit: boolean
  status: GitStatus | null
  lastCommit: Commit | null
  mtime: number | null
  /** Newer of last commit and newest dirty-file edit; drives sidebar ordering. */
  activityAt: number | null
}

export type ChangedFile = { status: string; path: string; from?: string }

export type Changes = {
  staged: ChangedFile[]
  unstaged: ChangedFile[]
  untracked: ChangedFile[]
  summary: string
}

export type Script = { name: string; script?: string; command: string; source: string }

export type Runner = {
  key: string
  nodeId: string
  name: string
  command: string
  running: boolean
  startedAt: number | null
  exitCode: number | null
  ports: number[]
}

export type SessionInfo = {
  key: string
  nodeId: string
  kind: 'claude' | 'shell'
  alive: boolean
  clients: number
  unread: boolean
  lastActivity: number
}

/**
 * A Claude Code session asking for you, raised by its Stop/Notification hooks.
 * `waiting` = blocked on your reply or a permission prompt; `done` = finished.
 */
export type AttentionState = 'waiting' | 'done'

export type Attention = {
  nodeId: string
  state: AttentionState
  message: string | null
  at: number
}

/** One transient notification. `leaving` drives the slide-out before removal. */
export type Toast = Attention & { id: string; leaving?: boolean }

export type PullRequest = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: string | null
  head: string
  base: string
  updatedAt: string | null
  reviewDecision: string | null
  checks: { state: 'passing' | 'failing' | 'pending' | 'none'; passed: number; failed: number; pending: number; total: number }
}

export type Summary = {
  isGit: boolean
  path: string
  name: string
  group: string | null
  marker?: string | null
  mtime?: number | null
  status?: GitStatus | null
  lastCommit?: Commit | null
  commits?: Commit[]
  remote?: string | null
  defaultBranch?: string | null
  worktrees?: Worktree[]
  scripts?: Script[]
  pr?: PullRequest | null
}

export type TabId = 'summary' | 'claude' | 'terminal' | 'changes' | 'tasks' | 'prs' | 'soon'

/** A Memento todo, as the Soon tab shows it. Horizon is a soft bucket; `due` is the deadline. */
export type TodoHorizon = 'now' | 'soon' | 'someday'
export type Todo = {
  id: string
  text: string
  horizon: TodoHorizon
  due: string | null
  /** Days since last touched. */
  age: number
  state: 'open' | 'fading' | 'faded' | 'closed'
  urgency: 'overdue' | 'today' | 'upcoming' | null
  /** Days until it fades, for undated open todos. */
  left: number | null
  closed: string | boolean | null
  source: string | null
  entities: string[]
}
export type Todos = {
  available: boolean
  entity: string | null
  error?: string | null
  open: Todo[]
  fading: Todo[]
  faded: Todo[]
  closed: Todo[]
}
