import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs/promises'
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
import { run } from './exec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

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
  res.json({ ok: true, dir, node: created })
}))

app.delete('/api/nodes/:id/worktree', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  if (n.worktree.isMain) return res.status(400).json({ error: 'cannot remove the main worktree' })

  Tasks.stopNode(req.params.id)
  await T.killNode(req.params.id)
  const result = await G.removeWorktree(n.project.path, n.cwd, { force: req.query.force === '1' })
  if (result.failed) return res.status(400).json({ error: result.stderr.trim() })
  await store.rescan()
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
  res.json(await GH.pullRequests(n.cwd))
}))

app.post('/api/nodes/:id/prs', wrap(async (req, res) => {
  const n = node(req, res); if (!n) return
  res.json(await GH.createPr(n.cwd, req.body ?? {}))
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

  store.on('nodes', onNodes)
  store.on('node', onNode)
  store.on('projects', onProjects)

  const taskTick = setInterval(() => sendIfChanged('tasks', Tasks.allRunners()), 2000)
  const sessionTick = setInterval(() => sendIfChanged('sessions', T.sessionSummaries()), 2000)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)

  req.on('close', () => {
    store.off('nodes', onNodes)
    store.off('node', onNode)
    store.off('projects', onProjects)
    clearInterval(taskTick)
    clearInterval(sessionTick)
    clearInterval(heartbeat)
  })
})

// --------------------------------------------------------- static (prod)

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

// ------------------------------------------------------------- websocket

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/pty') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url))
})

wss.on('connection', (ws, req, url) => {
  const nodeId = url.searchParams.get('node')
  const kind = url.searchParams.get('kind') === 'claude' ? 'claude' : 'shell'
  const target = url.searchParams.get('task')

  const hit = store.find(nodeId)
  if (!hit?.worktree) {
    ws.send(JSON.stringify({ type: 'error', message: 'unknown project node' }))
    return ws.close()
  }

  // A `task` param streams a dev-server log instead of an interactive shell.
  if (target) return attachRunner(ws, nodeId, target)

  const session = T.getSession(nodeId, kind, hit.worktree.path)

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
  })

  ws.on('close', () => {
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
server.listen(config.port, '127.0.0.1', async () => {
  console.log(`[pm] api        http://127.0.0.1:${config.port}`)
  console.log(`[pm] root       ${config.projectsRoot}`)
  console.log(`[pm] terminals  ${backend ? 'tmux (persistent)' : 'node-pty (tmux not found)'}`)
  await store.rescan()
  console.log(`[pm] indexed    ${store.projects.length} projects, ${store.nodes.length} worktrees`)
})

// Keep git state fresh in the background so sidebar badges don't go stale.
setInterval(() => store.refreshAll().catch(() => {}), 20_000)
setInterval(() => store.rescan().catch(() => {}), 5 * 60_000)
