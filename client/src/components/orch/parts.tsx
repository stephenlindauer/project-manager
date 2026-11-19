import type { ReactNode } from 'react'
import type { OrchRun } from '../../types'

/**
 * Small pieces the orchestrator screens share. Colours follow the app's
 * assigned meanings: orange is "wants you", green is running or done, cyan is
 * selection, red is failing. Only a working stage moves.
 */

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const fmtSpend = (s: { tokens: number; usd: number }) =>
  `${fmtTokens(s.tokens)} tok${s.usd >= 0.005 ? ` · $${s.usd.toFixed(2)}` : ''}`

export function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const FINAL = new Set(['done', 'abandoned', 'released'])
export const isFinal = (r: OrchRun) => FINAL.has(r.state)

type Tone = 'attn' | 'ok' | 'muted' | 'bad' | 'accent'

/** One word for where a run stands, and the tone that goes with it. */
export function standing(r: OrchRun): { label: string; tone: Tone } {
  if (r.state === 'done') return { label: 'done', tone: 'ok' }
  if (r.state === 'abandoned') return { label: 'abandoned', tone: 'muted' }
  if (r.state === 'released') return { label: 'released', tone: 'muted' }
  if (r.state === 'paused') return { label: 'paused', tone: 'muted' }
  if (r.state === 'held') return { label: 'you have it', tone: 'accent' }
  if (r.state === 'waiting' || r.blocking) return { label: 'needs you', tone: 'attn' }
  if (r.working) return { label: 'working', tone: 'ok' }
  return { label: 'waiting', tone: 'muted' }
}

const TONE: Record<Tone, string> = {
  attn: 'text-attn border-attn/50', ok: 'text-ok border-ok/40', muted: 'text-muted border-line',
  bad: 'text-bad border-bad/50', accent: 'text-accent border-accent/50',
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`shrink-0 rounded border px-1.5 py-px font-mono text-[10px] ${TONE[tone]}`}>{children}</span>
}

/**
 * The pipeline as a row of marks: done, current, to come. The current stage
 * is orange when it waits on me, and is the one thing that pulses while a
 * session works.
 */
export function StageRail({ run, labels = false }: { run: OrchRun; labels?: boolean }) {
  const st = standing(run)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
      {run.stages.map((s, i) => {
        const past = i < run.stageIndex || run.state === 'done'
        const here = i === run.stageIndex && !isFinal(run)
        const color = past ? 'bg-ok/70' : here ? (st.tone === 'attn' ? 'bg-attn' : st.tone === 'ok' ? 'bg-accent' : 'bg-muted') : 'bg-line-bright'
        return (
          <span key={s.id} className="flex items-center gap-1" title={s.id}>
            <span className={`size-[7px] rounded-full ${color} ${here && run.working ? 'animate-pulse' : ''}`} />
            {(labels || here) && (
              <span className={`font-mono text-[10px] ${here ? 'text-ink' : past ? 'text-muted' : 'text-muted/60'}`}>{s.id}</span>
            )}
            {i < run.stages.length - 1 && <span className="h-px w-2 bg-line-bright" />}
          </span>
        )
      })}
    </div>
  )
}

export function Button({ children, onClick, tone = 'plain', disabled, title }: {
  children: ReactNode; onClick?: () => void; tone?: 'plain' | 'primary' | 'danger'; disabled?: boolean; title?: string
}) {
  const cls = {
    plain: 'border-line text-muted hover:border-accent hover:text-ink',
    primary: 'border-accent text-accent hover:bg-accent/10',
    danger: 'border-line text-muted hover:border-bad hover:text-bad',
  }[tone]
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`rounded border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[13px] ${cls}`}
    >{children}</button>
  )
}
