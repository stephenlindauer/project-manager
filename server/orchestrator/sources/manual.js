/**
 * The `manual` task source: no tracker at all. I start a run by pasting a
 * brief (or a URL plus a line of what I want), so there is no queue to read
 * and nothing to write back. Everything in the brief came from me, so all of
 * it is trusted.
 *
 * This is also the reference for the adapter interface — only the first
 * three methods are required:
 *
 *   fetch(input, cfg)    → { id, title, type, url, pieces: [{ author, trusted, kind, text }] }
 *   ref(task)            → a short id for worktree, branch and PR names
 *   link(task)           → URL back to the task, or null
 *   queue(cfg)           → tasks ready for pickup            (optional)
 *   overrides(task, cfg) → per-task settings                 (optional)
 *   write(task, event, cfg) → status change or comment       (optional, off by default)
 */

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export default {
  name: 'manual',

  async fetch(input) {
    const text = String(input?.brief ?? input ?? '').trim()
    if (!text) throw new Error('a brief is required')
    const first = text.split('\n').find((l) => l.trim()) ?? text
    const title = String(input?.title ?? first).replace(/^#+\s*/, '').trim().slice(0, 120)
    const url = /https?:\/\/\S+/.exec(text)?.[0] ?? null
    return {
      id: null, title, type: input?.type ?? null, url,
      pieces: [{ author: 'me', trusted: true, kind: 'body', text }],
    }
  },

  ref(task) {
    const words = slug(task.title).split('-').filter(Boolean).slice(0, 6).join('-')
    return words.slice(0, 48) || 'task'
  },

  link: (task) => task.url ?? null,
}
