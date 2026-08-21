# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A local web app for managing every project under `~/Projects` — including itself.
Left nav lists projects (grouped by containing folder, sorted by recent activity);
the right panel has per-project tabs: Summary, Claude, Terminal, Changes, Tasks, PRs.

```bash
npm install     # postinstall step is required — see "node-pty" below
npm run dev     # http://localhost:5273 (client), :5274 (API)
npx tsc --noEmit
```

## Architecture

Plain ESM JavaScript on the server, TypeScript + React on the client. No server
build step.

| Path | Role |
| --- | --- |
| `server/index.js` | Express routes, `/pty` WebSocket, `/events` SSE, boot |
| `server/scanner.js` | Walks `~/Projects`, classifies dirs, groups them |
| `server/store.js` | In-memory project index; `hydrate()` derives git state |
| `server/git.js` | All git plumbing (porcelain v2 parsing, worktrees, diffs) |
| `server/terminals.js` | tmux/pty session lifecycle |
| `server/tasks.js` | Dev-server runners, script discovery |
| `client/src/store.ts` | zustand store + `visibleNodes()` sorting |
| `client/src/components/Terminal.tsx` | xterm view bound to a `/pty` socket |

**Node vs project.** A *project* is a repo; a *node* is one worktree of it. Nodes
are what the UI selects, keyboard-navigates, and opens terminals against. Node ids
are a hash of the worktree's absolute path (`scanner.js: idFor`).

## Landmines

Each of these caused a real bug. They are easy to reintroduce.

**Never put a literal NUL in a git `--format` string.** argv strings are
NUL-terminated, so `execve` silently truncates the format at the first field and
you get back only one column with no error. `git.js` uses `%x1f` (Unit Separator)
via the `FSEP`/`SEP` constants. NUL (`'\0'`) is only for parsing `-z` *output*.
Watch for raw `\x00` bytes accidentally written into source — grep for them if
parsing goes strange.

**node-pty's bundled `spawn-helper` ships without the executable bit**, because npm
does not preserve file modes in tarballs. Every `pty.spawn` then fails with a bare
`posix_spawnp failed`. `scripts/fix-pty-helper.js` runs on `postinstall` to fix it.
If terminals break after a dependency change, run `npm run postinstall` first.

**Never size a terminal from a hidden element.** Both terminal tabs mount while
`display: none`, where they measure as zero. A tmux session created at that size
paints its whole UI at ~20 columns, and that mangled output persists in tmux
scrollback through every later repaint. `Terminal.tsx` defers connecting until the
pane is visible (`activated` latch) and only reports sizes clearing `MIN_COLS`/
`MIN_ROWS`. `Session.resize()` *rejects* undersized values rather than clamping —
clamping is what silently created the broken sessions.

**Do not replay a scrollback buffer into a tmux-backed terminal.** tmux repaints
the full screen itself on attach; replaying our copy on top corrupts full-screen
TUIs because the stored bytes were drawn at the previous client's width.
`Session.append()` only buffers when the raw-pty fallback is active.

**zustand v5 selectors must not return new references.** It reads through
`useSyncExternalStore`, so a selector ending in `.filter()`/`.map()`/`{...}`
produces a new snapshot every render and locks the browser in an infinite loop
(`getSnapshot should be cached` → `Maximum update depth exceeded`). Wrap in
`useShallow` (see `TasksTab.tsx`) or select a raw slice and derive with `useMemo`.

**`dir="rtl"` truncation reorders leading punctuation.** It is used to keep
filenames visible on long paths, but without an inner `<bdi>` a leading dot moves
to the end and `.gitignore` renders as `gitignore.`. The DOM text stays correct, so
only a screenshot catches this.

## tmux sessions are user data

Sessions are named `pm-<kind>-<nodeId>` and hold real work — a `claude` session may
have hours of context in it. **Never run `tmux kill-server`, and confirm before
killing any individual session.** `tmux ls` is read-only and safe.

Restarting the API server (`node --watch` fires on any `server/` edit) detaches
viewers but does *not* destroy tmux sessions; they reattach on reconnect. Prefer
client-only changes when a session is live.

Also note: tmux sizes a window to its **smallest attached client**. Opening a second
viewer (including a headless test browser) on a live session can resize it out from
under the user.

## Verifying UI changes

Typechecking and API tests do not catch rendering bugs; several real ones here were
only visible in a screenshot. Drive real Chrome over CDP:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pm-chrome about:blank &
# then: Page.navigate → Runtime.evaluate to click → Page.captureScreenshot
```

Useful checks: click each tab and confirm the page stays responsive (a hung
`Runtime.evaluate` is the infinite-render signature), and read
`Runtime.consoleAPICalled` / `Runtime.exceptionThrown` for React warnings. When
testing a fix, revert it once and confirm the probe actually reproduces the bug —
otherwise the test may be passing vacuously.

**Stay off the Claude/Terminal tabs in an automated browser** unless the sizing path
is what you are testing; the Summary tab exercises the sidebar without attaching to
any session.

## Conventions

- Sidebar ordering lives in `visibleNodes()`. "Activity" is the newer of the last
  commit and the newest mtime among *currently dirty* files, so uncommitted work
  ranks. Ungrouped projects rank individually — bucketing them under one empty
  group moves 30+ repos as a block.
- Scanner skips symlinks (a symlinked repo would list twice and can recurse) and
  `.worktrees`, which is where new worktrees are created.
- Errors inside WebSocket handlers must not throw — an uncaught throw there takes
  down the whole server. Report into the terminal instead.
- A collapsed sidebar peek (hover or `⌥↑↓`) must stay an **overlay**: the panel is
  absolutely positioned so the main panel never reflows. Reflowing it resizes the
  terminal pane, and resizing a tmux-backed pane repaints the whole TUI — a peek
  that flickers the user's editor is worse than no peek. Only `⌘B` itself, the
  deliberate toggle, is allowed to change the layout.
- Colors come from the `@theme` block in `index.css`; each neon accent has an
  assigned meaning (cyan = selection, pink = branches, green = running/ahead,
  amber = dirty, red = failing). Check contrast before dimming small text.
- Night mode (toggle at the far right of the tab bar) redefines those same tokens
  under `:root[data-night]` at ~70% brightness, so any new color must be a token
  to follow it. Two exceptions need hand-editing: xterm's palette is set in JS
  (`XTERM_THEME` / `XTERM_THEME_NIGHT` in `Terminal.tsx`, kept in step by hand —
  and the night theme's `extendedAnsi` is load-bearing, not decoration, because
  a TUI draws almost entirely in 256-colour `38;5;N` codes that the 16 named
  fields never reach; colour 231 is pure white),
  and the `data-night` attribute is set at module load in `store.ts` rather than
  from an effect — from an effect the first paint would flash at full brightness.

## Deployment & auth

This machine runs the app as a launchd **LaunchAgent** (`local.projectmanager`),
not from a terminal. It serves the built `dist/`, so a client-only change is not
live until `npm run deploy:macos` (build + restart) runs — a source edit alone
does nothing. Control it with `scripts/macos/service.sh`
(`install|uninstall|start|stop|restart|status|logs`); per-OS scripts live under
`scripts/<os>/`. Restarting the service detaches terminal viewers but leaves tmux
sessions alive. Note the port will already be held by the agent, so a manual
`npm run start` fails with EADDRINUSE — that is the service, not a bug.

Optional, all off by default (loopback / http / no login), configured via env vars
or `pm.config.json` (see `server/config.js`). Setup scripts: `npm run generate-cert`
and `npm run create-user`.

- **The app is a full RCE surface** (every terminal is a real shell). Any change
  that widens exposure — binding, CORS, a new unauthenticated route — must keep the
  `/pty` WebSocket and `/events` SSE behind `Auth.requireAuth` / the upgrade check
  in `server/index.js`. The socket carries the session cookie automatically.
- Auth is single-user: scrypt password hash + HMAC-signed cookie, both stored in
  `.pm-auth.json` (gitignored, 0600). `server/auth.js` owns all of it; use its
  `safeEqual` for any secret comparison (timing-safe).
- The client treats any API `401` as "show the login gate" (`setUnauthorizedHandler`
  in `api.ts`). `/api/auth`, `/api/login`, `/api/logout` are the only unguarded
  routes.
- Defaults must stay backward-compatible: with no config, `requireAuth` is a no-op
  and behavior is identical to the pre-auth app.
