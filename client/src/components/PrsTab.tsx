import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Node, PrsView, PullRequest, Stack } from '../types'

const CHECK_STYLE: Record<string, string> = {
  passing: 'text-ok', failing: 'text-bad', pending: 'text-warn', none: 'text-muted', unknown: 'text-muted',
}

function Checks({ pr, className = '' }: { pr: PullRequest; className?: string }) {
  const c = pr.checks
  return (
    <span className={`shrink-0 text-[11px] ${CHECK_STYLE[c.state]} ${className}`}>
      {c.state === 'none' ? 'no checks' : c.state === 'unknown' ? '' : c.state}
      {c.total > 0 && ` ${c.passed}/${c.total}`}
    </span>
  )
}

/**
 * The review verdict as a single glyph: a green check once someone has
 * approved, a red cross while changes are requested. "Review required" is the
 * default state of every PR and says nothing, so it renders nothing.
 */
function Review({ pr }: { pr: PullRequest }) {
  if (pr.reviewDecision === 'APPROVED') {
    return <span className="shrink-0 text-[12px] font-bold text-ok" title="Approved">✓</span>
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return <span className="shrink-0 text-[12px] font-bold text-bad" title="Changes requested">✗</span>
  }
  return null
}

/**
 * The stack this worktree is part of, top of stack first so it reads like the
 * commits do. One row per PR; the rung you are on is marked, a rung already
 * open in a sibling worktree jumps there, anything else checks out here.
 */
function StackSection({ node, stack, onSwitched }: { node: Node; stack: Stack; onSwitched: () => void }) {
  const setActiveNode = useStore((s) => s.setActiveNode)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const switchTo = async (head: string) => {
    setBusy(head); setError(null)
    try {
      const res = await api.switchStack(node.id, head)
      if (res.nodeId && res.nodeId !== node.id) setActiveNode(res.nodeId)
      else if (res.moved) onSwitched()
      else if (!res.nodeId) setError(`${head} is checked out in ${res.path ?? 'another worktree'} that is not in the sidebar`)
    } catch (e) {
      setError(String((e as Error).message))
    } finally { setBusy(null) }
  }

  const rows = [...stack.entries].reverse()
  const grok = stack.kind === 'grok'
  const prCount = stack.entries.filter((e) => e.pr).length
  return (
    <section className="rounded-lg border border-line bg-panel p-3.5">
      <h3 className="mb-2 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Stack
        <span className="font-normal normal-case tracking-normal">
          {prCount} {prCount === 1 ? 'PR' : 'PRs'} on <span className="font-mono">{stack.base}</span>
          {grok && ' · git-grok'}
        </span>
      </h3>
      <ol className="space-y-1">
        {rows.map((e, i) => {
          const key = e.pr?.number ?? e.commit?.sha ?? i
          const elsewhere = e.checkedOutAt && !e.current
          return (
            <li key={key} className={`flex items-center gap-2 rounded px-2 py-1.5 ${e.current ? 'bg-panel-2' : ''}`}>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${e.current ? 'bg-accent' : e.pr ? 'bg-neon-pink' : 'border border-line-bright'}`}
                title={e.current ? 'this worktree' : undefined}
              />
              {e.pr ? (
                <a href={e.pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-accent">
                  <span className="font-mono text-muted">#{e.pr.number}</span>{' '}
                  <span className="text-[13px]">{e.pr.title}</span>
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                  {e.commit?.subject}
                  <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">not pushed</span>
                </span>
              )}
              {e.pr?.isDraft && <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">draft</span>}
              {e.pr && <Review pr={e.pr} />}
              {e.pr && <Checks pr={e.pr} />}
              {grok ? (
                <span className="shrink-0 font-mono text-[10px] text-muted">{e.commit?.short}</span>
              ) : e.current ? (
                <span className="w-14 shrink-0 rounded border border-accent/40 px-2 py-0.5 text-center text-[10px] text-accent">here</span>
              ) : e.head ? (
                <button
                  onClick={() => switchTo(e.head!)}
                  disabled={busy !== null}
                  title={elsewhere ? `Open in ${e.checkedOutAt}` : `git checkout ${e.head}${e.local ? '' : ' (from origin)'}`}
                  className="w-14 shrink-0 rounded border border-line px-2 py-0.5 text-center text-[10px] text-muted hover:border-accent hover:text-ink disabled:opacity-40"
                >{busy === e.head ? '…' : elsewhere ? 'Open' : 'Switch'}</button>
              ) : null}
            </li>
          )
        })}
        <li className="flex items-center gap-2 px-2 py-1 font-mono text-[10px] text-muted">
          <span className="h-2 w-2 shrink-0 rounded-full border border-line-bright" />
          {stack.base}
        </li>
      </ol>
      {stack.forks.length > 0 && (
        <div className="mt-2 text-[10px] text-muted">
          Also based on this stack:{' '}
          {stack.forks.map((f, i) => (
            <span key={f.number}>
              {i > 0 && ', '}
              <a href={f.url} target="_blank" rel="noreferrer" className="hover:text-accent">#{f.number} {f.title}</a>
            </span>
          ))}
        </div>
      )}
      {grok && (
        <div className="mt-2 text-[10px] text-muted">
          Every commit above <span className="font-mono">{stack.base}</span> is a PR. To work on one, edit its commit with <span className="font-mono">git rebase -i</span> and run <span className="font-mono">git grok</span>.
        </div>
      )}
      {error && <div className="mt-2 rounded border border-bad/40 bg-bad/10 p-2 text-[11px] text-bad">{error}</div>}
    </section>
  )
}

export function PrsTab({ node }: { node: Node }) {
  const [state, setState] = useState<PrsView | null>(null)
  const [creating, setCreating] = useState(false)
  const [mineOnly, setMineOnly] = useState(true)
  const [title, setTitle] = useState('')
  const [result, setResult] = useState<string | null>(null)

  const reload = () => {
    // Nudge the sidebar's ship verdicts too. The server folds calls within 10s
    // of a tick into that tick, so opening this tab repeatedly costs nothing.
    api.shipRefresh().catch(() => {})
    return api.prs(node.id).then(setState).catch(() => setState(null))
  }
  // Reload on a branch change too: switching within the stack lands here.
  useEffect(() => { setState(null); setResult(null); reload() }, [node.id, node.branch])

  const viewer = state?.viewer ?? null
  const mine = useMemo(
    () => (viewer ? (state?.prs ?? []).filter((pr) => pr.author === viewer) : (state?.prs ?? [])),
    [state?.prs, viewer],
  )
  const shown = mineOnly && viewer ? mine : state?.prs ?? []

  const create = async () => {
    if (!title.trim()) return
    setCreating(true)
    try {
      const res = await api.createPr(node.id, { title: title.trim() })
      setResult(res.ok ? `Created ${res.url}` : `Failed: ${res.error}`)
      if (res.ok) { setTitle(''); reload() }
    } finally { setCreating(false) }
  }

  if (!state) return <div className="p-6 text-muted">Loading…</div>

  if (!state.available) {
    return (
      <div className="p-6 text-muted">
        The <code className="text-ink">gh</code> CLI was not found. Install it to see pull requests here.
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Open pull requests
          </h2>
          {viewer && (
            <div className="ml-auto flex overflow-hidden rounded border border-line text-[11px]">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  onClick={() => setMineOnly(v)}
                  className={`px-2 py-0.5 ${
                    mineOnly === v ? 'bg-panel-2 text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  {v ? `Mine ${mine.length}` : `All ${state.prs.length}`}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={reload}
            className={`rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink ${viewer ? '' : 'ml-auto'}`}
          >↻</button>
        </header>

        {state.error && <div className="rounded border border-bad/40 bg-bad/10 p-3 text-bad">{state.error}</div>}

        {state.stack && state.stack.entries.length > 0 && (
          <StackSection node={node} stack={state.stack} onSwitched={reload} />
        )}

        <div className="space-y-1.5">
          {shown.map((pr) => (
            <a
              key={pr.number}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-line bg-panel p-3 hover:border-accent/60"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-muted">#{pr.number}</span>
                <span className="truncate text-[13px]">{pr.title}</span>
                {pr.isDraft && (
                  <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">draft</span>
                )}
                <span className="ml-auto flex shrink-0 items-baseline gap-2">
                  <Review pr={pr} />
                  <Checks pr={pr} />
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted">
                {pr.head} → {pr.base}
                {pr.author && ` · ${pr.author}`}
              </div>
            </a>
          ))}
          {shown.length === 0 && (
            <div className="text-muted">
              {mineOnly && viewer && state.prs.length > 0
                ? `No open pull requests by you — ${state.prs.length} by others.`
                : 'No open pull requests.'}
            </div>
          )}
        </div>

        {node.branch && (
          <section className="rounded-lg border border-line bg-panel p-3.5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Create PR from <span className="font-mono text-ink">{node.branch}</span>
            </h3>
            <div className="flex gap-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create() }}
                placeholder="Pull request title"
                className="flex-1 rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
              />
              <button
                onClick={create}
                disabled={creating || !title.trim()}
                className="rounded border border-line px-3 py-1.5 text-[12px] hover:border-accent disabled:opacity-40"
              >{creating ? 'Creating…' : 'Create'}</button>
            </div>
            {result && <div className="mt-2 text-[11px] text-muted">{result}</div>}
          </section>
        )}
      </div>
    </div>
  )
}
