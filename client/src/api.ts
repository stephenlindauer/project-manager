import type { Changes, Node, Project, PullRequest, Runner, Script, Summary, TodoHorizon, Todos } from './types'

/** Notified whenever a request 401s, so the app can drop back to the login gate. */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn }

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    const detail = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(detail.error ?? res.statusText)
  }
  return res.json()
}

const post = <T,>(url: string, body?: unknown) =>
  json<T>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined })

export type AuthStatus = { enabled: boolean; configured: boolean; authed: boolean }
export const authApi = {
  status: () => json<AuthStatus>('/api/auth'),
  login: (username: string, password: string) =>
    json<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => json<{ ok: boolean }>('/api/logout', { method: 'POST' }),
}

export const api = {
  meta: () => json<{ projectsRoot: string; terminalBackend: string; ghAvailable: boolean }>('/api/meta'),

  projects: () => json<{ projects: Project[]; nodes: Node[] }>('/api/projects'),
  rescan: () => post<{ projects: Project[]; nodes: Node[] }>('/api/rescan'),
  refreshNode: (id: string) => post<Node>(`/api/nodes/${id}/refresh`),
  fetchRemote: (id: string) => post<Node>(`/api/nodes/${id}/fetch`),

  summary: (id: string) => json<Summary>(`/api/nodes/${id}/summary`),
  branches: (id: string) => json<{ name: string; date: string; sha: string }[]>(`/api/nodes/${id}/branches`),

  changes: (id: string) => json<Changes>(`/api/nodes/${id}/changes`),
  diff: (id: string, file: string, staged = false) =>
    json<{ diff: string }>(`/api/nodes/${id}/diff?file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}`),

  prs: (id: string) =>
    json<{ available: boolean; prs: PullRequest[]; viewer?: string | null; error?: string | null }>(`/api/nodes/${id}/prs`),
  createPr: (id: string, body: { title: string; body?: string; base?: string; draft?: boolean }) =>
    post<{ ok: boolean; url?: string; error?: string }>(`/api/nodes/${id}/prs`, body),

  todos: (id: string) => json<Todos>(`/api/nodes/${id}/todos`),
  addTodo: (id: string, body: { text: string; horizon?: TodoHorizon; due?: string }) =>
    post<{ ok: boolean; error?: string }>(`/api/nodes/${id}/todos`, body),
  doneTodo: (id: string, obs: string, reason?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/nodes/${id}/todos/${obs}/done`, { reason }),
  bumpTodo: (id: string, obs: string, body: { horizon?: TodoHorizon; due?: string | null; reopen?: boolean } = {}) =>
    post<{ ok: boolean; error?: string }>(`/api/nodes/${id}/todos/${obs}/bump`, body),

  tasks: (id: string) => json<{ scripts: Script[]; runners: Runner[] }>(`/api/nodes/${id}/tasks`),
  startTask: (id: string, name: string, command: string) =>
    post<Runner>(`/api/nodes/${id}/tasks/start`, { name, command }),
  stopTask: (id: string, name: string) => post<Runner>(`/api/nodes/${id}/tasks/stop`, { name }),

  createWorktree: (projectId: string, branch: string, base?: string) =>
    post<{ ok: boolean; dir: string; node: Node }>(`/api/projects/${projectId}/worktrees`, { branch, base }),
  removeWorktree: (id: string, force = false) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/worktree?force=${force ? 1 : 0}`, { method: 'DELETE' }),

  clearAttention: (id: string) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/attention`, { method: 'DELETE' }),

  killSession: (id: string, kind: string) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/sessions/${kind}`, { method: 'DELETE' }),

  open: (path: string, app?: string) => post<{ ok: boolean }>('/api/open', { path, app }),
}
