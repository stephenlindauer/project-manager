import { run } from '../../exec.js'

/**
 * The `github-issues` task source, through the `gh` CLI the app already uses.
 *
 *   { "adapter": "github-issues",
 *     "repo": "owner/name",
 *     "queue": { "label": "ready-for-agent" },
 *     "writes": false, "statusSync": false, "comments": false,
 *     "labelMap": { "started": "in-progress", "pr": "in-review" },
 *     "fields": { "pipeline": "pipeline:", "autoMerge": "no-auto-merge" } }
 *
 * Trust matters most here. On a public repo anyone can open an issue or
 * comment on one, and that text would become a prompt to an agent with a
 * shell. Only the issue body and comments from people with write access to
 * the repo (owner, member, collaborator) reach a session; the rest are
 * counted and left out. Pickup from the queue additionally needs the *issue
 * author* to be trusted — a label is the queue marker, and only people with
 * triage rights can apply one, but the body under it is the author's.
 */

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

async function api(cfg, args) {
  const exec = cfg.gh ?? ((a) => run('gh', a, { timeout: 30_000 }))
  const r = await exec(['api', ...args])
  if (r.failed) throw new Error(`github-issues: gh api ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}

/** `https://github.com/o/r/issues/12`, `o/r#12`, `#12` or `12` (with `repo` on the source). */
export function parseRef(input, cfg = {}) {
  const text = String(input?.brief ?? input?.id ?? input ?? '').trim()
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(text)
  if (url) return { repo: url[1], number: Number(url[2]) }
  const short = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)\b/.exec(text)
  if (!short) throw new Error('a GitHub issue number or URL is required')
  const repo = short[1] ?? cfg.repo ?? cfg.queue?.repo
  if (!repo) throw new Error('github-issues: set `repo` on the source, or give the full issue URL')
  return { repo, number: Number(short[2]) }
}

export default {
  name: 'github-issues',

  async fetch(input, cfg = {}) {
    const { repo, number } = parseRef(input, cfg)
    const issue = await api(cfg, [`repos/${repo}/issues/${number}`])
    if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`)
    const comments = (await api(cfg, [`repos/${repo}/issues/${number}/comments?per_page=100`])) ?? []
    const widened = new Set(cfg.trusted ?? [])
    const ok = (assoc, login) => TRUSTED.has(assoc) || widened.has(login)
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    const pieces = [{
      kind: 'body', author: issue.user?.login ?? 'unknown', trusted: ok(issue.author_association, issue.user?.login),
      text: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
    }]
    for (const c of comments) {
      if (!c.body?.trim()) continue
      pieces.push({ kind: 'comment', author: c.user?.login ?? 'unknown', trusted: ok(c.author_association, c.user?.login), text: c.body.trim() })
    }
    const type = labels.find((l) => cfg.pipelines?.[l]) ?? null
    return { id: `${repo}#${number}`, repo, number, title: issue.title, url: issue.html_url, type, labels, pieces }
  },

  /** Carries the issue number; a PR that says "Fixes #n" is what links them on GitHub. */
  ref(task) {
    const words = slug(task.title).split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40)
    return `${task.number ?? String(task.id).split('#').pop()}-${words || 'issue'}`
  },

  link: (task) => task.url ?? null,

  async queue(cfg = {}) {
    const q = cfg.queue ?? {}
    const repo = q.repo ?? cfg.repo
    if (!repo || !q.label) return []
    const issues = (await api(cfg, [`repos/${repo}/issues?state=open&labels=${encodeURIComponent(q.label)}&per_page=50`])) ?? []
    const widened = new Set(cfg.trusted ?? [])
    return issues
      .filter((i) => !i.pull_request)
      .filter((i) => TRUSTED.has(i.author_association) || widened.has(i.user?.login))
      // The same id `fetch` gives the task, so a queued issue is recognised as already running.
      .map((i) => ({ id: `${repo}#${i.number}`, title: i.title, url: i.html_url }))
  },

  /** Labels as per-task settings: `pipeline:<name>` and a plain marker label per boolean. */
  overrides(task, cfg = {}) {
    const out = {}
    const f = cfg.fields ?? {}
    for (const l of task.labels ?? []) {
      if (f.pipeline && l.startsWith(f.pipeline)) out.pipeline = l.slice(f.pipeline.length).trim()
      if (f.autoMerge && l === f.autoMerge) out.autoMerge = false
      if (f.gateAutoPass && l === f.gateAutoPass) out.gateAutoPass = true
    }
    return out
  },

  async write(task, event, cfg = {}) {
    const [repo, number] = String(task.id).split('#')
    const done = []
    const label = cfg.statusSync ? cfg.labelMap?.[event.type] : null
    if (label) {
      await api(cfg, [`repos/${repo}/issues/${number}/labels`, '-X', 'POST', '-f', `labels[]=${label}`])
      done.push(`label ${label}`)
    }
    if (cfg.comments && event.message) {
      await api(cfg, [`repos/${repo}/issues/${number}/comments`, '-X', 'POST', '-f', `body=${cfg.commentPrefix ?? '🤖 '}${event.message}`])
      done.push('comment')
    }
    return done
  },
}
