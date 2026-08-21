import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { decodeOsc52, writeClipboard } from '../lib/clipboard'
import { useStore } from '../store'

/** Retro-neon ANSI palette, matched to the app's accent colours in index.css. */
const XTERM_THEME = {
  background: '#08080a',
  foreground: '#e9e9f2',
  cursor: '#00e5ff',
  cursorAccent: '#08080a',
  selectionBackground: 'rgba(0, 229, 255, 0.28)',

  black: '#17171e',
  red: '#ff3d64',
  green: '#2fffa4',
  yellow: '#ffc247',
  blue: '#00e5ff',
  magenta: '#ff2d8f',
  cyan: '#5ef0ff',
  white: '#c9c9d8',

  brightBlack: '#4b4b5c',
  brightRed: '#ff6b88',
  brightGreen: '#6effc0',
  brightYellow: '#ffd782',
  brightBlue: '#6ceeff',
  brightMagenta: '#ff6bb0',
  brightCyan: '#9df6ff',
  brightWhite: '#f4f4fb',
}

/** How much of the day palette's brightness night mode keeps. Matches the ratio
 *  the `:root[data-night]` tokens in index.css use (#e9e9f2 ink → #7a7a85). */
const NIGHT_DIM = 0.52

/**
 * A dimmed copy of xterm's colours 16-255.
 *
 * The named `ITheme` fields below only reach the first 16 ANSI slots and the
 * defaults. Everything a TUI emits as `\x1b[38;5;Nm` — which is most of what
 * Claude Code and any syntax highlighter actually draw with — indexes into this
 * extended palette instead, and without `extendedAnsi` it renders from xterm's
 * built-in table at full brightness. Colour 231 is pure white, so night mode
 * without this is still a white screen.
 *
 * It also catches truecolour in practice: tmux advertises `tmux-256color` with
 * no RGB capability here, so it downsamples 24-bit output into this same space.
 *
 * The layout is fixed: 16-231 are a 6x6x6 cube over CUBE_LEVELS, 232-255 are 24
 * greys. Scaling by NIGHT_DIM puts 256-colour white at the same brightness as
 * `--color-ink`, so terminal text matches the rest of the app.
 */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function dimmedExtendedAnsi(dim: number): string[] {
  const hex = (...rgb: number[]) =>
    '#' + rgb.map((v) => Math.round(v * dim).toString(16).padStart(2, '0')).join('')

  const out: string[] = []
  for (const r of CUBE_LEVELS)
    for (const g of CUBE_LEVELS)
      for (const b of CUBE_LEVELS) out.push(hex(r, g, b))
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    out.push(hex(v, v, v))
  }
  return out
}

/**
 * The same palette at ~50% brightness, for night mode. xterm's colours are set
 * in JS, so they cannot ride on the CSS tokens in index.css the way the rest of
 * the app does — this table has to be kept in step with the one above, and with
 * the `:root[data-night]` block, by hand.
 *
 * The day theme deliberately has no `extendedAnsi`: xterm rebuilds its palette
 * from the defaults on every theme change, so omitting it restores the standard
 * 256 colours rather than leaving the dimmed ones behind.
 */
const XTERM_THEME_NIGHT = {
  extendedAnsi: dimmedExtendedAnsi(NIGHT_DIM),

  background: '#030304',
  foreground: '#7a7a85',
  cursor: '#007a8a',
  cursorAccent: '#030304',
  selectionBackground: 'rgba(0, 229, 255, 0.14)',

  black: '#0c0c10',
  red: '#852034',
  green: '#198656',
  yellow: '#866625',
  blue: '#007a8a',
  magenta: '#85174a',
  cyan: '#317e86',
  white: '#6a6a71',

  brightBlack: '#282830',
  brightRed: '#863847',
  brightGreen: '#3a8664',
  brightYellow: '#867044',
  brightBlue: '#387d86',
  brightMagenta: '#86385c',
  brightCyan: '#528186',
  brightWhite: '#808084',
}

const themeFor = (night: boolean) => (night ? XTERM_THEME_NIGHT : XTERM_THEME)

/** A hidden element measures as zero; anything below this is not a real size. */
const MIN_COLS = 40
const MIN_ROWS = 10

/** Reconnect backoff: first retry is quick (server restarts are ~1-2s), capped. */
const RECONNECT_BASE_MS = 400
const RECONNECT_MAX_MS = 8000

/**
 * An xterm view bound to a server-side session over `/pty`.
 *
 * The session is not created until the pane is actually on screen. A terminal
 * mounted inside `display: none` measures as zero, and a tmux session created at
 * that size paints its whole UI at ~20 columns — output that stays mangled in
 * tmux's scrollback long after the pane is resized.
 *
 * Once created the connection is kept open even when the tab is hidden, so
 * switching tabs never drops the session or reflows the shell.
 */
export function Terminal({
  nodeId, kind, hidden, task,
}: {
  nodeId: string
  kind: 'claude' | 'shell'
  hidden: boolean
  task?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Whether this pane is genuinely on screen — reported to the server so a
  // Claude hook that fires while you are watching doesn't notify you about what
  // is already in front of you. Held in a ref so a reconnect can re-send it.
  const viewingRef = useRef(!hidden)
  const typePendingRef = useRef<(() => void) | null>(null)

  const night = useStore((s) => s.night)

  // Latches on the first time this pane is shown, and never goes back.
  const [activated, setActivated] = useState(!hidden)
  useEffect(() => { if (!hidden) setActivated(true) }, [hidden])

  useEffect(() => {
    if (!activated) return
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20_000,
      theme: themeFor(useStore.getState().night),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    // Let the app's global ⌥-arrow / ⌘K shortcuts win over the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return false
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') return false
      // ⌘B toggles the nav. ⌃B is left alone — it is tmux's prefix.
      if (e.metaKey && !e.ctrlKey && e.code === 'KeyB') return false
      return true
    })

    /*
      Copy-on-select, over two paths, because tmux and xterm each own the mouse
      in different situations.

      1. tmux (the usual one): `mouse on` means tmux receives the drag and paints
         its own highlight, so xterm never makes a browser selection — the text
         lands in tmux's paste buffer, out of the browser's reach. With
         `set-clipboard on` (set in terminals.js) tmux also emits the copy as an
         OSC 52 escape, which is what this handler turns into a clipboard write.
      2. xterm's own selection: shift-drag forces a local selection past tmux's
         mouse tracking, and the raw-pty fallback has no mouse tracking at all.
         Copy on mouseup rather than on every selection-change event, so a drag
         is one clipboard write and it happens inside the user gesture.
    */
    const oscHandler = term.parser.registerOscHandler(52, (payload) => {
      const text = decodeOsc52(payload)
      if (text) void writeClipboard(text)
      return true // handled either way; never answer a read request
    })

    const copySelection = () => {
      const sel = term.getSelection()
      if (sel) void writeClipboard(sel)
    }
    host.addEventListener('mouseup', copySelection)

    /** Fit only when the pane is laid out and the result is a plausible size. */
    const fitIfMeasurable = () => {
      if (!host.offsetParent || host.clientWidth < 1 || host.clientHeight < 1) return false
      try { fit.fit() } catch { return false }
      return term.cols >= MIN_COLS && term.rows >= MIN_ROWS
    }

    // The xterm instance lives for the whole effect; only the socket reconnects,
    // so a dropped connection never wipes the screen. `onData`/`sendResize` read
    // the *current* socket through the ref rather than closing over one instance.
    let disposed = false
    let retry = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let noticeShown = false // the "[disconnected]" line, written at most once per gap

    const sendResize = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    const connect = () => {
      if (disposed) return
      const sized = fitIfMeasurable()
      const params = new URLSearchParams({ node: nodeId, kind })
      // Only claim a size we actually measured; otherwise let the server keep its
      // default until the first real resize arrives.
      if (sized) {
        params.set('cols', String(term.cols))
        params.set('rows', String(term.rows))
      }
      if (task) params.set('task', task)

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/pty?${params}`)
      wsRef.current = ws

      ws.onopen = () => {
        retry = 0
        if (noticeShown) {
          term.writeln('\r\n\x1b[92m[reconnected]\x1b[0m')
          noticeShown = false
        }
        fitIfMeasurable()
        sendResize()
        ws.send(JSON.stringify({ type: 'view', active: viewingRef.current }))
        typePending()
      }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        // `replay` is the raw-pty fallback's full scrollback. On a reconnect the
        // screen already holds that content, so reset before writing it back to
        // avoid duplication. tmux never sends replay — it repaints on attach.
        if (msg.type === 'replay') { term.reset(); term.write(msg.data) }
        else if (msg.type === 'data') term.write(msg.data)
        else if (msg.type === 'exit') term.writeln('\r\n\x1b[90m[session ended]\x1b[0m')
        else if (msg.type === 'error') term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`)
      }
      ws.onclose = () => {
        wsRef.current = null
        if (disposed) return
        if (!noticeShown) {
          term.writeln('\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m')
          noticeShown = true
        }
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** retry, RECONNECT_MAX_MS)
        retry++
        reconnectTimer = setTimeout(connect, delay + Math.random() * 250)
      }
      // onerror is always followed by onclose, which owns the reconnect.
      ws.onerror = () => {}
    }

    /**
     * "Start in Claude" from the Soon tab queues a prompt for this node; it is
     * typed the moment a socket is open, not submitted - the person reads it
     * and presses Enter. A brand-new tmux session is still booting `claude` at
     * this point, and a pty buffers typed-ahead input, so the text lands in
     * the prompt once it appears rather than in a shell underneath it.
     */
    const typePending = () => {
      if (kind !== 'claude') return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const text = useStore.getState().takePendingInput(nodeId)
      if (text) ws.send(JSON.stringify({ type: 'input', data: text }))
    }
    typePendingRef.current = typePending

    // Registered once on the persistent term; reads whichever socket is current.
    if (!task) {
      term.onData((d) => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d }))
      })
    }

    const ro = new ResizeObserver(() => {
      if (fitIfMeasurable()) sendResize()
    })
    ro.observe(host)

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      host.removeEventListener('mouseup', copySelection)
      oscHandler.dispose()
      ro.disconnect()
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [nodeId, kind, task, activated])

  // The socket may already be open when a prompt is queued; type it now.
  const pending = useStore((s) => s.pendingInput[nodeId])
  useEffect(() => { if (pending) typePendingRef.current?.() }, [pending])

  // Re-fit when this tab becomes visible again; a hidden xterm can't measure itself.
  useEffect(() => {
    if (hidden || !activated) return
    const id = requestAnimationFrame(() => {
      const term = termRef.current
      const host = hostRef.current
      if (!term || !host || !host.offsetParent) return
      try { fitRef.current?.fit() } catch { /* transient */ }
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN && term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      term.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [hidden, activated])

  /**
   * Tell the server whether this pane is actually being looked at. Tab-hidden
   * and browser-backgrounded both count as not looking — the socket stays open
   * in either case, so connectedness alone cannot answer the question.
   */
  useEffect(() => {
    if (!activated) return
    const report = () => {
      const active = !hidden && document.visibilityState === 'visible'
      if (active === viewingRef.current) return
      viewingRef.current = active
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'view', active }))
    }
    report()
    document.addEventListener('visibilitychange', report)
    // Deliberately no reset here: clearing the ref in cleanup would make the
    // re-run see "already false" and skip sending the message that says so.
    // Closing the socket is what tells the server about an unmount.
    return () => document.removeEventListener('visibilitychange', report)
  }, [hidden, activated])

  // Recolour in place. Swapping `options.theme` only repaints the browser-side
  // renderer — no resize reaches tmux, so a live TUI is not redrawn or reflowed.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(night)
  }, [night, activated])

  return (
    <div
      ref={hostRef}
      className="h-full w-full px-2 py-1"
      style={{ display: hidden ? 'none' : 'block' }}
    />
  )
}
