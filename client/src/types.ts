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
  /** An orchestrator notice: clicking it opens that run. */
  runId?: string
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

/** See server/cleanup.js: `merged`/`missing` are purgeable, `empty`/`open` only ever listed. */
export type CleanupVerdict = 'merged' | 'missing' | 'empty' | 'open'

export type CleanupItem = {
  nodeId: string
  projectId: string
  project: string
  branch: string | null
  path: string
  verdict: CleanupVerdict
  /** "squash-merged into origin/main", "3 commits not on main", … */
  reason: string
  /** Live state that keeps a merged tree from being purged: dirty files, an open PR, a busy Claude. */
  holds: string[]
  /** The branch's upstream was deleted on the remote — usually a merged or closed PR. */
  upstreamGone: boolean
  /** A pm-* tmux session exists for it; purging ends it. */
  session: boolean
  activityAt: number | null
}

export type CleanupScan = {
  items: CleanupItem[]
  fetchErrors: { project: string; error: string }[]
  staleDays: number
}

export type CleanupResult = {
  nodeId: string
  project?: string
  branch?: string | null
  ok: boolean
  error: string | null
  branchDeleted?: boolean
}

// ------------------------------------------------------------ orchestrator

export type OrchRunState = 'active' | 'waiting' | 'paused' | 'held' | 'done' | 'abandoned' | 'released'

export type OrchRun = {
  id: string
  state: OrchRunState
  createdAt: number
  updatedAt: number
  endedAt: number | null
  task: { source: string; id: string | null; title: string; url: string | null; type: string | null; ref: string; untrusted: number }
  repoName: string
  repoPath: string
  pipeline: string
  stages: { id: string; kind: string }[]
  stageIndex: number
  stageId: string | null
  /** What it is doing or waiting on right now, in a few words. */
  note: string | null
  working: number
  attempts: number
  spend: { tokens: number; usd: number }
  pr: { number: number | null; url: string } | null
  worktree: { dir: string; branch: string | null; base: string } | null
  nodeId: string | null
  cards: number
  blocking: number
}

export type OrchCard = {
  id: string
  key: string
  runId: string
  stageId: string | null
  type: 'gate' | 'question' | 'permission' | 'paused' | 'effect' | 'fix' | string
  title: string
  body: string
  detail?: string | null
  choices: { id: string; label: string }[]
  recommended: string | null
  freeText?: boolean
  blocking: boolean
  createdAt: number
  answer: { choice: string; note: string | null; at: number } | null
  rule?: string
}

export type OrchState = {
  runs: OrchRun[]
  inbox: OrchCard[]
  limits: { running: number; wip: number; hasSlot: boolean; max: { activeSessions: number | null; wip: number | null; fixRounds: number | null; spendPerRun: number | null } }
}

export type OrchSession = {
  n: number; sid: string; role: string; stageId: string; set: string; resumed: boolean
  status: 'running' | 'finished' | 'failed' | 'vanished' | 'stopped'
  startedAt: number; endedAt: number | null; tokens: number; usd: number; activity: string | null
}

export type OrchEvent = { at: number; type: string; stage?: string; [k: string]: unknown }

export type OrchRunDetail = OrchRun & {
  sessions: OrchSession[]
  inbox: OrchCard[]
  attemptsByStage: Record<string, number>
  stageState: Record<string, { waitingOn: string | null; summary: string | null }>
  summary: string | null
  brief: string | null
  events: OrchEvent[]
  records: { name: string; content: string | null }[]
  /** Calls a permission set refused that the worker got past. */
  refused: { stageId: string; set: string; rule: string; at: number; allowed?: boolean }[]
}

export type OrchTranscriptItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'error'; text: string }
  | { kind: 'result'; text: string; status: string }

export type OrchMeta = {
  enabled: boolean
  errors?: string[]
  sources?: { name: string; adapter: string; queue: boolean }[]
  pipelines?: string[]
}

type Provenance = Record<string, string>
export type OrchRules = {
  dir: string
  errors: string[]
  machine: { values: Record<string, unknown>; provenance: Provenance }
  repo: { name: string; values: Record<string, unknown>; provenance: Provenance } | null
  pipelines: { name: string; errors: string[]; origin: string | null; stages: { id: string; kind: string; gate: boolean; skill: string | null }[]; owners: Record<string, string[]> }[]
  permissionSets: Record<string, { allow?: string[]; deny?: string[]; error?: string }>
  stages: { name: string; origin: string | null; wraps: string | null; error: string | null }[]
  sources: { name: string; origin: string | null; wraps: string | null; error: string | null }[]
  checks: { name: string; origin: string | null; wraps: string | null; error: string | null }[]
}
