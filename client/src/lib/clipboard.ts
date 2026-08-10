/**
 * Clipboard writes for the terminal panes.
 *
 * The async Clipboard API is the real path, but it is refused when the document
 * is not focused and (in Firefox) without a recent user gesture. Selecting text
 * is a gesture, so the common case works; the execCommand fallback covers the
 * rest. It is deprecated but still the only synchronous option.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* fall through */ }

  try {
    const el = document.createElement('textarea')
    el.value = text
    // Off-screen but still selectable — `display: none` cannot be selected, and
    // a visible element would steal focus and scroll the page.
    el.style.cssText = 'position:fixed;top:-9999px;opacity:0'
    el.setAttribute('readonly', '')
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  } catch {
    return false
  }
}

/** Cap on an OSC 52 payload, so a runaway program can't stall the tab. */
const MAX_OSC52_BYTES = 1_000_000

/**
 * Decode an OSC 52 payload (`<targets>;<base64>`) into text.
 *
 * Returns null for anything we refuse to act on: a read request (`?`), an empty
 * or oversized payload, or invalid base64. Read requests are always refused —
 * answering one would hand the clipboard's contents to whatever is running in
 * the terminal.
 */
export function decodeOsc52(payload: string): string | null {
  const semi = payload.indexOf(';')
  if (semi === -1) return null
  const b64 = payload.slice(semi + 1)
  if (!b64 || b64 === '?' || b64.length > MAX_OSC52_BYTES) return null

  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes) || null
  } catch {
    return null
  }
}
