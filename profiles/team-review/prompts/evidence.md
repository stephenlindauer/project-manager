## What to do

Split the pool into causes, from what you can see in real cases.

The pool record (`pool.json`, in this run's records folder) is the total. For each cause:

- Read real traces. List the trace ids you read; `traces_read` is their count.
- `basis` is `seen in trace` only if you watched it happen in a trace. If you worked it out from reading code, say `inferred from code`.
- `share` is its share of the pool. `low` and `high` are a range for its size, never one number.
- `top_actor_share` is the share of this cause that comes from its single largest user or workspace.
- `steps` is the calculation, one entry per factor, each with its value and where that value came from.

Use the stored data in `data_refs`. Do not propose fixes.
