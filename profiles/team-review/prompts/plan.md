## What to do

Write the plan for this task before any code is written. Do not change code.

Read enough of the repository to answer each field from what is actually there:

- `problem`: what is wrong, in one or two sentences.
- `evidence`: what shows it is wrong. Name the file, the log line, the query.
- `done_looks_like`: how anyone can tell the change worked.
- `fix_kind`: `root-cause` or `symptom`. Be honest. If the real cause is somewhere this task does not reach, say `symptom`.
- `precedents`: two or three earlier changes in this repository that did something similar, each with a commit or PR reference and why it is similar. Find them with `git log`.
- `failure_mode_prevented`: the specific failure this change stops from happening.
- `prediction`: the metric it should move, how to read that metric, its baseline with the window, the predicted value as a low–high range, and the earliest date the check can run.
