import { useMemo } from 'react'
import { sectionOf, useStore } from '../store'
import { shortAgo } from '../lib/time'
import type { Node } from '../types'
import { StatusBadges } from './StatusBadges'

type Section = { key: string; group: string | null; projects: Map<string, Node[]> }

/**
 * Split the already-sorted node list into `section → project → [main, ...worktrees]`.
 *
 * This walks the list in order rather than bucketing by group, so the recency
 * ordering from `visibleNodes` is preserved exactly — bucketing would silently
 * regroup ungrouped projects and undo the sort.
 */
function useTree(): Section[] {
  const nodes = useStore((s) => s.nodes)
  return useMemo(() => {
    const sections: Section[] = []
    let current: Section | null = null
    for (const n of nodes) {
      const key = sectionOf(n)
      if (!current || current.key !== key) {
        current = { key, group: n.group, projects: new Map() }
        sections.push(current)
      }
      if (!current.projects.has(n.projectId)) current.projects.set(n.projectId, [])
      current.projects.get(n.projectId)!.push(n)
    }
    return sections
  }, [nodes])
}

export function Sidebar() {
  const tree = useTree()
  const activeNodeId = useStore((s) => s.activeNodeId)
  const setActiveNode = useStore((s) => s.setActiveNode)
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const setPalette = useStore((s) => s.setPalette)
  const rescan = useStore((s) => s.rescan)
  const sessions = useStore((s) => s.sessions)
  const runners = useStore((s) => s.runners)

  return (
    <aside className="flex h-full w-[266px] shrink-0 flex-col border-r border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-accent glow-text">
          Projects
        </span>
        <button
          onClick={() => setPalette(true)}
          className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          title="Jump to project (⌘K)"
        >⌘K</button>
        <button
          onClick={() => rescan()}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          title="Rescan ~/Projects"
        >↻</button>
      </header>

      <nav className="flex-1 overflow-y-auto py-1">
        {tree.map(({ key, group, projects }) => (
          <section key={key} className={group ? 'mb-1' : ''}>
            {group && (
              <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-neon-purple/90">
                {group}
              </div>
            )}
            {[...projects.entries()].map(([projectId, projectNodes]) => {
              const main = projectNodes.find((n) => n.isMain) ?? projectNodes[0]

              // A project with a single worktree is just one row — nesting it
              // under its own name would double the length of the list for no
              // information. Once it has more than one, every branch nests so
              // they can be compared side by side rather than one of them
              // masquerading as the project itself.
              if (projectNodes.length === 1) {
                return (
                  <NodeRow
                    key={projectId}
                    node={main}
                    active={main.id === activeNodeId}
                    onSelect={() => setActiveNode(main.id)}
                    sessions={sessions}
                    runners={runners}
                    onNewBranch={() => setNewBranchFor(projectId)}
                    indent={!!group}
                  />
                )
              }

              return (
                <div key={projectId}>
                  <ProjectLabel
                    name={main.name}
                    count={projectNodes.length}
                    onNewBranch={() => setNewBranchFor(projectId)}
                    indent={!!group}
                  />
                  {projectNodes.map((n) => (
                    <NodeRow
                      key={n.id}
                      node={n}
                      nested
                      indent={!!group}
                      active={n.id === activeNodeId}
                      onSelect={() => setActiveNode(n.id)}
                      sessions={sessions}
                      runners={runners}
                    />
                  ))}
                </div>
              )
            })}
          </section>
        ))}
      </nav>

      <footer className="border-t border-line px-3 py-1.5 text-[10px] text-muted">
        <kbd className="text-accent">⌥↑↓</kbd> project · <kbd className="text-accent">⌥←→</kbd> tab
      </footer>
    </aside>
  )
}

/**
 * Non-interactive heading for a project whose branches are listed beneath it.
 * Selection happens on the branch rows, so there is never an ambiguous "is this
 * the project or its main branch?" target.
 */
function ProjectLabel({ name, count, onNewBranch, indent }: {
  name: string
  count: number
  onNewBranch: () => void
  indent?: boolean
}) {
  return (
    <div className={`group flex items-center gap-1.5 py-[3px] ${indent ? 'pl-[22px]' : 'pl-3'} pr-2 text-[12px] text-ink/80`}>
      <span className="truncate">{name}</span>
      <span className="shrink-0 rounded bg-panel-2 px-1 font-mono text-[9px] text-muted">{count}</span>
      <button
        onClick={onNewBranch}
        className="ml-auto shrink-0 text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        title="New branch worktree"
      >+</button>
    </div>
  )
}

function NodeRow({
  node, active, nested, indent, onSelect, onNewBranch, sessions, runners,
}: {
  node: Node
  active: boolean
  nested?: boolean
  indent?: boolean
  onSelect: () => void
  onNewBranch?: () => void
  sessions: { nodeId: string; unread: boolean; alive: boolean }[]
  runners: { nodeId: string; running: boolean }[]
}) {
  const unread = sessions.some((s) => s.nodeId === node.id && s.unread)
  const running = runners.some((r) => r.nodeId === node.id && r.running)

  return (
    <div
      onClick={onSelect}
      title={nested ? `${node.branch ?? node.label}\n${node.cwd}` : node.cwd}
      className={[
        'group relative flex cursor-default items-center gap-1.5 py-[3px] pr-2 text-[12px]',
        // The 10px group indent is padding on the row itself, not a wrapper, so
        // the hover/active background still spans the full sidebar width.
        nested
          ? (indent ? 'pl-[38px]' : 'pl-7')
          : (indent ? 'pl-[22px]' : 'pl-3'),
        active
          ? 'bg-accent/12 text-ink'
          : 'text-ink/80 hover:bg-panel-2 hover:text-ink',
      ].join(' ')}
    >
      {active && <span className="absolute left-0 top-0 h-full w-[2px] bg-accent shadow-neon" />}
      {nested && <span className="-ml-2.5 text-neon-pink/40">└</span>}

      {/*
        Nested rows are branches, so they show the branch name — `label` would
        render the project's own name for the main worktree and make it
        indistinguishable from its heading. Detached heads fall back to `label`,
        which git.js already sets to the short SHA.
      */}
      <span className={`truncate ${nested ? 'text-neon-pink/90' : ''}`}>
        {nested ? (node.branch ?? node.label) : node.label}
      </span>

      {running && (
        <span className="size-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" title="Task running" />
      )}
      {unread && (
        <span className="size-1.5 shrink-0 rounded-full bg-accent shadow-neon" title="Unread terminal output" />
      )}

      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <StatusBadges status={node.status} compact />
        <span
          className="w-7 text-right font-mono text-[10px] text-muted group-hover:hidden"
          title={node.activityAt ? new Date(node.activityAt).toLocaleString() : 'No activity recorded'}
        >{shortAgo(node.activityAt)}</span>
        {onNewBranch ? (
          <button
            onClick={(e) => { e.stopPropagation(); onNewBranch() }}
            className="hidden w-7 text-right text-muted hover:text-accent group-hover:block"
            title="New branch worktree"
          >+</button>
        ) : (
          <span className="hidden w-7 group-hover:block" />
        )}
      </span>
    </div>
  )
}
