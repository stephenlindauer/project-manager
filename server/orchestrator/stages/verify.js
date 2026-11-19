/**
 * Verify: the repo's own verify commands, in order, each exiting 0. No model
 * is involved — this is the check a worker cannot talk its way past. A
 * failure goes back to the worker with the command's output.
 */
export default {
  kind: 'verify',

  async step(ctx) {
    const cmds = ctx.stage.commands ?? ctx.repo.verify ?? []
    if (!cmds.length) return { done: true, note: 'no verify commands configured for this repo' }
    for (const [i, cmd] of cmds.entries()) {
      const j = await ctx.job(`v${i}`, { cmd, timeoutMs: (ctx.stage.timeoutMinutes ?? 30) * 60_000 })
      if (j.state !== 'done') return { wait: true }
      if (j.code !== 0) return { fail: { reasons: [`\`${cmd}\` exited ${j.code}:\n\n${j.tail}`] } }
    }
    return { done: true }
  },
}
