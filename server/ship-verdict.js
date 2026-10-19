/**
 * The next thing you have to do to ship a pull request, as one word.
 *
 * The sidebar does not show PR *status* — checks, review, draft — because a
 * worktree can own several PRs and a status readout per row does not fit. It
 * shows a *verdict*: the loudest action across the PRs the worktree owns.
 *
 *   fix       CI is red on the head commit.
 *   address   a reviewer requested changes.
 *   rebase    conflicts, or behind the base on a branch that requires it.
 *   merge     GitHub says it can be merged and nothing above applies.
 *   stacked   would be `merge`, but its base is another open PR of yours —
 *             an upper rung ships after the one below it.
 *   draft     yours to un-draft; nothing else is asking.
 *   ci        checks still running.
 *   review    waiting on reviewers, or blocked by something GitHub does not
 *             name (CODEOWNERS, unresolved threads, a merge queue).
 *
 * The first four are the attention set; the rest are quiet.
 *
 * Rules that came from real PRs rather than the GitHub docs:
 *  - A draft upper rung reports `mergeStateStatus: CLEAN`; `DRAFT` is not
 *    reliably returned. So `isDraft` gates merge/ci/review but never the red
 *    trio — failing CI, requested changes and conflicts are work regardless.
 *    BEHIND on a draft is noise (you rebase when you un-draft); DIRTY is not.
 *  - BLOCKED is never `merge`. Only UNKNOWN — freshly pushed, GitHub still
 *    computing — earns the approved-and-green fallback.
 *
 * Kept free of imports so it can be unit-tested with plain `node --test`.
 * The client mirrors VERDICTS in Sidebar.tsx (`SHIP_ORDER`); keep them in step.
 */

/** Loudest first. */
export const VERDICTS = ['fix', 'address', 'rebase', 'merge', 'stacked', 'draft', 'ci', 'review']

/** The verdicts that mean "you have to do something". */
export const ATTENTION = new Set(['fix', 'address', 'rebase', 'merge'])

/** Higher is louder; unknown words rank below everything. */
export const rank = (verdict) => {
  const i = VERDICTS.indexOf(verdict)
  return i === -1 ? 0 : VERDICTS.length - i
}

/**
 * @param {object} pr
 * @param {boolean} pr.isDraft
 * @param {string|null} pr.reviewDecision  APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
 * @param {string|null} pr.rollup          head commit statusCheckRollup.state:
 *                                         SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null
 * @param {string|null} pr.mergeStateStatus CLEAN | BEHIND | BLOCKED | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE | null
 * @param {boolean} pr.baseIsMyOpenPr      the base branch is the head of another open PR of yours
 */
export function verdictFor({
  isDraft = false, reviewDecision = null, rollup = null, mergeStateStatus = null, baseIsMyOpenPr = false,
} = {}) {
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'fix'
  if (reviewDecision === 'CHANGES_REQUESTED') return 'address'
  if (mergeStateStatus === 'DIRTY' || (mergeStateStatus === 'BEHIND' && !isDraft)) return 'rebase'

  const undecided = mergeStateStatus === 'UNKNOWN' || mergeStateStatus === null
  const mergeable = mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS'
    || (undecided && reviewDecision === 'APPROVED' && rollup === 'SUCCESS')
  if (!isDraft && mergeable) return baseIsMyOpenPr ? 'stacked' : 'merge'

  if (isDraft) return 'draft'
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return 'ci'
  return 'review'
}

/** The loudest of several verdicts, or null for none. */
export function loudest(verdicts) {
  let best = null
  for (const v of verdicts) if (best === null || rank(v) > rank(best)) best = v
  return best
}
