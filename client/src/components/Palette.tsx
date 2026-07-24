import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Node } from '../types'

/** Subsequence fuzzy match; returns a score where lower is a tighter match. */
function fuzzy(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    score += lastHit === -1 ? ti : ti - lastHit - 1
    lastHit = ti
    qi++
  }
  return qi === q.length ? score : null
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPalette)
  const nodes = useStore((s) => s.nodes)
  const setActiveNode = useStore((s) => s.setActiveNode)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setQuery(''); setIndex(0); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  const matches = useMemo(() => {
    const scored: { node: Node; score: number }[] = []
    for (const n of nodes) {
      const haystack = [n.group, n.name, n.branch, n.label].filter(Boolean).join(' ')
      const score = fuzzy(query, haystack)
      if (score !== null) scored.push({ node: n, score })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, 40).map((s) => s.node)
  }, [nodes, query])

  useEffect(() => { setIndex(0) }, [query])
  if (!open) return null

  const choose = (n?: Node) => {
    if (n) setActiveNode(n.id)
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-accent/40 bg-panel shadow-[0_0_40px_-8px_var(--color-accent)]"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); choose(matches[index]) }
          }}
          placeholder="Jump to project or branch…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-muted"
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {matches.map((n, i) => (
            <button
              key={n.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(n)}
              className={`relative flex w-full items-center gap-2 px-4 py-1.5 text-left ${
                i === index ? 'bg-accent/15 text-ink' : 'text-ink/80'
              }`}
            >
              {n.group && <span className="text-muted">{n.group}/</span>}
              <span>{n.name}</span>
              {!n.isMain && <span className="font-mono text-[11px] text-neon-pink">⑂ {n.label}</span>}
              <span className="ml-auto truncate font-mono text-[10px] text-muted/60">{n.cwd}</span>
            </button>
          ))}
          {matches.length === 0 && <div className="px-4 py-3 text-muted">No matches</div>}
        </div>
      </div>
    </div>
  )
}
