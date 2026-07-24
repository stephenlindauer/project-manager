import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ChangedFile, Changes, Node } from '../types'

const LABEL: Record<string, string> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked', T: 'typechange',
}
const COLOR: Record<string, string> = {
  M: 'text-warn', A: 'text-ok', D: 'text-bad', R: 'text-accent', C: 'text-accent', '?': 'text-muted',
}

export function ChangesTab({ node }: { node: Node }) {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [selected, setSelected] = useState<{ file: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<string>('')

  const reload = () =>
    api.changes(node.id).then(setChanges).catch(() => setChanges(null))

  useEffect(() => { setSelected(null); setDiff(''); reload() }, [node.id])

  useEffect(() => {
    if (!selected) { setDiff(''); return }
    let live = true
    api.diff(node.id, selected.file, selected.staged)
      .then((d) => { if (live) setDiff(d.diff) })
      .catch(() => { if (live) setDiff('') })
    return () => { live = false }
  }, [node.id, selected])

  if (!changes) return <div className="p-6 text-muted">Loading…</div>

  const total = changes.staged.length + changes.unstaged.length + changes.untracked.length

  return (
    <div className="flex h-full">
      <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {total} change{total === 1 ? '' : 's'}
          </span>
          <button
            onClick={reload}
            className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
          >↻</button>
        </div>
        {changes.summary && (
          <div className="border-b border-line px-3 py-1.5 font-mono text-[10px] text-muted">
            {changes.summary}
          </div>
        )}

        <FileGroup title="Staged" files={changes.staged} staged selected={selected} onSelect={setSelected} />
        <FileGroup title="Modified" files={changes.unstaged} selected={selected} onSelect={setSelected} />
        <FileGroup title="Untracked" files={changes.untracked} selected={selected} onSelect={setSelected} />

        {total === 0 && (
          <div className="p-4 text-center text-muted">Working tree is clean</div>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-auto">
        {diff ? (
          <Diff text={diff} />
        ) : (
          <div className="p-6 text-muted">
            {selected ? 'No textual diff (binary or empty file).' : 'Select a file to view its diff.'}
          </div>
        )}
      </div>
    </div>
  )
}

function FileGroup({ title, files, staged, selected, onSelect }: {
  title: string
  files: ChangedFile[]
  staged?: boolean
  selected: { file: string; staged: boolean } | null
  onSelect: (s: { file: string; staged: boolean }) => void
}) {
  if (!files.length) return null
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
        {title} · {files.length}
      </div>
      {files.map((f) => {
        const active = selected?.file === f.path && selected.staged === Boolean(staged)
        return (
          <button
            key={`${title}:${f.path}`}
            onClick={() => onSelect({ file: f.path, staged: Boolean(staged) })}
            className={`flex w-full items-center gap-2 px-3 py-[3px] text-left text-[12px] ${
              active ? 'bg-accent/15' : 'hover:bg-panel-2'
            }`}
            title={`${LABEL[f.status] ?? f.status} · ${f.path}`}
          >
            <span className={`w-3 shrink-0 font-mono ${COLOR[f.status] ?? 'text-muted'}`}>{f.status}</span>
            {/*
              `dir="rtl"` puts the ellipsis at the start so the filename stays
              visible on long paths. The inner <bdi> is required: without it,
              bidi reordering moves a leading dot to the end and ".gitignore"
              renders as "gitignore.".
            */}
            <span className="truncate" dir="rtl"><bdi>{f.path}</bdi></span>
          </button>
        )
      })}
    </div>
  )
}

/** Minimal unified-diff renderer: enough to review a change without leaving the app. */
function Diff({ text }: { text: string }) {
  return (
    <pre className="min-w-full p-3 font-mono text-[11.5px] leading-[1.5]">
      {text.split('\n').map((line, i) => {
        let cls = 'text-ink/80'
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-muted'
        else if (line.startsWith('@@')) cls = 'text-accent bg-accent/10'
        else if (line.startsWith('+')) cls = 'text-ok bg-ok/10'
        else if (line.startsWith('-')) cls = 'text-bad bg-bad/10'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-muted/60'
        return <div key={i} className={`${cls} whitespace-pre px-1`}>{line || ' '}</div>
      })}
    </pre>
  )
}
