import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'

/** Creates a git worktree for a new or existing branch, then jumps to it. */
export function NewBranchDialog() {
  const projectId = useStore((s) => s.newBranchFor)
  const close = () => useStore.getState().setNewBranchFor(null)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const setActiveNode = useStore((s) => s.setActiveNode)
  const rescan = useStore((s) => s.rescan)

  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [bases, setBases] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!project) return
    setBranch(''); setBase(''); setError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
    const main = project.worktrees.find((w) => w.isMain) ?? project.worktrees[0]
    if (main) {
      api.branches(main.id)
        .then((b) => setBases(b.map((x) => x.name)))
        .catch(() => setBases([]))
    }
  }, [project])

  if (!project) return null

  const submit = async () => {
    if (!branch.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const res = await api.createWorktree(project.id, branch.trim(), base || undefined)
      await rescan()
      if (res.node) setActiveNode(res.node.id)
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]" onClick={close}>
      <div
        className="w-[460px] rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-[14px] font-semibold">New worktree</h2>
        <p className="mb-3 text-[11px] text-muted">
          Creates a linked worktree for <span className="font-mono text-ink">{project.name}</span> so you can
          run this branch alongside the others.
        </p>

        <label className="mb-1 block text-[11px] text-muted">Branch name</label>
        <input
          ref={inputRef}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') close()
          }}
          placeholder="feature/my-thing"
          className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
        />

        <label className="mb-1 block text-[11px] text-muted">Base (blank = default branch)</label>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          list="pm-branch-list"
          placeholder="main"
          className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
        />
        <datalist id="pm-branch-list">
          {bases.map((b) => <option key={b} value={b} />)}
        </datalist>

        {error && <div className="mb-3 rounded border border-bad/40 bg-bad/10 p-2 text-[11px] text-bad">{error}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={close} className="rounded border border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !branch.trim()}
            className="rounded border border-accent/60 bg-accent/15 px-3 py-1.5 text-[12px] text-ink hover:bg-accent/25 disabled:opacity-40"
          >{busy ? 'Creating…' : 'Create worktree'}</button>
        </div>
      </div>
    </div>
  )
}
