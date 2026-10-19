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
| `server/trash.js` | Staging dir + detached delete for removed worktrees |
| `server/notify.js` | Claude Code hook signals, sound, hook token |
| `client/src/store.ts` | zustand store + `visibleNodes()` sorting |
| `client/src/components/Terminal.tsx` | xterm view bound to a `/pty` socket |

**Agent toggle.** The "Claude" tab hosts one agent CLI per node — Claude or
Codex, a segmented control in the tab bar, remembered in `agentByNode`. Each is
its own session kind (`pm-claude-…`, `pm-codex-…`; `terminals.js: LAUNCH`), so
toggling never kills the other's context. Status badges and hooks are Claude
only: Codex has no hook events, so a Codex session shows no badge. Its
`notify` config could feed one later, but people often use it already.

**New worktrees build in the background.** The new-worktree dialog closes on
submit and `store.createWorktreeInBackground` reports through toasts; it does
*not* select the new node, so you can keep working elsewhere.

**Worktree cleanup** (`⌫` in the sidebar header, `server/cleanup.js`). Opening it
runs `git fetch --prune origin` on every repo with linked worktrees, then
classifies each one: `merged` (no commits the default branch lacks, or all of them
landed by rebase or squash — the squash probe is a dangling `commit-tree` +
`git cherry`), `missing` (directory gone; purge prunes it), `empty` (the branch
reflog never recorded anything past "Created from" — a brand-new worktree looks
exactly like a merged one otherwise), or `open`. Only `merged`/`missing` with no
*holds* (dirty, locked, open PR, Claude working/waiting, task running) are
purgeable; purge re-checks each on the server and removes through the same
`dropWorktree` as the ✕ button, plus `git branch -D` if asked. Stale ones are
listed, never purged. A merged tree with a tmux session starts unticked.

**Queuing a prompt into Claude.** `store.startInClaude(nodeId, text)` stores text in
`pendingInput` and switches to that node's Claude tab; `Terminal.tsx` types it into the
session once its socket is open and never presses Enter — the person submits. Nothing
in the core app calls it today; it exists for integrations that turn an item into a prompt.

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

**node-pty 1.1.0 leaks two pty fds per spawn on macOS** (the parent never closes
the slave, and an off-by-one skips `low_fds[0]`). macOS caps ptys system-wide at
`kern.tty.ptmx_max` (511), so a long-running service eventually exhausts them and
every spawn — in any app — fails with `posix_spawnp failed`. It is pinned to
`1.2.0-beta.15`, which fixes both; do not downgrade to `latest` until a stable
release includes the fix. Diagnose with `lsof | grep -c ptmx`.

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

**Never let the server's own environment leak into what it spawns.** The
service used to run with `NODE_ENV=production` as its "serve `dist/`" switch,
and both spawn sites copied `process.env` into the child, so every terminal,
tmux session and Tasks runner ran as "production" — dev servers and test
runners in other repos crashed on boot because their config loaders key on
`NODE_ENV`. The switch is now the private `PM_SERVE_DIST=1`, and `exec.js:
childEnv()` strips it and `NODE_ENV` from every child. Route any new spawn
through `childEnv`. Note tmux captures its global environment from whatever
started the tmux server, so a poisoned server stays poisoned until
`tmux set-environment -gu NODE_ENV` (or a restart of tmux itself).

**Never ask `gh pr list` for `statusCheckRollup` across the whole repo.** It
expands to up to 100 check contexts per PR in one GraphQL query; on
a monorepo with ~100 checks per PR, 30 PRs of that overrun GitHub's ~10s
budget and gh returns an empty body (`unexpected end of JSON input`), so the
PRs tab showed nothing but an error. `gh.js` fetches checks only for
`--author @me` and the repo-wide list without them; those PRs carry
`checks.state: 'unknown'`.

**Never delete a worktree under the default 20 s exec timeout.** A
large frontend monorepo worktree holds 300k–600k files and takes minutes to unlink.
`git worktree remove` used to run on `exec.js`'s default budget, so git was
SIGTERMed mid-delete: the half-emptied tree stayed registered, and its empty
stderr reached the UI as a blank alert (the "remove rarely works" report).
`git.js: removeWorktree` now renames the tree into `<parent>/.worktrees/.trash/`
(instant on one volume), unregisters it by its *old* path — once the path is
gone git skips both the dirty check and the delete — and reclaims the space
with a detached `rm -rf` (`trash.js`); a boot sweep finishes deletes a restart
interrupted. The route's own `status` check is therefore the only dirty guard.
`run()` puts a timeout or signal into `stderr` when the child printed nothing,
so a killed command never surfaces as an empty error. The route then drops the
node from the index (`store.forgetWorktree`) and answers at once rather than
awaiting `store.rescan()`, which can take ~17 s.

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
- Pins (`pinnedNodes`, persisted) rank a worktree above its project's
  unpinned worktrees, after main. A pin never lifts the project or its group.
- Project headings fold on click (`collapsedProjects`, persisted in
  localStorage). A folded heading must keep carrying the loudest Claude badge of
  its rows and the selection bar when the active node is inside — folding is
  "out of the way", never "muted". `moveNode` walks past folded rows; `showNode`
  (toast, Needs-you strip) unfolds the project it lands in.
- The header's active-only toggle (`activeOnly`, persisted) hides worktrees
  with no Claude status, no running task, and not selected — `isActiveNode` in
  `store.ts` is the one definition; `moveNode` uses it too so ⌥↑↓ never lands
  on a hidden row. `ready` and `idle` count as active: a session at the prompt
  is still a session.
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
  amber = dirty, red = failing, orange = a Claude session wants you). Check
  contrast before dimming small text.
- Only the *blocked* attention state (`waiting`) animates. `done` gets the same
  orange as a static dot. Every marker pulsing at once is how a sidebar of 40
  projects turns into a slot machine — motion has to stay scarce to mean
  anything.
- Night mode (toggle at the far right of the tab bar) redefines those same tokens
  under `:root[data-night]` at ~70% brightness, so any new color must be a token
  to follow it. Two exceptions need hand-editing: xterm's palette is set in JS
  (`XTERM_THEME` / `XTERM_THEME_NIGHT` in `Terminal.tsx`, kept in step by hand —
  and the night theme's `extendedAnsi` is load-bearing, not decoration, because
  a TUI draws almost entirely in 256-colour `38;5;N` codes that the 16 named
  fields never reach; colour 231 is pure white),
  and the `data-night` attribute is set at module load in `store.ts` rather than
  from an effect — from an effect the first paint would flash at full brightness.

## Claude Code notifications and status badges

Claude Code's own hooks post to `/api/claude-hook` via `scripts/claude-notify-hook.js`.
Every node's session gets one record in `notify.js` — `state` (`working` /
`waiting` / `done`), a `phase` word while working, a `detail` line, the `task`
that started the turn, and `seen` — rendered as the badge under each sidebar
row (`ClaudeBadge`) and, for unseen `waiting`/`done`, in the **Needs you** strip
pinned above the tree. `waiting`/`done` also slide a toast into the top right
and play a macOS sound. `npm run install-hooks` writes the hooks into
`~/.claude/settings.json` (`-- --remove` takes them out); they go in *user*
settings on purpose, since the point is every project the app manages.

- **`/api/claude-hook` is the fourth route outside `requireAuth`** — a hook is a
  short-lived local process with no cookie to present. It is gated on loopback
  plus the token in `.pm-hook-token` (0600, gitignored, generated at boot), and
  it is write-only into a status record: nothing there reads project state back
  out. Keep it that way.
- **The hook script must never write to stdout or stderr, and must always exit
  0.** Anything it prints can surface mid-session in someone's Claude window.
  That is why it swallows Node's `NODE_TLS_REJECT_UNAUTHORIZED` warning, and why
  every failure path is a silent `exit 0`. It is registered `async` so Claude
  never waits on the round trip. To see what a Claude Code version actually
  sends, `touch .pm-hook-dump.jsonl` (gitignored) and delete it when done.
- **Phase comes from the tool, not from Claude.** `server/claude-phase.js` maps
  `tool_name` + a trimmed `tool_input` hint to one word: Edit → `editing`,
  test runners → `testing`, `gh pr checks` → `watching CI`, `Skill` → the skill
  name, `mcp__x__y` → `x`. Weak phases (`reading`, an unclassified command) only
  replace a strong one after 20s of quiet, so a Read mid-edit does not flicker
  the badge. `UserPromptSubmit` starts a turn (`task`, and `/skill` prompts set
  the phase directly); `PreToolUse`/`PostToolUse` refresh it; `Stop` →
  `done`, `Notification` → `waiting` except `idle_prompt`, which is `done`;
  `AskUserQuestion`'s PreToolUse is `waiting` because it has no hook of its
  own; `SessionEnd` forgets the record.
- **Watched panes get the record, not the noise.** `Terminal.tsx` reports
  `{type:'view'}` over `/pty` and the server counts viewers per socket; a
  `waiting`/`done` that lands while you watch is written `seen: true` with no
  toast or sound. `session.clients` cannot substitute: a hidden tab keeps its
  socket open, so it would claim to be watching a pane nobody can see.
- **`seen` replaces "clear".** Opening the Claude pane marks the record seen:
  `needs input` stops pinging but stays orange (it is still blocked), `ready`
  becomes a muted `idle`, and the row leaves the Needs-you strip. The toast's ✕
  dismisses only the toast. A notice swatted away in passing must never be the
  last trace of it.
- **A `done` within 3s of an unanswered `waiting` is dropped as a hook race**,
  not an answer (`RACE_MS`). The two hooks are async and can land out of order.
- **Leases.** A Claude that dies mid-turn never sends `Stop`, so `working`
  records not refreshed in 15 minutes are swept; `watching CI` / `testing` /
  `building` / `installing` / `delegating` get an hour, because those fire no
  hooks while they wait. A `gh pr checks --watch` longer than that goes dark.
- Only an unseen `waiting` badge pings, and the working spinner is the one other
  thing that moves. Everything else is a static label — motion has to stay
  scarce to mean anything in a sidebar of 40 rows.
- The Needs-you strip exists *instead of* re-sorting the tree by status: a row
  that jumps to the top when Claude finishes moves out from under ⌥↑↓ and the
  mouse. The tree keeps its recency order.
- `npm run install-hooks` is idempotent and replaces only its own entries, so
  re-run it whenever the event list changes; running sessions pick the new list
  up only after a restart. Check `~/.claude/settings.json` before assuming the
  signals work: the hooks are not installed by default.

- **The status webhook (`server/status-webhook.js`) rides the same records.**
  Off unless `statusWebhook` is in `pm.config.json`. It subscribes to
  `notifications`' `status` events rather than being called from the hook
  route, so a slow or dead endpoint can never delay a hook. It POSTs on a
  state or task change (phase churn does not count) and on a 60 s heartbeat,
  serialized and never thrown from.

## Ship verdicts

The second pill on a sidebar row (`ShipBadge`) and the **Ship** strip under
Needs-you answer "which branches need me to do something to ship". One word
per worktree — the *next action*, never PR status: `fix` (CI red), `address`
(changes requested), `rebase` (conflicts, or behind where required), `merge`
(GitHub says CLEAN); then the quiet set `stacked` (would merge, but its base is
another open PR of yours), `draft`, `ci`, `review`. A worktree owning several
PRs (a grok stack) shows the loudest. The table is `server/ship-verdict.js`,
pure and unit-tested (`npm test`); `SHIP_ORDER` in `Sidebar.tsx` mirrors it.

- **One GraphQL search per tick, not `gh pr list` per repo.** `server/ship.js`
  runs `gh api graphql` with `is:pr is:open author:@me` every 2 min
  (`PM_GH_POLL_MS`) and asks for the head commit's *aggregated*
  `statusCheckRollup { state }` — a scalar, so the per-context expansion that
  blows the ~10s budget above never happens. One rate-limit point per tick;
  polling pauses under 50 points left. `PM_SHIP=0` turns the whole thing off.
- **PRs map to worktrees in memory**: by `owner/repo` (from the remote,
  `git.js: githubRepo`) plus head branch, or for grok by the `Pull Request:`
  trailers above `origin/<default>` (one `git log` per HEAD change, at most 8
  per remap). The remap re-runs on every `nodes` refresh, so a checkout shows
  without a GitHub call. Your PRs that no worktree has checked out are the
  strip's "+N PRs with no worktree" footer.
- **Failure keeps the last good answer.** A failed fetch leaves the previous PR
  set in place; two in a row set `stale` and the pills dim. Warnings: one line
  on the first miss, one when it goes stale, then quiet. GitHub's search index
  trails a push by up to a minute, so a refresh right after `git push` may
  still describe the previous head.
- **Draft gates `merge`, not the red trio.** A draft upper rung really does
  report `mergeStateStatus: CLEAN`; `BLOCKED` is never
  `merge`; only `UNKNOWN` (GitHub still computing) gets the approved-and-green
  fallback. Stacking is "base is the head of another open PR of mine", not
  "base ≠ default branch" — some repos target a non-default branch like `qa`.
- Same rules as the Claude badge: never orange (`attn` is Claude's colour),
  never animated, `merge` gets the static green glow `ready` uses, a folded
  heading carries the loudest pill, and an attention verdict counts as
  `isActiveNode`. A strip row opens that worktree's PRs tab (`showNodeTab`)
  with no ack — a red CI clears when CI is green, not when looked at.
- `PM_SHIP_FIXTURE=<json>` swaps the GraphQL response for a file, re-read each
  tick — the way to stage a `merge` for a screenshot. `POST /api/ship/refresh`
  forces a tick (one per 10s; the PRs tab's ↻ calls it). `/events` carries the
  envelope as `ship-status`, replayed on connect like `claude-status`.

## PR stacks

The PRs tab opens with the stack the worktree belongs to (`GH.stack` in
`gh.js`), bottom-up, with the current rung marked. Two shapes are detected:

- **Chained branches**: each PR's base is the PR below it. Anchored on the PR
  whose head is the current branch, then walked down via `base` and up via
  "PRs based on me". The already-fetched PR list is the cache; a hop it does
  not cover costs one `gh pr list --head/--base` call. A branch point keeps
  the most recently updated child and reports the rest as `forks`.
- **git-grok**: every commit above `origin/<default>` is a PR
  and carries a `Pull Request: <url>` line in its message. That key has a
  space, so git's own `%(trailers)` parser rejects it — `git.js: stackCommits`
  matches it by regex. Commits without the line show as "not pushed".

"Switch" (`POST /api/nodes/:id/stack/switch`) is a plain `git checkout` of the
rung's head, refused when the tree has staged/unstaged/conflicted files
(409). If a sibling worktree already has that branch the answer is that
node's id and the client selects it instead — git would refuse the checkout
anyway. `grok/…` heads are refused outright: a grok stack lives on the
integration branch, and checking a grok branch out breaks the workflow.
`store.hydrate` re-derives `worktree.branch` from `git status` so the switch
(or a checkout in the terminal) shows in the sidebar without a rescan.

## Deployment & auth

This machine runs the app as a launchd **LaunchAgent** (`local.projectmanager`),
not from a terminal. It serves the built `dist/` (switched on by `PM_SERVE_DIST=1`, not
`NODE_ENV`), so a client-only change is not live until `npm run deploy:macos`
(build + restart) runs — a source edit alone does nothing. A change to the plist
template in `service.sh` needs `service.sh install` to rewrite it. Control it with `scripts/macos/service.sh`
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
