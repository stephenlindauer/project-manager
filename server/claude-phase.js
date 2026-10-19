/**
 * What is Claude doing, in one word, from the tool it is about to run.
 *
 * Fed by the PreToolUse / PostToolUse hooks (`tool_name` plus a one-line hint
 * from `tool_input`, trimmed by `scripts/claude-notify-hook.js`). The output is
 * a *phase* label for the sidebar badge — "editing", "testing", "watching CI" —
 * not a description of the individual call; the raw hint is kept separately for
 * the tooltip.
 *
 * `strong` phases describe a stretch of work and take over the badge at once.
 * `weak` ones (reading, running an unclassified command) are the connective
 * tissue between them: a Read in the middle of an edit must not flip the badge
 * to "reading" and back, so notify.js only lets a weak phase replace a strong
 * one after the strong one has gone quiet for a while.
 *
 * `null` means the tool says nothing about the phase (a todo list update, a
 * schedule): keep whatever was showing and just refresh the lease.
 */

/** Tools that are bookkeeping, not work. */
const SILENT = new Set([
  'TodoWrite', 'ScheduleWakeup', 'ToolSearch', 'ListAgents', 'SendFeedback',
  'Monitor', 'TaskOutput', 'TaskStop', 'ExitPlanMode', 'EnterPlanMode',
])

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READS = new Set(['Read', 'Grep', 'Glob', 'LS'])

/**
 * Bash command → phase. First match wins, so the specific (CI, PR) come before
 * the general (git, test runners) and read-only plumbing comes last.
 */
const COMMANDS = [
  ['watching CI', /\bgh\s+(pr\s+checks|run\s+(watch|view|list)|workflow\s+view)\b|statusCheckRollup/],
  ['pushing', /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bgt\s+(submit|sync)\b|\bgit\s+grok\b/],
  ['PR', /\bgh\s+(pr|api\s+\S*pulls|issue|review)\b/],
  ['committing', /\bgit\s+(commit|rebase|merge|cherry-pick|stash|revert|am)\b/],
  ['testing', /\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|playwright\s+test|rspec)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b|\btsc\b|\beslint\b|\bruff\b|\bmypy\b/],
  ['building', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|dev|start|deploy\S*)\b|\bmake\b|\bcargo\s+build\b|\bgo\s+build\b|\bdocker\s+(build|compose)\b|\bvite\b/],
  ['installing', /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip\s+install\b|\bbrew\s+install\b/],
  ['reading', /^\s*(cat|head|tail|sed\s+-n|less|grep|rg|ag|find|fd|ls|tree|wc|git\s+(status|diff|log|show|blame|branch|worktree\s+list)|gh\s+\S+\s+list|which|type|echo|printf|pwd)\b/],
]

/** Claude Code's own MCP tool names: `mcp__<server>__<tool>`. */
const MCP = /^mcp__([^_]+(?:_[^_]+)*)__/

/**
 * @param {string|null} tool  `tool_name` from the hook payload
 * @param {string|null} hint  trimmed `tool_input` slice (command, path, skill…)
 * @returns {{ phase: string, strong: boolean } | null}
 */
export function classify(tool, hint) {
  if (!tool || SILENT.has(tool)) return null
  if (EDITS.has(tool)) return { phase: 'editing', strong: true }
  if (READS.has(tool)) return { phase: 'reading', strong: false }
  if (tool === 'Agent' || tool === 'Task') return { phase: 'delegating', strong: true }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { phase: 'researching', strong: true }
  if (tool === 'AskUserQuestion') return { phase: 'asking', strong: true }
  if (tool === 'Skill') return { phase: skillPhase(hint), strong: true }
  if (tool === 'Bash') {
    for (const [phase, re] of COMMANDS) {
      if (re.test(hint ?? '')) return { phase, strong: phase !== 'reading' }
    }
    return { phase: 'running', strong: false }
  }
  const mcp = MCP.exec(tool)
  if (mcp) return { phase: mcp[1].replace(/[-_]+/g, ' '), strong: true }
  return { phase: 'running', strong: false }
}

/** A slash command or Skill name is the best label there is: `/code-review` → "code-review". */
export function skillPhase(name) {
  const n = String(name ?? '').replace(/^\//, '').split(/\s+/)[0]
  return n ? n.replace(/^.*:/, '') : 'skill'
}

/** `/foo bar` at the start of a prompt names a skill; anything else is a plain ask. */
export function promptPhase(prompt) {
  const m = /^\s*\/([\w:-]+)/.exec(prompt ?? '')
  return m ? { phase: skillPhase(m[1]), strong: true } : { phase: 'thinking', strong: false }
}
