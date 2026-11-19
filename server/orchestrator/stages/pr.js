import { run as exec, git } from '../../exec.js'
import { headSha, out, err, prState } from '../lib.js'
import { diffStat } from './gate.js'

/**
 * PR: push the branch and open the pull request (or a draft). Both are engine
 * side effects, never a model's tool call, and both go through `ctx.effect`
 * so a restart between "PR opened" and "PR recorded" cannot open a second.
 *
 * Re-entered after a fix loop, it pushes the new commits and finds the PR it
 * already opened.
 */
export default {
  kind: 'pr',
  owns: () => ['pr'],

  async step(ctx) {
    const { run, stage } = ctx
    const wt = run.worktree
    if (!wt?.branch) return { pause: 'There is no branch to open a pull request from.' }
    const sha = await headSha(wt.dir)

    // A fix for a teammate's comment is prepared, then waits for me: they are
    // reading that PR, and an unreviewed push would land under their eyes.
    // A CI fix is not held — it corrects what I already approved.
    if (run.pr?.number && run.loop?.kind === 'review' && ctx.repo.ship.fix_push !== 'auto') {
      const ask = ctx.ask({
        key: `fix:${sha}:${run.fixEpoch ?? 0}`, type: 'fix',
        title: `Fix ready to push: ${run.task.title}`,
        body: `${run.summary?.split('**Follow-up:**').at(-1)?.trim() ?? 'The requested changes are committed locally.'}\n\nPushing adds new commits on top of the PR. Nothing is rebased.`,
        detail: await diffStat(wt.dir, `origin/${wt.branch}`),
        choices: [{ id: 'push', label: 'Push' }, { id: 'send-back', label: 'Send back' }, { id: 'take-over', label: 'Take over' }],
        recommended: 'push',
      })
      if (ask.outcome) return ask.outcome
      // Spent: I took it over from here. Ask again about the tree as handed back.
      if (ask.answer.choice === 'take-over') { run.fixEpoch = (run.fixEpoch ?? 0) + 1; return { wait: true } }
      if (ask.answer.choice === 'send-back') {
        return { fail: { reasons: [ask.answer.note ?? 'The prepared fix was sent back. Re-read the review comments.'] }, uncounted: true }
      }
    }

    const pushed = await ctx.effect('push', sha, {
      describe: `push ${wt.branch} at ${sha?.slice(0, 8)}`,
      check: async () => {
        const r = await git(wt.dir, ['ls-remote', 'origin', `refs/heads/${wt.branch}`], { timeout: 30_000 })
        if (r.failed) return undefined
        return out(r).split(/\s/)[0] === sha ? sha : null
      },
      act: async () => {
        const r = await git(wt.dir, ['push', '-u', 'origin', `HEAD:refs/heads/${wt.branch}`], { timeout: 120_000 })
        if (r.failed) throw new Error(`git push failed: ${err(r)}`)
        return sha
      },
    })
    if (pushed.outcome) return pushed.outcome

    const existing = async () => {
      const pr = await prState(wt.dir, wt.branch)
      if (pr.error) return pr.missing ? null : undefined
      return pr.state === 'OPEN' || pr.state === 'MERGED' ? { number: pr.number, url: pr.url } : null
    }
    const opened = await ctx.effect('pr', 'open', {
      describe: `open the pull request for ${wt.branch}`,
      check: existing,
      act: async () => {
        const already = await existing()
        if (already) return already
        const title = stage.title ?? run.task.title
        const body = [
          run.summary ?? '',
          run.task.url ? `\nTask: ${run.task.url}` : '',
          '\n🤖 Opened by the Project Manager orchestrator',
        ].join('\n').trim()
        const args = ['pr', 'create', '--title', title, '--body', body, '--head', wt.branch, '--base', wt.base]
        if (stage.draft) args.push('--draft')
        const r = await exec('gh', args, { cwd: wt.dir, timeout: 60_000 })
        if (r.failed) throw new Error(`gh pr create failed: ${err(r)}`)
        const url = out(r).split('\n').pop()
        return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null, url }
      },
    })
    if (opened.outcome) return opened.outcome
    run.pr = opened.value
    ctx.app.shipRefresh?.()
    return { done: true, note: run.pr?.url ?? null }
  },
}
