import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'

/**
 * Creates a git worktree for a new or existing branch.
 *
 * Submit closes the dialog at once and hands the work to
 * `createWorktreeInBackground`: `git worktree add` can take several seconds, and a modal you have to babysit is the wrong shape
 * for that. Progress and the result arrive as toasts; the success toast is the
 * way into the new worktree.
 */
export function NewBranchDialog() {
  const projectId = useStore((s) => s.newBranchFor)
  const close = () => useStore.getState().setNewBranchFor(null)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const createInBackground = useStore((s) => s.createWorktreeInBackground)

  const [value, setValue] = useState('')
  const [base, setBase] = useState('')
  const [bases, setBases] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!project) return
    setValue(''); setBase('')
    setTimeout(() => inputRef.current?.focus(), 0)
    const main = project.worktrees.find((w) => w.isMain) ?? project.worktrees[0]
    if (main) {
      api.branches(main.id)
        .then((b) => setBases(b.map((x) => x.name)))
        .catch(() => setBases([]))
    }
  }, [project])

  if (!project) return null

  const trimmed = value.trim()
  const submit = () => {
    if (!trimmed) return
    createInBackground(project.id, { branch: trimmed, base: base || undefined })
    close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]" onClick={close}>
      <div
        className="w-[460px] rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-[14px] font-semibold">New worktree</h2>
        <p className="mb-3 text-[11px] text-muted">
          Creates a linked worktree for <span className="font-mono text-ink">{project.name}</span> so you can run this branch alongside the others.
        </p>

        <label className="mb-1 block text-[11px] text-muted">Branch name</label>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') close()
          }}
          list="pm-branch-list"
          placeholder="main"
          className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
        />
        <datalist id="pm-branch-list">
          {bases.map((b) => <option key={b} value={b} />)}
        </datalist>

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-muted">Runs in the background — a toast tells you when it is ready.</span>
          <button onClick={close} className="rounded border border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!trimmed}
            className="rounded border border-accent/60 bg-accent/15 px-3 py-1.5 text-[12px] text-ink hover:bg-accent/25 disabled:opacity-40"
          >Create worktree</button>
        </div>
      </div>
    </div>
  )
}
