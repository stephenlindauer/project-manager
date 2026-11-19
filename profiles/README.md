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
