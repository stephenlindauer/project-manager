import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The `clickup` task source, over ClickUp's public REST API with a personal
 * key. It uses only public, documented access: no private host, no borrowed
 * token. A machine that needs more wraps this file from its own
 * `orchestrator/sources/clickup.js`.
 *
 * Config, under `sources.<name>` in the machine layer:
 *
 *   { "adapter": "clickup",
 *     "apiKeyFile": "~/.config/clickup-key",   // or "apiKeyEnv": "CLICKUP_API_KEY"
 *     "teamId": "1234567",
 *     "queue": { "listId": "…", "status": "ready for agent" },  // or viewId, tag
 *     "writes": false, "statusSync": false, "comments": false,
 *     "statusMap": { "started": "in progress", "pr": "in review", "done": "complete" },
 *     "fields": { "pipeline": "Pipeline", "autoMerge": "Auto-merge" },
 *     "pipelines": { "investigation": "investigation" } }
 *
 * A repo file may narrow the queue (`"queue": { "listId": "…" }`), so one
 * source serves several repos, one list each.
 *
 * Trust. A brief is a prompt to an agent with a shell, so only content from
 * workspace members reaches a session. Guests are not trusted unless the
 * machine lists them in `trusted`. ClickUp's API does not say who moved a
 * task into the queue status, so pickup is gated on the task's *creator*
 * being trusted.
 *
 * Not built yet: the MCP sign-in mode named in the design.
 */

const API = 'https://api.clickup.com/api/v2'
const GUEST = 4

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

function keyOf(cfg) {
  if (cfg.apiKey) return cfg.apiKey
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv]
  if (cfg.apiKeyFile) {
    try { return fs.readFileSync(expand(cfg.apiKeyFile), 'utf8').trim() } catch { /* reported below */ }
  }
  throw new Error('clickup: no API key. Set apiKeyFile, apiKeyEnv or apiKey on the source.')
}

async function call(cfg, method, url, body) {
  const http = cfg.fetch ?? fetch
  const res = await http(`${API}${url}`, {
    method,
    headers: { Authorization: keyOf(cfg), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`clickup ${method} ${url.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json()
}

/** `https://app.clickup.com/t/abc123`, `/t/<team>/SL-114`, `SL-114` or a bare id. */
export function parseRef(input) {
  const text = String(input?.brief ?? input?.id ?? input ?? '').trim()
  const url = /app\.clickup\.com\/t\/(?:(\d+)\/)?([A-Za-z0-9_-]+)/.exec(text)
  const id = url ? url[2] : text.split(/\s/)[0]
  if (!id) throw new Error('a ClickUp task id or URL is required')
  return { id, custom: /^[A-Z][A-Z0-9]*-\d+$/.test(id), teamId: url?.[1] ?? null }
}

// Member lists change rarely; a queue poll must not refetch them every time.
const members = new Map()
async function trustedIds(cfg) {
  const key = `${cfg.teamId ?? ''}`
  const hit = members.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000 && !cfg.fetch) return hit.ids
  const { teams = [] } = await call(cfg, 'GET', '/team')
  const ids = new Set()
  for (const team of teams) {
    if (cfg.teamId && String(team.id) !== String(cfg.teamId)) continue
    for (const m of team.members ?? []) if (m.user?.role !== GUEST) ids.add(String(m.user.id))
  }
  for (const extra of cfg.trusted ?? []) ids.add(String(extra))
  members.set(key, { at: Date.now(), ids })
  return ids
}

function fieldValue(task, name) {
  const f = (task.custom_fields ?? []).find((x) => x.name?.toLowerCase() === String(name).toLowerCase())
  if (!f || f.value == null) return null
  if (f.type === 'drop_down') {
    const opt = (f.type_config?.options ?? []).find((o) => o.orderindex === f.value || o.id === f.value)
    return opt?.name ?? null
  }
  if (f.type === 'checkbox') return f.value === true || f.value === 'true'
  return f.value
}

function normalise(task, cfg) {
  const tags = (task.tags ?? []).map((t) => t.name)
  const type = (cfg.fields?.type && fieldValue(task, cfg.fields.type)) ||
    tags.find((t) => cfg.pipelines?.[t]) || null
  return {
    id: task.id,
    customId: task.custom_id ?? null,
    title: task.name,
    url: task.url ?? `https://app.clickup.com/t/${task.id}`,
    type: type ? String(type).toLowerCase() : null,
    status: task.status?.status ?? null,
    creatorId: task.creator?.id != null ? String(task.creator.id) : null,
    raw: task,
  }
}

export default {
  name: 'clickup',

  async fetch(input, cfg = {}) {
    const ref = parseRef(input)
    const teamId = ref.teamId ?? cfg.teamId
    if (ref.custom && !teamId) throw new Error('clickup: a custom task id needs teamId on the source')
    const q = `?include_markdown_description=true${ref.custom ? `&custom_task_ids=true&team_id=${teamId}` : ''}`
    const raw = await call(cfg, 'GET', `/task/${encodeURIComponent(ref.id)}${q}`)
    const task = normalise(raw, cfg)
    const trusted = await trustedIds(cfg)
    const { comments = [] } = await call(cfg, 'GET', `/task/${raw.id}/comment`).catch(() => ({ comments: [] }))

    const pieces = [{
      kind: 'body',
      author: raw.creator?.username ?? 'unknown',
      trusted: trusted.has(task.creatorId),
      text: `${raw.name}\n\n${raw.markdown_description ?? raw.description ?? ''}`.trim(),
    }]
    // Oldest first, the order they were written in.
    for (const c of [...comments].sort((a, b) => Number(a.date) - Number(b.date))) {
      if (!c.comment_text?.trim()) continue
      pieces.push({
        kind: 'comment', author: c.user?.username ?? 'unknown',
        trusted: trusted.has(String(c.user?.id)), text: c.comment_text.trim(),
      })
    }
    return { ...task, pieces }
  },

  /** Carries the task id, so ClickUp's GitHub integration links the branch and PR. */
  ref(task) {
    const id = task.customId ?? `CU-${task.id}`
    const words = slug(task.title).split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40)
    return words ? `${id}-${words}` : id
  },

  link: (task) => task.url ?? null,

  async queue(cfg = {}) {
    const q = cfg.queue ?? {}
    if (!q.listId && !q.viewId) return []
    const params = new URLSearchParams({ include_closed: 'false', subtasks: 'false' })
    if (q.status) params.append('statuses[]', q.status)
    if (q.tag) params.append('tags[]', q.tag)
    const url = q.viewId ? `/view/${q.viewId}/task?page=0` : `/list/${q.listId}/task?${params}`
    const { tasks = [] } = await call(cfg, 'GET', url)
    const trusted = await trustedIds(cfg)
    return tasks
      .filter((t) => !q.status || t.status?.status?.toLowerCase() === String(q.status).toLowerCase())
      .filter((t) => !q.tag || (t.tags ?? []).some((x) => x.name === q.tag))
      // Pickup needs a trusted author behind the task.
      .filter((t) => trusted.has(String(t.creator?.id)))
      .map((t) => ({ id: t.id, title: t.name, url: t.url }))
  },

  overrides(task, cfg = {}) {
    const out = {}
    for (const [key, fieldName] of Object.entries(cfg.fields ?? {})) {
      if (key === 'type') continue
      const v = fieldValue(task.raw ?? {}, fieldName)
      if (v == null || v === '') continue
      out[key] = typeof v === 'string' && ['on', 'off', 'yes', 'no'].includes(v.toLowerCase()) ? ['on', 'yes'].includes(v.toLowerCase()) : v
    }
    return out
  },

  /**
   * Status sync and event comments. Both are off until the source sets
   * `writes: true` and then `statusSync` / `comments` separately; the engine
   * does not call this at all otherwise.
   */
  async write(task, event, cfg = {}) {
    const done = []
    const status = cfg.statusSync ? cfg.statusMap?.[event.type] : null
    if (status) {
      await call(cfg, 'PUT', `/task/${task.id}`, { status })
      done.push(`status → ${status}`)
    }
    if (cfg.comments && event.message) {
      await call(cfg, 'POST', `/task/${task.id}/comment`, { comment_text: `${cfg.commentPrefix ?? '🤖 '}${event.message}`, notify_all: false })
      done.push('comment')
    }
    return done
  },
}
