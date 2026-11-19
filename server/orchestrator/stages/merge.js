import { run as exec } from '../../exec.js'
import { err, prState, due } from '../lib.js'

/**
 * Merge, per the repo's ship policy.
 *
 *   merge.by: me                  wait for me to merge it
 *   merge.by: github-auto-merge   arm GitHub's auto-merge, then wait
 *   merge.by: app                 merge once the policy's approvals and CI are met
 *   stage `waitOnly: true`        do nothing but wait for the merge (a skill owns it)
 *
 * With no `watch` stage before it, this stage is also what waits on CI, so a
 * red check here goes back to the worker with the failing check names.
 *
 * Two things are deliberately not defaults: the merge method (auto paths stay
 * off until the repo sets one), and "no CI" — a repo with no checks must say
 * `ci: none`, so a missing workflow never passes as green by accident.
 */
const NO_CHECKS_GRACE_MS = 3 * 60_000

export default {
  kind: 'merge',
  owns: (stage, { hasWatch }) => (hasWatch || stage.waitOnly ? [] : ['ci']),

  async step(ctx) {
    const { run, state: st } = ctx
    const ship = ctx.repo.ship
    const cwd = run.worktree?.dir ?? run.repoPath
    if (!run.pr?.number) return { pause: 'There is no pull request to merge.' }
    // The first look is immediate; after that, GitHub is asked every 20s, not every tick.
    if (st.pr && !due(st, 'poll', (ctx.stage.pollSeconds ?? 20) * 1000)) return { wait: true }

    const pr = await prState(cwd, run.pr.number)
    if (pr.error) { ctx.state.lastError = pr.error; return { wait: true } }
    st.pr = { state: pr.state, failed: pr.failed, pending: pr.pending.length, approvals: pr.approvals }
    st.since ??= Date.now()

    if (pr.state === 'MERGED') {
      run.mergedAt = Date.now()
      ctx.app.shipRefresh?.()
      return { done: true, note: `merged ${pr.url}` }
    }
    if (pr.state === 'CLOSED') return { pause: `The pull request was closed without merging: ${pr.url}` }

    // `waitOnly`: a skill opened the PR, armed the merge and is watching CI
    // itself. This stage's whole job is to notice when it lands.
    if (ctx.stage.waitOnly) { st.waitingOn = 'the merge'; return { wait: true } }

    // A task can turn auto-merge off for itself; it can never turn it on.
    const by = run.overrides?.autoMerge === false ? 'me' : ship.merge.by
    const method = ship.merge.method
    if (by === 'me') { st.waitingOn = 'you to merge'; return { wait: true } }
    if (!['squash', 'merge', 'rebase'].includes(method)) {
      return { pause: `This repo's ship policy has merge.by "${by}" but no merge.method. Set squash, merge or rebase in its repo file.` }
    }

    if (by === 'github-auto-merge') {
      const armed = await ctx.effect('auto-merge', String(run.pr.number), {
        describe: `arm auto-merge on #${run.pr.number}`,
        check: async () => null, // arming twice is harmless
        act: async () => {
          const r = await exec('gh', ['pr', 'merge', String(run.pr.number), '--auto', `--${method}`], { cwd, timeout: 60_000 })
          if (r.failed) throw new Error(`gh pr merge --auto failed: ${err(r)}`)
          return true
        },
      })
      if (armed.outcome) return armed.outcome
      if (pr.failed.length && !ctx.stage.waitOnly) return { fail: { reasons: [`CI failed on ${pr.url}: ${pr.failed.join(', ')}`] } }
      st.waitingOn = 'GitHub auto-merge'
      return { wait: true }
    }

    // by === 'app'
    if (pr.isDraft) { st.waitingOn = 'the PR to leave draft'; return { wait: true } }
    if (pr.changesRequested) return { fail: { reasons: [`Changes were requested on ${pr.url}.`] } }
    if (pr.approvals < (ship.approvals ?? 0)) { st.waitingOn = `${ship.approvals - pr.approvals} more approval(s)`; return { wait: true } }
    if (ship.ci !== 'none') {
      if (pr.failed.length) return { fail: { reasons: [`CI failed on ${pr.url}: ${pr.failed.join(', ')}. Read the failing checks with \`gh pr checks ${pr.number}\` and fix them.`] } }
      if (pr.pending.length) { st.waitingOn = `CI (${pr.pending.length} pending)`; return { wait: true } }
      if (!pr.checks.length) {
        if (Date.now() - st.since < NO_CHECKS_GRACE_MS) { st.waitingOn = 'CI to start'; return { wait: true } }
        return { pause: `${pr.url} has no CI checks, and this repo's ship policy says ci: required. If the repo really has no CI, set "ci": "none" in its repo file.` }
      }
    }
    if (pr.mergeable === 'CONFLICTING') return { fail: { reasons: [`${pr.url} has merge conflicts with ${pr.baseRef}. Merge origin/${pr.baseRef} into the branch and resolve them.`] } }

    const merged = await ctx.effect('merge', String(run.pr.number), {
      describe: `merge #${run.pr.number} (${method})`,
      check: async () => {
        const now = await prState(cwd, run.pr.number)
        if (now.error) return undefined
        return now.state === 'MERGED' ? true : null
      },
      act: async () => {
        const r = await exec('gh', ['pr', 'merge', String(run.pr.number), `--${method}`], { cwd, timeout: 120_000 })
        if (r.failed) throw new Error(`gh pr merge failed: ${err(r)}`)
        return true
      },
    })
    if (merged.outcome) return merged.outcome
    run.mergedAt = Date.now()
    ctx.app.shipRefresh?.()
    return { done: true, note: `merged ${pr.url}` }
  },
}
