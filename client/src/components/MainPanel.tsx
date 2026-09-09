import { useState } from 'react'
import { api } from '../api'
import { TABS, useStore } from '../store'
import type { Node, TabId } from '../types'
import { ChangesTab } from './ChangesTab'
import { PrsTab } from './PrsTab'
import { SoonTab } from './SoonTab'
import { SummaryTab } from './SummaryTab'
import { TasksTab } from './TasksTab'
import { Terminal } from './Terminal'

/** The two tabs backed by a tmux session, and the session kind each maps to. */
const SESSION_KIND: Partial<Record<TabId, 'claude' | 'shell'>> = {
  claude: 'claude',
  terminal: 'shell',
}

export function MainPanel({ node }: { node: Node }) {
  const activeTab = useStore((s) => s.activeTab)
  const setTab = useStore((s) => s.setTab)
  const sessions = useStore((s) => s.sessions)
  const attention = useStore((s) => s.attention)
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const rescan = useStore((s) => s.rescan)
  const night = useStore((s) => s.night)
  const toggleNight = useStore((s) => s.toggleNight)

  // Bumping a kind's epoch changes the Terminal's key, forcing a full remount:
  // the old socket is torn down and a fresh one connects. MainPanel is keyed by
  // node.id in App, so this state resets when the project changes.
  const [epoch, setEpoch] = useState<{ claude: number; shell: number }>({ claude: 0, shell: 0 })
  const bump = (kind: 'claude' | 'shell') => setEpoch((p) => ({ ...p, [kind]: p[kind] + 1 }))

  const sessionKind = SESSION_KIND[activeTab]

  /** Drop and re-establish the socket without touching the tmux session. Fixes a
   *  dead/half-open connection (e.g. after the laptop sleeps) while keeping the
   *  session — and anything running in it — alive. */
  const reconnect = (kind: 'claude' | 'shell') => bump(kind)

  /** Destroy the tmux session, then remount to spawn a fresh one. */
  const killSession = async (kind: 'claude' | 'shell') => {
    const label = kind === 'claude' ? 'Claude' : 'terminal'
    if (!confirm(
      `Kill the ${label} session for ${node.name}?\n\n` +
      'This ends the tmux session and everything running in it, then starts a ' +
      'fresh one. Use Reconnect instead if the terminal is just frozen.',
    )) return
    try {
      await api.killSession(node.id, kind)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      bump(kind)
    }
  }

  const removeWorktree = async () => {
    if (!confirm(`Remove worktree ${node.cwd}?\n\nThe branch itself is kept.`)) return
    try {
      await api.removeWorktree(node.id)
      await rescan()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-1 border-b border-line bg-panel px-2">
        {TABS.map((t) => {
          const unread = sessions.some(
            (s) => s.nodeId === node.id && s.unread &&
              ((t.id === 'claude' && s.kind === 'claude') || (t.id === 'terminal' && s.kind === 'shell')),
          )
          // Attention outranks unread on the Claude tab: "it wants you" is
          // strictly more urgent than "it printed something".
          const wants = t.id === 'claude' && Boolean(attention[node.id])
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.hint}
              className={`relative border-b-2 px-3 py-2 text-[12px] transition-colors ${
                activeTab === t.id
                  ? 'border-accent text-ink shadow-[inset_0_-8px_14px_-10px_var(--color-accent)]'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {wants ? (
                <span className="ml-1.5 inline-block size-[7px] rounded-full bg-attn align-middle attn-ping" />
              ) : unread && (
                <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle shadow-neon" />
              )}
            </button>
          )
        })}

        <div className="ml-auto flex items-center gap-2 pr-1 text-[11px] text-muted">
          {sessionKind && (
            <>
              <button
                onClick={() => reconnect(sessionKind)}
                className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-ink"
                title="Reconnect this session (keeps it running — fixes a frozen terminal)"
              >⟳ reconnect</button>
              <button
                onClick={() => killSession(sessionKind)}
                className="rounded border border-line px-1.5 py-0.5 hover:border-bad hover:text-bad"
                title="Kill this tmux session and start a fresh one"
              >✕ kill</button>
              <span className="text-line">|</span>
            </>
          )}
          {node.branch && <span className="font-mono text-neon-pink glow-text">⑂ {node.branch}</span>}
          <button
            onClick={() => setNewBranchFor(node.projectId)}
            className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-ink"
            title="New branch worktree"
          >+ branch</button>
          {!node.isMain && (
            <button
              onClick={removeWorktree}
              className="rounded border border-line px-1.5 py-0.5 hover:border-bad hover:text-bad"
              title="Remove this worktree"
            >remove</button>
          )}
          {/* Last in the row so it stays pinned to the corner whatever else the
              tab or worktree adds to this cluster. */}
          <button
            onClick={toggleNight}
            aria-pressed={night}
            className={`rounded border px-1.5 py-0.5 ${
              night ? 'border-accent text-accent' : 'border-line hover:border-accent hover:text-ink'
            }`}
            title={night ? 'Night mode on — restore full brightness' : 'Night mode — dim the whole palette'}
          >{night ? '☾' : '☀'}</button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {activeTab === 'summary' && <SummaryTab node={node} />}
        {activeTab === 'changes' && <ChangesTab node={node} />}
        {activeTab === 'tasks' && <TasksTab node={node} />}
        {activeTab === 'prs' && <PrsTab node={node} />}
        {activeTab === 'soon' && <SoonTab node={node} />}

        {/*
          Terminals stay mounted for the active project and are merely hidden
          when another tab shows, so switching tabs never drops the session or
          reflows the shell. Keying on node.id tears them down only when the
          project itself changes.
        */}
        <div className="h-full" style={{ display: activeTab === 'claude' ? 'block' : 'none' }}>
          <Terminal key={`${node.id}:claude:${epoch.claude}`} nodeId={node.id} kind="claude" hidden={activeTab !== 'claude'} />
        </div>
        <div className="h-full" style={{ display: activeTab === 'terminal' ? 'block' : 'none' }}>
          <Terminal key={`${node.id}:shell:${epoch.shell}`} nodeId={node.id} kind="shell" hidden={activeTab !== 'terminal'} />
        </div>
      </div>
    </main>
  )
}
