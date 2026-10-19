import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { ago } from '../lib/time'
import { useStore } from '../store'
import type { CleanupItem, CleanupResult, CleanupScan } from '../types'

const STALE_CHOICES = [7, 14, 30, 60]
const DAY_MS = 86_400_000

const purgeable = (it: CleanupItem) => (it.verdict === 'merged' || it.verdict === 'missing') && it.holds.length === 0

/**
 * Worktree cleanup: removes the linked worktrees whose work is already on the
 * default branch, and lists the ones that have gone quiet without merging.
 *
 * Opening it fetches every repo with linked worktrees (so a squash-merge on
 * GitHub is visible) and classifies them server-side; see server/cleanup.js.
 * Stale ones are only ever listed — clicking one opens it — because they may
 * hold the only copy of unmerged work. A merged worktree with a live session
 * starts unticked: the session may hold context worth more than the tree.
 */
export function CleanupDialog() {
  const open = useStore((s) => s.cleanupOpen)
  const close = () => useStore.getState().setCleanupOpen(false)

  const [scan, setScan] = useState<CleanupScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [staleDays, setStaleDays] = useState(14)
  const [deleteBranches, setDeleteBranches] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setScan(null); setError(null); setFailures({})
    api.cleanupScan()
      .then((s) => {
        setScan(s)
        setStaleDays(s.staleDays)
        setPicked(Object.fromEntries(s.items.filter(purgeable).map((it) => [it.nodeId, !it.session])))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  const { merged, held, stale } = useMemo(() => {
    const items = scan?.items ?? []
    const cutoff = Date.now() - staleDays * DAY_MS
    return {
      merged: items.filter(purgeable),
      held: items.filter((it) => (it.verdict === 'merged' || it.verdict === 'missing') && it.holds.length > 0),
      stale: items
        .filter((it) => (it.verdict === 'open' || it.verdict === 'empty')
          && (it.upstreamGone || (it.activityAt ?? 0) < cutoff))
        .sort((a, b) => (a.activityAt ?? 0) - (b.activityAt ?? 0)),
    }
  }, [scan, staleDays])

  if (!open) return null

  const chosen = merged.filter((it) => picked[it.nodeId]).map((it) => it.nodeId)

  const purge = async () => {
    if (!chosen.length) return
    setBusy(true)
    try {
      const { results } = await api.cleanupPurge(chosen, deleteBranches)
      const failed = results.filter((r) => !r.ok)
      const gone = new Set(results.filter((r) => r.ok).map((r) => r.nodeId))
      setFailures(Object.fromEntries(failed.map((r) => [r.nodeId, r.error ?? 'failed'])))
      setScan((s) => (s ? { ...s, items: s.items.filter((it) => !gone.has(it.nodeId)) } : s))
      useStore.getState().notice({
        key: 'cleanup',
        tone: failed.length ? 'bad' : 'ok',
        title: `Removed ${gone.size} worktree${gone.size === 1 ? '' : 's'}`,
        message: summarise(results, failed),
        sticky: failed.length > 0,
      })
      if (!failed.length) close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openNode = (id: string) => {
    useStore.getState().showNodeTab(id, 'summary')
    close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={() => !busy && close()}>
      <div
        className="flex max-h-[78vh] w-[680px] max-w-[calc(100vw-32px)] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold">Clean up worktrees</h2>
          <p className="mt-0.5 text-[11px] text-muted">
            Merged worktrees hold nothing the default branch lacks and can go. Stale ones are listed for you to decide.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && <div className="mb-3 rounded border border-bad/50 bg-bad/10 px-2 py-1.5 text-[12px] text-bad">{error}</div>}
          {!scan && !error && <div className="py-8 text-center text-[12px] text-muted">Fetching and checking worktrees…</div>}

          {scan && scan.fetchErrors.length > 0 && (
            <div className="mb-3 text-[11px] text-warn">
              Could not fetch {scan.fetchErrors.map((f) => f.project).join(', ')} — judged against the last-fetched origin.
            </div>
          )}

          {scan && (
            <>
              <Heading
                title="Merged"
                count={merged.length}
                action={merged.length > 1 ? (
                  <button
                    className="text-[11px] text-muted hover:text-ink"
                    onClick={() => {
                      const all = chosen.length < merged.length
                      setPicked(Object.fromEntries(merged.map((it) => [it.nodeId, all])))
                    }}
                  >{chosen.length < merged.length ? 'select all' : 'select none'}</button>
                ) : null}
              />
              {merged.length === 0 && <Empty>Nothing merged to remove.</Empty>}
              {merged.map((it) => (
                <label key={it.nodeId} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-panel-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--color-accent)]"
                    checked={Boolean(picked[it.nodeId])}
                    onChange={(e) => setPicked({ ...picked, [it.nodeId]: e.target.checked })}
                  />
                  <Row item={it} note={<span className="text-ok">{it.reason}</span>}>
                    {it.session && <Flag tone="warn">has a session — removing ends it</Flag>}
                    {failures[it.nodeId] && <Flag tone="bad">{failures[it.nodeId]}</Flag>}
                  </Row>
                </label>
              ))}

              {held.length > 0 && (
                <>
                  <Heading title="Merged, but kept" count={held.length} />
                  {held.map((it) => (
                    <button key={it.nodeId} onClick={() => openNode(it.nodeId)} className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2">
                      <span className="w-[13px]" />
                      <Row item={it} note={<span className="text-muted">{it.reason}</span>}>
                        <Flag tone="warn">{it.holds.join(' · ')}</Flag>
                      </Row>
                    </button>
                  ))}
                </>
              )}

              <Heading
                title="Stale"
                count={stale.length}
                action={(
                  <label className="text-[11px] text-muted">
                    quiet for{' '}
                    <select
                      value={staleDays}
                      onChange={(e) => setStaleDays(Number(e.target.value))}
                      className="rounded border border-line bg-bg px-1 py-0.5 text-ink outline-none focus:border-accent"
                    >
                      {STALE_CHOICES.map((d) => <option key={d} value={d}>{d}+ days</option>)}
                    </select>
                  </label>
                )}
              />
              {stale.length === 0 && <Empty>No unmerged worktree has been quiet that long.</Empty>}
              {stale.map((it) => (
                <button key={it.nodeId} onClick={() => openNode(it.nodeId)} className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2" title="Open this worktree">
                  <span className="w-[13px]" />
                  <Row item={it} note={<span className="text-muted">{it.reason}</span>}>
                    {it.upstreamGone && <Flag tone="pink">remote branch deleted</Flag>}
                    {it.holds.map((h) => <Flag key={h} tone="warn">{h}</Flag>)}
                    {it.session && <Flag tone="muted">session</Flag>}
                  </Row>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <label className="mr-auto flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={deleteBranches}
              onChange={(e) => setDeleteBranches(e.target.checked)}
            />
            Also delete their local branches
          </label>
          <button onClick={close} disabled={busy} className="rounded border border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink disabled:opacity-40">
            Close
          </button>
          <button
            onClick={purge}
            disabled={busy || !chosen.length}
            className="rounded border border-accent/60 bg-accent/15 px-3 py-1.5 text-[12px] text-ink hover:bg-accent/25 disabled:opacity-40"
          >{busy ? 'Removing…' : `Remove ${chosen.length} worktree${chosen.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  )
}

function summarise(results: CleanupResult[], failed: CleanupResult[]) {
  const branches = results.filter((r) => r.branchDeleted).length
  const parts = []
  if (branches) parts.push(`${branches} branch${branches === 1 ? '' : 'es'} deleted`)
  if (failed.length) parts.push(`${failed.length} kept: ${failed.map((r) => r.branch ?? r.nodeId).join(', ')}`)
  return parts.join(' · ') || null
}

function Heading({ title, count, action }: { title: string; count: number; action?: React.ReactNode }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-2 first:mt-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neon-purple/90">{title}</span>
      <span className="text-[11px] text-muted">{count}</span>
      <span className="ml-auto">{action}</span>
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) =>
  <div className="px-1.5 py-1 text-[12px] text-muted">{children}</div>

function Row({ item, note, children }: { item: CleanupItem; note: React.ReactNode; children?: React.ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span className="shrink-0 text-[12px] text-ink">{item.project}</span>
        <span className="truncate font-mono text-[12px] text-neon-pink">{item.branch ?? '(detached)'}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">{ago(item.activityAt)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {note}
        {children}
      </span>
    </span>
  )
}

const FLAG_TONE = {
  warn: 'text-warn', bad: 'text-bad', pink: 'text-neon-pink', muted: 'text-muted',
} as const

const Flag = ({ tone, children }: { tone: keyof typeof FLAG_TONE; children: React.ReactNode }) =>
  <span className={FLAG_TONE[tone]}>· {children}</span>
