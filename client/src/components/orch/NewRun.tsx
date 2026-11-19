import { useEffect, useMemo, useState } from 'react'
import { orchApi } from '../../api'
import { useStore } from '../../store'
import type { OrchMeta } from '../../types'
import { Button } from './parts'

/**
 * Start a run by hand: pick the repo, paste the brief. With a tracker source
 * selected, the "brief" box takes the task's id or URL instead and the
 * adapter fetches the rest.
 */
export function NewRun({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects)
  const activeNode = useStore((s) => s.nodes.find((n) => n.id === s.activeNodeId) ?? null)
  const openRun = useStore((s) => s.openRun)
  const repos = useMemo(() => projects.filter((p) => p.isGit).sort((a, b) => a.name.localeCompare(b.name)), [projects])

  const [meta, setMeta] = useState<OrchMeta | null>(null)
  const [projectId, setProjectId] = useState(activeNode?.projectId ?? repos[0]?.id ?? '')
  const [source, setSource] = useState('')
  const [pipeline, setPipeline] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { orchApi.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const manual = !source || meta?.sources?.find((s) => s.name === source)?.adapter === 'manual'
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const { run } = await orchApi.start({ projectId, brief: brief.trim(), source: source || undefined, pipeline: pipeline || undefined })
      openRun(run.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const field = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent max-md:text-[16px]'
  return (
    <div className="fixed inset-0 z-[105] grid place-items-start bg-black/60 p-3 pt-[8vh] md:place-items-center md:pt-3" onClick={onClose}>
      <div className="w-full max-w-[620px] rounded border border-line-bright bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.7)]" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-4 py-2.5 text-[13px] text-ink">New run</div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Repository
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={field}>
              {repos.map((p) => <option key={p.id} value={p.id}>{p.group ? `${p.group} / ` : ''}{p.name}</option>)}
            </select>
          </label>

          <div className="flex gap-3">
            {(meta?.sources?.length ?? 0) > 1 && (
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted">
                Task source
                <select value={source} onChange={(e) => setSource(e.target.value)} className={field}>
                  <option value="">Repo default</option>
                  {meta!.sources!.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted">
              Pipeline
              <select value={pipeline} onChange={(e) => setPipeline(e.target.value)} className={field}>
                <option value="">Repo default</option>
                {meta?.pipelines?.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[11px] text-muted">
            {manual ? 'Brief — the first line becomes the title' : 'Task id or URL'}
            <textarea
              value={brief} onChange={(e) => setBrief(e.target.value)} rows={manual ? 9 : 2} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && brief.trim()) submit() }}
              placeholder={manual ? 'What is wrong, what done looks like, anything the worker should know.' : ''}
              className={`${field} resize-y font-mono leading-snug`}
            />
          </label>
          {error && <div className="whitespace-pre-wrap text-[11px] text-bad">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          <span className="mr-auto text-[10px] text-muted/70 max-md:hidden">⌘↵ to start</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={busy || !brief.trim() || !projectId} onClick={submit}>{busy ? 'Starting…' : 'Start run'}</Button>
        </div>
      </div>
    </div>
  )
}
