# Orchestrator profiles

A profile is a complete example config for one kind of machine. Nothing here is
read by the app: copy the nearest one into the machine's `orchestrator/` folder
(beside `pm.config.json`, gitignored) and edit it.

```bash
node scripts/orchestrator-runner-check.js   # first, on any new machine
mkdir -p orchestrator
cp -R profiles/solo-ship/. orchestrator/
# then set "orchestrator": { "enabled": true } in pm.config.json and restart
```

| Profile | For |
| --- | --- |
| `solo-ship` | Personal repos that ship without review: build, verify, PR, merge, deploy. No gates. |
| `team-review` | A machine with team review and estimate-driven work. `code-change`: a plan record and plan gate before any code, fresh reviewers and a PR gate with an explain-back, CI and review comments watched, then a post-check of predicted against measured. `investigation`: count the pool, sample causes into an evidence record, cross-check the arithmetic with a second model, decide per cause, hand the chosen ones off as code-change runs. |
| `ci-only` | A solo business repo where CI is the only reviewer. Tasks come from a ClickUp queue, and one existing skill cuts the branch, opens the PR, writes status and watches CI. |

Profiles carry structure and placeholder values only. Real repo names, paths,
thresholds and tokens belong in the machine's own folder, never here.

## Layout of the machine folder

| Path | Holds |
| --- | --- |
| `machine.json` | Sources, pipelines, permission sets, limits, session model |
| `repos/<repo dir name>.json` | That repo's source, pipeline, verify commands and ship policy |
| `prompts/*.md` | Stage prompts a pipeline names |
| `sources/*.js`, `stages/*.js`, `checks/*.js` | Private adapters; a file with a repo adapter's name overrides or wraps it |
| `runs/` | The run store. Written by the app. |

The Rules screen in Orchestrator mode shows the effective result and which file
each value came from.

## A skill that owns side effects

Cutting the branch, writing task status, opening the PR and watching CI each
have exactly one owner in a pipeline. When a `work` stage runs a skill that
already does some of them, say so with `owns`, give it the calls it needs with
`allow`, and switch the stage kind that would repeat it off:

- `intake` takes `"branch": false` and hands the skill a detached worktree.
- `pr` and `watch` are left out; the stage's check is `{ "pr": "exists" }`.
- `merge` takes `"waitOnly": true`.
- The source keeps `"statusSync": false`, because the skill writes status.

A pipeline where one of the four has two owners is refused when a run starts,
and the Rules screen shows who owns what.
