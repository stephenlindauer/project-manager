const UNITS: [limit: number, div: number, suffix: string][] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86_400, 3600, 'h'],
  [604_800, 86_400, 'd'],
  [2_629_800, 604_800, 'w'],
  [31_557_600, 2_629_800, 'mo'],
  [Infinity, 31_557_600, 'y'],
]

/** Compact relative time ("2m", "3d", "1y"). Accepts an ISO string or epoch ms. */
export function shortAgo(at?: string | number | null): string {
  if (!at) return ''
  const then = typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(then)) return ''
  const secs = Math.max(0, (Date.now() - then) / 1000)
  for (const [limit, div, suffix] of UNITS) {
    if (secs < limit) return `${Math.floor(secs / div)}${suffix}`
  }
  return ''
}

/** Same scale, phrased for prose ("2m ago"). */
export const ago = (at?: string | number | null) => {
  const s = shortAgo(at)
  return s ? `${s} ago` : '—'
}
