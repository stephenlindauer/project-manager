import { prState, due } from '../lib.js'

/**
 * The branch's PR has reached a state: `{ pr: 'exists' }` or `{ pr: 'merged' }`.
 * For a skill stage that opens the PR itself — this is how the run learns of it.
 */
export default {
  name: 'pr',
  async run(ctx, settings) {
    if (!due(ctx.state, 'pr-check', 20_000) && !ctx.state.prSeen) return { wait: true }
    const wt = ctx.run.worktree
    // With no branch on record (a skill cut its own), `gh pr view` with no
    // argument reads the worktree's current branch.
    const pr = await prState(wt?.dir ?? ctx.cwd, ctx.run.pr?.number ?? wt?.branch ?? null)
    if (pr.error) return pr.missing ? { ok: false, reasons: ['No pull request exists for this branch yet.'] } : { wait: true }
    ctx.run.pr = { number: pr.number, url: pr.url }
    if (wt && !wt.branch) wt.branch = pr.headRef
    ctx.state.prSeen = true
    if (settings.pr === 'merged' && pr.state !== 'MERGED') return { wait: true }
    return { ok: true }
  },
}
