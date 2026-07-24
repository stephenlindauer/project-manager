import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const home = os.homedir()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Optional persistent config, so the deployment settings (https/host/auth) can
 * live in a file instead of env vars. Env vars always win over the file. The
 * file is gitignored — it is per-machine, not shared.
 */
function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'pm.config.json'), 'utf8'))
  } catch { return {} }
}
const file = loadFile()

/** Coerce an env/file value to boolean; env "0"/"false"/"" count as false. */
const bool = (envVal, fileVal, dflt = false) => {
  if (envVal !== undefined) return !['0', 'false', 'no', ''].includes(String(envVal).toLowerCase())
  if (fileVal !== undefined) return Boolean(fileVal)
  return dflt
}
const str = (envVal, fileVal, dflt) => envVal ?? fileVal ?? dflt

const https = file.https ?? {}
const auth = file.auth ?? {}

export const config = {
  /** Absolute path to the project root (where pm.config.json / certs live). */
  root,

  /** Root directory scanned for projects. */
  projectsRoot: process.env.PM_PROJECTS_ROOT || file.projectsRoot || path.join(home, 'Projects'),
  /** How deep to descend looking for repos. punchup/punchup-web is depth 2. */
  maxDepth: Number(process.env.PM_MAX_DEPTH || file.maxDepth || 3),
  port: Number(process.env.PM_PORT || file.port || 5274),

  /**
   * Interface to bind. Defaults to loopback — the app grants full shell access,
   * so exposing it on the network (0.0.0.0) should go hand in hand with auth.
   */
  host: str(process.env.PM_HOST, file.host, '127.0.0.1'),

  https: {
    enabled: bool(process.env.PM_HTTPS, https.enabled, false),
    cert: str(process.env.PM_TLS_CERT, https.cert, path.join(root, 'certs', 'pm-cert.pem')),
    key: str(process.env.PM_TLS_KEY, https.key, path.join(root, 'certs', 'pm-key.pem')),
  },

  auth: {
    enabled: bool(process.env.PM_AUTH, auth.enabled, false),
    file: str(process.env.PM_AUTH_FILE, auth.file, path.join(root, '.pm-auth.json')),
  },

  /** Command launched in the "Claude" tmux tab. */
  claudeCommand: process.env.PM_CLAUDE_COMMAND || file.claudeCommand || 'claude',
  /** Directory name (sibling to a repo) that holds its worktrees. */
  worktreeDirName: '.worktrees',
  /** Never descend into these. */
  ignoreDirs: new Set([
    'node_modules', '.git', '.worktrees', 'dist', 'build', 'out',
    'vendor', 'Pods', '.next', '.turbo', '.venv', 'venv', '__pycache__',
    'DerivedData', '.gradle', 'target', '.cache', 'coverage', '.expo',
    'Library', 'tmp', '.terraform',
  ]),
  /** Files that mark a directory as a project even without git. */
  projectMarkers: [
    'package.json', 'go.mod', 'Cargo.toml', 'Package.swift', 'pom.xml',
    'build.gradle', 'pyproject.toml', 'requirements.txt', 'Gemfile',
    'CMakeLists.txt', 'composer.json', 'CLAUDE.md',
  ],
}
