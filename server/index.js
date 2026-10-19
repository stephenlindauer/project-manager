import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'

import { config } from './config.js'
import { store } from './store.js'
import { worktreeDirFor } from './scanner.js'
import * as G from './git.js'
import * as T from './terminals.js'
import * as Tasks from './tasks.js'
import * as GH from './gh.js'
import * as Auth from './auth.js'
import * as Notify from './notify.js'
import * as Ship from './ship.js'
import * as Trash from './trash.js'
import { run } from './exec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

Auth.loadAuth()
Notify.loadHookToken()
const cookieOpts = { secure: config.https.enabled }

/** Resolve `:id` to a node, or 404. Every node-scoped route funnels through this. */
function node(req, res) {
  const hit = store.find(req.params.id)
  if (!hit?.worktree) {
    res.status(404).json({ error: 'unknown node' })
    return null
  }
  return { ...hit, cwd: hit.worktree.path }
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[api]', req.path, e)
    if (!res.headersSent) res.status(500).json({ error: String(e?.message ?? e) })
  })

// ---------------------------------------------------------------- auth
// These three are reachable without a session so the login flow can run; every
// other /api and /events route is guarded by requireAuth below.

app.get('/api/auth', (req, res) => {
  res.json({
    enabled: Auth.isEnabled(),
    configured: Auth.isConfigured(),
    authed: !Auth.isEnabled() || Auth.isRequestAuthed(req),
  })
})

// A fixed delay on every attempt blunts online brute-forcing without needing a
// stateful rate limiter.
const LOGIN_DELAY_MS = 500
app.post('/api/login', wrap(async (req, res) => {
  await new Promise((r) => setTimeout(r, LOGIN_DELAY_MS))
  const { username, password } = req.body ?? {}
  if (await Auth.verifyCredentials(username, password)) {
    res.setHeader('Set-Cookie', Auth.sessionCookie(username, cookieOpts))
    return res.json({ ok: true })
  }
  res.status(401).json({ error: 'invalid username or password' })
}))

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', Auth.clearCookie())
  res.json({ ok: true })
})

// ------------------------------------------------------- claude code hooks

/**
 * Callback for Claude Code's hooks — see
 * `scripts/claude-notify-hook.js`, installed into ~/.claude/settings.json by
 * `npm run install-hooks`.
 *
 * This is the fourth route that bypasses `requireAuth`, and it must stay so:
 * the hook is a short-lived local process with no browser session to borrow a
 * cookie from. It is guarded two other ways instead — the connection must come
 * from loopback, and it must present the 0600 token from `.pm-hook-token`. It
 * is also strictly *write-only into a notification*: nothing here reads project
 * state back out, so a leaked token costs the attacker a toast, not a shell.
 *
 * Registered above the `requireAuth` mounts because Express matches in order.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

app.post('/api/claude-hook', (req, res) => {
  if (!LOOPBACK.has(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'loopback only' })
  }
  if (!Auth.safeEqual(req.get('x-pm-hook-token') ?? '', Notify.hookToken() ?? '\0')) {
    return res.status(401).json({ error: 'bad hook token' })
  }

  const body = req.body ?? {}
  const { event, cwd, session } = body
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)
  const nodeId = hookNodeId(session, cwd)
  if (!nodeId) return res.json({ ok: true, delivered: false, reason: 'no matching project' })
  const watched = () => T.isWatched(nodeId, 'claude')

  switch (event) {
    // Claude picked up a prompt: a new task starts, and it is working.
    case 'UserPromptSubmit':
      return res.json({ ok: true, working: true, changed: Notify.working(nodeId, { prompt: str(body.prompt, 200) }) })
    // About to run / just ran a tool: still working, and the tool names the
    // phase. AskUserQuestion is the exception — it has no hook of its own, so
    // its PreToolUse is the moment Claude starts waiting on you, and its
    // PostToolUse the moment you answered.
    case 'PreToolUse':
      if (body.tool === 'AskUserQuestion') {
        return res.json(Notify.settle({
          nodeId, state: 'waiting', message: str(body.toolHint, 240) ?? 'Claude has a question', watched: watched(),
        }))
      }
      // falls through
    case 'PostToolUse':
      return res.json({
        ok: true, working: true,
        changed: Notify.working(nodeId, { tool: str(body.tool, 80), toolHint: str(body.toolHint, 200) }),
      })
    case 'SessionEnd':
      return res.json({ ok: true, working: false, changed: Notify.forget(nodeId) })
    // A Notification is Claude blocked on you — except `idle_prompt`, which
    // only means the turn ended a minute ago and you have not typed since.
    // That is "ready", the same as Stop, not a block.
    case 'Notification': {
      const idle = body.notificationType === 'idle_prompt'
      return res.json(Notify.settle({
        nodeId, state: idle ? 'done' : 'waiting', message: str(body.message, 240), watched: watched(),
      }))
    }
    // Stop: the turn is over. Claude's closing words become the tooltip.
    case 'Stop':
      return res.json(Notify.settle({
        nodeId, state: 'done', message: str(body.message, 240), detail: str(body.lastMessage, 400), watched: watched(),
      }))
    default:
      return res.status(400).json({ error: 'unknown event' })
  }
})

/**
 * Which node a hook came from. The tmux session name is exact when the session
 * was started by this app (`pm-claude-<nodeId>`); otherwise fall back to the
 * shell's cwd, which also covers a `claude` run from a real terminal.
 */
function hookNodeId(session, cwd) {
  const named = /^pm-claude-([0-9a-f]{6,})$/.exec(String(session ?? ''))?.[1]
  if (named && store.find(named)) return named
  return store.nodeContaining(typeof cwd === 'string' ? cwd : null)?.id ?? null
}

app.use('/api', Auth.requireAuth)
app.use('/events', Auth.requireAuth)

// ---------------------------------------------------------------- meta

app.get('/api/meta', wrap(async (req, res) => {
  res.json({
    projectsRoot: config.projectsRoot,
    terminalBackend: T.backend(),
    ghAvailable: await GH.detectGh(),
    lastScan: store.lastScan,
  })
}))

// ------------------------------------------------------------ projects

app.get('/api/projects', wrap(async (req, res) => {
  if (!store.lastScan) await store.rescan()
  res.json({ projects: store.projects, nodes: store.nodes })
}))

app.post('/api/rescan', wrap(async (req, res) => {
  await store.rescan()
  res.json({ projects: store.projects, nodes: store.nodes })
}))

app.post('/api/nodes/:id/refresh', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  res.json(await store.refreshNode(req.params.id))
}))

/** Everything the Summary tab needs, in one round trip. */
app.get('/api/nodes/:id/summary', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const { cwd, project } = n

  if (!project.isGit) {
    const stat = await fs.stat(cwd).catch(() => null)
    return res.json({
      isGit: false, path: cwd, name: project.name, group: project.group,
      mtime: stat?.mtimeMs ?? null, marker: project.marker,
    })
  }

  const [status, lastCommit, commits, remote, defaultBranch, wts, scripts, pr] =
    await Promise.all([
      G.status(cwd), G.lastCommit(cwd), G.recentCommits(cwd, 8),
      G.remoteUrl(cwd), G.defaultBranch(cwd), G.worktrees(cwd),
      Tasks.discoverScripts(cwd), GH.currentPr(cwd),
    ])

  res.json({
    isGit: true, path: cwd, name: project.name, group: project.group,
    status, lastCommit, commits, remote, defaultBranch,
    worktrees: wts, scripts, pr,
  })
}))

app.get('/api/nodes/:id/branches', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  res.json(await G.branches(n.cwd))
}))

app.post('/api/nodes/:id/fetch', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  await G.fetchAll(n.cwd)
  res.json(await store.refreshNode(req.params.id))
}))

// ----------------------------------------------------------- worktrees

app.post('/api/projects/:id/worktrees', wrap(async (req, res) => {
  const project = store.byId.get(req.params.id)
  if (!project) return res.status(404).json({ error: 'unknown project' })
  if (!project.isGit) return res.status(400).json({ error: 'not a git repo' })

  const branch = String(req.body?.branch ?? '').trim()
  if (!branch) return res.status(400).json({ error: 'branch required' })
  if (!/^[\w.\/-]+$/.test(branch)) return res.status(400).json({ error: 'invalid branch name' })

  const base = req.body?.base || (await G.defaultBranch(project.path))
  const dir = worktreeDirFor(project.path, branch)
  const result = await G.addWorktree(project.path, { branch, base, dir })
  if (result.failed) {
    return res.status(400).json({ error: result.stderr.trim() || result.stdout.trim() })
  }
  await store.rescan()
  const created = store.nodes.find((x) => x.cwd === dir)
  res.json({ ok: true, dir, branch, node: created })
}))

app.delete('/api/nodes/:id/worktree', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  if (n.worktree.isMain) return res.status(400).json({ error: 'cannot remove the main worktree' })

  const force = req.query.force === '1'
  // Refuse a dirty tree *before* touching the sessions: killing the Claude
  // session first meant a failed removal still cost the person their context.
  // This is also the *only* dirty check — `removeWorktree` moves the tree
  // away before git looks at it. 409 + `needsForce` is the client's cue to
  // offer `--force`; `files` is what that would lose.
  if (!force) {
    const s = await G.status(n.cwd)
    if (s && s.staged + s.unstaged + s.untracked + s.conflicted > 0) {
      return res.status(409).json({
        error: `worktree has uncommitted changes (${s.files.length} file${s.files.length === 1 ? '' : 's'})`,
        needsForce: true,
        files: s.files,
      })
    }
  }

  Tasks.stopNode(req.params.id)
  Notify.forget(req.params.id)
  await T.killNode(req.params.id)
  const result = await G.removeWorktree(n.project.path, n.cwd, { force })
  if (result.failed) {
    const error = result.stderr.trim() || result.stdout.trim() || 'git worktree remove failed'
    console.error(`[worktree] remove failed ${n.cwd}: ${error}`)
    // Anything git still refuses (a lock, a tree we could not move) gets the
    // same offer; a failure *with* --force is final.
    return res.status(force ? 400 : 409).json({ error, needsForce: !force, files: [] })
  }
  console.log(`[worktree] removed ${n.cwd}${result.trashed ? ' (files deleting in the background)' : ''}`)
  // Answer now. A full rescan takes ~17s here; clients get the new tree over
  // SSE from `forgetWorktree` instead.
  store.forgetWorktree(req.params.id)
  res.json({ ok: true })
}))

// ------------------------------------------------------------- changes

app.get('/api/nodes/:id/changes', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  if (!n.project.isGit) return res.json({ staged: [], unstaged: [], untracked: [], summary: '' })
  res.json(await G.changedFiles(n.cwd))
}))

app.get('/api/nodes/:id/diff', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const file = String(req.query.file ?? '')
  if (!file) return res.status(400).json({ error: 'file required' })
  res.json({ diff: await G.fileDiff(n.cwd, file, { staged: req.query.staged === '1' }) })
}))

// ------------------------------------------------------------------ PRs

app.get('/api/nodes/:id/prs', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const [view, defaultBranch] = await Promise.all([GH.pullRequests(n.cwd), G.defaultBranch(n.cwd)])
  const stack = view.available
    ? await GH.stack(n.cwd, { branch: n.worktree.branch, defaultBranch, prs: view.prs }).catch((e) => {
        console.error('[stack]', n.cwd, e)
        return null
      })
    : null
  res.json({ ...view, stack })
}))

/**
 * Switch this worktree to another PR in its stack. If the branch is already
 * checked out in a sibling worktree the answer is that node, not a checkout:
 * git would refuse anyway, and the caller wants to land where the work is.
 */
app.post('/api/nodes/:id/stack/switch', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const head = String(req.body?.head ?? '').trim()
  if (!/^[\w.\/-]+$/.test(head)) return res.status(400).json({ error: 'invalid branch name' })
  if (head.startsWith('grok/')) {
    return res.status(400).json({ error: 'git-grok stacks live on the integration branch; edit the commit with git rebase -i instead of checking out the grok branch' })
  }
  if (n.worktree.branch === head) return res.json({ ok: true, nodeId: req.params.id, moved: false })

  const elsewhere = (await G.worktrees(n.cwd)).find((w) => w.branch === head && w.path !== n.cwd)
  if (elsewhere) {
    const target = store.nodes.find((x) => x.cwd === elsewhere.path)
    return res.json({ ok: true, nodeId: target?.id ?? null, moved: false, path: elsewhere.path })
  }

  const st = await G.status(n.cwd)
  const dirty = (st?.staged ?? 0) + (st?.unstaged ?? 0) + (st?.conflicted ?? 0)
  if (dirty) return res.status(409).json({ error: `working tree has ${dirty} uncommitted change${dirty === 1 ? '' : 's'}; commit or stash first` })

  const result = await G.checkout(n.cwd, head)
  if (result.failed) return res.status(400).json({ error: result.stderr.trim() || result.stdout.trim() })
  res.json({ ok: true, nodeId: req.params.id, moved: true, node: await store.refreshNode(req.params.id) })
}))

app.post('/api/nodes/:id/prs', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  res.json(await GH.createPr(n.cwd, req.body ?? {}))
}))

/** Re-poll the ship verdicts now (throttled server-side); the PRs tab's ↻ calls it. */
app.post('/api/ship/refresh', wrap(async (_req, res) => {
  res.json(await Ship.refresh())
}))

// ----------------------------------------------------------------- tasks

app.get('/api/nodes/:id/tasks', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  res.json({
    scripts: await Tasks.discoverScripts(n.cwd),
    runners: Tasks.runnersFor(req.params.id),
  })
}))

app.post('/api/nodes/:id/tasks/start', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const { name, command } = req.body ?? {}
  if (!name || !command) return res.status(400).json({ error: 'name and command required' })
  const runner = Tasks.getRunner({ nodeId: req.params.id, cwd: n.cwd, name, command })
  runner.start()
  res.json(runner.summary())
}))

app.post('/api/nodes/:id/tasks/stop', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  const runner = Tasks.getRunner({ nodeId: req.params.id, cwd: n.cwd, name: req.body?.name })
  runner.stop()
  res.json(runner.summary())
}))

// -------------------------------------------------------------- sessions

app.get('/api/sessions', wrap((req, res) => res.json(T.sessionSummaries())))

/** Acknowledge a node's Claude badge from the UI: keep the label, stop shouting. */
app.delete('/api/nodes/:id/attention', wrap((req, res) => {
  res.json({ ok: Notify.seen(req.params.id) })
}))

app.delete('/api/nodes/:id/sessions/:kind', wrap(async (req, res) => {
  res.json({ ok: await T.killSession(req.params.id, req.params.kind) })
}))

/** Open a path in the user's editor / Finder. */
app.post('/api/open', wrap(async (req, res) => {
  const target = String(req.body?.path ?? '')
  const nodeMatch = store.nodeForPath(target)
  if (!nodeMatch) return res.status(400).json({ error: 'path is not a known project' })
  const withApp = req.body?.app ? ['-a', String(req.body.app)] : []
  const result = await run('open', [...withApp, target])
  res.json({ ok: !result.failed, error: result.failed ? result.stderr.trim() : null })
}))

// ---------------------------------------------------------------- events

/** Server-sent events: sidebar badges and task state without client polling. */
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  /**
   * Polled events are only forwarded when their payload actually changed.
   * Re-sending identical task/session lists every tick would rerender the whole
   * client twice a second for nothing.
   */
  const lastSent = new Map()
  const sendIfChanged = (event, data) => {
    const encoded = JSON.stringify(data)
    if (lastSent.get(event) === encoded) return
    lastSent.set(event, encoded)
    res.write(`event: ${event}\ndata: ${encoded}\n\n`)
  }

  const onNodes = (nodes) => send('nodes', nodes)
  const onNode = (n) => send('node', n)
  const onProjects = () => send('projects', { projects: store.projects, nodes: store.nodes })
  const onStatus = (list) => send('claude-status', list)
  const onToast = (t) => send('claude-toast', t)
  const onShip = (env) => send('ship-status', env)

  store.on('nodes', onNodes)
  store.on('node', onNode)
  store.on('projects', onProjects)
  Notify.notifications.on('status', onStatus)
  Notify.notifications.on('toast', onToast)
  Ship.events.on('status', onShip)

  // A page that loads (or reconnects) after a signal was raised still has to
  // learn about it — the sidebar badge is sticky state, not just an event.
  send('claude-status', Notify.statusList())
  send('ship-status', Ship.statusList())

  const taskTick = setInterval(() => sendIfChanged('tasks', Tasks.allRunners()), 2000)
  const sessionTick = setInterval(() => sendIfChanged('sessions', T.sessionSummaries()), 2000)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)

  req.on('close', () => {
    store.off('nodes', onNodes)
    store.off('node', onNode)
    store.off('projects', onProjects)
    Notify.notifications.off('status', onStatus)
    Notify.notifications.off('toast', onToast)
    Ship.events.off('status', onShip)
    clearInterval(taskTick)
    clearInterval(sessionTick)
    clearInterval(heartbeat)
  })
})

// --------------------------------------------------------- static (prod)

// Our own flag, not NODE_ENV: NODE_ENV would leak into every terminal and Task
// the app spawns (see `childEnv`), and this process is the only thing it should
// ever describe.
if (process.env.PM_SERVE_DIST === '1') {
  const dist = path.join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

// ------------------------------------------------------------- websocket

function createServer() {
  const srv = config.https.enabled
    ? https.createServer(
        { cert: fss.readFileSync(config.https.cert), key: fss.readFileSync(config.https.key) },
        app,
      )
    : http.createServer(app)
  srv.on('upgrade', onUpgrade)
  return srv
}
const wss = new WebSocketServer({ noServer: true })

function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/pty') return socket.destroy()
  // The /pty socket is a full shell; gate it on the same session cookie the page
  // used. The cookie rides along on the upgrade request automatically.
  if (Auth.isEnabled() && !Auth.isRequestAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url))
}

const server = createServer()

wss.on('connection', (ws, req, url) => {
  const nodeId = url.searchParams.get('node')
  const kind = T.isKind(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'shell'
  const target = url.searchParams.get('task')

  const hit = store.find(nodeId)
  if (!hit?.worktree) {
    ws.send(JSON.stringify({ type: 'error', message: 'unknown project node' }))
    return ws.close()
  }

  // A `task` param streams a dev-server log instead of an interactive shell.
  if (target) return attachRunner(ws, nodeId, target)

  const session = T.getSession(nodeId, kind, hit.worktree.path)

  // Opening the Claude pane *is* the acknowledgement — there is nothing left to
  // flag once you are looking at it. The badge itself stays, as a quiet label.
  if (kind === 'claude') Notify.seen(nodeId)

  // The client reports whether this pane is on screen in a foreground tab, so a
  // Stop hook that fires while you watch Claude work stays silent. Tracked per
  // socket so two viewers can't leave the count stuck above zero.
  let viewing = false
  const setViewing = (on) => {
    if (on === viewing) return
    viewing = on
    session.viewers = Math.max(0, session.viewers + (on ? 1 : -1))
  }

  // The client reports its measured size up-front so the session can be created
  // at the right dimensions rather than repainting after the first resize.
  // `resize` rejects sizes that are too small to be a real measurement, so a
  // pane that has not been laid out yet leaves the default in place.
  session.resize(url.searchParams.get('cols'), url.searchParams.get('rows'))

  const onData = (d) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }))
  }
  const onExit = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }))
  }

  // Replay the buffer and subscribe *before* spawning, so anything the session
  // emits while starting up is streamed rather than lost in the gap.
  ws.send(JSON.stringify({ type: 'backend', backend: T.backend(), cwd: hit.worktree.path }))
  if (session.buffer) ws.send(JSON.stringify({ type: 'replay', data: session.buffer }))
  session.on('data', onData)
  session.on('exit', onExit)

  session.attach().catch((err) => {
    console.error('[pty] attach failed', err)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: String(err?.message ?? err) }))
    }
  })

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'input') session.write(msg.data)
    else if (msg.type === 'resize') session.resize(msg.cols, msg.rows)
    else if (msg.type === 'restart') { session.destroy().then(() => session.spawn()) }
    else if (msg.type === 'view') {
      setViewing(Boolean(msg.active))
      if (viewing && kind === 'claude') Notify.seen(nodeId)
    }
  })

  ws.on('close', () => {
    setViewing(false)
    session.off('data', onData)
    session.off('exit', onExit)
    session.detach()
  })
})

function attachRunner(ws, nodeId, name) {
  const runner = Tasks.getRunner({ nodeId, name })
  if (runner.log) ws.send(JSON.stringify({ type: 'replay', data: runner.log }))
  const onData = (d) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }))
  }
  const onState = (s) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'state', state: s }))
  }
  runner.on('data', onData)
  runner.on('state', onState)
  ws.on('close', () => {
    runner.off('data', onData)
    runner.off('state', onState)
  })
}

// ----------------------------------------------------------------- boot

const backend = await T.detectTmux()
const scheme = config.https.enabled ? 'https' : 'http'
const shownHost = config.host === '0.0.0.0' ? '<this-machine-ip>' : config.host

/**
 * Bound to one specific non-loopback address (a Tailscale IP, say), the app
 * would be unreachable from 127.0.0.1 — and the Claude hook script, the
 * service's health check and Tailscale Serve all talk to loopback. So a
 * specific address also gets a loopback listener on the same port.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const alsoLoopback = !LOOPBACK_HOSTS.has(config.host) && config.host !== '0.0.0.0' && config.host !== '::'
if (alsoLoopback) {
  createServer()
    .on('error', (err) => console.warn(`[pm] loopback listener failed: ${err.message}`))
    .listen(config.port, '127.0.0.1')
}

server.listen(config.port, config.host, async () => {
  console.log(`[pm] server     ${scheme}://${shownHost}:${config.port}`)
  console.log(`[pm] bind       ${config.host}${config.host === '0.0.0.0' ? ' (all interfaces)'
    : LOOPBACK_HOSTS.has(config.host) ? ' (loopback only)' : ' + 127.0.0.1'}`)
  console.log(`[pm] tls        ${config.https.enabled ? 'on' : 'off'}`)
  console.log(`[pm] auth       ${authStatusLine()}`)
  console.log(`[pm] terminals  ${backend ? 'tmux (persistent)' : 'node-pty (tmux not found)'}`)
  console.log('[pm] hooks      POST /api/claude-hook  ' +
    `(sound ${config.notify.sound ? 'on' : 'off'} — install with: npm run install-hooks)`)
  console.log(`[pm] ship       ${config.gh.ship ? `gh search every ${Math.round(config.gh.pollMs / 1000)}s` : 'off (PM_SHIP=0)'}`)

  // The app hands out full shell access. Loudly flag the dangerous combination
  // of network exposure without a login.
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !Auth.isEnabled()) {
    console.warn('\n\x1b[41m\x1b[97m  WARNING  \x1b[0m ' +
      '\x1b[91mListening on the network with NO authentication.\x1b[0m')
    console.warn('           Anyone who can reach this port gets a shell on this machine.')
    console.warn('           Enable auth: set "auth": true in pm.config.json and run `npm run create-user`.\n')
  }
  if (config.auth.enabled && !Auth.isConfigured()) {
    console.warn('\x1b[93m[pm] auth is enabled but no user exists — run `npm run create-user`. ' +
      'All requests will 503 until then.\x1b[0m')
  }

  await store.rescan()
  console.log(`[pm] indexed    ${store.projects.length} projects, ${store.nodes.length} worktrees`)
  // A restart mid-delete leaves trashed worktrees behind; finish them.
  const swept = await Trash.sweep(store.projects.map((p) => p.path))
  if (swept) console.log(`[pm] trash      resuming ${swept} interrupted worktree delete${swept === 1 ? '' : 's'}`)
  if (config.gh.ship) Ship.start()
})

function authStatusLine() {
  if (!config.auth.enabled) return 'off (open access)'
  return Auth.isConfigured() ? 'on' : 'ENABLED BUT NO USER — run npm run create-user'
}

// Keep git state fresh in the background so sidebar badges don't go stale.
setInterval(() => store.refreshAll().catch(() => {}), 20_000)
setInterval(() => store.rescan().catch(() => {}), 5 * 60_000)

// Detach (but never kill) tmux clients on the way out, so a restart under
// `node --watch` does not leave orphaned attach processes stacked on a session.
// The tmux sessions themselves — and any work inside them — survive.
let shuttingDown = false
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    T.detachAll()
    process.exit(0)
  })
}
