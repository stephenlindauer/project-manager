import { useEffect, useMemo, useRef, useState } from 'react'
import { isActiveNode, sectionOf, useStore } from '../store'
import { ago } from '../lib/time'
import type { AttentionState, ClaudeStatus, Node, Runner, ShipOrphan, ShipStatus, ShipVerdict } from '../types'
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
  const activeOnly = useStore((s) => s.activeOnly)
  const claude = useStore((s) => s.claude)
  const runners = useStore((s) => s.runners)
  const ship = useStore((s) => s.ship)
  const activeNodeId = useStore((s) => s.activeNodeId)
  return useMemo(() => {
    const sections: Section[] = []
    let current: Section | null = null
    // Active-only drops quiet worktrees, and with them any project or group
    // left empty — a heading with nothing under it is just more to scan past.
    const shown = activeOnly
      ? nodes.filter((n) => isActiveNode({ claude, runners, activeNodeId, ship }, n.id))
      : nodes
    for (const n of shown) {
      const key = sectionOf(n)
      if (!current || current.key !== key) {
        current = { key, group: n.group, projects: new Map() }
        sections.push(current)
      }
      if (!current.projects.has(n.projectId)) current.projects.set(n.projectId, [])
      current.projects.get(n.projectId)!.push(n)
    }
    return sections
  }, [nodes, activeOnly, claude, runners, ship, activeNodeId])
}

/** Width of the rail left behind when the nav is collapsed. */
const RAIL = 'w-3'

/**
 * The project nav, in two states.
 *
 * Expanded, it is an ordinary flex child. Collapsed, the flow slot shrinks to a
 * 12px rail and the panel itself becomes an absolutely-positioned overlay that
 * slides off to the left — same element, same classes, same 300px box at the
 * same origin, so a peek renders 1:1 with the docked panel.
 *
 * That overlay is the whole point: hovering the rail or navigating with ⌥↑↓
 * must not reflow the main panel. A reflow would resize the terminal pane, and
 * every resize of a tmux-backed pane forces a full repaint of whatever TUI is
 * running in it. Collapsing itself does resize once — that part is deliberate.
 */
export function Sidebar() {
  const tree = useTree()
  const activeNodeId = useStore((s) => s.activeNodeId)
  const setActiveNode = useStore((s) => s.setActiveNode)
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const setPalette = useStore((s) => s.setPalette)
  const rescan = useStore((s) => s.rescan)
  const sessions = useStore((s) => s.sessions)
  const runners = useStore((s) => s.runners)
  const claude = useStore((s) => s.claude)
  const nodes = useStore((s) => s.nodes)
  const showNode = useStore((s) => s.showNode)
  const showNodeTab = useStore((s) => s.showNodeTab)
  const ship = useStore((s) => s.ship)
  const shipMeta = useStore((s) => s.shipMeta)
  const shipStripFolded = useStore((s) => s.shipStripFolded)
  const toggleShipStrip = useStore((s) => s.toggleShipStrip)

  // Sessions asking for you that you have not looked at yet — the strip at the
  // top of the list. Blocked ones first, then whichever asked most recently.
  const needsYou = useMemo(() => Object.values(claude)
    .filter((c) => c.state !== 'working' && !c.seen)
    .sort((a, b) => (a.state === b.state ? b.at - a.at : a.state === 'waiting' ? -1 : 1)), [claude])
  // Pull requests with something on you — the second strip. Loudest verdict
  // first, then whichever moved most recently. Derived here, never in a
  // selector: a fresh array from a selector is the zustand v5 render loop.
  const shipAttention = useMemo(() => Object.values(ship)
    .filter((s) => s.attention)
    .sort((a, b) => rankShip(b.verdict) - rankShip(a.verdict) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')), [ship])
  const shipOrphans = useMemo(() => shipMeta.orphans.filter((o) => o.attention), [shipMeta.orphans])
  const collapsed = useStore((s) => s.navCollapsed)
  const peek = useStore((s) => s.navPeek)
  const toggleNav = useStore((s) => s.toggleNav)
  const collapsedProjects = useStore((s) => s.collapsedProjects)
  const toggleProject = useStore((s) => s.toggleProject)
  const pinnedNodes = useStore((s) => s.pinnedNodes)
  const togglePin = useStore((s) => s.togglePin)
  const activeOnly = useStore((s) => s.activeOnly)
  const toggleActiveOnly = useStore((s) => s.toggleActiveOnly)
  const hiddenCount = activeOnly ? nodes.length - tree.reduce((n, s) => n + [...s.projects.values()].reduce((m, l) => m + l.length, 0), 0) : 0

  // Hover is deliberately local: it must not race the store's peek timer, and
  // it should survive the mouse moving from the rail onto the overlay (the
  // overlay is a child of this wrapper, so no mouseleave fires in between).
  const [hovered, setHovered] = useState(false)
  const shown = !collapsed || hovered || peek

  return (
    <div
      className={`relative z-30 h-full shrink-0 ${collapsed ? RAIL : 'w-[300px]'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Collapsed, the rail is the only thing on screen — so it has to carry the
          signal too, or a notification for an unselected project is invisible. */}
      {collapsed && (
        <Rail onExpand={toggleNav} active={shown} attention={needsYou.length > 0} ship={shipAttention.length > 0} />
      )}

      <aside
        className={[
          'flex h-full w-[300px] flex-col border-r border-line bg-panel',
          // Only the positioning changes between states; the box does not.
          collapsed ? 'absolute left-0 top-0 z-30 transition-transform duration-150' : 'shrink-0',
          collapsed && !shown ? '-translate-x-full' : 'translate-x-0',
          collapsed && shown ? 'shadow-[6px_0_24px_rgba(0,0,0,0.55)]' : '',
        ].join(' ')}
        // Off-screen, it must not swallow clicks meant for the main panel.
        aria-hidden={collapsed && !shown}
        inert={collapsed && !shown ? true : undefined}
      >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-accent glow-text">
          Projects
        </span>
        <button
          onClick={() => setPalette(true)}
          className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          title="Jump to project (⌘K)"
        >⌘K</button>
        <button
          onClick={toggleActiveOnly}
          aria-pressed={activeOnly}
          className={`rounded border px-1.5 py-0.5 text-[10px] ${
            activeOnly ? 'border-accent text-accent' : 'border-line text-muted hover:border-accent hover:text-ink'
          }`}
          title={activeOnly
            ? `Showing active worktrees only (${hiddenCount} hidden) — click to show all`
            : 'Show only worktrees with a Claude session, a running task, a PR waiting on you, or the selection'}
        >{activeOnly ? `◉ ${hiddenCount}` : '◎'}</button>
        <button
          onClick={() => rescan()}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          title="Rescan ~/Projects"
        >↻</button>
        <button
          onClick={toggleNav}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          title={collapsed ? 'Pin sidebar open (⌘B)' : 'Collapse sidebar (⌘B)'}
        >{collapsed ? '»' : '«'}</button>
      </header>

      <nav className="flex-1 overflow-y-auto py-2">
        {needsYou.length > 0 && (
          <NeedsYou items={needsYou} nodes={nodes} onOpen={showNode} />
        )}
        {(shipAttention.length > 0 || shipOrphans.length > 0) && (
          <ShipStrip
            items={shipAttention}
            nodes={nodes}
            orphans={shipOrphans}
            folded={shipStripFolded}
            onToggle={toggleShipStrip}
            onOpen={(id) => showNodeTab(id, 'prs')}
          />
        )}
        {tree.map(({ key, group, projects }) => (
          <section key={key} className={group ? 'mb-1' : ''}>
            {group && (
              <div className="px-4 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-neon-purple/90">
                {group}
              </div>
            )}
            {[...projects.entries()].map(([projectId, projectNodes]) => {
              const main = projectNodes.find((n) => n.isMain) ?? projectNodes[0]
              const folded = Boolean(collapsedProjects[projectId])

              // Every project renders as a heading with its branches nested
              // beneath it, even when there is only one. The rows are tall
              // enough now that the saved line is not worth a second layout, and
              // a lone worktree indented like its siblings reads as what it is:
              // a branch of that project, not the project itself.
              //
              // A folded project is just the heading. It still has to carry
              // the loudest Claude badge among its rows, or folding a project
              // would be the same as muting it.
              return (
                <div key={projectId}>
                  <ProjectLabel
                    name={main.name}
                    count={projectNodes.length}
                    onNewBranch={() => setNewBranchFor(projectId)}
                    onToggle={() => toggleProject(projectId)}
                    folded={folded}
                    holdsActive={folded && projectNodes.some((n) => n.id === activeNodeId)}
                    loudest={folded ? loudestOf(projectNodes.map((n) => claude[n.id]).filter(Boolean) as ClaudeStatus[]) : null}
                    loudestShip={folded ? loudestShip(projectNodes.map((n) => ship[n.id]).filter(Boolean) as ShipStatus[]) : null}
                    runners={folded ? runners.filter((r) => r.running && projectNodes.some((n) => n.id === r.nodeId)) : []}
                    indent={!!group}
                  />
                  {!folded && projectNodes.map((n) => (
                    <NodeRow
                      key={n.id}
                      node={n}
                      indent={!!group}
                      active={n.id === activeNodeId}
                      onSelect={() => setActiveNode(n.id)}
                      pinned={Boolean(pinnedNodes[n.id])}
                      onTogglePin={() => togglePin(n.id)}
                      sessions={sessions}
                      runners={runners}
                      claude={claude[n.id] ?? null}
                      ship={ship[n.id] ?? null}
                    />
                  ))}
                </div>
              )
            })}
          </section>
        ))}
      </nav>

      <footer className="border-t border-line px-4 py-2 text-[11px] text-muted">
        <kbd className="text-accent">⌥↑↓</kbd> project · <kbd className="text-accent">⌥←→</kbd> tab
        · <kbd className="text-accent">⌘B</kbd> nav
      </footer>
      </aside>
    </div>
  )
}

/**
 * The 12px strip left in the layout when the nav is collapsed — the hover
 * target that brings the panel back, and a click target that re-pins it.
 * Without it the only way back would be the keyboard.
 */
function Rail({ onExpand, active, attention, ship }: {
  onExpand: () => void
  active: boolean
  attention: boolean
  /** A pull request is waiting on you. Quieter than `attention`: static green, no ping. */
  ship: boolean
}) {
  return (
    <button
      onClick={onExpand}
      title={attention ? 'Claude wants you — show projects (⌘B)'
        : ship ? 'Pull requests are waiting on you — show projects (⌘B)'
        : 'Show projects (⌘B)'}
      className="group h-full w-full cursor-default border-r border-line bg-panel"
    >
      <span
        className={`mx-auto block h-16 w-[2px] rounded-full transition-colors ${
          attention && !active
            ? 'bg-attn attn-ping'
            : ship && !active ? 'bg-ok shadow-[0_0_6px_var(--color-ok)]'
            : active ? 'bg-accent shadow-neon' : 'bg-line group-hover:bg-accent/60'
        }`}
      />
    </button>
  )
}

/**
 * A dev server or script from the Tasks tab is running in this worktree. Green
 * is "running" everywhere in the app; the text is the task name, or a count
 * when several are up. It used to be a 6px dot on the branch line, which was
 * accurate and invisible.
 */
function RunnerBadge({ runners }: { runners: Runner[] }) {
  const label = runners.length === 1 ? runners[0].name : `${runners.length} tasks`
  const title = runners.map((r) => `${r.name}${r.ports.length ? ` :${r.ports.join(' :')}` : ''} — ${r.command}`).join('\n')
  return (
    <span
      title={title}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border border-ok/40 px-1.5 font-mono text-[10px] leading-4 text-ok"
    >
      <span className="size-[6px] shrink-0 rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * Which of a project's Claude badges to show on its folded heading: the one
 * asking for you the loudest. Unseen blocks first, then unseen finishes, then
 * anything working; seen states last.
 */
function loudestOf(list: ClaudeStatus[]): ClaudeStatus | null {
  const rank = (c: ClaudeStatus) =>
    c.state === 'waiting' ? (c.seen ? 2 : 5) : c.state === 'done' ? (c.seen ? 1 : 4) : 3
  return list.reduce<ClaudeStatus | null>((best, c) => (!best || rank(c) > rank(best) ? c : best), null)
}

/**
 * Ship verdicts, loudest first. Mirrors VERDICTS in server/ship-verdict.js —
 * keep the two in step.
 */
const SHIP_ORDER: ShipVerdict[] = ['fix', 'address', 'rebase', 'merge', 'stacked', 'draft', 'ci', 'review']
const rankShip = (v: ShipVerdict) => SHIP_ORDER.length - SHIP_ORDER.indexOf(v)

/** Which of a project's ship pills a folded heading carries: the loudest. */
function loudestShip(list: ShipStatus[]): ShipStatus | null {
  return list.reduce<ShipStatus | null>((best, s) => (!best || rankShip(s.verdict) > rankShip(best.verdict) ? s : best), null)
}

/** The word on the pill, and the sentence in its tooltip. */
const SHIP_LABEL: Record<ShipVerdict, string> = {
  fix: 'fix CI', address: 'changes', rebase: 'rebase', merge: 'merge',
  stacked: 'stacked', draft: 'draft', ci: 'ci', review: 'review',
}
const SHIP_HEADING: Record<ShipVerdict, string> = {
  fix: 'CI is failing — fix it',
  address: 'Changes requested — address them',
  rebase: 'Behind its base or conflicting — rebase',
  merge: 'Approved and green — merge it',
  stacked: 'Ready, but the PR below it ships first',
  draft: 'Draft — nothing else is asking',
  ci: 'Checks are running',
  review: 'Waiting on reviewers',
}

/**
 * The per-row ship pill: the next thing you have to do to get this worktree's
 * pull requests merged (server/ship-verdict.js has the words). Red for
 * "something rejected it", amber for "stale against its base", green with a
 * static glow for "merge it" — the same device `ready` uses. Quiet verdicts are
 * muted. Never orange, which is Claude's colour, and never animated: motion is
 * spent on the two Claude cues and nothing else. `stale` dims it — GitHub has
 * been unreachable and this is the last good answer.
 */
export function ShipBadge({ status }: { status: ShipStatus }) {
  const { verdict, prs, stale, at } = status
  const tone = verdict === 'fix' || verdict === 'address' ? 'border-bad/50 text-bad'
    : verdict === 'rebase' ? 'border-warn/50 text-warn'
    : verdict === 'merge' ? 'border-ok/50 text-ok shadow-[0_0_7px_var(--color-ok)]'
    : 'border-line text-muted'
  const facts = (p: ShipStatus['prs'][number]) => [
    p.rollup ?? 'no checks', p.mergeStateStatus ?? 'merge state unknown', p.reviewDecision ?? 'no review', p.isDraft && 'draft',
  ].filter(Boolean).join(' · ').toLowerCase().replaceAll('_', ' ')
  const title = [
    SHIP_HEADING[verdict],
    ...prs.map((p) => `#${p.number} ${p.title}\n    ${SHIP_LABEL[p.verdict]} · ${facts(p)}`),
    stale && `GitHub unreachable — last good answer ${ago(at)}`,
  ].filter(Boolean).join('\n')

  return (
    <span
      title={title}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[10px] leading-4 ${tone}${stale ? ' opacity-60' : ''}`}
    >
      <span className="truncate">{SHIP_LABEL[verdict]}{prs.length > 1 ? ` ·${prs.length}` : ''}</span>
    </span>
  )
}

/**
 * Heading for a project whose branches are listed beneath it. Clicking it folds
 * the project to this one line and back — the click target is the heading, not
 * the main branch, so there is never an ambiguous "is this the project or its
 * main branch?" selection. The fold is remembered across reloads.
 *
 * Folded, the heading takes over three jobs from the rows it hides: the loudest
 * Claude badge among them, the loudest ship pill, and a selection bar when the
 * active node is inside.
 */
function ProjectLabel({ name, count, onNewBranch, onToggle, folded, holdsActive, loudest, loudestShip, runners, indent }: {
  name: string
  count: number
  onNewBranch: () => void
  onToggle: () => void
  folded: boolean
  holdsActive: boolean
  loudest: ClaudeStatus | null
  loudestShip: ShipStatus | null
  runners: Runner[]
  indent?: boolean
}) {
  return (
    <div
      onClick={onToggle}
      title={folded ? 'Expand project' : 'Collapse project'}
      className={[
        'group relative mt-2 flex cursor-default items-center gap-2 pt-1.5 pb-1 pr-3 text-[13px] font-medium',
        indent ? 'pl-[26px]' : 'pl-4',
        holdsActive ? 'bg-accent/12 text-ink' : 'text-ink/80 hover:text-ink',
      ].join(' ')}
    >
      {holdsActive && <span className="absolute left-0 top-0 h-full w-[2px] bg-accent shadow-neon" />}
      <span className="-ml-2.5 w-2.5 shrink-0 text-[10px] text-muted">{folded ? '▸' : '▾'}</span>
      <span className="truncate">{name}</span>
      <span className="shrink-0 rounded bg-panel-2 px-1.5 font-mono text-[10px] text-muted">{count}</span>
      {loudest && <span className="min-w-0 shrink"><ClaudeBadge status={loudest} /></span>}
      {loudestShip && <span className="min-w-0 shrink"><ShipBadge status={loudestShip} /></span>}
      {runners.length > 0 && <span className="min-w-0 shrink"><RunnerBadge runners={runners} /></span>}
      <button
        onClick={(e) => { e.stopPropagation(); onNewBranch() }}
        className="ml-auto shrink-0 text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        title="New branch worktree"
      >+</button>
    </div>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M10.5 1.5 14.5 5.5 12 6.5 9.5 9 9.5 12.5 3.5 6.5 7 6.5 9.5 4Z" />
      <path d="M6.5 9.5 2 14" strokeLinecap="round" />
    </svg>
  )
}

/** Wording for the badge tooltip and the toast's heading. */
export const ATTENTION_LABEL: Record<AttentionState, string> = {
  waiting: 'Claude is waiting on you',
  done: 'Claude finished',
}

/**
 * The per-row Claude badge. One pill, three states:
 *
 *   working   grey, a small spinner, and the current *phase* as the text —
 *             "editing", "testing", "watching CI", a skill name. The spinner
 *             is the "working" cue, so the word itself is not spent on it.
 *   waiting   orange "needs input". Pings until you look at the pane, then
 *             holds as a plain orange label: still blocked, no longer news.
 *   done      orange "ready" with a glow until seen, then a muted "idle".
 *
 * Motion stays scarce on purpose: only an unseen `waiting` pings, and the
 * spinner is the one other thing that moves. The tooltip carries the task you
 * asked for and the last command, file or message — the detail the badge is
 * too small to hold.
 */
export function ClaudeBadge({ status }: { status: ClaudeStatus }) {
  const { state, phase, detail, task, seen, since } = status
  const label = state === 'working' ? (phase ?? 'working')
    : state === 'waiting' ? 'needs input'
    : seen ? 'idle' : 'ready'
  const heading = state === 'working' ? `Claude is working — ${phase ?? 'working'}`
    : state === 'waiting' ? 'Claude needs your input'
    : seen ? 'Claude is idle' : 'Claude finished — ready for you'
  const title = [`${heading} · ${ago(since)}`, task && `Asked: ${task}`, detail].filter(Boolean).join('\n')
  const tone = state === 'working' ? 'border-line-bright bg-panel-2 text-ink/75'
    : state === 'waiting'
      ? (seen ? 'border-attn/40 text-attn/80' : 'border-attn/70 bg-attn/15 text-attn attn-ping')
      : (seen ? 'border-line text-muted' : 'border-attn/50 text-attn shadow-[0_0_7px_var(--color-attn)]')

  return (
    <span
      title={title}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[10px] leading-4 ${tone}`}
    >
      {state === 'working' && (
        <span className="size-[8px] shrink-0 rounded-full border-[1.5px] border-ink/25 border-t-ink/80 motion-safe:animate-spin" />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * The sessions asking for you, pinned above the project tree. The tree itself
 * keeps its recency order — a row that jumps to the top the moment Claude
 * finishes would move out from under ⌥↑↓ and the mouse — so this strip is how
 * "which worktrees need me" gets answered without reordering anything. A row
 * disappears once you open that Claude pane.
 */
function NeedsYou({ items, nodes, onOpen }: {
  items: ClaudeStatus[]
  nodes: Node[]
  onOpen: (id: string) => void
}) {
  return (
    <section className="mx-2 mb-2 rounded border border-attn/30 bg-attn/[0.06]">
      <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-attn">
        Needs you
        <span className="rounded bg-attn/20 px-1.5 font-mono text-[10px] font-normal tracking-normal">{items.length}</span>
      </div>
      {items.map((c) => {
        const n = nodes.find((x) => x.id === c.nodeId)
        if (!n) return null
        return (
          <button
            key={c.nodeId}
            onClick={() => onOpen(c.nodeId)}
            title={`${n.name} · ${n.branch ?? n.label}\n${n.cwd}`}
            className="flex w-full cursor-default items-center gap-2 px-2.5 py-1 text-left text-[12px] leading-[16px] text-ink/85 hover:bg-attn/10 hover:text-ink"
          >
            <span className="shrink-0 truncate max-w-[40%]">{n.name}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-neon-pink/90">{n.branch ?? n.label}</span>
            <span className="ml-auto shrink-0"><ClaudeBadge status={c} /></span>
          </button>
        )
      })}
    </section>
  )
}

/**
 * Pull requests with something on you, pinned under Needs-you. Same job —
 * answer "which worktrees need me" without re-sorting the tree — but unlike a
 * Claude signal these do not clear when looked at: a red CI stays red until it
 * is fixed. So the strip folds to its heading, and remembers that. A row opens
 * the worktree's PRs tab. PRs of yours that no worktree has checked out are
 * counted in the footer, with the list in its tooltip.
 */
function ShipStrip({ items, nodes, orphans, folded, onToggle, onOpen }: {
  items: ShipStatus[]
  nodes: Node[]
  orphans: ShipOrphan[]
  folded: boolean
  onToggle: () => void
  onOpen: (id: string) => void
}) {
  return (
    <section className="mx-2 mb-2 rounded border border-ok/30 bg-ok/[0.06]">
      <button
        onClick={onToggle}
        aria-expanded={!folded}
        title={folded ? 'Show pull requests waiting on you' : 'Fold'}
        className="flex w-full cursor-default items-center gap-2 px-2.5 pt-1.5 pb-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-ok"
      >
        <span className="w-2.5 shrink-0 text-muted">{folded ? '▸' : '▾'}</span>
        Ship
        <span className="rounded bg-ok/20 px-1.5 font-mono text-[10px] font-normal tracking-normal">{items.length + orphans.length}</span>
      </button>
      {!folded && items.map((s) => {
        const n = nodes.find((x) => x.id === s.nodeId)
        if (!n) return null
        return (
          <button
            key={s.nodeId}
            onClick={() => onOpen(s.nodeId)}
            title={`${n.name} · ${n.branch ?? n.label}\n${n.cwd}`}
            className="flex w-full cursor-default items-center gap-2 px-2.5 py-1 text-left text-[12px] leading-[16px] text-ink/85 hover:bg-ok/10 hover:text-ink"
          >
            <span className="shrink-0 truncate max-w-[40%]">{n.name}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-neon-pink/90">{n.branch ?? n.label}</span>
            <span className="ml-auto shrink-0"><ShipBadge status={s} /></span>
          </button>
        )
      })}
      {!folded && orphans.length > 0 && (
        <div
          className="px-2.5 pt-0.5 pb-1.5 font-mono text-[10px] text-muted"
          title={orphans.map((o) => `${o.repo}#${o.number} · ${SHIP_LABEL[o.verdict]} · ${o.head ?? '?'}\n    ${o.title}`).join('\n')}
        >
          +{orphans.length} PR{orphans.length === 1 ? '' : 's'} with no worktree
        </div>
      )}
    </section>
  )
}

function NodeRow({
  node, active, indent, onSelect, pinned, onTogglePin, sessions, runners, claude, ship,
}: {
  node: Node
  active: boolean
  indent?: boolean
  onSelect: () => void
  pinned: boolean
  onTogglePin: () => void
  sessions: { nodeId: string; unread: boolean; alive: boolean }[]
  runners: Runner[]
  claude: ClaudeStatus | null
  ship: ShipStatus | null
}) {
  const unread = sessions.some((s) => s.nodeId === node.id && s.unread)
  const running = runners.filter((r) => r.nodeId === node.id && r.running)

  // ⌥↑↓ can walk the selection past the edge of the scroll area. That is merely
  // annoying when the nav is docked, but breaks the collapsed case outright: the
  // peek would slide open showing no highlight at all. `nearest` keeps it a
  // minimal nudge instead of recentring the list on every keystroke.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div
      ref={ref}
      onClick={onSelect}
      title={`${node.branch ?? node.label}\n${node.cwd}`}
      className={[
        'group relative flex cursor-default flex-col gap-[3px] py-2 pr-3',
        // The 10px group indent is padding on the row itself, not a wrapper, so
        // the hover/active background still spans the full sidebar width.
        indent ? 'pl-[42px]' : 'pl-8',
        active
          ? 'bg-accent/12 text-ink'
          : 'text-ink/80 hover:bg-panel-2 hover:text-ink',
      ].join(' ')}
    >
      {active && <span className="absolute left-0 top-0 h-full w-[2px] bg-accent shadow-neon" />}

      {/*
        Line one is the branch alone — `label` would render the project's own
        name for the main worktree and make it indistinguishable from its
        heading. Detached heads fall back to `label`, which git.js already sets
        to the short SHA. One line, truncated; the tooltip carries the full
        branch and path.
      */}
      <div className="flex items-center gap-2 text-[13px] leading-[18px]">
        <span className="-ml-2.5 shrink-0 text-neon-pink/40">└</span>
        <span className="min-w-0 truncate text-neon-pink/90">
          {node.branch ?? node.label}
        </span>

        {/*
          State dots, then the pin. Claude's own state moved down a line into
          the badge. The pin shows on hover; a pinned row keeps it visible, so
          the reason the row sits at the top of its project is on screen.
        */}
        <span className="ml-auto flex h-[18px] shrink-0 items-center gap-1.5">
          {unread && (
            <span className="size-1.5 rounded-full bg-accent shadow-neon" title="Unread terminal output" />
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin() }}
            className={[
              'transition-opacity hover:text-accent',
              pinned ? 'text-ink/70' : 'text-muted opacity-0 group-hover:opacity-100',
            ].join(' ')}
            title={pinned ? 'Unpin worktree' : 'Pin to top of project'}
            aria-pressed={pinned}
          ><PinIcon filled={pinned} /></button>
        </span>
      </div>

      {/*
        Below the name: on the left, what this worktree's Claude session is up
        to (see ClaudeBadge) and what its pull requests need from you (see
        ShipBadge); on the right, the git counters and how recently it moved.
        This line never wraps; the badges truncate before the counters do.
      */}
      <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px] leading-4 text-muted">
        {claude && <ClaudeBadge status={claude} />}
        {ship && <ShipBadge status={ship} />}
        {running.length > 0 && <RunnerBadge runners={running} />}
        <span className="ml-auto flex shrink-0 items-center gap-2">
        <StatusBadges status={node.status} compact />
        <span
          title={node.activityAt ? new Date(node.activityAt).toLocaleString() : 'No activity recorded'}
        >{ago(node.activityAt)}</span>
        </span>
      </div>
    </div>
  )
}
