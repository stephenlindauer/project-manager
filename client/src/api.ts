import type { Changes, Node, Project, PrsView, Runner, Script, Summary } from './types'

/** Notified whenever a request 401s, so the app can drop back to the login gate. */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn }

/** A non-2xx response. `detail` is the server's JSON body, so callers can act
 *  on fields beyond the message (e.g. a 409's `needsForce`). */
export class ApiError extends Error {
  constructor(public status: number, public detail: Record<string, unknown>) {
    super(typeof detail.error === 'string' ? detail.error : `HTTP ${status}`)
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    const detail = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, detail)
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

const EDITOR_APP = 'Visual Studio Code'

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

  prs: (id: string) => json<PrsView>(`/api/nodes/${id}/prs`),
  /** Move this worktree to another PR in its stack; `nodeId` may name a sibling worktree that already has it. */
  switchStack: (id: string, head: string) =>
    post<{ ok: boolean; nodeId: string | null; moved: boolean; path?: string; node?: Node }>(`/api/nodes/${id}/stack/switch`, { head }),
  createPr: (id: string, body: { title: string; body?: string; base?: string; draft?: boolean }) =>
    post<{ ok: boolean; url?: string; error?: string }>(`/api/nodes/${id}/prs`, body),
  /** Re-poll the sidebar's ship verdicts now; the server ignores calls within 10s of a tick. */
  shipRefresh: () => post<{ ok: boolean; skipped: boolean; at: number | null }>('/api/ship/refresh'),

  tasks: (id: string) => json<{ scripts: Script[]; runners: Runner[] }>(`/api/nodes/${id}/tasks`),
  startTask: (id: string, name: string, command: string) =>
    post<Runner>(`/api/nodes/${id}/tasks/start`, { name, command }),
  stopTask: (id: string, name: string) => post<Runner>(`/api/nodes/${id}/tasks/stop`, { name }),

  createWorktree: (projectId: string, spec: { branch: string; base?: string }) =>
    post<{ ok: boolean; dir: string; branch: string; node: Node | null }>(
      `/api/projects/${projectId}/worktrees`, spec,
    ),
  /** 409 with `{ needsForce: true, files }` when the tree is dirty; retry with `force` to discard them. */
  removeWorktree: (id: string, force = false) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/worktree?force=${force ? 1 : 0}`, { method: 'DELETE' }),

  /** Mark a node's Claude badge as seen: the label stays, the shouting stops. */
  ackClaude: (id: string) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/attention`, { method: 'DELETE' }),

  killSession: (id: string, kind: string) =>
    json<{ ok: boolean }>(`/api/nodes/${id}/sessions/${kind}`, { method: 'DELETE' }),

  open: (path: string, app?: string) => post<{ ok: boolean; error?: string | null }>('/api/open', { path, app }),
  /** Open a worktree in VS Code. Goes through `open -a`, so it needs no `code` on PATH. */
  openInEditor: (path: string) => api.open(path, EDITOR_APP),
}
