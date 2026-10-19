import { create } from 'zustand'
import { api, authApi, setUnauthorizedHandler } from './api'
import type { Agent, ClaudeStatus, Node, Project, Runner, SessionInfo, ShipEnvelope, ShipStatus, TabId, Toast } from './types'

export const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'summary', label: 'Summary', hint: 'Project overview and git state' },
  { id: 'claude', label: 'Claude', hint: 'Persistent Claude Code session' },
  { id: 'terminal', label: 'Terminal', hint: 'Persistent shell' },
  { id: 'changes', label: 'Changes', hint: 'Review before committing' },
  { id: 'tasks', label: 'Tasks', hint: 'Dev servers and scripts' },
  { id: 'prs', label: 'PRs', hint: 'Pull requests and CI' },
]

type State = {
  projects: Project[]
  nodes: Node[]
  runners: Runner[]
  sessions: SessionInfo[]
  /** What each node's Claude session is doing, keyed by node id. Server-owned; see notify.js. */
  claude: Record<string, ClaudeStatus>
  /** The next thing you must do to ship each node's PRs, keyed by node id. Server-owned; see ship.js. */
  ship: Record<string, ShipStatus>
  /** The rest of the ship envelope: availability, staleness, PRs with no worktree. */
  shipMeta: Omit<ShipEnvelope, 'nodes'>
  /** Transient notifications, oldest first. At most one per node. */
  toasts: Toast[]
  activeNodeId: string | null
  activeTab: TabId
  /** Remembers the last tab per node so switching projects feels like tabs in an editor. */
  tabByNode: Record<string, TabId>
  paletteOpen: boolean
  /** Dimmed palette for reading in a dark room. Persisted; see `applyNight`. */
  night: boolean
  /** Sidebar collapsed to its rail. Persisted; hover and ⌥↑↓ peek over it. */
  navCollapsed: boolean
  /** Projects folded to their heading in the sidebar, by project id. Persisted. */
  collapsedProjects: Record<string, true>
  /** Worktrees pinned to the top of their project, by node id. Persisted; see `visibleNodes`. */
  pinnedNodes: Record<string, true>
  /** Which agent CLI the "Claude" tab shows per node. Persisted; default claude. */
  agentByNode: Record<string, Agent>
  /** Sidebar shows only worktrees with something going on (see `isActiveNode`). Persisted. */
  activeOnly: boolean
  /** The Ship strip folded to its heading. Persisted. */
  shipStripFolded: boolean
  /** A timed peek from keyboard navigation. Hover peeking is local to Sidebar. */
  navPeek: boolean
  newBranchFor: string | null
  /**
   * Text waiting to be typed into a node's Claude session the moment its
   * socket is open (`startInClaude`). Typed, never submitted: the person reads
   * it and presses Enter.
   */
  pendingInput: Record<string, string>
  loading: boolean
  /** null = auth state unknown; true = login screen required; false = past the gate. */
  needsLogin: boolean | null
  meta: { projectsRoot: string; terminalBackend: string; ghAvailable: boolean } | null

  load: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  rescan: () => Promise<void>
  setActiveNode: (id: string) => void
  setTab: (tab: TabId) => void
  moveNode: (delta: number) => void
  moveTab: (delta: number) => void
  setPalette: (open: boolean) => void
  dismissToast: (id: string) => void
  showNode: (id: string) => void
  /** Jump to a node and open one of its tabs, unfolding its project on the way. */
  showNodeTab: (id: string, tab: TabId) => void
  ackClaude: (id: string) => void
  toggleNight: () => void
  toggleNav: () => void
  toggleProject: (projectId: string) => void
  togglePin: (nodeId: string) => void
  toggleActiveOnly: () => void
  toggleShipStrip: () => void
  setAgent: (nodeId: string, agent: Agent) => void
  /** Push a local toast. Same `key` replaces an earlier one. */
  notice: (t: { key: string; title: string; message?: string | null; tone?: Toast['tone']; nodeId?: string | null; sticky?: boolean }) => void
  /** Create a worktree without holding a dialog open: toasts on start, success and failure. */
  createWorktreeInBackground: (projectId: string, spec: { branch: string; base?: string }) => void
  peekNav: () => void
  setNewBranchFor: (projectId: string | null) => void
  /** Queue text for a node's Claude tab and switch to it. */
  startInClaude: (nodeId: string, text: string) => void
  takePendingInput: (nodeId: string) => string | null
}

/**
 * A section is one folder group, or a single ungrouped project. Ungrouped
 * projects must rank individually — lumping all of them under one empty group
 * would move 30+ unrelated repos as a block and bury the real groups.
 */
export const sectionOf = (n: Node) =>
  n.group ? `group:${n.group}` : `project:${n.projectId}`

/**
 * Sidebar order: most recently active first, at every level.
 *
 * Sections are ranked by their most recent member and projects by their most
 * recent worktree, so a branch you are working in lifts its whole project — and
 * its group — to the top. Within a project the main worktree stays first,
 * because the sidebar renders the other worktrees as its children.
 *
 * A pinned worktree ranks above its project's unpinned worktrees, never outside
 * the project: a pin does not lift the project or its group. The main worktree
 * still comes first.
 */
export function visibleNodes(nodes: Node[], pinned: Record<string, true>): Node[] {
  const recencyOf = (list: Node[]) => Math.max(0, ...list.map((n) => n.activityAt ?? 0))


  const bySection = new Map<string, Node[]>()
  const byProject = new Map<string, Node[]>()
  for (const n of nodes) {
    const s = sectionOf(n)
    if (!bySection.has(s)) bySection.set(s, [])
    bySection.get(s)!.push(n)
    if (!byProject.has(n.projectId)) byProject.set(n.projectId, [])
    byProject.get(n.projectId)!.push(n)
  }

  const sectionRank = new Map([...bySection].map(([s, list]) => [s, recencyOf(list)]))
  const projectRank = new Map([...byProject].map(([p, list]) => [p, recencyOf(list)]))

  return [...nodes].sort((a, b) => {
    const sa = sectionOf(a)
    const sb = sectionOf(b)
    if (sa !== sb) {
      return (sectionRank.get(sb)! - sectionRank.get(sa)!)
        || (a.group ?? a.name).localeCompare(b.group ?? b.name)
    }
    if (a.projectId !== b.projectId) {
      return (projectRank.get(b.projectId)! - projectRank.get(a.projectId)!)
        || a.name.localeCompare(b.name)
    }
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    if (!pinned[a.id] !== !pinned[b.id]) return pinned[a.id] ? -1 : 1
    return (b.activityAt ?? 0) - (a.activityAt ?? 0) || a.label.localeCompare(b.label)
  })
}

/**
 * "Active" for the sidebar's active-only filter: a Claude session in any
 * state — working, blocked on you, ready, or idle at the prompt (a session you
 * have looked at is still a session) — a running task, a pull request waiting
 * on you (a `merge` you have not clicked is live work; see ship.js), or simply
 * being the selected worktree, which must never vanish from under the panel
 * showing it.
 */
export function isActiveNode(s: Pick<State, 'claude' | 'runners' | 'activeNodeId' | 'ship'>, id: string): boolean {
  return id === s.activeNodeId || Boolean(s.claude[id]) || Boolean(s.ship[id]?.attention)
    || s.runners.some((r) => r.nodeId === id && r.running)
}

/** Whether the active-only filter, if on, lets this node through. */
export const isShownNode = (s: Pick<State, 'claude' | 'runners' | 'activeNodeId' | 'activeOnly' | 'ship'>, id: string) =>
  !s.activeOnly || isActiveNode(s, id)

/**
 * Night mode is a `data-night` attribute on <html>; index.css redefines the
 * colour tokens under it. Applied at module load rather than from an effect so
 * the first paint is already dimmed — a full-brightness flash is exactly what
 * the mode exists to avoid.
 */
const nightAtBoot = localStorage.getItem('pm:night') === '1'

function loadJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}

function loadIdSet(key: string): Record<string, true> {
  try {
    const ids = JSON.parse(localStorage.getItem(key) ?? '[]') as string[]
    return Object.fromEntries(ids.map((id) => [id, true as const]))
  } catch { return {} }
}
function applyNight(on: boolean) {
  document.documentElement.toggleAttribute('data-night', on)
}
applyNight(nightAtBoot)

export const useStore = create<State>((set, get) => ({
  projects: [],
  nodes: [],
  runners: [],
  sessions: [],
  claude: {},
  ship: {},
  shipMeta: { available: false, stale: false, at: null, orphans: [] },
  toasts: [],
  activeNodeId: null,
  activeTab: 'summary',
  tabByNode: {},
  paletteOpen: false,
  night: nightAtBoot,
  navCollapsed: localStorage.getItem('pm:navCollapsed') === '1',
  collapsedProjects: loadIdSet('pm:collapsedProjects'),
  pinnedNodes: loadIdSet('pm:pinnedNodes'),
  agentByNode: loadJson<Record<string, Agent>>('pm:agentByNode', {}),
  activeOnly: localStorage.getItem('pm:activeOnly') === '1',
  shipStripFolded: localStorage.getItem('pm:shipStripFolded') === '1',
  navPeek: false,
  newBranchFor: null,
  pendingInput: {},
  loading: true,
  needsLogin: null,
  meta: null,

  load: async () => {
    // A 401 anywhere (expired session, etc.) bounces the whole app to login.
    setUnauthorizedHandler(() => set({ needsLogin: true, loading: false }))

    const auth = await authApi.status().catch(() => ({ enabled: false, configured: true, authed: true }))
    if (auth.enabled && !auth.authed) {
      set({ needsLogin: true, loading: false })
      return
    }

    const [meta, data] = await Promise.all([api.meta(), api.projects()])
    const nodes = visibleNodes(data.nodes, get().pinnedNodes)
    const remembered = localStorage.getItem('pm:activeNode')
    const active = nodes.find((n) => n.id === remembered)?.id ?? nodes[0]?.id ?? null
    set({ meta, projects: data.projects, nodes, activeNodeId: active, needsLogin: false, loading: false })
    connectEvents(set, get)
  },

  login: async (username, password) => {
    await authApi.login(username, password)
    set({ needsLogin: false, loading: true })
    await get().load()
  },

  logout: async () => {
    await authApi.logout().catch(() => {})
    set({ needsLogin: true })
  },

  rescan: async () => {
    const data = await api.rescan()
    set({ projects: data.projects, nodes: visibleNodes(data.nodes, get().pinnedNodes) })
  },

  setActiveNode: (id) => {
    localStorage.setItem('pm:activeNode', id)
    set({ activeNodeId: id, activeTab: get().tabByNode[id] ?? 'summary' })
  },

  setTab: (tab) => {
    const id = get().activeNodeId
    set({
      activeTab: tab,
      tabByNode: id ? { ...get().tabByNode, [id]: tab } : get().tabByNode,
    })
  },

  moveNode: (delta) => {
    const { nodes, activeNodeId, collapsedProjects } = get()
    if (!nodes.length) return
    const i = nodes.findIndex((n) => n.id === activeNodeId)
    // Rows inside a folded project are not on screen, so the keyboard walks
    // past them — landing the selection on a row you cannot see is how a
    // "folded" project turns into a mystery. Bounded, so a fully folded
    // sidebar cannot spin.
    let next: Node | undefined
    for (let step = 1; step <= nodes.length; step++) {
      const cand = nodes[(i + delta * step + nodes.length * step) % nodes.length]
      if (!collapsedProjects[cand.projectId] && isShownNode(get(), cand.id)) { next = cand; break }
    }
    if (next) get().setActiveNode(next.id)
    // Keyboard navigation is useless against a collapsed nav you can't see.
    get().peekNav()
  },

  moveTab: (delta) => {
    const i = TABS.findIndex((t) => t.id === get().activeTab)
    get().setTab(TABS[(i + delta + TABS.length) % TABS.length].id)
  },

  setPalette: (paletteOpen) => set({ paletteOpen }),

  dismissToast: (id) => {
    const toast = get().toasts.find((t) => t.id === id)
    if (!toast || toast.leaving) return
    // Mark first, drop after the slide-out. Removing outright would make the
    // toast vanish rather than leave.
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })
    setTimeout(
      () => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      TOAST_EXIT_MS,
    )
  },

  /** Jump to a node's Claude session — what clicking a toast does. */
  showNode: (id) => {
    get().showNodeTab(id, 'claude')
    get().ackClaude(id)
  },

  showNodeTab: (id, tab) => {
    // A deliberate jump unfolds the project: the row you just asked for must
    // be on screen, not hidden under a heading.
    const node = get().nodes.find((n) => n.id === id)
    if (node && get().collapsedProjects[node.projectId]) get().toggleProject(node.projectId)
    get().setActiveNode(id)
    get().setTab(tab)
  },

  ackClaude: (id) => {
    const cur = get().claude[id]
    if (!cur || cur.seen) return
    // Flip it locally first; the server echoes the same state back over SSE.
    set({ claude: { ...get().claude, [id]: { ...cur, seen: true } } })
    api.ackClaude(id).catch(() => {})
  },

  toggleNight: () => {
    const night = !get().night
    localStorage.setItem('pm:night', night ? '1' : '0')
    applyNight(night)
    set({ night })
  },

  toggleNav: () => {
    const navCollapsed = !get().navCollapsed
    localStorage.setItem('pm:navCollapsed', navCollapsed ? '1' : '0')
    // Drop any in-flight peek, so expanding doesn't leave a timer that later
    // "un-peeks" and looks like a flicker.
    if (peekTimer) clearTimeout(peekTimer)
    set({ navCollapsed, navPeek: false })
  },

  toggleActiveOnly: () => {
    const activeOnly = !get().activeOnly
    localStorage.setItem('pm:activeOnly', activeOnly ? '1' : '0')
    set({ activeOnly })
  },

  toggleShipStrip: () => {
    const shipStripFolded = !get().shipStripFolded
    localStorage.setItem('pm:shipStripFolded', shipStripFolded ? '1' : '0')
    set({ shipStripFolded })
  },

  setAgent: (nodeId, agent) => {
    const agentByNode = { ...get().agentByNode, [nodeId]: agent }
    localStorage.setItem('pm:agentByNode', JSON.stringify(agentByNode))
    set({ agentByNode })
  },

  notice: ({ key, title, message = null, tone = 'info', nodeId = null, sticky = false }) => {
    const toast: Toast = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, key, nodeId, title, tone, message, at: Date.now() }
    pushToast(set, get, toast, sticky)
  },

  createWorktreeInBackground: (projectId, spec) => {
    const project = get().projects.find((p) => p.id === projectId)
    const what = spec.branch
    const key = `worktree:${projectId}:${what}`
    get().notice({ key, title: 'Creating worktree…', message: `${project?.name ?? ''} · ${what}`, sticky: true })
    api.createWorktree(projectId, spec)
      .then(async (res) => {
        await get().rescan()
        // Deliberately does not select the new node: this runs while you are
        // doing something else, and yanking the panel over would undo that.
        // The toast is the way in.
        get().notice({
          key, tone: 'ok', nodeId: res.node?.id ?? null,
          title: 'Worktree ready',
          message: res.branch,
        })
      })
      .catch((e) => {
        get().notice({ key, tone: 'bad', title: 'Worktree failed', message: e instanceof Error ? e.message : String(e), sticky: true })
      })
  },

  toggleProject: (projectId) => {
    const { [projectId]: was, ...rest } = get().collapsedProjects
    const collapsedProjects = was ? rest : { ...rest, [projectId]: true as const }
    localStorage.setItem('pm:collapsedProjects', JSON.stringify(Object.keys(collapsedProjects)))
    set({ collapsedProjects })
  },

  togglePin: (nodeId) => {
    const { [nodeId]: was, ...rest } = get().pinnedNodes
    const pinnedNodes = was ? rest : { ...rest, [nodeId]: true as const }
    localStorage.setItem('pm:pinnedNodes', JSON.stringify(Object.keys(pinnedNodes)))
    set({ pinnedNodes, nodes: visibleNodes(get().nodes, pinnedNodes) })
  },

  peekNav: () => {
    if (!get().navCollapsed) return
    if (peekTimer) clearTimeout(peekTimer)
    peekTimer = setTimeout(() => useStore.setState({ navPeek: false }), PEEK_MS)
    set({ navPeek: true })
  },

  setNewBranchFor: (newBranchFor) => set({ newBranchFor }),

  startInClaude: (nodeId, text) => {
    set({ pendingInput: { ...get().pendingInput, [nodeId]: text } })
    get().setActiveNode(nodeId)
    get().setTab('claude')
  },

  takePendingInput: (nodeId) => {
    const text = get().pendingInput[nodeId]
    if (!text) return null
    const { [nodeId]: _taken, ...rest } = get().pendingInput
    set({ pendingInput: rest })
    return text
  },
}))

/** How long a keyboard-triggered peek stays open after the last keystroke. */
const PEEK_MS = 1600
let peekTimer: ReturnType<typeof setTimeout> | null = null

/** Add a toast, replacing any earlier one with the same key. `sticky` toasts wait for ✕ or a click. */
function pushToast(set: (p: Partial<State>) => void, get: () => State, toast: Toast, sticky: boolean) {
  const kept = get().toasts.filter((t) => t.key !== toast.key)
  set({ toasts: [...kept, toast].slice(-MAX_TOASTS) })
  if (!sticky) setTimeout(() => useStore.getState().dismissToast(toast.id), TOAST_MS)
}

/** Toast lifetime, and how long the slide-out runs. Keep in step with index.css. */
const TOAST_MS = 7000
const TOAST_EXIT_MS = 220
/** Beyond this the stack stops being glanceable and starts being a wall. */
const MAX_TOASTS = 4

/**
 * Live updates from the server. Node-level git refreshes are merged in place so
 * the sidebar never flickers or loses its ordering mid-refresh.
 */
let eventSource: EventSource | null = null

function connectEvents(set: (p: Partial<State>) => void, get: () => State) {
  // React StrictMode runs effects twice in dev; without this guard every reload
  // would leak a second SSE connection and double every update.
  if (eventSource) return
  const es = new EventSource('/events')
  eventSource = es
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) eventSource = null }

  es.addEventListener('nodes', (e) => {
    set({ nodes: visibleNodes(JSON.parse((e as MessageEvent).data), get().pinnedNodes) })
  })
  es.addEventListener('node', (e) => {
    const updated = JSON.parse((e as MessageEvent).data) as Node
    set({ nodes: get().nodes.map((n) => (n.id === updated.id ? updated : n)) })
  })
  es.addEventListener('projects', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    set({ projects: data.projects, nodes: visibleNodes(data.nodes, get().pinnedNodes) })
  })
  es.addEventListener('tasks', (e) => {
    set({ runners: JSON.parse((e as MessageEvent).data) })
  })
  es.addEventListener('sessions', (e) => {
    set({ sessions: JSON.parse((e as MessageEvent).data) })
  })

  // Sticky state: sent whole, including once on connect, so a page opened after
  // the signal still shows the indicator.
  es.addEventListener('claude-status', (e) => {
    const list = JSON.parse((e as MessageEvent).data) as ClaudeStatus[]
    set({ claude: Object.fromEntries(list.map((a) => [a.nodeId, a])) })
  })
  es.addEventListener('ship-status', (e) => {
    const { nodes, ...shipMeta } = JSON.parse((e as MessageEvent).data) as ShipEnvelope
    set({ ship: Object.fromEntries(nodes.map((s) => [s.nodeId, s])), shipMeta })
  })

  es.addEventListener('claude-toast', (e) => {
    const raw = JSON.parse((e as MessageEvent).data) as Omit<Toast, 'key'>
    // One toast per node: a project that finishes twice replaces its own notice
    // instead of stacking two of them.
    pushToast(set, get, { ...raw, key: `claude:${raw.nodeId}` }, false)
  })
}

export const useActiveNode = () =>
  useStore((s) => s.nodes.find((n) => n.id === s.activeNodeId) ?? null)
