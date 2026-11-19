import { commitsAhead, dirtyFiles } from '../lib.js'

/** The tree has commits the base lacks, and nothing left uncommitted. */
export default {
  name: 'commits',
  async run(ctx) {
    const wt = ctx.run.worktree
    if (!wt) return { ok: false, reasons: ['there is no worktree'] }
    const reasons = []
    if (!(await commitsAhead(wt.dir, wt.baseSha ?? wt.base))) reasons.push('No commits were made. Commit the work locally.')
    const dirty = await dirtyFiles(wt.dir)
    if (dirty.length) reasons.push(`Uncommitted changes remain: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? '…' : ''}. Commit them or remove them.`)
    return { ok: !reasons.length, reasons }
  },
}
