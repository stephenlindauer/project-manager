import { commandRule } from '../permissions.js'
import { promptText, taskHeader } from '../lib.js'

/**
 * Work: a worker session does the task, and code decides whether it is done.
 *
 * Runs one of three ways, per stage:
 *   prompt   a markdown file or inline text (the default: "implement the brief")
 *   skill    a skill by name — how an existing skill-based flow is reused
 *            instead of rewritten. Such a stage declares what the skill does
 *            itself in `owns` and the calls it needs in `allow`.
 *   command  a shell command, for a step that needs no model
 *
 * "Worker reports done" is never enough: the stage's `checks` must pass too.
 * A failed check goes back to the same conversation with the failures.
 */

const DEFAULT_PROMPT = [
  '## What to do',
  '',
  'Implement this task in the current worktree. Follow the repository\'s own instructions and conventions.',
  'Before finishing, run the checks the repository expects and fix what they find.',
  'Commit your work locally with a clear message. Do not push; the pipeline opens the pull request.',
].join('\n')

export default {
  kind: 'work',
  fixable: true,

  async step(ctx) {
    const { stage, run } = ctx

    if (stage.command) {
      const j = await ctx.job('command', { cmd: stage.command, timeoutMs: (stage.timeoutMinutes ?? 30) * 60_000 })
      if (j.state !== 'done') return { wait: true }
      if (j.code !== 0) return { fail: { reasons: [`\`${stage.command}\` exited ${j.code}:\n\n${j.tail}`] }, to: stage.id }
    } else {
      const skill = stage.skill ?? null
      const body = skill
        ? `/${skill} ${run.task.url ?? run.task.id ?? run.task.title}`
        : (promptText(ctx.machine, stage.prompt) ?? DEFAULT_PROMPT)
      const verify = (ctx.repo.verify ?? []).map(commandRule)
      const w = await ctx.worker('main', {
        role: skill ? `skill:${skill}` : 'worker',
        set: stage.set ?? (skill && stage.owns?.length ? 'skill' : 'work'),
        ownsEffects: Boolean(skill && stage.owns?.length),
        extraAllow: [...verify, ...(stage.allow ?? [])],
        model: stage.model,
        prompt: () => `${taskHeader(ctx)}\n${body}\n${verify.length ? `\nThe repository's checks: ${ctx.repo.verify.map((c) => `\`${c}\``).join(', ')}.\n` : ''}`,
      })
      if (w.outcome) return w.outcome
      ctx.state.summary = w.summary ?? w.text ?? null
      // What the PR body says the change does: the last worker's own words.
      if (!stage.skill) run.summary = ctx.state.summary
    }

    const defaults = stage.command || stage.skill || !run.worktree?.branch ? [] : ['commits']
    const c = await ctx.check(stage.checks ?? defaults)
    if (c.wait) return { wait: true }
    if (!c.ok) {
      // Let the worker run again with the failures, in the same conversation.
      delete ctx.state.w
      delete ctx.state.j
      return { fail: { reasons: c.reasons }, to: stage.id }
    }
    return { done: true }
  },
}
