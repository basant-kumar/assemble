# assemble — protocol reference

Deep detail for the `assemble` skill. Load this when you need exact event
semantics, status derivation, agent selection, pricing, or adapter wiring.

## Ledger event protocol

The ledger is `.assemble/ledger.ndjson` — one JSON object per line, append-only.
Event types (`LedgerEvent.type`):

| type              | emitted when                              | key fields |
|-------------------|-------------------------------------------|------------|
| `stage_started`   | a stage begins                            | `stage`, `agent` |
| `stage_completed` | worker returned successfully              | `stage`, `agent`, `tokensIn`, `tokensOut` |
| `stage_failed`    | worker threw / timed out                  | `stage`, `agent`, `notes` |
| `cost`            | after each worker call                    | `stage`, `worker`, `model`, `tokensIn`, `tokensOut`, `costUsd` |
| `gate_approved`   | `assemble gate approve`                   | `stage`, `approvedBy` |
| `gate_rejected`   | `assemble gate reject`                    | `stage`, `approvedBy`, `notes` |
| `stage_skipped`   | `assemble gate skip` / disabled stage     | `stage`, `approvedBy`, `notes` |
| `budget_abort`    | a "pause"-policy budget breach aborted    | `stage` |
| `memory_synced`   | `assemble memory-sync`                    | `stage`, `sha` (HEAD base for next diff) |

Every event carries an ISO `ts`. Status is **derived**, never written.

## Status derivation (`deriveStageStatus`)

Fold the ledger events for a stage in order:

- `stage.enabled === false` → **`skipped`** (short-circuit; never runs, never blocks).
- start: **`pending`**
- `stage_started` → **`running`**
- `stage_completed` → **`awaiting_gate`** if `stage.gate === "human"`, else **`approved`**
- `stage_failed` → **`failed`**
- `gate_approved` → **`approved`**
- `gate_rejected` → **`needs_rework`**
- `stage_skipped` → **`skipped`**

`isStageSatisfied(status) = status === "approved" || status === "skipped"`.
A stage is **blocked** from running until *every earlier stage* is satisfied.

## Flavor → hero selection (`resolveStageAgent`)

- `agentSpecialty(role)` maps a role to `technical` | `ui` | `null` (regex on role name).
- If the stage's currently configured agent's specialty already matches
  `stage.flavor` → use it (`auto: false`).
- Otherwise auto-select the **first** agent in `config.agents` whose specialty
  matches the flavor (`auto: true`, logged as `↳ flavor:… → auto-selected …`).
- `flavor: both` / unset falls back to the stage's configured agent.

## Run path (`runStage` → adapter)

1. Locate stage by `id`; error if unknown, disabled, or **blocked** by an
   unsatisfied earlier stage.
2. `resolveStageAgent` → `agent = config.agents[name]`.
3. `model = stage.modelOverride ?? agent.model`.
4. `prompt = withSkills(agent.skills, stage.prompt)` (skills prefixed onto prompt).
5. Build `runOpts = { prompt, model, cwd }`; add `thinking` (claude only) or
   `effort` (codex only); add `timeoutMs` from `agent.timeout`.
6. `appendEvent(stage_started)`.
7. `adapter.run(runOpts)` (see adapters below).
8. `appendEvent(stage_completed)` + `appendEvent(cost)` with `computeCost`.
9. If `--auto-commit` and `config.utilityModel`: `commitStageChanges` runs the
   utility model to draft a commit; emits a second `cost` event (`worker: "utility"`).
10. On throw: `appendEvent(stage_failed, notes)`.

## Adapters (`src/adapters.ts`)

Both spawn a provider CLI via `execFile` (64 MB maxBuffer, killed on timeout).

**claude** (`claudeAdapter`):
```
claude -p <prompt> --model <model> --output-format json
```
- Thinking budget via env `MAX_THINKING_TOKENS`, from
  `THINKING_BUDGET = { off: "0", auto: null, extended: "31999" }`
  (`null`/`auto` leaves it unset → model decides).
- Parses stdout JSON: `result` → output, `usage.input_tokens` / `usage.output_tokens`.
- Non-JSON stdout → `AdapterError`.

**codex** (`codexAdapter`):
```
codex exec --json --model <model> [-c model_reasoning_effort="<effort>"] <prompt>
```
- Reads newline-delimited JSON events; concatenates `message.text`; reads
  `token_count` events for tokens.

`getAdapter(provider)` supports `claude` and `codex` (M1). Unknown → `AdapterError`.

## Cost model (`computeCost`)

```
cost = tokensIn * pricing[model].input + tokensOut * pricing[model].output
```
`pricing` is a record keyed by model id. Override/extend via env
`ASSEMBLE_PRICING_JSON` (JSON merged over the config table).

## Gate protocol (`src/gate.ts`)

- `approveGate` / `rejectGate` call `requireAwaiting` first: the stage must be
  `awaiting_gate`, else `GateError: stage '…' is <status>, not awaiting_gate`.
- `approve` → `gate_approved` (default `approvedBy: "council"`).
- `reject` → `gate_rejected` + `notes`.
- Skips (`when: auto` only) emit `stage_skipped`.

## Memory (`assemble memory-sync`)

Refreshes `docs/assemble/ARCHI.md` (default `DEFAULT_ARCHI_PATH`) from the diff
since the last `memory_synced` sha (or `--since <ref>`). Records a new
`memory_synced` event with the current HEAD sha as the base for the next diff.
