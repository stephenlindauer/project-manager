import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

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

/** A hidden element measures as zero; anything below this is not a real size. */
const MIN_COLS = 40
const MIN_ROWS = 10

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
      theme: XTERM_THEME,
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
      return true
    })

    /** Fit only when the pane is laid out and the result is a plausible size. */
    const fitIfMeasurable = () => {
      if (!host.offsetParent || host.clientWidth < 1 || host.clientHeight < 1) return false
      try { fit.fit() } catch { return false }
      return term.cols >= MIN_COLS && term.rows >= MIN_ROWS
    }

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

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    ws.onopen = () => { fitIfMeasurable(); sendResize() }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'data' || msg.type === 'replay') term.write(msg.data)
      else if (msg.type === 'exit') term.writeln('\r\n\x1b[90m[session ended]\x1b[0m')
      else if (msg.type === 'error') term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`)
    }
    ws.onclose = () => term.writeln('\r\n\x1b[90m[disconnected]\x1b[0m')

    if (!task) {
      term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d }))
      })
    }

    const ro = new ResizeObserver(() => {
      if (fitIfMeasurable()) sendResize()
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [nodeId, kind, task, activated])

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

  return (
    <div
      ref={hostRef}
      className="h-full w-full px-2 py-1"
      style={{ display: hidden ? 'none' : 'block' }}
    />
  )
}
