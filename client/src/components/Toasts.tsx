import { useStore } from '../store'
import { ATTENTION_LABEL } from './Sidebar'
import type { Node, Toast } from '../types'

/**
 * Notifications from Claude Code's Stop/Notification hooks, stacked in the top
 * right and sliding in from the right edge.
 *
 * Clicking one is the whole point: it selects that project and opens its Claude
 * tab, which is also what acknowledges the signal server-side. The ✕ dismisses
 * the toast *only* — the sidebar pip stays until you actually look at the
 * session, so a notice swatted away in passing is never the last trace of it.
 *
 * Sits above the scanline overlay (`#root::before`, z-100) — a notification
 * rendered under the CRT wash would be the one thing in the app you can't read.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const nodes = useStore((s) => s.nodes)
  const showNode = useStore((s) => s.showNode)
  const dismissToast = useStore((s) => s.dismissToast)

  if (!toasts.length) return null

  // Offset below the tab bar rather than flush to the corner: the reconnect,
  // kill and night controls live up there, and a notification that covers them
  // is worse than one sitting three rows lower.
  return (
    <div
      className="pointer-events-none fixed right-3 top-[46px] z-[110] flex w-[300px] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          node={nodes.find((n) => n.id === t.nodeId) ?? null}
          onOpen={() => { showNode(t.nodeId); dismissToast(t.id) }}
          onDismiss={() => dismissToast(t.id)}
        />
      ))}
    </div>
  )
}

function ToastCard({ toast, node, onOpen, onDismiss }: {
  toast: Toast
  node: Node | null
  onOpen: () => void
  onDismiss: () => void
}) {
  const waiting = toast.state === 'waiting'

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title="Open this Claude session"
      className={[
        'pointer-events-auto cursor-default overflow-hidden rounded border bg-panel/95 backdrop-blur-sm',
        'shadow-[0_8px_28px_rgba(0,0,0,0.6)] transition-colors hover:border-attn',
        waiting ? 'border-attn/70' : 'border-line',
        toast.leaving ? 'toast-out' : 'toast-in',
      ].join(' ')}
    >
      {/* A hairline in the accent colour, so the card reads as "Claude" before
          any of its text has been. */}
      <div className={`h-[2px] w-full ${waiting ? 'bg-attn' : 'bg-attn/40'}`} />

      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={`mt-[5px] size-[7px] shrink-0 rounded-full bg-attn ${waiting ? 'attn-ping' : ''}`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[12px] text-ink">
              {node ? node.label : 'Claude'}
            </span>
            {node?.branch && !node.isMain && (
              <span className="truncate font-mono text-[10px] text-neon-pink/90">⑂ {node.branch}</span>
            )}
          </div>

          <div className="mt-0.5 text-[11px] text-attn">{ATTENTION_LABEL[toast.state]}</div>

          {toast.message && (
            <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted">
              {toast.message}
            </div>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          title="Dismiss (the sidebar marker stays)"
          aria-label="Dismiss notification"
          className="-mr-0.5 -mt-0.5 shrink-0 px-1 text-[12px] leading-none text-muted hover:text-ink"
        >✕</button>
      </div>
    </div>
  )
}
