import { execFile } from 'node:child_process'

/**
 * Promisified execFile that never throws on a non-zero exit; callers inspect
 * `code`. Git uses non-zero exits for ordinary answers (e.g. `diff --quiet`),
 * so treating them as exceptions would be wrong more often than right.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: 20_000, ...opts },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? (err ? String(err.message) : ''),
          failed: Boolean(err),
        })
      },
    )
  })
}

export const git = (cwd, args, opts) =>
  run('git', ['--no-optional-locks', ...args], { cwd, ...opts })
