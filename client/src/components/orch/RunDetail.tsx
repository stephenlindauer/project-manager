import { useEffect, useRef, useState } from 'react'
import { orchApi } from '../../api'
import { useStore } from '../../store'
import type { OrchEvent, OrchRunDetail, OrchSession, OrchTranscriptItem } from '../../types'
import { CardView } from './CardView'
import { Button, Pill, StageRail, ago, fmtSpend, fmtTokens, isFinal, standing } from './parts'

/**
 * One run: where it is, what it decided, what it is doing right now.
 *
 * The record is refetched whenever the run's summary changes on the event
 * stream, so the page follows the run without polling on a timer.
 */
export function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const live = useStore((s) => s.orch?.runs.find((r) => r.id === id) ?? null)
  const showNode = useStore((s) => s.setActiveNode)
  const setMode = useStore((s) => s.setMode)
  const [run, setRun] = useState<OrchRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<number | null>(null)
  const stamp = live?.updatedAt ?? 0

  useEffect(() => {
    let gone = false
    orchApi.run(id).then((r) => { if (!gone) setRun(r) }).catch((e) => { if (!gone) setError(e.message) })
    return () => { gone = true }
  }, [id, stamp])

  if (error) return <div className="p-5 text-[12px] text-bad">{error}</div>
  if (!run) return <div className="p-5 text-[12px] text-muted">Loading…</div>

  const st = standing(run)
  const open = run.inbox.filter((c) => !c.answer)
  const decisions = run.events.filter((e) => e.type === 'decision')
  const running = run.sessions.find((s) => s.status === 'running')
  const shown = session ?? running?.n ?? run.sessions.at(-1)?.n ?? null
  const continueByHand = useStore((s) => s.continueByHand)
  const control = (action: 'pause' | 'resume' | 'abandon') => {
    if (action === 'abandon' && !confirm('Abandon this run?\n\nIts sessions stop. The worktree and branch are left as they are.')) return
    orchApi.control(run.id, action).catch((e) => alert(e.message))
  }
  const takeOver = () => {
    if (!confirm('Take over this run?\n\nIts sessions stop and the Claude tab opens on the same conversation. The orchestrator does nothing in that worktree until you hand it back.')) return
    orchApi.control(run.id, 'takeover').then((r) => continueByHand(r.resume)).catch((e) => alert(e.message))
  }
  const handBack = () => {
    const note = prompt('Hand back to the orchestrator?\n\nThis closes the Claude tab\'s session in that worktree, then re-checks the tree as it stands: verify, review, gates.\n\nOptional note for the run:', '')
    if (note === null) return
    orchApi.control(run.id, 'handback', note.trim() || undefined).catch((e) => alert(e.message))
  }
  const release = () => {
    if (!confirm('Release this run?\n\nThe run ends and the worktree becomes an ordinary project.')) return
    orchApi.control(run.id, 'release').catch((e) => alert(e.message))
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4 p-3 md:p-5">
      <div>
        <button onClick={onBack} className="text-[12px] text-muted hover:text-accent">‹ Board</button>
        <div className="mt-2 flex items-start gap-2">
          <h1 className="min-w-0 flex-1 text-[15px] leading-snug text-ink">{run.task.title}</h1>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <span>{run.repoName}</span>
          {run.worktree?.branch && <span className="font-mono text-[10px] text-neon-pink/90">⑂ {run.worktree.branch}</span>}
          {run.task.url && <a href={run.task.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">task ↗</a>}
          {run.pr && <a href={run.pr.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">PR{run.pr.number ? ` #${run.pr.number}` : ''} ↗</a>}
          {run.nodeId && (
            <button onClick={() => { showNode(run.nodeId!); setMode('projects') }} className="text-accent hover:underline">worktree →</button>
          )}
          <span className="font-mono text-[10px]">{fmtSpend(run.spend)}</span>
          <span className="font-mono text-[10px]">{run.pipeline}</span>
        </div>
        {run.task.untrusted > 0 && (
          <div className="mt-1 text-[11px] text-warn">{run.task.untrusted} piece{run.task.untrusted === 1 ? '' : 's'} from outside authors not included in the brief.</div>
        )}
      </div>

      <div className="rounded border border-line bg-panel px-3 py-2.5">
        <StageRail run={run} labels />
        {run.note && !isFinal(run) && <div className="mt-2 truncate font-mono text-[11px] text-muted">{run.note}</div>}
        {Object.entries(run.attemptsByStage).filter(([, n]) => n > 0).length > 0 && (
          <div className="mt-1.5 font-mono text-[10px] text-warn">
            {Object.entries(run.attemptsByStage).filter(([, n]) => n > 0).map(([s, n]) => `${s}: ${n} failed`).join(' · ')}
          </div>
        )}
      </div>

      {!isFinal(run) && (
        <div className="flex flex-wrap gap-2">
          {run.state === 'held' ? (
            <>
              <Button tone="primary" onClick={handBack} title="Re-check the worktree as it stands and carry on">Hand back</Button>
              <Button onClick={release} title="End the run; keep the worktree as an ordinary project">Release</Button>
            </>
          ) : (
            <>
              {run.state === 'paused'
                ? <Button tone="primary" onClick={() => control('resume')}>Resume</Button>
                : <Button onClick={() => control('pause')} title="Stop its sessions; resume picks the conversation back up">Pause</Button>}
              {run.worktree && <Button onClick={takeOver} title="Continue this run by hand in its Claude tab">Take over</Button>}
            </>
          )}
          <Button tone="danger" onClick={() => control('abandon')}>Abandon</Button>
        </div>
      )}

      {open.map((c) => <CardView key={c.id} card={c} run={run} showRun={false} />)}

      {run.summary && <Section title="Summary"><p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{run.summary}</p></Section>}

      {run.sessions.length > 0 && (
        <Section title="Sessions">
          <div className="flex flex-wrap gap-1.5">
            {run.sessions.map((s) => (
              <button
                key={s.n} onClick={() => setSession(s.n)}
                className={`rounded border px-2 py-1 text-left font-mono text-[10px] ${shown === s.n ? 'border-accent text-ink' : 'border-line text-muted hover:text-ink'}`}
              >
                <span className={SESSION_TONE[s.status]}>●</span> {s.n} {s.role} · {s.stageId}
                {s.tokens ? ` · ${fmtTokens(s.tokens)}` : ''}
              </button>
            ))}
          </div>
          {shown != null && <Transcript key={`${run.id}:${shown}`} runId={run.id} session={run.sessions.find((s) => s.n === shown)!} />}
        </Section>
      )}

      {decisions.length > 0 && (
        <Section title={`Decisions made without you (${decisions.length})`}>
          <ul className="flex flex-col gap-1.5">
            {decisions.map((d, i) => (
              <li key={i} className="text-[12px] leading-snug">
                <span className="text-muted">{String(d.what ?? '')}</span>
                <span className="text-ink"> → {String(d.chose ?? '')}</span>
                {d.why ? <span className="text-muted/70"> ({String(d.why)})</span> : null}
                <span className="ml-1.5 font-mono text-[10px] text-muted/60">{String(d.by ?? '')} · {d.stage}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {run.refused.length > 0 && (
        <Section title={`Refused calls it got past (${run.refused.length})`} fold>
          <ul className="flex flex-col gap-2">
            {run.refused.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-muted">{r.rule}</code>
                <span className="shrink-0 font-mono text-[10px] text-muted/60">{r.set} · {r.stageId}</span>
                {r.allowed
                  ? <span className="shrink-0 font-mono text-[10px] text-ok">allowed</span>
                  : <Button onClick={() => orchApi.allowRefused(run.id, i).catch((e) => alert(e.message))} title={`Add this exact call to the "${r.set}" permission set`}>Allow always</Button>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {run.records.map((r) => (
        <Section key={r.name} title={`Record: ${r.name}`} fold>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">{r.content}</pre>
        </Section>
      ))}

      <Section title="History" fold>
        <ol className="flex flex-col gap-1">
          {run.events.filter((e) => HISTORY.has(e.type)).map((e, i) => (
            <li key={i} className="flex gap-2 font-mono text-[10px] leading-snug">
              <span className="w-8 shrink-0 text-right text-muted/60">{ago(e.at)}</span>
              <span className={`w-24 shrink-0 ${e.type.includes('fail') || e.type === 'paused' ? 'text-warn' : 'text-muted'}`}>{e.type}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted">{describe(e)}</span>
            </li>
          ))}
        </ol>
      </Section>

      {run.brief && (
        <Section title="Brief" fold>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">{run.brief}</pre>
        </Section>
      )}
    </div>
  )
}

const SESSION_TONE: Record<OrchSession['status'], string> = {
  running: 'text-accent', finished: 'text-ok', failed: 'text-bad', vanished: 'text-warn', stopped: 'text-muted',
}

const HISTORY = new Set([
  'created', 'stage-done', 'stage-failed', 'jump', 'paused', 'pause', 'resume', 'card', 'answer', 'session-start',
  'session-end', 'session-lost', 'job-start', 'job-end', 'job-lost', 'intent', 'result', 'worktree', 'done', 'abandoned', 'error',
])

function describe(e: OrchEvent): string {
  const stage = e.stage ? `${e.stage}` : ''
  switch (e.type) {
    case 'stage-failed': return `${stage}: ${((e.reasons as string[]) ?? []).join(' / ').slice(0, 400)}`
    case 'stage-done': return `${stage}${e.note ? ` — ${e.note}` : ''}`
    case 'jump': return `back to ${e.to}`
    case 'card': return `${(e.card as { type: string; title: string })?.type}: ${(e.card as { title: string })?.title}`
    case 'answer': return `${e.choice}${e.note ? ` — ${e.note}` : ''}`
    case 'session-start': return `${stage} #${e.n} ${e.role}${e.resumed ? ' (resumed)' : ''}`
    case 'session-end': return `${stage} #${e.n} ${e.status ?? ''} ${String(e.summary ?? '').slice(0, 200)}`
    case 'session-lost': return `${stage} #${e.n} ${e.status}`
    case 'job-start': return `${stage}: ${e.cmd}`
    case 'job-end': return `${stage}: ${e.cmd} → exit ${e.code}`
    case 'intent': return `${e.effect}: ${e.describe ?? e.key}`
    case 'result': return `${e.effect} done${e.recovered ? ' (found after a restart)' : ''}`
    case 'worktree': return `${e.dir}`
    case 'paused': return String(e.reason ?? '').slice(0, 300)
    case 'error': return String(e.message ?? '')
    default: return stage
  }
}

function Section({ title, children, fold = false }: { title: string; children: React.ReactNode; fold?: boolean }) {
  if (fold) {
    return (
      <details className="rounded border border-line bg-panel">
        <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-muted">{title}</summary>
        <div className="border-t border-line px-3 py-2.5">{children}</div>
      </details>
    )
  }
  return (
    <section className="rounded border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">{title}</h2>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

/**
 * A session's transcript: a tail of the file its process writes. While the
 * session runs this polls by byte offset, so each request carries only what
 * is new.
 */
function Transcript({ runId, session }: { runId: string; session: OrchSession }) {
  const [items, setItems] = useState<OrchTranscriptItem[]>([])
  const [prompt, setPrompt] = useState<string | null>(null)
  const offset = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const running = session.status === 'running'

  useEffect(() => {
    let gone = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const pull = async () => {
      try {
        const r = await orchApi.transcript(runId, session.n, offset.current)
        if (gone) return
        if (r.prompt) setPrompt(r.prompt)
        offset.current = r.offset
        if (r.items.length) {
          const near = box.current ? box.current.scrollHeight - box.current.scrollTop - box.current.clientHeight < 80 : true
          setItems((prev) => [...prev, ...r.items])
          if (near) requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }))
        }
      } catch { /* the next pull tries again */ }
      if (!gone && running) timer = setTimeout(pull, 2000)
    }
    pull()
    return () => { gone = true; if (timer) clearTimeout(timer) }
  }, [runId, session.n, running])

  return (
    <div ref={box} className="mt-2.5 max-h-[55vh] overflow-y-auto rounded bg-bg p-2.5">
      {prompt && (
        <details className="mb-2">
          <summary className="cursor-pointer font-mono text-[10px] text-muted">prompt</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted/80">{prompt}</pre>
        </details>
      )}
      {!items.length && <div className="font-mono text-[11px] text-muted/60">{running ? 'Starting…' : 'No output.'}</div>}
      {items.map((it, i) => {
        if (it.kind === 'tool') return <div key={i} className="truncate font-mono text-[11px] leading-relaxed text-muted"><span className="text-neon-purple">{it.name}</span> {it.input}</div>
        if (it.kind === 'error') return <div key={i} className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-warn">{it.text}</div>
        if (it.kind === 'result') return <div key={i} className="mt-1.5 whitespace-pre-wrap break-words border-t border-line pt-1.5 text-[12px] leading-relaxed text-ok">{it.status}: {it.text}</div>
        return <div key={i} className="my-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">{it.text}</div>
      })}
    </div>
  )
}
