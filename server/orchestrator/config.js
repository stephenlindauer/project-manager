import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_SETS } from './permissions.js'

/**
 * Orchestrator settings, in four layers — the most specific value wins:
 *
 *   app defaults   this file. Every optional feature off, the `manual` source,
 *                  one minimal `ship` pipeline.
 *   machine        the `orchestrator` block of pm.config.json, then
 *                  `orchestrator/machine.json` beside it.
 *   repo           `orchestrator/repos/<repo dir name>.json`.
 *   task           overrides the task source reports (applied per run).
 *
 * Nothing here is specific to one machine: pipelines, thresholds, permission
 * sets and private adapters all live in the gitignored `orchestrator/` folder.
 * `provenance` remembers which file each value came from, for the Rules screen.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..', '..')

export const APP_DEFAULTS = {
  enabled: false,
  sources: { manual: { adapter: 'manual' } },
  pipelines: {
    ship: {
      stages: [
        { kind: 'intake' },
        { kind: 'work', name: 'build' },
        { kind: 'verify' },
        { kind: 'pr' },
        { kind: 'merge' },
        { kind: 'deploy' },
      ],
    },
  },
  permissionSets: DEFAULT_SETS,
  limits: {
    /** Orchestrator sessions working at once, across all runs. */
    activeSessions: 3,
    /** Orchestrator plus interactive sessions the hooks report as working. Off. */
    totalActiveSessions: null,
    /** Tokens across a run's life. Off until a machine sets it. */
    spendPerRun: null,
    /** Loops per stage before the run pauses into the inbox. */
    fixRounds: 3,
    /** Runs waiting on me or on review before the queue stops being read. */
    wip: 5,
  },
  mustAsk: [
    'An irreversible action, or anything that deletes or overwrites work.',
    'Anything other people will see: a post, a reply, a push to a branch under review.',
    'A change of scope, or work that belongs in a new task.',
    'A choice that makes the better option more expensive later: a schema, an API shape, data written.',
    'Flipping a flag or config value. Recommend it; never do it.',
  ],
  session: { command: null, model: null, effort: null },
  resolver: { enabled: false, model: null },
  reviewers: [],
  notifier: { routes: {} },
  retentionDays: 30,
  tickMs: 3000,
  /** Price table for showing dollars: { "<model>": { in: usdPerMTok, out: usdPerMTok } }. */
  prices: null,
}

export const REPO_DEFAULTS = {
  source: 'manual',
  pipeline: 'ship',
  verify: [],
  houseRules: [],
  ship: {
    merge: { by: 'me', method: null },
    approvals: 0,
    ci: 'required',
    stacks: 'none',
    stackMerge: 'bottom-up',
    fix_push: 'ask',
    replies: 'off',
    deploy: { by: 'app', cmd: null, check: null },
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** Deep-merge `src` over `target`. Arrays and scalars replace; `prov` records the origin of each leaf. */
export function layer(target, src, origin, prov = {}, prefix = '') {
  if (!isObj(src)) return target
  for (const [k, v] of Object.entries(src)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isObj(v) && isObj(target[k])) {
      target[k] = layer({ ...target[k] }, v, origin, prov, key)
    } else {
      target[k] = isObj(v) ? layer({}, v, origin, prov, key) : v
      if (!isObj(v)) prov[key] = origin
    }
  }
  return target
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return null
    return { __error: `${path.basename(file)}: ${err.message}` }
  }
}

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

/**
 * Load the app + machine layers. `root` is where pm.config.json lives; `dir`
 * is the machine's orchestrator folder (PM_ORCH_DIR moves it, for tests).
 */
export function loadMachine({ root = appRoot, dir = process.env.PM_ORCH_DIR || path.join(root, 'orchestrator') } = {}) {
  const prov = {}
  const errors = []
  const cfg = layer({}, structuredClone(APP_DEFAULTS), 'app defaults', prov)

  const pm = readJson(path.join(root, 'pm.config.json'))
  if (pm?.__error) errors.push(pm.__error)
  else if (isObj(pm?.orchestrator)) layer(cfg, pm.orchestrator, 'pm.config.json', prov)

  const machine = readJson(path.join(dir, 'machine.json'))
  if (machine?.__error) errors.push(machine.__error)
  else if (machine) layer(cfg, machine, 'orchestrator/machine.json', prov)

  if (process.env.PM_ORCH !== undefined) {
    cfg.enabled = !['0', 'false', 'no', ''].includes(String(process.env.PM_ORCH).toLowerCase())
    prov.enabled = 'PM_ORCH'
  }
  return { ...cfg, dir, root, provenance: prov, errors }
}

/** The repo layer for one repository: defaults, then `repos/<name>.json`. */
export function loadRepo(machine, repoPath) {
  const prov = {}
  const cfg = layer({}, structuredClone(REPO_DEFAULTS), 'app defaults', prov)
  const name = path.basename(repoPath)
  const reposDir = path.join(machine.dir, 'repos')
  let file = path.join(reposDir, `${name}.json`)
  // Two repos can share a directory name; a file may claim one by `path`.
  try {
    for (const f of fs.readdirSync(reposDir)) {
      if (!f.endsWith('.json')) continue
      const j = readJson(path.join(reposDir, f))
      if (j && !j.__error && j.path && path.resolve(expand(j.path)) === path.resolve(repoPath)) file = path.join(reposDir, f)
    }
  } catch { /* no repos folder yet */ }
  const repo = readJson(file)
  const errors = []
  if (repo?.__error) errors.push(repo.__error)
  else if (repo) layer(cfg, repo, `orchestrator/repos/${path.basename(file)}`, prov)
  return { ...cfg, name, path: repoPath, provenance: prov, errors }
}

/** Resolve a path named in config: absolute, `~/`, or relative to the orchestrator folder. */
export function resolveIn(machine, p) {
  const e = expand(p)
  return path.isAbsolute(e) ? e : path.join(machine.dir, e)
}

// ------------------------------------------------------------- discovery

/**
 * Adapters and stage kinds are found by listing folders, not by an import
 * list: the repo's own, then the machine's. A machine file with the same name
 * wins and may wrap the repo's (it receives it as `base`). So a private
 * adapter is a file on that machine — no fork, nothing for a merge to conflict
 * with.
 */
export async function discover(sub, machineDir) {
  const found = new Map()
  const dirs = [
    [path.join(here, sub), `server/orchestrator/${sub}`],
    [path.join(machineDir, sub), `orchestrator/${sub}`],
  ]
  for (const [dir, label] of dirs) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort() } catch { continue }
    for (const f of files) {
      const name = f.slice(0, -3)
      try {
        const mod = await import(pathToFileURL(path.join(dir, f)).href)
        const base = found.get(name)?.impl ?? null
        const impl = typeof mod.default === 'function' ? mod.default(base) : mod.default
        if (!impl) throw new Error('no default export')
        found.set(name, { name, impl, origin: `${label}/${f}`, wraps: base ? found.get(name).origin : null })
      } catch (err) {
        found.set(name, { ...(found.get(name) ?? { name, impl: null }), error: `${label}/${f}: ${err.message}` })
      }
    }
  }
  return found
}

// ------------------------------------------------------------- pipelines

/** The side effects that must have exactly one owner in a pipeline. */
export const EFFECTS = ['branch', 'status', 'pr', 'ci']

/**
 * Give every stage an id and check the pipeline can run: known kinds, unique
 * ids, loop targets that exist, and one owner per side effect. A skill that
 * cuts its own branch or watches CI itself declares it with `owns`, and the
 * stage kind that would do the same must then be absent or switched off.
 */
export function resolvePipeline(name, pipeline, { kinds, source = null }) {
  const errors = []
  if (!pipeline || !Array.isArray(pipeline.stages) || !pipeline.stages.length) {
    return { name, stages: [], owners: {}, errors: [`pipeline "${name}" has no stages`] }
  }
  const seen = new Map()
  const stages = pipeline.stages.map((raw) => {
    const s = { ...raw }
    const base = s.name || s.kind
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    s.id = n === 1 ? base : `${base}-${n}`
    if (!kinds.has(s.kind) || !kinds.get(s.kind).impl) errors.push(`stage "${s.id}": unknown kind "${s.kind}"`)
    return s
  })
  const ids = new Set(stages.map((s) => s.id))
  for (const s of stages) {
    if (s.onFail && !ids.has(s.onFail)) errors.push(`stage "${s.id}": onFail names "${s.onFail}", which is not a stage`)
  }

  const owners = Object.fromEntries(EFFECTS.map((e) => [e, []]))
  const hasMerge = stages.some((s) => s.kind === 'merge')
  const hasWatch = stages.some((s) => s.kind === 'watch')
  for (const s of stages) {
    const impl = kinds.get(s.kind)?.impl
    const declared = Array.isArray(s.owns) ? s.owns : []
    const own = [...declared, ...(impl?.owns?.(s, { hasWatch }) ?? [])]
    for (const e of own) if (owners[e]) owners[e].push(s.id)
  }
  if (source?.writes && source.statusSync) owners.status.push(`source:${source.name}`)

  for (const e of EFFECTS) {
    if (owners[e].length > 1) errors.push(`"${e}" has two owners: ${owners[e].join(' and ')}`)
  }
  // A tracker with writes off has no status owner, and that is a valid setup.
  // The other three are only required once a pipeline actually ships code.
  if (!owners.branch.length && stages.some((s) => ['work', 'pr', 'merge'].includes(s.kind))) {
    errors.push('"branch" has no owner')
  }
  if (hasMerge) for (const e of ['pr', 'ci']) if (!owners[e].length) errors.push(`"${e}" has no owner`)

  return { name, stages, owners, errors }
}
