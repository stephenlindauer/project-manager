import os from 'node:os'
import path from 'node:path'

const home = os.homedir()

export const config = {
  /** Root directory scanned for projects. */
  projectsRoot: process.env.PM_PROJECTS_ROOT || path.join(home, 'Projects'),
  /** How deep to descend looking for repos. punchup/punchup-web is depth 2. */
  maxDepth: Number(process.env.PM_MAX_DEPTH || 3),
  port: Number(process.env.PM_PORT || 5274),
  /** Command launched in the "Claude" tmux tab. */
  claudeCommand: process.env.PM_CLAUDE_COMMAND || 'claude',
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
