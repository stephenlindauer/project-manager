/**
 * Permission sets, one per stage kind, written in Claude Code's own rule
 * syntax. For each session the engine writes a settings file from the set and
 * starts `claude` with it in `dontAsk` mode: Claude Code does the matching
 * (compound commands included) and refuses anything unmatched at once, so the
 * app never parses a shell command to decide whether it is safe and nothing
 * ever waits on a prompt that times out.
 *
 * The session also loads the person's own user settings — that is the point,
 * it needs their skills and MCP servers — and those may *allow* things like
 * `gh pr merge`. Allow lists merge, deny wins, so every set except `skill`
 * carries SIDE_EFFECT_DENY: pushes, PRs, merges and deploys belong to engine
 * code, not to a model's tool call.
 */

const READ = [
  'Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git branch --show-current)', 'Bash(git branch --list:*)', 'Bash(git rev-parse:*)',
  'Bash(git ls-files:*)', 'Bash(git blame:*)', 'Bash(git merge-base:*)', 'Bash(git grep:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(rg:*)',
  'Bash(grep:*)', 'Bash(pwd)', 'Bash(which:*)', 'Bash(jq:*)',
]

/** Everything a model must never do itself outside a named skill stage. */
export const SIDE_EFFECT_DENY = [
  'Bash(git push:*)', 'Bash(git remote:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr ready:*)', 'Bash(gh pr close:*)',
  'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh pr edit:*)',
  'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue close:*)', 'Bash(gh issue edit:*)',
  'Bash(gh release:*)', 'Bash(gh api:*)', 'Bash(gh workflow run:*)',
]

const NO_EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export const DEFAULT_SETS = {
  /** Reviewers, cross-check, the resolver, the explain-back. */
  read: { allow: READ, deny: [...SIDE_EFFECT_DENY, ...NO_EDITS] },
  /** A record stage: read, plus writing the record file (added per session). */
  record: { extends: 'read', allow: [], deny: [...SIDE_EFFECT_DENY, 'NotebookEdit'], edits: 'record' },
  /** A worker: edit inside the worktree, run the repo's commands, commit locally. */
  work: {
    extends: 'read',
    allow: [
      'Skill', 'Agent', 'Task',
      'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git mv:*)', 'Bash(git rm:*)',
      'Bash(git restore:*)', 'Bash(git stash:*)',
      'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm install)', 'Bash(npm ci)', 'Bash(npx tsc:*)',
      'Bash(node --test:*)', 'Bash(mkdir:*)', 'Bash(touch:*)', 'Bash(mv:*)', 'Bash(cp:*)',
    ],
    deny: SIDE_EFFECT_DENY,
    edits: 'worktree',
  },
  /** A work stage running a skill that owns side effects; the stage lists what it needs. */
  skill: { extends: 'work', allow: [], deny: [] },
}

/**
 * Flatten a named set into `{ allow, deny }`. `extends` pulls in the parent's
 * allow rules; deny rules are the set's own, so `skill` can drop the
 * side-effect denials that `work` carries.
 */
export function resolveSet(sets, name, seen = new Set()) {
  const set = sets?.[name]
  if (!set) throw new Error(`unknown permission set "${name}"`)
  if (seen.has(name)) throw new Error(`permission set "${name}" extends itself`)
  seen.add(name)
  const parent = set.extends ? resolveSet(sets, set.extends, seen) : { allow: [] }
  return {
    allow: [...new Set([...parent.allow, ...(set.allow ?? [])])],
    deny: [...new Set(set.deny ?? [])],
    edits: set.edits ?? parent.edits ?? null,
  }
}

/**
 * The settings file for one session. `extraAllow` carries the stage's own
 * additions (a repo's verify commands, a skill's calls, a record path) and any
 * one-off rule from an "allow once" card.
 */
export function settingsFor(sets, name, { extraAllow = [], extraDeny = [] } = {}) {
  const set = resolveSet(sets, name)
  const deny = [...new Set([...set.deny, ...extraDeny])]
  // An explicit allow must not be shadowed by a deny inherited for safety —
  // that is how a skill stage is given back exactly the calls it owns.
  const allow = [...new Set([...set.allow, ...extraAllow])]
  return { permissions: { allow, deny: deny.filter((d) => !extraAllow.includes(d)), defaultMode: 'dontAsk' } }
}

/** A permission rule for one exact denied tool call, for "allow once" / "allow always". */
export function ruleFor(denial) {
  const { tool, input } = denial
  if (tool === 'Bash' && typeof input?.command === 'string') return `Bash(${input.command})`
  // `Edit(//abs/path)` covers every file-editing tool; `//` marks an absolute path.
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && input?.file_path) return `Edit(/${input.file_path})`
  if (tool === 'Read' && input?.file_path) return `Read(/${input.file_path})`
  return tool
}

/** Edits anywhere under one directory. */
export const editsUnder = (dir) => `Edit(/${dir}/**)`

/** `npm test` → a rule matching it and anything appended. */
export const commandRule = (cmd) => `Bash(${String(cmd).trim()}:*)`
