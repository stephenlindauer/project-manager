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
  kind: SessionKind
  alive: boolean
  clients: number
  unread: boolean
  lastActivity: number
}

/**
 * What a node's Claude Code session is doing, as told by its own hooks.
 * `working` = mid-turn; `waiting` = blocked on you (permission, question);
 * `done` = finished the turn and sitting at the prompt.
 */
export type ClaudeState = 'working' | 'waiting' | 'done'

/** The two states that ask for you — what toasts and the "needs you" strip carry. */
export type AttentionState = 'waiting' | 'done'

export type ClaudeStatus = {
  nodeId: string
  state: ClaudeState
  /** One word for the current stretch of work while `working`: "editing", "testing", a skill name. */
  phase: string | null
  /** One line of specifics: the command or file, the prompt, Claude's closing words. */
  detail: string | null
  /** First line of the prompt that started the current turn. */
  task: string | null
  /** Last hook, and when `state` was entered. */
  at: number
  since: number
  /** You have looked at the pane since `since`; unseen waiting/done is what the sidebar shouts about. */
  seen: boolean
}

/**
 * The next thing you have to do to ship a worktree's pull requests, as one
 * word. The first four ask for you; the rest say why nothing does yet.
 * Mirrors VERDICTS in server/ship-verdict.js.
 */
export type ShipVerdict = 'fix' | 'address' | 'rebase' | 'merge' | 'stacked' | 'draft' | 'ci' | 'review'

export type ShipPr = {
  number: number
  url: string
  title: string
  head: string | null
  base: string | null
  verdict: ShipVerdict
  /** The head commit's aggregated check state: SUCCESS | FAILURE | PENDING | ERROR | EXPECTED. */
  rollup: string | null
  mergeStateStatus: string | null
  reviewDecision: string | null
  isDraft: boolean
}

/** One worktree's ship verdict — the loudest across the PRs it owns. Server-owned; see ship.js. */
export type ShipStatus = {
  nodeId: string
  verdict: ShipVerdict
  /** `verdict` is in the attention set: something is on you. */
  attention: boolean
  prs: ShipPr[]
  updatedAt: string | null
  /** When the PR data was last fetched from GitHub. */
  at: number | null
  /** Two fetches in a row failed; this is the last good answer, not the current one. */
  stale: boolean
}

/** A PR of yours in a repo we index, on a branch no worktree has checked out. */
export type ShipOrphan = {
  repo: string
  number: number
  title: string
  url: string
  head: string | null
  verdict: ShipVerdict
  attention: boolean
}

export type ShipEnvelope = {
  available: boolean
  stale: boolean
  at: number | null
  nodes: ShipStatus[]
  orphans: ShipOrphan[]
}

/**
 * One transient notification. Two flavours share the stack: a Claude signal
 * from the server (`state` set, headed by ATTENTION_LABEL) and a local notice
 * from the app itself (`title` set — a worktree being created, an error).
 * `key` dedupes: a newer toast with the same key replaces the older one.
 * `leaving` drives the slide-out before removal.
 */
export type Toast = {
  id: string
  key: string
  nodeId: string | null
  state?: AttentionState
  title?: string
  tone?: 'attn' | 'ok' | 'bad' | 'info'
  message: string | null
  at: number
  leaving?: boolean
}

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
  /** `unknown` means checks were not fetched for this PR (only your own PRs carry them). */
  checks: { state: 'passing' | 'failing' | 'pending' | 'none' | 'unknown'; passed: number; failed: number; pending: number; total: number }
}

/** One rung of a PR stack. `pr` is null for a git-grok commit not yet pushed. */
export type StackEntry = {
  head: string | null
  pr: PullRequest | null
  commit: { sha: string; short: string; subject: string } | null
  /** This worktree is on the entry's branch. */
  current: boolean
  /** The branch exists locally (vs. only on the remote). */
  local: boolean
  /** Absolute path of the worktree that has the branch checked out, if any. */
  checkedOutAt: string | null
}

/**
 * The stack the current worktree belongs to, bottom (nearest `base`) to top.
 * `branches` = chained feature branches; `grok` = git-grok commits on the
 * integration branch; null = the branch has no PR.
 */
export type Stack = {
  kind: 'branches' | 'grok' | null
  base: string | null
  entries: StackEntry[]
  /** Other PRs based on a rung of this stack that are not in the main line. */
  forks: { number: number; title: string; head: string; base: string; url: string }[]
}

export type PrsView = {
  available: boolean
  prs: PullRequest[]
  viewer?: string | null
  error?: string | null
  stack?: Stack | null
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

/** The agent CLIs the "Claude" tab can host. Each is its own tmux session kind. */
export type Agent = 'claude' | 'codex'
export type SessionKind = Agent | 'shell'

export type TabId = 'summary' | 'claude' | 'terminal' | 'changes' | 'tasks' | 'prs'
