import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTENTION, VERDICTS, loudest, rank, verdictFor } from './ship-verdict.js'
import { parseGitHubRepo } from './git.js'

const pr = (over = {}) => ({
  isDraft: false, reviewDecision: 'REVIEW_REQUIRED', rollup: 'SUCCESS', mergeStateStatus: 'BLOCKED', baseIsMyOpenPr: false, ...over,
})

test('each rule in isolation', () => {
  assert.equal(verdictFor(pr({ rollup: 'FAILURE' })), 'fix')
  assert.equal(verdictFor(pr({ rollup: 'ERROR' })), 'fix')
  assert.equal(verdictFor(pr({ reviewDecision: 'CHANGES_REQUESTED' })), 'address')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'DIRTY' })), 'rebase')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'BEHIND' })), 'rebase')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'CLEAN' })), 'merge')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'HAS_HOOKS' })), 'merge')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'CLEAN', baseIsMyOpenPr: true })), 'stacked')
  assert.equal(verdictFor(pr({ isDraft: true })), 'draft')
  assert.equal(verdictFor(pr({ rollup: 'PENDING' })), 'ci')
  assert.equal(verdictFor(pr({ rollup: 'EXPECTED' })), 'ci')
  assert.equal(verdictFor(pr()), 'review')
  assert.equal(verdictFor({}), 'review')
})

test('precedence: red trio beats everything, including draft and clean', () => {
  assert.equal(verdictFor(pr({ rollup: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN', isDraft: true })), 'fix')
  assert.equal(verdictFor(pr({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN', isDraft: true })), 'address')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'DIRTY', isDraft: true })), 'rebase')
})

test('Draft stack rung: draft upper rung reporting CLEAN is draft, not merge', () => {
  const rung = { isDraft: true, reviewDecision: null, rollup: 'SUCCESS', mergeStateStatus: 'CLEAN', baseIsMyOpenPr: true }
  assert.equal(verdictFor(rung), 'draft')
  assert.equal(verdictFor({ ...rung, isDraft: false }), 'stacked')
  assert.equal(verdictFor({ ...rung, isDraft: false, baseIsMyOpenPr: false }), 'merge')
})

test('BLOCKED never promotes to merge; UNKNOWN does when approved and green', () => {
  assert.equal(verdictFor(pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', rollup: 'SUCCESS' })), 'review')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'APPROVED', rollup: 'SUCCESS' })), 'merge')
  assert.equal(verdictFor(pr({ mergeStateStatus: null, reviewDecision: 'APPROVED', rollup: 'SUCCESS' })), 'merge')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'APPROVED', rollup: 'PENDING' })), 'ci')
  assert.equal(verdictFor(pr({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', rollup: 'SUCCESS' })), 'review')
})

test('draft: BEHIND is noise, DIRTY is not', () => {
  assert.equal(verdictFor(pr({ isDraft: true, mergeStateStatus: 'BEHIND' })), 'draft')
  assert.equal(verdictFor(pr({ isDraft: true, mergeStateStatus: 'DIRTY' })), 'rebase')
})

test('loudest and rank follow VERDICTS order', () => {
  assert.equal(loudest(['review', 'fix', 'merge']), 'fix')
  assert.equal(loudest(['review', 'ci']), 'ci')
  assert.equal(loudest(['stacked', 'merge']), 'merge')
  assert.equal(loudest([]), null)
  for (let i = 1; i < VERDICTS.length; i++) assert.ok(rank(VERDICTS[i - 1]) > rank(VERDICTS[i]), VERDICTS[i])
  assert.equal(rank('nonsense'), 0)
  assert.deepEqual([...ATTENTION], VERDICTS.slice(0, 4))
})

test('parseGitHubRepo handles every remote spelling', () => {
  assert.equal(parseGitHubRepo('git@github.com:acme/widgets.git'), 'acme/widgets')
  assert.equal(parseGitHubRepo('https://github.com/acme/widgets'), 'acme/widgets')
  assert.equal(parseGitHubRepo('https://github.com/acme/widgets.git'), 'acme/widgets')
  assert.equal(parseGitHubRepo('https://github.com/acme/widgets/'), 'acme/widgets')
  assert.equal(parseGitHubRepo('ssh://git@github.com/acme/widgets.git'), 'acme/widgets')
  assert.equal(parseGitHubRepo('git://github.com/acme/widgets'), 'acme/widgets')
  assert.equal(parseGitHubRepo('https://gitlab.com/acme/widgets.git'), null)
  assert.equal(parseGitHubRepo(''), null)
  assert.equal(parseGitHubRepo(null), null)
})
