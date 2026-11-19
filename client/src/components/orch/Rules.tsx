import { useEffect, useMemo, useState } from 'react'
import { orchApi } from '../../api'
import { useStore } from '../../store'
import type { OrchRules } from '../../types'

/**
 * The effective settings, read-only, with the file each value came from.
 *
 * There is no editor on purpose: config is files on the machine. This screen
 * answers "what will actually happen, and why" — which layer set a value,
 * which adapter file is in use, and who owns each side effect in each
 * pipeline.
 */
export function Rules() {
  const projects = useStore((s) => s.projects)
  const repos = useMemo(() => projects.filter((p) => p.isGit).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const [projectId, setProjectId] = useState('')
  const [rules, setRules] = useState<OrchRules | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let gone = false
    orchApi.rules(projectId || null).then((r) => { if (!gone) setRules(r) }).catch((e) => { if (!gone) setError(e.message) })
    return () => { gone = true }
  }, [projectId])

  if (error) return <div className="p-5 text-[12px] text-bad">{error}</div>
  if (!rules) return <div className="p-5 text-[12px] text-muted">Loading…</div>

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4 p-3 md:p-5">
      <div className="text-[11px] text-muted">
        Config folder: <span className="font-mono text-ink">{rules.dir}</span>
      </div>
      {rules.errors.length > 0 && (
        <div className="rounded border border-bad/50 bg-panel px-3 py-2 text-[12px] text-bad">
          {rules.errors.map((e) => <div key={e}>{e}</div>)}
        </div>
      )}

      <Block title="Pipelines">
        <div className="flex flex-col gap-3">
          {rules.pipelines.map((p) => (
            <div key={p.name}>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-ink">{p.name}</span>
                <span className="font-mono text-[10px] text-muted/70">{p.origin}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-muted">
                {p.stages.map((s, i) => (
                  <span key={s.id}>
                    <span className={s.gate ? 'text-attn' : s.skill ? 'text-neon-purple' : 'text-muted'}>{s.id}{s.skill ? ` (/${s.skill})` : ''}</span>
                    {i < p.stages.length - 1 ? ' → ' : ''}
                  </span>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted/80">
                {Object.entries(p.owners).map(([effect, owners]) => (
                  <span key={effect}>{effect}: <span className={owners.length === 1 ? 'text-ok' : owners.length ? 'text-bad' : 'text-muted/60'}>{owners.join(', ') || 'nobody'}</span></span>
                ))}
              </div>
              {p.errors.map((e) => <div key={e} className="mt-1 text-[11px] text-bad">Refused: {e}</div>)}
            </div>
          ))}
        </div>
      </Block>

      <Block title="Repository">
        <select
          value={projectId} onChange={(e) => setProjectId(e.target.value)}
          className="mb-2 rounded border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent max-md:text-[16px]"
        >
          <option value="">Pick a repository…</option>
          {repos.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {rules.repo && <Values values={rules.repo.values} provenance={rules.repo.provenance} />}
      </Block>

      <Block title="Machine"><Values values={rules.machine.values} provenance={rules.machine.provenance} /></Block>

      <Block title="Permission sets" fold>
        {Object.entries(rules.permissionSets).map(([name, set]) => (
          <div key={name} className="mb-3 last:mb-0">
            <div className="font-mono text-[12px] text-ink">{name}</div>
            {set.error && <div className="text-[11px] text-bad">{set.error}</div>}
            <div className="mt-1 break-words font-mono text-[10px] leading-relaxed text-ok/80">{set.allow?.join('  ')}</div>
            <div className="mt-1 break-words font-mono text-[10px] leading-relaxed text-bad/80">{set.deny?.join('  ')}</div>
          </div>
        ))}
      </Block>

      <Block title="Adapters and stage kinds" fold>
        {(['sources', 'stages', 'checks'] as const).map((group) => (
          <div key={group} className="mb-3 last:mb-0">
            <div className="text-[11px] uppercase tracking-wider text-muted">{group}</div>
            {rules[group].map((a) => (
              <div key={a.name} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                <span className="text-ink">{a.name}</span>
                <span className="text-muted/70">{a.origin}</span>
                {a.wraps && <span className="text-neon-purple">wraps {a.wraps}</span>}
                {a.error && <span className="text-bad">{a.error}</span>}
              </div>
            ))}
          </div>
        ))}
      </Block>
    </div>
  )
}

function Block({ title, children, fold = false }: { title: string; children: React.ReactNode; fold?: boolean }) {
  const head = 'px-3 py-2 text-[11px] uppercase tracking-wider text-muted'
  if (fold) {
    return (
      <details className="rounded border border-line bg-panel">
        <summary className={`cursor-pointer ${head}`}>{title}</summary>
        <div className="border-t border-line px-3 py-2.5">{children}</div>
      </details>
    )
  }
  return (
    <section className="rounded border border-line bg-panel">
      <h2 className={`border-b border-line ${head}`}>{title}</h2>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

/** Flatten a settings object to `a.b.c  value  ← file` rows. */
function Values({ values, provenance }: { values: Record<string, unknown>; provenance: Record<string, string> }) {
  const rows = useMemo(() => {
    const out: { key: string; value: string; from: string }[] = []
    const walk = (v: unknown, key: string) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const entries = Object.entries(v as Record<string, unknown>)
        // Whole sub-objects set in one place (a pipeline, a source) read better as one row.
        if (key && provenance[key]) { out.push({ key, value: JSON.stringify(v), from: provenance[key] }); return }
        for (const [k, x] of entries) walk(x, key ? `${key}.${k}` : k)
        return
      }
      if (key.startsWith('pipelines.')) return // shown above, resolved
      out.push({ key, value: v === null ? 'off' : JSON.stringify(v), from: provenance[key] ?? '' })
    }
    walk(values, '')
    return out
  }, [values, provenance])

  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] leading-relaxed">
          <span className="text-muted">{r.key}</span>
          <span className="min-w-0 break-all text-ink">{r.value}</span>
          <span className={`ml-auto shrink-0 text-[10px] ${r.from === 'app defaults' ? 'text-muted/50' : 'text-accent/80'}`}>{r.from}</span>
        </div>
      ))}
    </div>
  )
}
