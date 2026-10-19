import { execFile } from 'node:child_process'

/**
 * Promisified execFile that never throws on a non-zero exit; callers inspect
 * `code`. Git uses non-zero exits for ordinary answers (e.g. `diff --quiet`),
 * so treating them as exceptions would be wrong more often than right.
 */
export function run(cmd, args, opts = {}) {
  const options = { maxBuffer: 32 * 1024 * 1024, timeout: 20_000, ...opts }
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      resolve({
        code: err?.code ?? 0,
        stdout: stdout ?? '',
        stderr: stderr || describe(err, cmd, options.timeout),
        failed: Boolean(err),
      })
    })
  })
}

/**
 * Words for a failure that left stderr empty: a timeout (execFile kills the
 * child with SIGTERM and says nothing), another signal, or a spawn error such
 * as ENOENT. A plain non-zero exit keeps its empty stderr — git uses those as
 * ordinary answers. Without this, a killed `git worktree remove` reached the
 * UI as an empty string.
 */
function describe(err, cmd, timeout) {
  if (!err) return ''
  if (typeof err.code === 'string') return err.message // ENOENT, EACCES, maxBuffer
  if (err.killed && timeout) {
    const t = timeout >= 1000 ? `${Math.round(timeout / 1000)}s` : `${timeout}ms`
    return `${cmd} timed out after ${t}`
  }
  if (err.signal) return `${cmd} was killed by ${err.signal}`
  return ''
}

/**
 * Environment for anything the app spawns on the user's behalf: terminals,
 * tmux sessions, Tasks runners. Starts from our own env (PATH, HOME, SSH agent)
 * but drops the variables that only mean something to this server. NODE_ENV in
 * particular: the service used to run with NODE_ENV=production and every dev
 * server and test runner launched from the Tasks tab inherited it, so config
 * loaders that key on it thought they were deployed.
 */
const PRIVATE_ENV = ['NODE_ENV', 'PM_SERVE_DIST', 'XPC_SERVICE_NAME', 'OSLogRateLimit']
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of PRIVATE_ENV) delete env[k]
  return env
}

export const git = (cwd, args, opts) =>
  run('git', ['--no-optional-locks', ...args], { cwd, ...opts })
