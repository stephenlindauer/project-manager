import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore } from '../store'
import type { Node, Script } from '../types'
import { Terminal } from './Terminal'

/**
 * Start/stop dev servers and scripts discovered from the project's manifest.
 * Detected ports are surfaced as clickable links so a running dev server is one
 * click from the browser.
 */
export function TasksTab({ node }: { node: Node }) {
  const [scripts, setScripts] = useState<Script[]>([])
  const [open, setOpen] = useState<string | null>(null)
  // `useShallow` is required: zustand v5 reads the selector through
  // useSyncExternalStore, so returning a fresh array from `.filter()` on every
  // read makes React see a new snapshot each render and loop until the tab dies.
  const runners = useStore(useShallow((s) => s.runners.filter((r) => r.nodeId === node.id)))

  useEffect(() => {
    setOpen(null)
    api.tasks(node.id).then((d) => setScripts(d.scripts)).catch(() => setScripts([]))
  }, [node.id])

  const runnerFor = (name: string) => runners.find((r) => r.name === name)

  return (
    <div className="flex h-full">
      <div className="w-[290px] shrink-0 overflow-y-auto border-r border-line">
        <div className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
          Scripts
        </div>
        {scripts.length === 0 && (
          <div className="p-4 text-muted">No scripts detected in this project.</div>
        )}
        {scripts.map((s) => {
          const r = runnerFor(s.name)
          return (
            <div
              key={`${s.source}:${s.name}`}
              className={`border-b border-line/50 px-3 py-2 ${open === s.name ? 'bg-panel-2' : ''}`}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOpen(s.name)}
                  className="truncate text-left text-[12px] hover:text-accent"
                >{s.name}</button>
                {r?.running && <span className="size-1.5 shrink-0 rounded-full bg-ok" />}
                <button
                  onClick={() =>
                    r?.running ? api.stopTask(node.id, s.name)
                      : api.startTask(node.id, s.name, s.command).then(() => setOpen(s.name))
                  }
                  className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                    r?.running
                      ? 'border-bad/50 text-bad hover:bg-bad/10'
                      : 'border-line text-muted hover:border-accent hover:text-ink'
                  }`}
                >{r?.running ? 'Stop' : 'Run'}</button>
              </div>
              <div className="truncate font-mono text-[10px] text-muted">{s.command}</div>
              {r && r.ports.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.ports.map((p) => (
                    <a
                      key={p}
                      href={`http://localhost:${p}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/25"
                    >:{p}</a>
                  ))}
                </div>
              )}
              {r && !r.running && r.exitCode !== null && (
                <div className={`mt-0.5 text-[10px] ${r.exitCode === 0 ? 'text-muted' : 'text-bad'}`}>
                  exited {r.exitCode}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="min-w-0 flex-1">
        {open ? (
          <Terminal key={`${node.id}:${open}`} nodeId={node.id} kind="shell" task={open} hidden={false} />
        ) : (
          <div className="p-6 text-muted">Select a script to view its output.</div>
        )}
      </div>
    </div>
  )
}
