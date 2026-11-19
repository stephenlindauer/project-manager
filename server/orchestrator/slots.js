import fs from 'node:fs'
import path from 'node:path'
import { lastJson } from './stages/record.js'
import { sq } from './runner.js'

/**
 * A reviewer slot: a model and a runner, not a fixed product. Review and
 * cross-check both use slots, so a second model is plugged in once.
 *
 *   { "name": "claude", "runner": "claude", "model": null }
 *   { "name": "second", "runner": "command", "command": "…" }
 *
 * A `command` slot is any program. It reads its prompt from the file named in
 * $PM_REVIEW_PROMPT and prints one JSON object (or writes it to the file in
 * $PM_REVIEW_OUT). That is how a second model's CLI is used without this app
 * knowing its flags, and its sessions are tracked by log and exit file only —
 * nothing depends on that CLI's hooks.
 *
 * Returns `{ out }` or `{ outcome }` for the stage to return. A slot that
 * cannot run pauses the run: a reviewer that failed to start must never pass
 * for one that found nothing.
 */
export async function runSlot(ctx, slot, key, { prompt, schema, role, shape, extraAllow = [], model } = {}) {
  if (slot.runner !== 'command') {
    return ctx.worker(key, {
      role: role ?? `slot:${slot.name}`, set: 'read', fresh: true, noResolver: true,
      model: slot.model ?? model, schema, extraAllow, prompt,
    })
  }

  const st = ctx.state
  const dir = path.join(ctx.runDir, 'slots')
  fs.mkdirSync(dir, { recursive: true })
  const promptFile = path.join(dir, `${ctx.stage.id}-${key}.prompt.md`)
  const outFile = path.join(dir, `${ctx.stage.id}-${key}.out.json`)
  if (!st.j?.[key]) {
    fs.rmSync(outFile, { force: true })
    const text = typeof prompt === 'function' ? await prompt({}) : prompt
    fs.writeFileSync(promptFile, `${text}\n\nPrint your answer as one JSON object${shape ? `: ${shape}` : ''}.\n`)
  }
  const j = await ctx.job(key, {
    cmd: slot.command, timeoutMs: (slot.timeoutMinutes ?? 20) * 60_000,
    env: { PM_REVIEW_PROMPT: promptFile, PM_REVIEW_OUT: outFile },
  })
  if (j.state !== 'done') return { outcome: { wait: true } }
  const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  const out = lastJson(read(outFile)) ?? lastJson(read(path.join(ctx.runDir, 'jobs', `${st.j[key].n}.log`)))
  if (j.code !== 0 || !out) {
    return { outcome: { pause: `Slot "${slot.name}" (${sq(slot.command)}) ${j.code !== 0 ? `exited ${j.code}` : 'printed no JSON answer'}:\n\n${j.tail}` } }
  }
  return { out }
}

/** The slots a stage should use: its own, else the machine's, else one Claude session. */
export function slotsFor(ctx, pick = null) {
  const all = ctx.stage.reviewers ?? ctx.machine.reviewers ?? []
  const list = all.length ? all : [{ name: 'claude', runner: 'claude' }]
  if (!pick) return list
  const hit = list.find((s) => s.name === pick)
  return hit ? [hit] : []
}
