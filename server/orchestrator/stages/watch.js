import fs from 'node:fs'
import path from 'node:path'
import { run as exec } from '../../exec.js'
import { resolveIn } from '../config.js'
import { prState, due } from '../lib.js'

/**
 * Watch: follow the PR through CI and team review until the repo's ship
 * policy says it is ready — approvals met, CI green, threads resolved.
 *
 *   CI fails                       back to the worker with the failing checks.
 *                                  The fix is pushed without me: it is a
 *                                  correction to what I already approved.
 *   Changes requested / a comment  back to the worker with the comments. The
 *                                  fix is prepared, and by default waits in my
 *                                  inbox for a one-click push (`fix_push: ask`
 *                                  — teammates are reading that PR).
 *   Approved, green, resolved      done; the merge stage takes it from there.
 *
 * Both loops go back through verify and review like any other fix. They set
 * `run.loop`, which is what lets an already-approved gate pass the fix
 * through and tells the pr stage whether to ask before pushing.
 *
 * Trust: a review comment becomes part of a prompt to an agent with a shell.
 * Only comments from people with write access to the repo are passed on; the
 * rest are counted on the run and left for me.
 */

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const THREADS = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:60){nodes{id isResolved isOutdated comments(first:20){nodes{id body path line author{login} authorAssociation}}}}
  comments(last:30){nodes{id body author{login} authorAssociation}}
  reviews(last:20){nodes{id state body author{login} authorAssociation}}}}}`

async function conversation(ctx, number) {
  const repo = await ctx.app.git.githubRepo(ctx.cwd)
  if (!repo) return null
  const [owner, name] = String(repo).split('/')
  const r = await exec('gh', ['api', 'graphql', '-f', `query=${THREADS}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`], { cwd: ctx.cwd, timeout: 30_000 })
  if (r.failed) return null
  try {
    const pr = JSON.parse(r.stdout).data.repository.pullRequest
    return {
      threads: pr.reviewThreads.nodes,
      comments: pr.comments.nodes,
      reviews: pr.reviews.nodes.filter((x) => x.body?.trim()),
    }
  } catch { return null }
}

/**
 * Every comment a teammate leaves on my PRs is kept, so a mistake gets
 * through at most once. They are appended as raw lines to the repo's mined
 * rules file (a `{ "mined": "…" }` entry in `houseRules`), which the review
 * stage reads on the next run. Tidying that file into rules is by hand.
 */
function mine(ctx, comments) {
  const entry = (ctx.repo.houseRules ?? []).find((r) => r && typeof r === 'object' && r.mined)
  if (!entry) return
  try {
    const file = resolveIn(ctx.machine, entry.mined)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines = comments.map((c) => `- (PR #${ctx.run.pr.number}) ${c.replace(/\s+/g, ' ').slice(0, 600)}`)
    fs.appendFileSync(file, `${lines.join('\n')}\n`)
  } catch (err) { ctx.log('error', { message: `could not append to the mined rules: ${err.message}` }) }
}

export default {
  kind: 'watch',
  owns: () => ['ci'],

  async step(ctx) {
    const { run, state: st } = ctx
    const ship = ctx.repo.ship
    if (!run.pr?.number) return { pause: 'There is no pull request to watch.' }
    // Arriving here ends whatever fix loop brought the run back.
    if (run.loop) { run.loop = null; ctx.save() }
    if (st.pr && !due(st, 'poll', (ctx.stage.pollSeconds ?? 30) * 1000)) return { wait: true }

    const pr = await prState(ctx.cwd, run.pr.number)
    if (pr.error) { st.lastError = pr.error; return { wait: true } }
    st.pr = { state: pr.state, failed: pr.failed, pending: pr.pending.length, approvals: pr.approvals }
    if (pr.state === 'MERGED') return { done: true, note: 'already merged' }
    if (pr.state === 'CLOSED') return { pause: `The pull request was closed without merging: ${pr.url}` }

    const handled = (run.handled ??= {})

    // ---- CI
    if (ship.ci !== 'none' && pr.failed.length && handled.ci !== pr.head) {
      handled.ci = pr.head
      run.loop = { from: ctx.stage.id, kind: 'ci' }
      return { fail: { reasons: [`CI failed on ${pr.url}: ${pr.failed.join(', ')}. Read the failures with \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`, then fix the cause.`] } }
    }

    // ---- review comments
    const talk = await conversation(ctx, run.pr.number)
    const me = (await ctx.app.gh.viewer?.()) || null
    let unresolved = 0
    if (talk) {
      const fresh = []
      let outside = 0
      const take = (id, who, assoc, text) => {
        if (!text?.trim() || who === me || handled[id]) return
        handled[id] = true
        if (TRUSTED.has(assoc)) fresh.push(text)
        else outside++
      }
      for (const t of talk.threads) {
        if (t.isResolved) continue
        unresolved++
        const last = t.comments.nodes.at(-1)
        if (last) take(last.id, last.author?.login, last.authorAssociation, `${last.path ?? ''}${last.line ? `:${last.line}` : ''} — ${last.author?.login}: ${last.body}`)
      }
      for (const c of talk.comments) take(c.id, c.author?.login, c.authorAssociation, `${c.author?.login}: ${c.body}`)
      for (const r of talk.reviews) take(r.id, r.author?.login, r.authorAssociation, `${r.author?.login} (${r.state.toLowerCase().replace('_', ' ')}): ${r.body}`)
      if (outside) { run.outsideComments = (run.outsideComments ?? 0) + outside; ctx.log('outside-comments', { count: outside }) }
      if (fresh.length) {
        mine(ctx, fresh)
        run.loop = { from: ctx.stage.id, kind: 'review' }
        return {
          fail: {
            reasons: [
              `Review comments on ${pr.url} to address. Make the change each one asks for. If a comment is unclear or you disagree with it, ask instead of guessing.`,
              ...fresh,
            ],
          },
        }
      }
    }

    // ---- ready?
    const waits = []
    if (pr.isDraft) waits.push('the PR to leave draft')
    if (pr.changesRequested) waits.push('the requested changes to be re-reviewed')
    if (pr.approvals < (ship.approvals ?? 0)) waits.push(`${ship.approvals - pr.approvals} more approval(s)`)
    if (ship.ci !== 'none') {
      if (pr.pending.length) waits.push(`CI (${pr.pending.length} pending)`)
      else if (pr.failed.length) waits.push('a fix for the failing CI')
      else if (!pr.checks.length) waits.push('CI to start')
    }
    if (ship.threads !== 'ignore' && unresolved) waits.push(`${unresolved} unresolved thread${unresolved === 1 ? '' : 's'}`)
    if (waits.length) { st.waitingOn = waits.join(', '); return { wait: true } }
    return { done: true, note: 'approved, green and resolved' }
  },
}
