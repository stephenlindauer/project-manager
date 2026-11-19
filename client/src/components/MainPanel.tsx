import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../api'
import { usePhone } from '../lib/media'
import { TABS, useStore } from '../store'
import type { Agent, Node, SessionKind, TabId } from '../types'
import { ChangesTab } from './ChangesTab'
import { PrsTab } from './PrsTab'
import { SummaryTab } from './SummaryTab'
import { TasksTab } from './TasksTab'
import { Terminal } from './Terminal'

const AGENTS: { id: Agent; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
]

export function MainPanel({ node }: { node: Node }) {
  const activeTab = useStore((s) => s.activeTab)
  const setTab = useStore((s) => s.setTab)
  const sessions = useStore((s) => s.sessions)
  const claude = useStore((s) => s.claude)
  const ship = useStore((s) => s.ship)
  // The "Claude" tab hosts one agent CLI at a time, chosen per node. Each agent
  // is its own tmux session, so toggling never disturbs the other one's context;
  // the panes stay mounted once used so a toggle is a reveal, not a reconnect.
  const agent: Agent = useStore((s) => s.agentByNode[node.id]) ?? 'claude'
  const setAgent = useStore((s) => s.setAgent)
  const [usedAgents, setUsedAgents] = useState<Set<Agent>>(() => new Set([agent]))
  const pickAgent = (a: Agent) => { setUsedAgents((p) => new Set(p).add(a)); setAgent(node.id, a) }

  /** The tmux session kind behind the current tab, if any. */
  const SESSION_KIND: Partial<Record<TabId, SessionKind>> = { claude: agent, terminal: 'shell' }
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const rescan = useStore((s) => s.rescan)
  const night = useStore((s) => s.night)
  const toggleNight = useStore((s) => s.toggleNight)
  // On a phone this panel is a screen of its own, hidden while the nav shows.
  // Its terminals must hear that as hidden, or a pane nobody can see reports
  // itself watched and swallows the notifications meant for you.
  const phone = usePhone()
  const offscreen = useStore((s) => phone && s.phonePane === 'nav')
  const setPhonePane = useStore((s) => s.setPhonePane)
  const [menuOpen, setMenuOpen] = useState(false)
  // The phone tab row scrolls sideways; keep the selected tab in it, including
  // one chosen from elsewhere (a toast, the Ship strip opening PRs).
  const tabRow = useRef<HTMLElement>(null)
  useEffect(() => {
    tabRow.current?.querySelector('[data-active]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTab, phone])

  // Bumping a kind's epoch changes the Terminal's key, forcing a full remount:
  // the old socket is torn down and a fresh one connects. MainPanel is keyed by
  // node.id in App, so this state resets when the project changes.
  const [epoch, setEpoch] = useState<Record<SessionKind, number>>({ claude: 0, codex: 0, shell: 0 })
  const bump = (kind: SessionKind) => setEpoch((p) => ({ ...p, [kind]: p[kind] + 1 }))

  const sessionKind = SESSION_KIND[activeTab]

  /** Drop and re-establish the socket without touching the tmux session. Fixes a
   *  dead/half-open connection (e.g. after the laptop sleeps) while keeping the
   *  session — and anything running in it — alive. */
  const reconnect = (kind: SessionKind) => bump(kind)

  /** Destroy the tmux session, then remount to spawn a fresh one. */
  const killSession = async (kind: SessionKind) => {
    const label = kind === 'shell' ? 'terminal' : AGENTS.find((a) => a.id === kind)?.label ?? kind
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

  /** Two-step: a plain remove, then — if git refuses because the tree is
   *  dirty — a second confirm that spells out what `--force` would discard. */
  const removeWorktree = async () => {
    if (!confirm(`Remove worktree ${node.cwd}?\n\nThe branch itself is kept.`)) return
    const fail = (e: unknown) => alert(e instanceof Error ? e.message : String(e))
    try {
      await api.removeWorktree(node.id)
    } catch (e) {
      if (!(e instanceof ApiError) || e.detail.needsForce !== true) return fail(e)
      const files = Array.isArray(e.detail.files) ? (e.detail.files as string[]) : []
      const shown = files.slice(0, 15).map((f) => `  ${f}`)
      if (files.length > shown.length) shown.push(`  …and ${files.length - shown.length} more`)
      if (!confirm(
        `${e.message}.\n\nForce-remove anyway? Uncommitted work in the worktree is lost` +
        ` (the branch and its commits are kept).` +
        (shown.length ? `\n\n${shown.join('\n')}` : ''),
      )) return
      try {
        await api.removeWorktree(node.id, true)
      } catch (e2) {
        return fail(e2)
      }
    }
    await rescan()
  }

  const tabs = TABS.map((t) => {
    const unread = sessions.some(
      (s) => s.nodeId === node.id && s.unread &&
        ((t.id === 'claude' && s.kind === agent) || (t.id === 'terminal' && s.kind === 'shell')),
    )
    // Attention outranks unread on the Claude tab: "it wants you" is
    // strictly more urgent than "it printed something".
    const st = claude[node.id]
    const wants = t.id === 'claude' && Boolean(st && st.state !== 'working' && !st.seen)
    // The PRs tab gets a static green dot while a pull request waits on you.
    const ships = t.id === 'prs' && Boolean(ship[node.id]?.attention)
    return (
      <button
        key={t.id}
        data-active={activeTab === t.id || undefined}
        onClick={() => setTab(t.id)}
        title={t.hint}
        className={`relative shrink-0 border-b-2 px-3 py-2 text-[12px] transition-colors max-md:py-2.5 max-md:text-[13px] ${
          activeTab === t.id
            ? 'border-accent text-ink shadow-[inset_0_-8px_14px_-10px_var(--color-accent)]'
            : 'border-transparent text-muted hover:text-ink'
        }`}
      >
        {t.id === 'claude' ? AGENTS.find((a) => a.id === agent)?.label : t.label}
        {wants ? (
          <span className="ml-1.5 inline-block size-[7px] rounded-full bg-attn align-middle attn-ping" />
        ) : unread ? (
          <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle shadow-neon" />
        ) : ships && (
          <span className="ml-1.5 inline-block size-1.5 rounded-full bg-ok align-middle shadow-[0_0_6px_var(--color-ok)]" />
        )}
      </button>
    )
  })

  const agentToggle = activeTab === 'claude' && (
    <div className="flex shrink-0 overflow-hidden rounded border border-line" role="radiogroup" aria-label="Agent">
      {AGENTS.map((a) => (
        <button
          key={a.id}
          role="radio"
          aria-checked={agent === a.id}
          onClick={() => pickAgent(a.id)}
          className={`px-2 py-0.5 max-md:py-1.5 ${agent === a.id ? 'bg-accent/15 text-ink' : 'hover:text-ink'}`}
          title={`Show the ${a.label} session for this worktree`}
        >{a.label}</button>
      ))}
    </div>
  )

  /** Everything but the agent toggle; a row on desktop, the ⋯ menu on a phone. */
  const actions = (
    <>
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
          <span className="text-line max-md:hidden">|</span>
        </>
      )}
      {node.branch && <span className="font-mono text-neon-pink glow-text max-md:hidden">⑂ {node.branch}</span>}
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
      >{night ? '☾' : '☀'}{phone && (night ? ' night mode on' : ' night mode')}</button>
    </>
  )

  return (
    <main className={`flex min-w-0 flex-1 flex-col ${offscreen ? 'hidden' : ''}`}>
      {phone ? (
        <header className="relative border-b border-line bg-panel">
          <div className="flex items-center gap-2 px-2 pt-1.5 text-[12px] text-muted">
            <button
              onClick={() => { setMenuOpen(false); setPhonePane('nav') }}
              className="-ml-1 shrink-0 px-2 py-1.5 text-[20px] leading-none text-accent"
              aria-label="Back to projects"
            >‹</button>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[14px] font-medium text-ink">{node.name}</div>
              {node.branch && <div className="truncate font-mono text-[11px] text-neon-pink">⑂ {node.branch}</div>}
            </div>
            {agentToggle}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-label="Actions"
              className={`shrink-0 rounded border px-2.5 py-1 text-[15px] leading-none ${menuOpen ? 'border-accent text-accent' : 'border-line'}`}
            >⋯</button>
          </div>
          <nav ref={tabRow} className="no-scrollbar flex overflow-x-auto px-1">{tabs}</nav>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div
                className="absolute right-2 top-full z-50 mt-1 flex min-w-[200px] flex-col gap-1.5 rounded-lg border border-line bg-panel-2 p-2 text-[13px] text-muted shadow-2xl [&>button]:px-3 [&>button]:py-2 [&>button]:text-left"
                onClick={() => setMenuOpen(false)}
              >{actions}</div>
            </>
          )}
        </header>
      ) : (
        <header className="flex items-center gap-1 border-b border-line bg-panel px-2">
          {tabs}
          <div className="ml-auto flex items-center gap-2 pr-1 text-[11px] text-muted">
            {agentToggle}
            {actions}
          </div>
        </header>
      )}

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
        {AGENTS.filter((a) => usedAgents.has(a.id)).map((a) => {
          const shown = activeTab === 'claude' && agent === a.id && !offscreen
          return (
            <div key={a.id} className="h-full" style={{ display: shown ? 'block' : 'none' }}>
              <Terminal
                key={`${node.id}:${a.id}:${epoch[a.id]}`}
                nodeId={node.id}
                kind={a.id}
                hidden={!shown}
                takesPrompts={agent === a.id}
              />
            </div>
          )
        })}
        <div className="h-full" style={{ display: activeTab === 'terminal' ? 'block' : 'none' }}>
          <Terminal key={`${node.id}:shell:${epoch.shell}`} nodeId={node.id} kind="shell" hidden={activeTab !== 'terminal' || offscreen} />
        </div>
      </div>
    </main>
  )
}
