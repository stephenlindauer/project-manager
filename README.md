# ProjectManager

A local web interface for working across every project in `~/Projects` — including itself.

```bash
npm install
npm run dev     # → http://localhost:5273
```

## Layout

Left navigation lists every project found under `~/Projects`, grouped by containing
folder (so the nine repos inside `punchup/` nest under a `punchup` heading). Git
worktrees appear as children of their repo, so multiple branches of the same project
are always visible side by side.

The right panel has six tabs for the selected project:

| Tab | What it does |
| --- | --- |
| **Summary** | Branch, upstream, ahead/behind, working-tree counts, last commit, recent history, worktrees, the PR for this branch |
| **Claude** | Persistent `claude` session in tmux |
| **Terminal** | Persistent shell in tmux |
| **Changes** | Staged / modified / untracked files with unified diffs — review before committing |
| **Tasks** | Scripts detected from `package.json` (and Cargo/Go/Make); start & stop dev servers, with detected ports linked |
| **PRs** | Open pull requests with CI rollup status; create a PR from the current branch |

## Keyboard

| Keys | Action |
| --- | --- |
| `⌥↑` / `⌥↓` | Previous / next project (walks worktrees too) |
| `⌥←` / `⌥→` | Previous / next tab |
| `⌘K` | Fuzzy jump to any project or branch |

Shortcuts are bound in the capture phase so they work while a terminal has focus.

## Terminals

Sessions live in tmux (`pm-<kind>-<nodeId>`), so they survive browser reloads *and*
server restarts. You can attach from a real terminal at any time:

```bash
tmux ls
tmux attach -t pm-claude-<id>
```

If tmux is missing the server falls back to plain node-pty sessions, which survive
reloads but not restarts. The active backend is reported at `/api/meta`.

## Worktrees

`+ branch` on any project creates a linked worktree at
`~/Projects/.worktrees/<repo>/<branch>` and jumps to it. The scanner skips
`.worktrees`, so worktrees only ever appear nested under their own repo. Removing a
worktree stops its tasks and kills its tmux sessions first; the branch itself is kept.

## Configuration

Environment variables read at startup (see `server/config.js`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PM_PROJECTS_ROOT` | `~/Projects` | Directory to scan |
| `PM_MAX_DEPTH` | `3` | How deep to look for repos |
| `PM_PORT` | `5274` | API/WebSocket port |
| `PM_CLAUDE_COMMAND` | `claude` | Command launched in the Claude tab |
| `PM_HOST` | `127.0.0.1` | Interface to bind (`0.0.0.0` = all) |
| `PM_HTTPS` | `0` | Serve over TLS |
| `PM_TLS_CERT` / `PM_TLS_KEY` | `certs/pm-*.pem` | Certificate paths |
| `PM_AUTH` | `0` | Require login |
| `PM_AUTH_FILE` | `.pm-auth.json` | Credential file |

The same settings can live in a **`pm.config.json`** at the repo root instead of env
vars (env vars win). Copy `pm.config.example.json` to start. That file, the auth
file, and `certs/` are gitignored.

## Remote access & authentication

By default the app binds to loopback only and has no login — fine for local use.
**It hands out full shell access to every project, so never expose it on a network
without authentication.** The server prints a red warning if you do.

To run it over HTTPS, on the LAN, behind a login:

```bash
npm run generate-cert    # self-signed cert (localhost + LAN IPs) → certs/
npm run create-user      # prompts for a username + password → .pm-auth.json
```

Then set in `pm.config.json`:

```json
{
  "host": "0.0.0.0",
  "https": { "enabled": true },
  "auth": { "enabled": true }
}
```

Restart. You'll reach it at `https://<machine-ip>:5273` (dev) and be asked to log in.
The certificate is self-signed, so browsers warn once per device — that's expected.

- Passwords are stored as scrypt hashes; sessions are HMAC-signed cookies (30-day).
- Auth covers the API, the SSE stream, **and** the `/pty` terminal WebSocket.
- `create-user` is re-runnable to change the password; the cookie secret is preserved
  so other devices stay logged in. Delete `.pm-auth.json` to reset everything.

## Notes

`npm run postinstall` re-applies the executable bit to node-pty's bundled
`spawn-helper`. npm does not preserve file modes in published tarballs, and without
it every terminal fails with `posix_spawnp failed`.
