import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Node, Todo, TodoHorizon, Todos } from '../types'

/**
 * What you mean to do in this project, soon but not now.
 *
 * The list lives in Memento; this tab is a window onto one project's slice of
 * it — only todos attached to `project:<this repo>`, never unscoped "life"
 * todos (decided 2026-08-20). The same records show in the Memento web UI, in
 * `mem todos`, and at the top of a Claude Code session here.
 *
 * Decay is the feature: an undated todo untouched for 90 days leaves the view
 * (it stays in Memento, under "Faded"). The fade is shown two weeks ahead, so
 * nothing vanishes unwatched. "Bump" is the one thing that resets the clock.
 */

const HORIZONS: TodoHorizon[] = ['now', 'soon', 'someday']

const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ')

/** The prompt a todo becomes in the Claude tab. Typed, not sent. */
const promptFor = (t: Todo) =>
  `Let's work on this todo: ${t.text} (memento ${t.id} — mark it done with the memento \`done\` tool when finished)`

function When({ t }: { t: Todo }) {
  if (t.urgency === 'overdue') return <span className="text-bad">overdue · {t.due}</span>
  if (t.urgency === 'today') return <span className="text-warn">due today</span>
  if (t.due) return <span className="text-accent">due {t.due}</span>
  if (t.state === 'fading') return <span className="italic text-warn/80">fades in {t.left}d</span>
  if (t.state === 'faded') return <span className="italic text-muted">faded {t.left != null ? -t.left : ''}d ago</span>
  if (t.state === 'closed') return <span className="text-muted">done{typeof t.closed === 'string' ? ` · ${t.closed}` : ''}</span>
  return <span className="text-muted">{t.age === 0 ? 'today' : `${t.age}d`}</span>
}

export function SoonTab({ node }: { node: Node }) {
  const [state, setState] = useState<Todos | null>(null)
  const [text, setText] = useState('')
  const [horizon, setHorizon] = useState<TodoHorizon>('soon')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const startInClaude = useStore((s) => s.startInClaude)

  const reload = () => api.todos(node.id).then(setState).catch((e) => {
    setState({ available: true, entity: null, error: e instanceof Error ? e.message : String(e), open: [], fading: [], faded: [], closed: [] })
  })
  useEffect(() => { setState(null); setNotice(null); reload() }, [node.id])

  /** Run a write, report its failure inline, and refresh on success. */
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key)
    setNotice(null)
    try {
      const res = await fn()
      if (!res.ok) setNotice(res.error ?? 'that did not work')
      else await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const add = () => {
    const t = text.trim()
    if (!t) return
    void act('add', async () => {
      const res = await api.addTodo(node.id, { text: t, horizon, due: due || undefined })
      if (res.ok) { setText(''); setDue('') }
      return res
    })
  }

  if (!state) return <div className="p-6 text-muted">Loading…</div>

  if (!state.available) {
    return (
      <div className="p-6 text-muted">
        Memento is not configured on this machine. Todos live there; run{' '}
        <code className="text-ink">mem config --api … --token …</code> and this tab will fill in.
      </div>
    )
  }

  const groups = HORIZONS.map((h) => [h, state.open.filter((t) => t.horizon === h)] as const)

  const row = (t: Todo) => {
    const open = t.state !== 'closed' && t.state !== 'faded'
    return (
      <div
        key={t.id}
        className={cls(
          'group rounded-lg border border-line bg-panel p-3 hover:border-accent/60',
          t.state === 'fading' && 'opacity-70',
          (t.state === 'faded' || t.state === 'closed') && 'opacity-60',
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className={cls('text-[13px]', t.state === 'closed' && 'line-through text-muted')}>{t.text}</span>
          <span className="ml-auto shrink-0 text-[11px]"><When t={t} /></span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">{t.horizon}</span>
          <span className="font-mono text-[10px] text-muted" title={t.id}>{(t.source ?? '').split(':')[0]}</span>
          <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {open && (
              <button
                onClick={() => startInClaude(node.id, promptFor(t))}
                className="rounded border border-accent/50 px-2 py-0.5 text-accent hover:border-accent hover:bg-accent/10"
                title="Switch to the Claude tab with this todo typed as the prompt"
              >Start in Claude</button>
            )}
            {open && (
              <button
                disabled={busy === t.id}
                onClick={() => act(t.id, () => api.doneTodo(node.id, t.id))}
                className="rounded border border-line px-2 py-0.5 text-muted hover:border-ok hover:text-ok disabled:opacity-40"
              >done</button>
            )}
            {t.state === 'closed' ? (
              <button
                disabled={busy === t.id}
                onClick={() => act(t.id, () => api.bumpTodo(node.id, t.id, { reopen: true }))}
                className="rounded border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-ink disabled:opacity-40"
              >reopen</button>
            ) : (
              <button
                disabled={busy === t.id}
                onClick={() => act(t.id, () => api.bumpTodo(node.id, t.id))}
                className="rounded border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-ink disabled:opacity-40"
                title="Still want this — reset its 90-day clock"
              >{t.state === 'faded' ? 'revive' : 'bump'}</button>
            )}
            {open && HORIZONS.filter((h) => h !== t.horizon).map((h) => (
              <button
                key={h}
                disabled={busy === t.id}
                onClick={() => act(t.id, () => api.bumpTodo(node.id, t.id, { horizon: h }))}
                className="rounded border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-ink disabled:opacity-40"
              >→ {h}</button>
            ))}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Soon · {node.name}
          </h2>
          <span className="text-[11px] text-muted">{state.open.length} open</span>
          <button
            onClick={reload}
            className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink"
          >↻</button>
        </header>

        {state.error && <div className="rounded border border-bad/40 bg-bad/10 p-3 text-bad">{state.error}</div>}
        {notice && <div className="rounded border border-bad/40 bg-bad/10 p-3 text-[12px] text-bad">{notice}</div>}

        <section className="rounded-lg border border-line bg-panel p-3.5">
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              placeholder={`Something to do in ${node.name}`}
              className="flex-1 rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
            />
            <div className="flex overflow-hidden rounded border border-line text-[11px]">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  onClick={() => setHorizon(h)}
                  className={`px-2 py-0.5 ${horizon === h ? 'bg-panel-2 text-ink' : 'text-muted hover:text-ink'}`}
                >{h}</button>
              ))}
            </div>
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              title="Due date, optional. A dated todo never fades."
              className="rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-muted outline-none focus:border-accent"
            />
            <button
              onClick={add}
              disabled={busy === 'add' || !text.trim()}
              className="rounded border border-line px-3 py-1.5 text-[12px] hover:border-accent disabled:opacity-40"
            >{busy === 'add' ? 'Adding…' : 'Add'}</button>
          </div>
        </section>

        {state.fading.length > 0 && (
          <div className="text-[11px] text-muted">
            {state.fading.length} of these will fade within two weeks unless bumped. An undated todo untouched
            for 90 days leaves this list — if it mattered, it would have happened.
          </div>
        )}

        {groups.map(([h, rows]) => rows.length > 0 && (
          <section key={h} className="space-y-1.5">
            <h3 className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {h} <span className="font-mono font-normal">{rows.length}</span>
            </h3>
            {rows.map(row)}
          </section>
        ))}

        {state.open.length === 0 && !state.error && (
          <div className="text-muted">Nothing open here. Add one above, or tell Claude what you mean to do.</div>
        )}

        {state.faded.length > 0 && (
          <details className="pt-2">
            <summary className="cursor-pointer text-[11px] text-muted hover:text-ink">
              Faded · {state.faded.length} — untouched 90+ days; revive one to bring it back
            </summary>
            <div className="mt-2 space-y-1.5">{state.faded.map(row)}</div>
          </details>
        )}
        {state.closed.length > 0 && (
          <details className="pt-2">
            <summary className="cursor-pointer text-[11px] text-muted hover:text-ink">Done · {state.closed.length}</summary>
            <div className="mt-2 space-y-1.5">{state.closed.map(row)}</div>
          </details>
        )}
      </div>
    </div>
  )
}
