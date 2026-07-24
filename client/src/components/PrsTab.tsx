import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Node, PullRequest } from '../types'

const CHECK_STYLE: Record<string, string> = {
  passing: 'text-ok', failing: 'text-bad', pending: 'text-warn', none: 'text-muted',
}

export function PrsTab({ node }: { node: Node }) {
  const [state, setState] = useState<
    { available: boolean; prs: PullRequest[]; viewer?: string | null; error?: string | null } | null
  >(null)
  const [creating, setCreating] = useState(false)
  const [mineOnly, setMineOnly] = useState(true)
  const [title, setTitle] = useState('')
  const [result, setResult] = useState<string | null>(null)

  const reload = () => api.prs(node.id).then(setState).catch(() => setState(null))
  useEffect(() => { setState(null); setResult(null); reload() }, [node.id])

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
                <span className={`ml-auto shrink-0 text-[11px] ${CHECK_STYLE[pr.checks.state]}`}>
                  {pr.checks.state === 'none' ? 'no checks' : pr.checks.state}
                  {pr.checks.total > 0 && ` ${pr.checks.passed}/${pr.checks.total}`}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted">
                {pr.head} → {pr.base}
                {pr.author && ` · ${pr.author}`}
                {pr.reviewDecision && ` · ${pr.reviewDecision.toLowerCase().replace('_', ' ')}`}
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
