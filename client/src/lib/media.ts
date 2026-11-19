import { useSyncExternalStore } from 'react'

/**
 * Phone layout: below Tailwind's `md` (48rem), the nav and the panel each take
 * the whole screen instead of sitting side by side. Keep in step with the
 * `max-md:` classes that do the rest of the work in CSS.
 */
const PHONE = '(max-width: 47.999rem)'
const query = typeof window !== 'undefined' ? window.matchMedia(PHONE) : null

const subscribe = (fn: () => void) => {
  query?.addEventListener('change', fn)
  return () => query?.removeEventListener('change', fn)
}

export const isPhone = () => Boolean(query?.matches)
export const usePhone = () => useSyncExternalStore(subscribe, isPhone)
