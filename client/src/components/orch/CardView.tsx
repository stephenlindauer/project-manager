import { useState } from 'react'
import { orchApi } from '../../api'
import { useStore } from '../../store'
import type { OrchCard, OrchRun } from '../../types'
import { Button, ago } from './parts'

const KIND: Record<string, string> = {
  gate: 'gate', question: 'question', permission: 'permission', paused: 'paused', effect: 'check', fix: 'fix ready',
}

/** How much of a card shows before the fold. A gate is one decision, not a document. */
const FOLD_WORDS = 150

/**
 * One thing waiting on me: a single decision, the recommended option first.
 * Anything past ~150 words sits behind a toggle — a card that needs scrolling
 * to find its buttons gets rubber-stamped.
 */
export function CardView({ card, run, showRun = true }: { card: OrchCard; run: OrchRun | null; showRun?: boolean }) {
  const openRun = useStore((s) => s.openRun)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const continueByHand = useStore((s) => s.continueByHand)
  const [picks, setPicks] = useState<Record<string, string>>(() => Object.fromEntries((card.items ?? []).map((i) => [i.id, i.recommended])))

  const words = card.body.split(/\s+/)
  const long = words.length > FOLD_WORDS
  const body = long && !open ? `${words.slice(0, FOLD_WORDS).join(' ')}…` : card.body

  const choices = [...card.choices].sort((a, b) => Number(b.id === card.recommended) - Number(a.id === card.recommended))
  const send = async (choice: string, withNote = true) => {
    if (choice === 'send-back' && !note.trim()) { setError('Say what to change, then send it back.'); return }
    setBusy(true); setError(null)
    try {
      const r = await orchApi.answer(card.runId, card.id, choice, withNote ? note.trim() || undefined : undefined, card.items ? picks : undefined)
      if (choice === 'take-over') continueByHand(r.resume)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className={`rounded border bg-panel ${card.blocking ? 'border-attn/50' : 'border-line'}`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px]">
        <span className={`font-mono ${card.blocking ? 'text-attn' : 'text-muted'}`}>{KIND[card.type] ?? card.type}</span>
        {showRun && run && (
          <button onClick={() => openRun(run.id)} className="min-w-0 truncate text-muted hover:text-accent" title="Open this run">
            {run.repoName} · {run.task.title}
          </button>
        )}
        {card.stageId && <span className="font-mono text-muted/70">{card.stageId}</span>}
        <span className="ml-auto shrink-0 text-muted/70">{ago(card.createdAt)}</span>
      </div>

      <div className="px-3 py-2.5">
        <div className="text-[13px] leading-snug text-ink">{card.title}</div>
        {body && <div className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">{body}</div>}
        {long && (
          <button onClick={() => setOpen(!open)} className="mt-1 text-[11px] text-accent hover:underline">
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
        {card.detail && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-accent">Detail</summary>
            <pre className="mt-1.5 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 font-mono text-[11px] leading-snug text-muted">{card.detail}</pre>
          </details>
        )}

        {card.items && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {card.items.map((it) => (
              <div key={it.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-line bg-bg px-2 py-1.5">
                <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-snug text-ink">{it.label}</span>
                {it.blocked && <span className="font-mono text-[10px] text-warn" title={it.reasons.join('\n')}>blocked: {it.reasons[0] ?? 'by the validator'}</span>}
                <span className="flex shrink-0 gap-1">
                  {it.choices.map((c) => (
                    <button
                      key={c} onClick={() => setPicks((p) => ({ ...p, [it.id]: c }))}
                      aria-pressed={picks[it.id] === c}
                      className={`rounded border px-2 py-0.5 text-[11px] pointer-coarse:px-2.5 pointer-coarse:py-1.5 ${picks[it.id] === c ? 'border-accent text-accent' : 'border-line text-muted hover:text-ink'}`}
                    >{c}</button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}

        {(card.freeText || card.type === 'gate' || card.type === 'fix') && (
          <input
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={card.freeText ? 'Or answer in your own words, then Enter' : 'Note — required to send back'}
            onKeyDown={(e) => { if (e.key === 'Enter' && card.freeText && note.trim()) send(note.trim(), false) }}
            className="mt-2.5 w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-muted/60 focus:border-accent max-md:text-[16px]"
          />
        )}

        <div className="mt-2.5 flex flex-wrap gap-2">
          {choices.map((c) => (
            <Button key={c.id} tone={c.id === card.recommended ? 'primary' : c.id === 'abandon' ? 'danger' : 'plain'} disabled={busy} onClick={() => send(c.id)}>
              {c.label}{c.id === card.recommended ? ' ✓' : ''}
            </Button>
          ))}
        </div>
        {error && <div className="mt-2 text-[11px] text-bad">{error}</div>}
      </div>
    </div>
  )
}
