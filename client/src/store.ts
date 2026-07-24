import { create } from 'zustand'
import { api } from './api'
import type { Node, Project, Runner, SessionInfo, TabId } from './types'

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
  activeNodeId: string | null
  activeTab: TabId
  /** Remembers the last tab per node so switching projects feels like tabs in an editor. */
  tabByNode: Record<string, TabId>
  paletteOpen: boolean
  newBranchFor: string | null
  loading: boolean
  meta: { projectsRoot: string; terminalBackend: string; ghAvailable: boolean } | null

  load: () => Promise<void>
  rescan: () => Promise<void>
  setActiveNode: (id: string) => void
  setTab: (tab: TabId) => void
  moveNode: (delta: number) => void
  moveTab: (delta: number) => void
  setPalette: (open: boolean) => void
  setNewBranchFor: (projectId: string | null) => void
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
 */
export function visibleNodes(nodes: Node[]): Node[] {
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
    return (b.activityAt ?? 0) - (a.activityAt ?? 0) || a.label.localeCompare(b.label)
  })
}

export const useStore = create<State>((set, get) => ({
  projects: [],
  nodes: [],
  runners: [],
  sessions: [],
  activeNodeId: null,
  activeTab: 'summary',
  tabByNode: {},
  paletteOpen: false,
  newBranchFor: null,
  loading: true,
  meta: null,

  load: async () => {
    const [meta, data] = await Promise.all([api.meta(), api.projects()])
    const nodes = visibleNodes(data.nodes)
    const remembered = localStorage.getItem('pm:activeNode')
    const active = nodes.find((n) => n.id === remembered)?.id ?? nodes[0]?.id ?? null
    set({ meta, projects: data.projects, nodes, activeNodeId: active, loading: false })
    connectEvents(set, get)
  },

  rescan: async () => {
    const data = await api.rescan()
    set({ projects: data.projects, nodes: visibleNodes(data.nodes) })
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
    const { nodes, activeNodeId } = get()
    if (!nodes.length) return
    const i = nodes.findIndex((n) => n.id === activeNodeId)
    const next = nodes[(i + delta + nodes.length) % nodes.length]
    if (next) get().setActiveNode(next.id)
  },

  moveTab: (delta) => {
    const i = TABS.findIndex((t) => t.id === get().activeTab)
    get().setTab(TABS[(i + delta + TABS.length) % TABS.length].id)
  },

  setPalette: (paletteOpen) => set({ paletteOpen }),
  setNewBranchFor: (newBranchFor) => set({ newBranchFor }),
}))

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
    set({ nodes: visibleNodes(JSON.parse((e as MessageEvent).data)) })
  })
  es.addEventListener('node', (e) => {
    const updated = JSON.parse((e as MessageEvent).data) as Node
    set({ nodes: get().nodes.map((n) => (n.id === updated.id ? updated : n)) })
  })
  es.addEventListener('projects', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    set({ projects: data.projects, nodes: visibleNodes(data.nodes) })
  })
  es.addEventListener('tasks', (e) => {
    set({ runners: JSON.parse((e as MessageEvent).data) })
  })
  es.addEventListener('sessions', (e) => {
    set({ sessions: JSON.parse((e as MessageEvent).data) })
  })
}

export const useActiveNode = () =>
  useStore((s) => s.nodes.find((n) => n.id === s.activeNodeId) ?? null)
