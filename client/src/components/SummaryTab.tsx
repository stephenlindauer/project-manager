import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { ago as rel } from '../lib/time'
import type { Node, Summary } from '../types'
import { StatusBadges } from './StatusBadges'


export function SummaryTab({ node }: { node: Node }) {
  const [data, setData] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const setNewBranchFor = useStore((s) => s.setNewBranchFor)
  const setActiveNode = useStore((s) => s.setActiveNode)
  const nodes = useStore((s) => s.nodes)

  useEffect(() => {
    let live = true
    setData(null)
    api.summary(node.id).then((d) => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [node.id])

  const refresh = async () => {
    setBusy(true)
    try {
      await api.fetchRemote(node.id)
      setData(await api.summary(node.id))
    } finally { setBusy(false) }
  }

  if (!data) return <div className="p-6 text-muted">Loading…</div>

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {data.group && <span className="text-muted">{data.group}/</span>}
            {data.name}
          </h1>
          {data.status && <StatusBadges status={data.status} />}
          <button
            onClick={refresh}
            disabled={busy}
            className="ml-auto rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-50"
          >{busy ? 'Fetching…' : 'Fetch'}</button>
          <button
            onClick={() => api.open(data.path)}
            className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink"
          >Open in Finder</button>
        </header>

        <div className="font-mono text-[11px] text-muted">{data.path}</div>

        {!data.isGit ? (
          <Card title="Not a git repository">
            <p className="text-muted">
              Detected as a project via <code className="text-ink">{data.marker}</code>.
              Terminal and task tabs still work here.
            </p>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="Branch">
                <Row label="Current" value={data.status?.branch ?? '(detached)'} mono />
                <Row label="Upstream" value={data.status?.upstream ?? 'none'} mono />
                <Row label="Default" value={data.defaultBranch ?? '—'} mono />
                <Row
                  label="Sync"
                  value={
                    data.status && (data.status.ahead || data.status.behind)
                      ? `${data.status.ahead} ahead · ${data.status.behind} behind`
                      : 'up to date'
                  }
                />
              </Card>

              <Card title="Working tree">
                <Row label="Staged" value={String(data.status?.staged ?? 0)} />
                <Row label="Modified" value={String(data.status?.unstaged ?? 0)} />
                <Row label="Untracked" value={String(data.status?.untracked ?? 0)} />
                <Row label="Conflicts" value={String(data.status?.conflicted ?? 0)} />
              </Card>
            </div>

            <Card title="Last commit">
              {data.lastCommit ? (
                <div className="space-y-1">
                  <div className="text-[13px]">{data.lastCommit.subject}</div>
                  <div className="text-muted">
                    <span className="font-mono text-accent">{data.lastCommit.short}</span>
                    {' · '}{data.lastCommit.author}
                    {' · '}{rel(data.lastCommit.committedAt ?? data.lastCommit.authoredAt)}
                  </div>
                </div>
              ) : <span className="text-muted">No commits yet</span>}
            </Card>

            {data.pr && (
              <Card title="Pull request for this branch">
                <a href={data.pr.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  #{data.pr.number} {data.pr.title}
                </a>
                <div className="mt-1 text-muted">
                  {data.pr.isDraft ? 'draft · ' : ''}
                  checks {data.pr.checks.state}
                  {data.pr.checks.total > 0 &&
                    ` (${data.pr.checks.passed}/${data.pr.checks.total})`}
                </div>
              </Card>
            )}

            <Card
              title="Worktrees"
              action={
                <button
                  onClick={() => setNewBranchFor(node.projectId)}
                  className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink"
                >+ New branch</button>
              }
            >
              <div className="space-y-1">
                {(data.worktrees ?? []).map((w) => {
                  const target = nodes.find((n) => n.cwd === w.path)
                  return (
                    <div key={w.path} className="flex items-center gap-2">
                      <button
                        onClick={() => target && setActiveNode(target.id)}
                        className="font-mono text-[12px] text-accent hover:underline disabled:text-muted disabled:no-underline"
                        disabled={!target}
                      >{w.branch ?? w.name}</button>
                      {w.isMain && <span className="text-[10px] text-muted">main</span>}
                      <span className="truncate font-mono text-[10px] text-muted/70">{w.path}</span>
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card title="Recent commits">
              {(data.commits ?? []).length === 0 && (
                <span className="text-muted">No commits yet</span>
              )}
              <div className="space-y-1">
                {(data.commits ?? []).map((c) => (
                  <div key={c.short} className="flex gap-2 truncate">
                    <span className="font-mono text-accent">{c.short}</span>
                    <span className="truncate">{c.subject}</span>
                    <span className="ml-auto shrink-0 text-muted">{rel(c.date)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

function Card({ title, children, action }: {
  title: string; children: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-line bg-panel p-3.5">
      <div className="mb-2 flex items-center">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-muted">{label}</span>
      <span className={`truncate ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</span>
    </div>
  )
}
