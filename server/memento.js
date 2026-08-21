import fs from 'node:fs'
import { config } from './config.js'

/**
 * The Memento todo surface, read over HTTP.
 *
 * Memento (the memory server) owns the todos; this is a thin client, like gh.js
 * is for GitHub. It reads `{ api, token }` from the same config file the `mem`
 * CLI uses, so pointing one at the server points both. Everything returns the
 * `{ available, ..., error }` envelope rather than throwing, for the same reason
 * gh.js does: a memory server that is down must render as "unavailable" in one
 * tab, not as a 500 that looks like ProjectManager is broken.
 *
 * Scope is the one rule that matters here and it is enforced on the Memento
 * side: a project asks for `project:<slug>` and gets only todos attached to
 * that entity, never an unscoped "life" todo (decided 2026-08-20).
 */

let cached

/** The CLI's config, read lazily and once; absent means the tab is off. */
export function mementoConfig() {
  if (cached !== undefined) return cached
  // The file is best-effort; the environment wins over it and works without it,
  // which is how a test points this at a throwaway server.
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(config.memento.configFile, 'utf8')) } catch { raw = {} }
  const api = process.env.MEMENTO_API || raw.api
  const token = process.env.MEMENTO_TOKEN || raw.token
  cached = api ? { api: String(api).replace(/\/+$/, ''), token: token || null } : null
  return cached
}

export const available = () => Boolean(mementoConfig())

/**
 * Memento's entity slug: NFKD, strip combining marks, lowercase, runs of
 * anything non-alphanumeric become one dash. Must match lib/id.js over there,
 * or `project:ProjectManager` never finds `project:projectmanager`.
 */
export const projectEntity = (name) => 'project:' + String(name)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

async function request(method, pathname, { query, body } = {}) {
  const cfg = mementoConfig()
  if (!cfg) return { failed: true, error: 'memento is not configured' }
  const url = new URL(cfg.api + pathname)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.memento.timeoutMs),
    })
    const text = await res.text()
    let payload
    try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text.slice(0, 200) } }
    if (!res.ok) return { failed: true, error: payload.error || `memento returned ${res.status}` }
    return { failed: false, data: payload }
  } catch (e) {
    return { failed: true, error: `cannot reach memento: ${String(e?.message ?? e)}` }
  }
}

/** A project's open todos, plus its faded and done ones for the fold-aways. */
export async function todos(projectName) {
  if (!available()) return { available: false, open: [], fading: [], faded: [], closed: [], entity: null }
  const entity = projectEntity(projectName)
  const r = await request('GET', '/todos', { query: { entity, faded: 'true', closed: 'true' } })
  if (r.failed) return { available: true, open: [], fading: [], faded: [], closed: [], entity, error: r.error }
  return { available: true, entity, error: null, ...r.data }
}

export async function add(projectName, { text, horizon, due }) {
  const r = await request('POST', '/remember', {
    body: {
      text: String(text ?? '').trim(),
      entities: [projectEntity(projectName)],
      kind: 'todo',
      horizon: horizon || 'soon',
      due: due || undefined,
      source: 'projectmanager:soon',
    },
  })
  return r.failed ? { ok: false, error: r.error } : { ok: true, observation: r.data.observation }
}

export async function done(id, reason) {
  const r = await request('POST', '/close', { body: { id, reason: reason || 'done in ProjectManager' } })
  return r.failed ? { ok: false, error: r.error } : { ok: true }
}

/** "Still want this": reset the fade clock, optionally moving or re-dating it. */
export async function bump(id, { horizon, due, reopen } = {}) {
  const body = { id }
  if (horizon) body.horizon = horizon
  if (due !== undefined) body.due = due || null
  if (reopen) body.reopen = true
  const r = await request('POST', '/touch', { body })
  return r.failed ? { ok: false, error: r.error } : { ok: true, observation: r.data.observation }
}
