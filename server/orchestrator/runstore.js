import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * One folder per run, under the machine's `orchestrator/runs/<runId>/`:
 *
 *   run.json         the whole run record. Written to a temp file and renamed
 *                    into place, so a crash never leaves half a file.
 *   events.jsonl     append-only: stage history, the decision log, and the
 *                    intent/result lines that keep side effects from repeating.
 *   brief.md         the brief exactly as the worker received it.
 *   records/         plan and evidence records, validator results.
 *   sessions/        per session: prompt, settings, launcher, transcript
 *                    (`<n>.jsonl`), stderr and exit code (`<n>.exit`).
 *   jobs/            the same for plain commands (verify, deploy).
 *
 * The server restarts on every deploy and every edit to its own code, so
 * nothing about a run lives only in memory.
 */

export const newRunId = () =>
  `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`

export function createRunStore(runsDir) {
  const dirOf = (id) => path.join(runsDir, id)

  function save(run) {
    const dir = dirOf(run.id)
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    const file = path.join(dir, 'run.json')
    const tmp = `${file}.${process.pid}.tmp`
    run.updatedAt = Date.now()
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2))
    fs.renameSync(tmp, file)
    return run
  }

  function load(id) {
    try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'run.json'), 'utf8')) } catch { return null }
  }

  function loadAll() {
    let ids = []
    try { ids = fs.readdirSync(runsDir) } catch { return [] }
    return ids.map(load).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt)
  }

  function append(id, event) {
    const line = JSON.stringify({ at: Date.now(), ...event })
    fs.mkdirSync(dirOf(id), { recursive: true })
    fs.appendFileSync(path.join(dirOf(id), 'events.jsonl'), `${line}\n`)
  }

  function events(id) {
    let raw = ''
    try { raw = fs.readFileSync(path.join(dirOf(id), 'events.jsonl'), 'utf8') } catch { return [] }
    const out = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      // A crash can leave a torn last line; everything before it is intact.
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out
  }

  /**
   * Where a side effect stands: `none` (never attempted), `done` (its result
   * is recorded), or `open` — an intent with no result, which means the server
   * stopped somewhere between doing it and writing that down.
   */
  function effectState(id, kind, key) {
    let state = { state: 'none' }
    for (const e of events(id)) {
      if (e.effect !== kind || e.key !== key) continue
      if (e.type === 'intent') state = { state: 'open', intent: e }
      else if (e.type === 'result') state = { state: 'done', value: e.value ?? null }
      else if (e.type === 'intent-void') state = { state: 'none' }
    }
    return state
  }

  function writeFile(id, rel, content, mode) {
    const file = path.join(dirOf(id), rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, mode ? { mode } : undefined)
    return file
  }

  function readFile(id, rel) {
    try { return fs.readFileSync(path.join(dirOf(id), rel), 'utf8') } catch { return null }
  }

  /** Drop the heavy files of a long-finished run; the summary in run.json stays. */
  function trim(id) {
    for (const sub of ['sessions', 'jobs']) {
      fs.rmSync(path.join(dirOf(id), sub), { recursive: true, force: true })
    }
  }

  return { runsDir, dirOf, save, load, loadAll, append, events, effectState, writeFile, readFile, trim }
}
