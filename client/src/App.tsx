import { useEffect } from 'react'
import { MainPanel } from './components/MainPanel'
import { NewBranchDialog } from './components/NewBranchDialog'
import { Palette } from './components/Palette'
import { Sidebar } from './components/Sidebar'
import { useActiveNode, useStore } from './store'

export default function App() {
  const loading = useStore((s) => s.loading)
  const load = useStore((s) => s.load)
  const node = useActiveNode()
  const meta = useStore((s) => s.meta)

  useEffect(() => { load().catch((e) => console.error(e)) }, [load])
  useGlobalShortcuts()

  if (loading) {
    return <div className="grid h-full place-items-center text-muted">Scanning ~/Projects…</div>
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      {node ? (
        <MainPanel key={node.id} node={node} />
      ) : (
        <div className="grid flex-1 place-items-center text-muted">
          No projects found under {meta?.projectsRoot}
        </div>
      )}
      <Palette />
      <NewBranchDialog />
    </div>
  )
}

/**
 * ⌥↑/⌥↓ switches project, ⌥←/⌥→ switches tab, ⌘K opens the palette.
 *
 * Bound in the capture phase on `window` so it wins over xterm, which otherwise
 * swallows the keystroke and sends an escape sequence to the shell. Matching on
 * `code` rather than `key` is required: macOS rewrites Option+Arrow into other
 * characters, so `key` is unreliable here.
 */
function useGlobalShortcuts() {
  const moveNode = useStore((s) => s.moveNode)
  const moveTab = useStore((s) => s.moveTab)
  const setPalette = useStore((s) => s.setPalette)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault()
        setPalette(!useStore.getState().paletteOpen)
        return
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) return

      switch (e.code) {
        case 'ArrowDown': e.preventDefault(); moveNode(1); break
        case 'ArrowUp': e.preventDefault(); moveNode(-1); break
        case 'ArrowRight': e.preventDefault(); moveTab(1); break
        case 'ArrowLeft': e.preventDefault(); moveTab(-1); break
        default: break
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [moveNode, moveTab, setPalette])
}
