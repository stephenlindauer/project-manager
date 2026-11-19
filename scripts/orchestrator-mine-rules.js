#!/usr/bin/env node
/**
 * Seed a repo's mined house rules from review comments on PRs already merged.
 *
 *   node scripts/orchestrator-mine-rules.js <owner/repo> <out.md> [--limit 30] [--author @me]
 *
 * It appends one raw line per comment a teammate left on those PRs. The watch
 * stage adds to the same file as new comments arrive; the review stage reads
 * it. Turning the lines into tidy rules is editing, and is yours to do.
 */
import fs from 'node:fs'
import path from 'node:path'
import { run } from '../server/exec.js'

const [repo, out] = process.argv.slice(2)
const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }
if (!repo || !out) { console.error('usage: orchestrator-mine-rules.js <owner/repo> <out.md> [--limit 30] [--author @me]'); process.exit(2) }

const gh = async (args) => {
  const r = await run('gh', args, { timeout: 60_000 })
  if (r.failed) throw new Error(r.stderr.trim() || `gh ${args.join(' ')} failed`)
  return JSON.parse(r.stdout || 'null')
}

const me = (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim()
const prs = await gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--author', opt('author', '@me'), '--limit', opt('limit', '30'), '--json', 'number,title'])
const lines = []
for (const pr of prs) {
  const comments = await gh(['api', `repos/${repo}/pulls/${pr.number}/comments?per_page=100`])
  for (const c of comments ?? []) {
    if (!c.body?.trim() || c.user?.login === me) continue
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association)) continue
    lines.push(`- (PR #${pr.number}, ${c.path ?? 'general'}) ${c.body.replace(/\s+/g, ' ').slice(0, 600)}`)
  }
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.appendFileSync(out, `${lines.join('\n')}${lines.length ? '\n' : ''}`)
console.log(`${lines.length} comment(s) from ${prs.length} merged PR(s) appended to ${out}`)
