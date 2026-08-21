#!/usr/bin/env node
/**
 * Register (or remove) the Project Manager notification hooks in
 * ~/.claude/settings.json.
 *
 *   npm run install-hooks
 *   npm run install-hooks -- --remove
 *
 * The hooks go in *user* settings, not this repo's `.claude/`, because the point
 * is to be notified about every project the app manages — a hook scoped to this
 * repo would only ever fire for this repo.
 *
 * Entries are tagged with a marker command path so the installer can find and
 * replace its own previous work without disturbing hooks from anywhere else.
 * Every write is preceded by a timestamped backup: this file is hand-edited and
 * shared with other tooling, and a settings.json that fails to parse silently
 * disables *all* of a user's settings.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(root, 'scripts', 'claude-notify-hook.js')
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')

/** Both events we listen for, and what each one means in the UI. */
const EVENTS = {
  Stop: 'Claude finished a turn',
  Notification: 'Claude is waiting on you',
}

const remove = process.argv.includes('--remove')

/**
 * Exec form (`command` + `args`) rather than a shell string: the script path is
 * passed as one argv element, so a directory with a space or a quote in it can
 * never be re-parsed by a shell. `process.execPath` is used deliberately — hooks
 * can run under a bare GUI/launchd environment where an nvm-shimmed `node` is
 * not on PATH.
 */
const command = process.execPath
const args = [HOOK]
const isOurs = (h) =>
  [h?.command, ...(Array.isArray(h?.args) ? h.args : [])]
    .some((v) => typeof v === 'string' && v.includes(HOOK))

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${settingsPath} is not a JSON object — refusing to overwrite it.`)
    }
    return { settings: parsed, raw }
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, raw: null }
    if (err instanceof SyntaxError) {
      fail(`${settingsPath} is not valid JSON (${err.message}).\n` +
        'Fix it by hand first — rewriting it here would destroy settings.')
    }
    throw err
  }
}

function fail(msg) {
  console.error(`\x1b[31m[hooks] ${msg}\x1b[0m`)
  process.exit(1)
}

const { settings, raw } = readSettings()
settings.hooks ??= {}

let changed = false

for (const [event, description] of Object.entries(EVENTS)) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []

  // Drop any previous install of ours, then drop groups we emptied doing so.
  const cleaned = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0)

  if (cleaned.length !== groups.length ||
      groups.some((g) => (g.hooks ?? []).some(isOurs))) changed = true

  if (!remove) {
    cleaned.push({
      hooks: [{
        type: 'command',
        command,
        args,
        // async: Claude must never sit waiting on a notification round trip.
        async: true,
        timeout: 5,
        statusMessage: description,
      }],
    })
    changed = true
  }

  if (cleaned.length) settings.hooks[event] = cleaned
  else delete settings.hooks[event]
}

if (!changed) {
  console.log('[hooks] nothing to do.')
  process.exit(0)
}

if (!Object.keys(settings.hooks).length) delete settings.hooks

fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
if (raw !== null) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.writeFileSync(backup, raw)
  console.log(`[hooks] backed up  ${backup}`)
}
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

console.log(`[hooks] ${remove ? 'removed from' : 'installed into'}  ${settingsPath}`)
if (!remove) {
  console.log(`[hooks] events     ${Object.keys(EVENTS).join(', ')}`)
  console.log(`[hooks] command    ${command} ${args.join(' ')}`)
  console.log('[hooks] Claude Code picks this up on its next session (or after /hooks).')
}
