import fs from 'node:fs'
import { git } from '../../exec.js'
import { out, err } from '../lib.js'

/**
 * Intake: give the run a worktree and (unless a skill cuts its own) a branch.
 *
 * The task itself was fetched when the run was created — that is what filled
 * `brief.md`. Safe to repeat: a worktree that already exists at the run's
 * directory is adopted, never created twice.
 */
export default {
  kind: 'intake',
  owns: (stage) => (stage.branch === false ? [] : ['branch']),

  async step(ctx) {
    const { run, stage, app } = ctx
    if (run.worktree?.dir && fs.existsSync(run.worktree.dir)) return { done: true }

    const repo = run.repoPath
    const base = stage.base ?? ctx.repo.base ?? await app.git.defaultBranch(repo)
    // Start from what the remote has now, not from a local branch that may be
    // weeks behind. A repo with no remote simply uses the local base.
    await git(repo, ['fetch', 'origin', base], { timeout: 60_000 })
    const remote = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])
    const from = remote.failed ? base : `origin/${base}`
    const baseSha = out(await git(repo, ['rev-parse', from]))

    const prefix = stage.branchPrefix ?? ctx.repo.branchPrefix ?? ''
    let branch = `${prefix}${run.task.ref}`
    const taken = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (!taken.failed && out(taken)) branch = `${branch}-${run.id.slice(-4)}`
    const dir = app.worktreeDirFor(repo, branch)

    let result
    if (stage.branch === false) {
      // A skill will cut the branch itself; it gets a detached tree to do it in.
      result = await git(repo, ['worktree', 'add', '--detach', dir, from], { timeout: 120_000 })
    } else {
      result = await app.git.addWorktree(repo, { branch, base: from, dir })
    }
    if (result.failed && !fs.existsSync(dir)) return { fail: { reasons: [`could not create the worktree: ${err(result)}`] }, to: stage.id }

    run.worktree = { dir, branch: stage.branch === false ? null : branch, base, baseSha }
    ctx.log('worktree', run.worktree)
    ctx.save()
    await app.rescan?.()
    return { done: true }
  },
}
