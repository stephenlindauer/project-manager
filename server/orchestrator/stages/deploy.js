import { git } from '../../exec.js'
import { due, err } from '../lib.js'

/**
 * Deploy: run the repo's deploy command, or wait for a deploy something else
 * runs (`deploy.by: external`), and finish only when `deploy.check` passes.
 * With no check set, the command exiting 0 is the answer.
 *
 * The command runs in its own tmux session, like every job, which matters
 * most here: deploying this app restarts this server mid-stage. The deploy
 * carries on, and the freshly booted engine finds its exit file.
 *
 * A deploy is never re-run on a guess. If its outcome cannot be read back —
 * the session vanished without an exit code and there is no check — the run
 * goes to my inbox.
 */
export default {
  kind: 'deploy',

  async step(ctx) {
    const { state: st, stage } = ctx
    const d = ctx.repo.ship.deploy ?? {}
    const cwd = d.cwd ?? ctx.run.repoPath
    const timeoutMs = (stage.timeoutMinutes ?? 30) * 60_000

    if (d.by !== 'external') {
      if (!d.cmd) return { done: true, note: 'no deploy command configured for this repo' }

      if (!st.deployed) {
        if (d.pull && !st.pulled) {
          const r = await git(cwd, ['pull', '--ff-only'], { timeout: 120_000 })
          if (r.failed) return { pause: `Could not update ${cwd} before deploying: ${err(r)}` }
          st.pulled = true
        }
        const answer = ctx.answer('deploy-lost')
        if (answer?.choice === 'happened') st.deployed = true
        else {
          if (answer?.choice === 'redo' && !st.redone) { st.redone = true; delete ctx.state.j?.deploy }
          const j = await ctx.job('deploy', { cmd: d.cmd, cwd, timeoutMs })
          if (j.state === 'running') return { wait: true }
          if (j.state === 'lost') {
            if (d.check) st.deployed = true // the check below decides
            else return {
              inbox: {
                key: 'deploy-lost', type: 'effect', title: `Did the deploy finish? ${d.cmd}`,
                body: 'The deploy command stopped without leaving an exit code, and this repo has no deploy.check to read the result from. It will not be re-run on a guess.',
                choices: [{ id: 'happened', label: 'It deployed' }, { id: 'redo', label: 'Deploy again' }],
              },
            }
          } else if (j.code !== 0) {
            return { pause: `The deploy command exited ${j.code}:\n\n${j.tail}` }
          } else st.deployed = true
        }
      }
      if (!d.check) return { done: true, note: 'deploy command exited 0' }
    } else if (!d.check) {
      return { pause: 'deploy.by is "external" but this repo has no deploy.check to tell when the change is live.' }
    }

    // Poll the check until it passes.
    st.checkSince ??= Date.now()
    const k = `check-${st.checkN ?? 0}`
    if (!ctx.state.j?.[k] && !due(st, 'check', (stage.pollSeconds ?? 60) * 1000) && st.checkN) return { wait: true }
    const c = await ctx.job(k, { cmd: d.check, cwd, timeoutMs: 5 * 60_000 })
    if (c.state === 'running') return { wait: true }
    if (c.state === 'done' && c.code === 0) return { done: true, note: 'deploy check passed' }
    st.checkN = (st.checkN ?? 0) + 1
    const limit = (stage.checkTimeoutMinutes ?? (d.by === 'external' ? 24 * 60 : 15)) * 60_000
    if (Date.now() - st.checkSince > limit) {
      return { pause: `The deploy check has not passed after ${Math.round(limit / 60_000)} minutes:\n\n${c.tail ?? ''}` }
    }
    return { wait: true }
  },
}
