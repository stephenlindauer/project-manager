import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import type { OrchRun } from '../../types'
import { CardView } from './CardView'
import { NewRun } from './NewRun'
import { Button, Pill, StageRail, ago, fmtSpend, isFinal, standing } from './parts'
import { Rules } from './Rules'
import { RunDetail } from './RunDetail'

/**
 * Orchestrator mode: every run in flight and everything waiting on me.
 *
 * It is an overlay over Projects mode, not a replacement for it — the project
 * tree and its terminals stay mounted underneath (and are told they are
 * hidden), so switching modes never reconnects or resizes a tmux pane.
 *
 * The inbox is the phone screen: each card is one decision, short enough to
 * act on there.
 */
export function Orchestrator() {
  const orch = useStore((s) => s.orch)
  const view = useStore((s) => s.orchView)
  const setView = useStore((s) => s.setOrchView)
  const runId = useStore((s) => s.orchRunId)
  const openRun = useStore((s) => s.openRun)
  const setMode = useStore((s) => s.setMode)
  const [starting, setStarting] = useState(false)

  const runs = orch?.runs ?? []
  const inbox = orch?.inbox ?? []
  const blocking = inbox.filter((c) => c.blocking).length
  const limits = orch?.limits

  const tab = (id: typeof view, label: string, count?: number) => (
    <button
      onClick={() => setView(id)}
      data-active={view === id && !runId ? '' : undefined}
      className={`shrink-0 border-b-2 px-3 py-2.5 text-[12px] transition-colors ${
        view === id && !runId ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
      }`}
    >
      {label}
      {count ? <span className={`ml-1.5 font-mono text-[10px] ${id === 'inbox' && blocking ? 'text-attn' : 'text-muted'}`}>{count}</span> : null}
    </button>
  )

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-panel pl-2 pr-3">
        <button
          onClick={() => setMode('projects')}
          title="Back to Projects"
          className="shrink-0 px-2 py-2.5 text-[12px] text-muted hover:text-accent"
        >‹ Projects</button>
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        <nav className="flex min-w-0 flex-1 overflow-x-auto">
          {tab('board', 'Board', runs.filter((r) => !isFinal(r)).length)}
          {tab('inbox', 'Inbox', inbox.length)}
          {tab('rules', 'Rules')}
        </nav>
        {limits && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted max-md:hidden"
            title="Orchestrator sessions working now, of the limit"
          >
            {limits.running}/{limits.max.activeSessions ?? '∞'} sessions
          </span>
        )}
        <Button tone="primary" onClick={() => setStarting(true)}>+ Run</Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {runId ? (
          <RunDetail key={runId} id={runId} onBack={() => openRun(null)} />
        ) : view === 'board' ? (
          <Board runs={runs} onStart={() => setStarting(true)} />
        ) : view === 'inbox' ? (
          <div className="mx-auto flex max-w-[760px] flex-col gap-3 p-3 md:p-5">
            {!inbox.length && <Empty>Nothing is waiting on you.</Empty>}
            {inbox.map((c) => <CardView key={c.id} card={c} run={runs.find((r) => r.id === c.runId) ?? null} />)}
          </div>
        ) : (
          <Rules />
        )}
      </main>

      {starting && <NewRun onClose={() => setStarting(false)} />}
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded border border-dashed border-line px-4 py-10 text-center text-[12px] text-muted">{children}</div>
)

/**
 * Runs grouped by what they need, not by stage: pipelines differ per run, so
 * stage columns would not line up. "Needs you" is first because it is the
 * only group that is waiting on a person.
 */
function Board({ runs, onStart }: { runs: OrchRun[]; onStart: () => void }) {
  const groups = useMemo(() => {
    const g = { needs: [] as OrchRun[], working: [] as OrchRun[], waiting: [] as OrchRun[], finished: [] as OrchRun[] }
    for (const r of runs) {
      if (isFinal(r)) g.finished.push(r)
      else if (r.state === 'waiting' || r.blocking) g.needs.push(r)
      else if (r.working) g.working.push(r)
      else g.waiting.push(r)
    }
    return g
  }, [runs])

  if (!runs.length) {
    return (
      <div className="mx-auto max-w-[760px] p-3 md:p-5">
        <Empty>
          No runs yet.
          <div className="mt-3"><Button tone="primary" onClick={onStart}>Start a run</Button></div>
        </Empty>
      </div>
    )
  }

  const section = (title: string, list: OrchRun[], tone = 'text-muted') => list.length > 0 && (
    <section>
      <h2 className={`mb-2 text-[11px] uppercase tracking-wider ${tone}`}>{title} <span className="font-mono text-muted/70">{list.length}</span></h2>
      <div className="flex flex-col gap-2">{list.map((r) => <RunCard key={r.id} run={r} />)}</div>
    </section>
  )

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 p-3 md:p-5">
      {section('Needs you', groups.needs, 'text-attn')}
      {section('Working', groups.working)}
      {section('Waiting', groups.waiting)}
      {section('Finished', groups.finished.slice(0, 15))}
    </div>
  )
}

function RunCard({ run }: { run: OrchRun }) {
  const openRun = useStore((s) => s.openRun)
  const st = standing(run)
  return (
    <button
      onClick={() => openRun(run.id)}
      className={`w-full rounded border bg-panel px-3 py-2.5 text-left transition-colors hover:border-accent ${
        st.tone === 'attn' ? 'border-attn/50' : 'border-line'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{run.task.title}</span>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
        <span>{run.repoName}</span>
        {run.worktree?.branch && <span className="truncate font-mono text-[10px] text-neon-pink/90">⑂ {run.worktree.branch}</span>}
        {run.pr?.number && <span className="font-mono text-[10px]">#{run.pr.number}</span>}
        <span className="font-mono text-[10px] text-muted/70">{run.pipeline}</span>
      </div>
      <div className="mt-2"><StageRail run={run} /></div>
      {(run.note || run.attempts > 0) && !isFinal(run) && (
        <div className="mt-1.5 truncate font-mono text-[10px] text-muted">
          {run.note}{run.note && run.attempts > 0 ? ' · ' : ''}{run.attempts > 0 ? `${run.attempts} retr${run.attempts === 1 ? 'y' : 'ies'}` : ''}
        </div>
      )}
      <div className="mt-1.5 flex gap-3 font-mono text-[10px] text-muted/70">
        <span>{fmtSpend(run.spend)}</span>
        <span>{ago(run.createdAt)} old</span>
      </div>
    </button>
  )
}
