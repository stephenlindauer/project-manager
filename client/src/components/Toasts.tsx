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
  const setActiveNode = useStore((s) => s.setActiveNode)
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
          onOpen={() => {
            if (!t.nodeId) return
            // A Claude signal opens the Claude pane; a notice just selects the node.
            if (t.state) showNode(t.nodeId); else setActiveNode(t.nodeId)
            dismissToast(t.id)
          }}
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
  // A Claude signal carries `state`; a local notice carries `title`. The card
  // is the same shape for both so the stack reads as one thing.
  const waiting = toast.state === 'waiting'
  const tone = toast.state ? 'attn' : (toast.tone ?? 'info')
  const heading = toast.state ? ATTENTION_LABEL[toast.state] : (toast.title ?? '')
  const openable = Boolean(toast.nodeId && node)
  const color = { attn: 'text-attn', ok: 'text-ok', bad: 'text-bad', info: 'text-accent' }[tone]
  const bar = { attn: 'bg-attn', ok: 'bg-ok', bad: 'bg-bad', info: 'bg-accent' }[tone]
  const hover = { attn: 'hover:border-attn', ok: 'hover:border-ok', bad: 'hover:border-bad', info: 'hover:border-accent' }[tone]

  return (
    <div
      onClick={openable ? onOpen : undefined}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onKeyDown={(e) => { if (openable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      title={openable ? 'Open this worktree' : undefined}
      className={[
        'pointer-events-auto cursor-default overflow-hidden rounded border bg-panel/95 backdrop-blur-sm',
        'shadow-[0_8px_28px_rgba(0,0,0,0.6)] transition-colors',
        openable ? hover : '',
        waiting ? 'border-attn/70' : 'border-line',
        toast.leaving ? 'toast-out' : 'toast-in',
      ].join(' ')}
    >
      {/* A hairline in the tone colour, so the card reads as what it is before
          any of its text has been. */}
      <div className={`h-[2px] w-full ${bar} ${waiting ? '' : 'opacity-50'}`} />

      <div className="flex items-start gap-2 px-2.5 py-2">
        <span className={`mt-[5px] size-[7px] shrink-0 rounded-full ${bar} ${waiting ? 'attn-ping' : ''}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[12px] text-ink">
              {node ? node.label : (toast.state ? 'Claude' : heading)}
            </span>
            {node?.branch && !node.isMain && (
              <span className="truncate font-mono text-[10px] text-neon-pink/90">⑂ {node.branch}</span>
            )}
          </div>

          {(node || toast.state) && <div className={`mt-0.5 text-[11px] ${color}`}>{heading}</div>}

          {toast.message && (
            <div className="mt-1 line-clamp-3 whitespace-pre-line text-[11px] leading-snug text-muted">
              {toast.message}
            </div>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          title={toast.state ? 'Dismiss (the sidebar badge stays)' : 'Dismiss'}
          aria-label="Dismiss notification"
          className="-mr-0.5 -mt-0.5 shrink-0 px-1 text-[12px] leading-none text-muted hover:text-ink"
        >✕</button>
      </div>
    </div>
  )
}
