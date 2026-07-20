# assemble — Milestone 3: Budget Caps + Enforcement Implementation Plan

M3 builds directly on M2. M2 gave us accurate cost accounting (`cost` ledger
events, `computeCost`, `aggregateCost`) and a pricing table. M3 makes the
orchestrator *act* on that spend: define budgets in config, track running spend
during a pipeline run, and enforce a policy when a budget is breached.

## Global Constraints

- **TDD**: every task writes failing tests first, then the implementation.
- **No breaking changes**: `budget` is optional. Configs without it behave
  exactly as they do today (unlimited spend, no enforcement).
- **Enforcement is deterministic**: given the same ledger, the same breach
  decision is reached every time. No model calls in the enforcement path.
- **Fail safe, not silent**: a breach under `block` aborts the run with a
  non-zero exit and a clear message; it never silently continues.
- Reuse M2 primitives — do not re-derive cost. Enforcement consumes
  `aggregateCost` output.

## File Structure

- `src/config.ts` — add `BudgetSchema` + `budget` field to `ConfigSchema`.
- `src/budget.ts` — **new**: `checkBudget(config, events)` → breach decision.
- `src/engine.ts` — call the budget check after each `cost` event is appended.
- `src/pipeline.ts` — honor the enforcement decision between stages.
- `src/cli.ts` — `assemble budget` status command; `assemble cost` shows
  remaining headroom.
- Tests alongside each: `tests/budget.test.ts`, plus additions to
  `config`/`engine`/`pipeline`/`cli` test files.

### Task 1: `budget` in Config Schema

Add an optional budget block. Support a global cap and optional per-stage and
per-worker caps, plus an enforcement `policy`.

```yaml
budget:
  policy: block        # warn | pause | block  (default: warn)
  total: 5.00          # USD cap for the whole run (optional)
  perStage:            # optional per-stage caps
    implement: 2.00
  perWorker:           # optional per-worker caps
    sonnet-worker: 1.50
```

- `BudgetSchema`: `policy` enum defaulting to `warn`; `total`, `perStage`,
  `perWorker` all optional, non-negative.
- Tests: valid budget parses; negative cap rejected; omitted budget → config
  still valid and `budget === undefined`.

### Task 2: `checkBudget` Breach Logic (`src/budget.ts`)

Pure function: `checkBudget(config, events): BudgetDecision`.

- Uses `aggregateCost(events)` for running totals.
- Compares `total`, each `perStage[stage]`, each `perWorker[worker]` against
  their caps. Returns `{ breached: boolean, policy, breaches: Breach[] }`
  where each breach names the scope (`total` / `stage:x` / `worker:y`), the
  cap, and the actual spend.
- No budget configured → `{ breached: false, breaches: [] }`.
- Tests: under cap → not breached; total over cap → breached; per-stage over
  cap → breached with correct scope; multiple simultaneous breaches reported.

### Task 3: Enforcement in the Engine/Pipeline

After each stage's `cost` event is written, re-read the ledger and call
`checkBudget`. Apply the policy:

- `warn` — log a warning line, continue.
- `pause` — surface a human gate ("budget exceeded — approve to continue?"),
  reusing the M1 gate mechanism; on reject, stop.
- `block` — write a `budget-abort` ledger event and throw, aborting the run
  with a non-zero exit.

- Tests: `block` policy over cap halts before the next stage and exits
  non-zero; `warn` policy over cap logs but completes; `pause` over cap invokes
  the gate; under cap runs untouched (regression guard).

### Task 4: CLI Surface

- `assemble budget` — prints per-scope spend vs cap and remaining headroom,
  reading the ledger like `assemble cost` does.
- `assemble cost` — append a "remaining" column when a budget is configured.
- Tests: `budget` command output shows caps and remaining; degrades gracefully
  when no budget configured.

### Task 5: Milestone Review Pass

Full `npx vitest run`; typecheck; verify no regression to M1/M2 behavior;
update README with the `budget` config block and `assemble budget` command.

## Out of Scope (follow-up plans)

- Real Slack/Jira side-op targets (still deferred from M2 — needs per-target
  adapters, auth, API surface).
- Soft/rolling budgets across multiple runs (M3 scopes budget to a single run's
  ledger).
- Cost forecasting / pre-run estimation before a stage executes.

## Self-Review Notes

- Enforcement path is pure + deterministic; no model calls — satisfies the
  global constraint and keeps `block` decisions reproducible from the ledger.
- `budget` optional → zero behavior change for existing configs (regression
  guarded in Task 3).
- `pause` reuses the existing human-gate primitive rather than inventing a new
  interaction path.
