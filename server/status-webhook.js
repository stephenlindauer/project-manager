/**
 * Optional outbound status webhook: a snapshot of every Claude session's state,
 * POSTed to `statusWebhook.url` in pm.config.json so another service can show
 * what this machine's sessions are doing. Off unless configured.
 *
 *   POST <url>
 *   Authorization: Bearer <token>
 *   <any extra `headers`>
 *   { reporter, sessions: [{ id, project, branch, task, state, activity, updated }] }
 *
 * `id` is the tmux session name (`pm-claude-<nodeId>`); `state` is one of
 * idle | running | waiting | ended. `project`, `branch`, `task` and `activity`
 * are left out entirely when their `include` flag is false.
 *
 * A snapshot goes out whenever a session's state changes (the hook events at
 * /api/claude-hook: a turn starting, ending, or blocking on you; a session
 * ending) and on a heartbeat. A session that disappears is reported once as
 * `ended`, retried until a POST succeeds.
 *
 * Sending is fire-and-forget and never throws: a webhook that is down, slow or
 * misconfigured must not reach the hook route or any session. Failures log one
 * line when they start and one when they clear.
 */

export const HEARTBEAT_MS = 60_000
const TIMEOUT_MS = 5_000
/** Coalesce a burst of hook events (Stop + Notification racing) into one POST. */
const DEBOUNCE_MS = 250

const STATE = { working: 'running', waiting: 'waiting', done: 'idle' }

/**
 * Normalize the `statusWebhook` block from pm.config.json. Returns null (off)
 * when it is absent or has no usable http(s) url.
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  let url
  try { url = new URL(String(raw.url ?? '')) } catch { url = null }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    if (raw.url) console.warn('[pm] statusWebhook.url is not an http(s) URL — webhook off')
    return null
  }
  const inc = raw.include ?? {}
  const flag = (v) => v === undefined ? true : Boolean(v)
  // Extra request headers, e.g. a proxy's own credentials in front of the
  // receiver. Only string values are kept.
  const headers = {}
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v
  }
  return {
    url: url.href,
    token: typeof raw.token === 'string' && raw.token ? raw.token : null,
    reporter: typeof raw.reporter === 'string' && raw.reporter ? raw.reporter : null,
    headers,
    include: { repo: flag(inc.repo), branch: flag(inc.branch), task: flag(inc.task), activity: flag(inc.activity) },
  }
}

/** One status record (notify.js) as a contract session. */
export function toSession(rec, where, include) {
  const s = { id: `pm-claude-${rec.nodeId}` }
  if (include.repo) s.project = where?.project ?? null
  if (include.branch) s.branch = where?.branch ?? null
  if (include.task) s.task = rec.task ?? null
  s.state = rec.state === 'ended' ? 'ended' : (STATE[rec.state] ?? 'idle')
  if (include.activity) s.activity = rec.state === 'ended' ? null : (rec.phase ?? rec.detail ?? null)
  s.updated = new Date(rec.at ?? Date.now()).toISOString()
  return s
}

/**
 * @param cfg      parseConfig() output
 * @param list     () => current status records (notify.js statusList)
 * @param lookup   nodeId => { project, branch } | null
 * @param fetchFn  injectable for tests
 */
export function createStatusWebhook(cfg, { list, lookup, fetchFn = fetch, log = console } = {}) {
  /** nodeId -> last record sent, to spot state changes and disappearances. */
  let known = new Map()
  /** Records gone since the last successful POST, reported as `ended`. */
  const ended = new Map()
  let timer = null
  let heartbeat = null
  let inFlight = null
  let again = false
  let failing = false

  const sig = (rec) => `${rec.state}|${rec.task ?? ''}`

  /** Fold the current records into `known`/`ended`; true when anything worth a POST changed. */
  function observe(records) {
    const now = new Map(records.map((r) => [r.nodeId, r]))
    let changed = false
    for (const [id, prev] of known) {
      if (!now.has(id)) {
        ended.set(id, { ...prev, state: 'ended', at: Date.now() })
        changed = true
      }
    }
    for (const [id, rec] of now) {
      const prev = known.get(id)
      if (!prev || sig(prev) !== sig(rec)) changed = true
      ended.delete(id)
    }
    known = now
    return changed
  }

  function payload() {
    const recs = [...known.values(), ...ended.values()]
    const body = {
      reporter: cfg.reporter,
      sessions: recs.map((r) => toSession(r, lookup(r.nodeId), cfg.include)),
    }
    return { body, endedIds: [...ended.keys()] }
  }

  async function post() {
    const { body, endedIds } = payload()
    // The body's type and the bearer token are this module's; extras cannot replace them.
    const headers = { ...cfg.headers, 'content-type': 'application/json' }
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`
    try {
      const res = await fetchFn(cfg.url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Delivered: the receiver has seen these end. One that came back since stays.
      for (const id of endedIds) if (!known.has(id)) ended.delete(id)
      if (failing) log.log('[pm] statusWebhook delivering again')
      failing = false
      return true
    } catch (err) {
      if (!failing) log.warn(`[pm] statusWebhook POST failed: ${err?.message ?? err}`)
      failing = true
      return false
    }
  }

  /** Send now, or right after the POST in flight — never two at once. */
  function send() {
    if (inFlight) { again = true; return inFlight }
    inFlight = post().finally(() => {
      inFlight = null
      if (again) { again = false; send() }
    })
    return inFlight
  }

  /** A status event from notify.js: POST if a session's state changed. */
  function onStatus(records) {
    try {
      if (!observe(records)) return
      clearTimeout(timer)
      timer = setTimeout(send, DEBOUNCE_MS)
      timer.unref?.()
    } catch (err) {
      log.warn(`[pm] statusWebhook: ${err?.message ?? err}`)
    }
  }

  function tick() {
    try { observe(list()) } catch { /* the heartbeat still goes out */ }
    return send()
  }

  return {
    onStatus,
    tick,
    send,
    start(intervalMs = HEARTBEAT_MS) {
      observe(list())
      heartbeat = setInterval(tick, intervalMs)
      heartbeat.unref?.()
      return send()
    },
    stop() { clearInterval(heartbeat); clearTimeout(timer) },
  }
}
