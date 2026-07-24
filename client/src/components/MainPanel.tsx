import { api } from '../api'
import { TABS, useStore } from '../store'
import type { Node } from '../types'
import { ChangesTab } from './ChangesTab'
import { PrsTab } from './PrsTab'
import { SummaryTab } from './SummaryTab'
import { TasksTab } from './TasksTab'
import { Terminal } from './Terminal'

export function MainPanel({ node }: { node: Node }) {
  const activeTab = useStore((s) => s.activeTab)
  const setTab = useStore((s) => s.setTab)
  const sessions = useStore((s) => s.sessions)
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const rescan = useStore((s) => s.rescan)

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
              {unread && (
                <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle shadow-neon" />
              )}
            </button>
          )
        })}

        <div className="ml-auto flex items-center gap-2 pr-1 text-[11px] text-muted">
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
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {activeTab === 'summary' && <SummaryTab node={node} />}
        {activeTab === 'changes' && <ChangesTab node={node} />}
        {activeTab === 'tasks' && <TasksTab node={node} />}
        {activeTab === 'prs' && <PrsTab node={node} />}

        {/*
          Terminals stay mounted for the active project and are merely hidden
          when another tab shows, so switching tabs never drops the session or
          reflows the shell. Keying on node.id tears them down only when the
          project itself changes.
        */}
        <div className="h-full" style={{ display: activeTab === 'claude' ? 'block' : 'none' }}>
          <Terminal key={`${node.id}:claude`} nodeId={node.id} kind="claude" hidden={activeTab !== 'claude'} />
        </div>
        <div className="h-full" style={{ display: activeTab === 'terminal' ? 'block' : 'none' }}>
          <Terminal key={`${node.id}:shell`} nodeId={node.id} kind="shell" hidden={activeTab !== 'terminal'} />
        </div>
      </div>
    </main>
  )
}
