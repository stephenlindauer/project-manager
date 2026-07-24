import type { GitStatus } from '../types'

/**
 * Compact git state: dirty-file count, ahead/behind arrows, conflict marker.
 * Rendered in the sidebar (compact) and in the Summary header (full).
 */
export function StatusBadges({ status, compact }: { status: GitStatus | null; compact?: boolean }) {
  if (!status) return null
  const dirty = status.staged + status.unstaged + status.untracked

  return (
    <span className={`flex items-center gap-1 font-mono ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
      {status.conflicted > 0 && (
        <span className="text-bad" title={`${status.conflicted} conflicted`}>!{status.conflicted}</span>
      )}
      {dirty > 0 && (
        <span
          className="text-warn"
          title={`${status.staged} staged · ${status.unstaged} modified · ${status.untracked} untracked`}
        >●{dirty}</span>
      )}
      {status.ahead > 0 && <span className="text-ok" title={`${status.ahead} ahead`}>↑{status.ahead}</span>}
      {status.behind > 0 && <span className="text-accent" title={`${status.behind} behind`}>↓{status.behind}</span>}
      {!compact && status.branch && <span className="text-muted">{status.branch}</span>}
    </span>
  )
}
