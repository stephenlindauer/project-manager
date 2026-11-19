/** A command that must exit 0. `{ command: 'npm test', key?: 'unit' }`. */
export default {
  name: 'command',
  async run(ctx, settings, i) {
    const j = await ctx.job(`check-${settings.key ?? i}`, { cmd: settings.command, timeoutMs: (settings.timeoutMinutes ?? 30) * 60_000 })
    if (j.state === 'running') return { wait: true }
    if (j.state === 'lost') return { wait: true } // it starts again on the next tick
    if (j.code === 0) return { ok: true }
    return { ok: false, reasons: [`\`${settings.command}\` exited ${j.code}:\n\n${j.tail}`] }
  },
}
