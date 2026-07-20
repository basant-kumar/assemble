# Troupe — Multi-Agent Dev Workflow Orchestrator (Design Spec)

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Origin:** Successor to [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow) v2.2.0, addressing its gaps for multi-agent orchestration.

## 1. Problem & Goals

TRIP-workflow proves that a small Plan → Implement → Release loop with cross-model
review (writer ≠ reviewer) reduces hallucination and drift. But its implementation
is prose + bash: models are hardcoded in a shell `case` on a directory name, the
only copilot is Codex CLI, gates (`APPROVED`, `REQUEST_CHANGES`) are magic strings
the agent is *trusted* to honor, state is flat files inside the skills directory,
and there is no design stage, no parallelism, no cost tracking.

**Troupe** keeps TRIP's virtues (few commands, ARCHI.md memory, writer/reviewer
separation) and replaces its trust-based orchestration with a real CLI-enforced
state machine.

Goals:

1. **Per-stage configurable models** — plan, plan-review, design, design-review,
   implement, code-review, release, memory-sync each routable to any
   provider/model with per-model tuning (thinking, effort, context window, speed,
   timeout, cost).
2. **Agents always follow the workflow** — gates and review loops are enforced by
   code, not prose. A disobedient agent can stall, never skip.
3. **Multi-provider** — Claude Code CLI, Codex CLI first-class; Gemini, OpenCode,
   Mistral Vibe, and anything else via a generic command-template adapter.
4. **Easy to use** — zero-config start, presets, 3 memorable commands. Config is
   optional overrides only.
5. **v1 includes** parallel implement batches (worktrees + batch DAG), cost/token
   ledger, and ARCHI.md drift detection. Implementation is phased: gates+config
   first, parallelism last.

## 2. Architecture Overview

**Approach: split driver.** Interactive stages (plan drafting, design
exploration — where the human converses) run in the user's Claude Code session
via thin skills. Mechanical stages (review loops, implement batches, gates,
release checks) are executed by the `troupe` CLI. The state machine lives in the
CLI in both cases: a skill cannot advance a stage without a recorded verdict,
because the next `troupe stage run` hard-fails on a missing/failed gate.

- **Distribution:** npm-installed TypeScript CLI (`troupe`) + thin Claude Code
  skills. Node is assumed present (Claude Code users have it).
- **The conductor is not special:** the interactive session is just the agent
  handling interactive stages. A future `troupe run --headless` can hand those
  to a claude adapter without architectural change.

### Repo layout (the troupe project itself)

```
troupe/
├── packages/cli/            # orchestrator CLI (TypeScript, zod schemas)
│   ├── src/config/          # troupe.config.yaml loader + validation + presets
│   ├── src/stages/          # stage state machine, gate enforcement
│   ├── src/adapters/        # claude / codex / generic adapters
│   ├── src/verdicts/        # structured verdict schemas + parsing
│   ├── src/ledger/          # run ledger, cost/token accounting
│   └── src/worktrees/       # parallel batch execution (phase 3)
├── skills/                  # thin SKILL.md wrappers (plan / implement / release)
└── templates/               # config starter, per-stage prompt templates
```

### Per-project footprint after `troupe init`

```
your-repo/
├── troupe.config.yaml       # optional overrides: stages, agents, models, gates
├── .troupe/                 # runs/, sessions/, worktrees/, ledger.ndjson
├── docs/troupe/             # plans, designs, reviews, ARCHI.md
└── .claude/skills/          # the 3 thin skills
```

`.troupe/` is gitignored except `ledger.ndjson` (project's choice at init).

### Components (crisp boundaries)

| Component | One purpose | Consumed via |
|---|---|---|
| Config | Load/validate/resolve `troupe.config.yaml` + presets | typed accessor module |
| Stage engine | State machine; only writer of stage status | `troupe stage run`, `troupe gate *` |
| Adapters | Uniform provider invocation | `Adapter` interface |
| Verdicts | JSON verdict schemas + parse/retry | verdict parser |
| Ledger | Append-only accounting | `troupe status`, `troupe report` |
| Prompt templates | Per-stage `.tpl`, safe substitution, user-overridable | template loader |

## 3. User Experience

- `troupe init` — interactive setup; working defaults for everything; generates
  minimal config, docs folders, skills, seed ARCHI.md.
- **3 skill commands**: `/troupe-plan`, `/troupe-implement`, `/troupe-release`.
- **Presets** (`mode:`): `solo` (one model everywhere), `duo` (writer +
  cross-provider reviewer), `full` (distinct model per stage). Users graduate to
  per-stage tuning only when they want it.
- **Direct stage invocation**: any stage runs standalone.
  - *Pipeline mode* (default in an active run): gates enforced.
  - *Ad-hoc mode*: `troupe stage run code-review --adhoc [--target <path|range>]`
    — no prerequisites, any target, ledger-tagged `adhoc`, never mutates run
    state. Replaces TRIP's `/TRIP-review`, `/TRIP-test`, `/codex-ask` with one
    uniform mechanism.
- `troupe status` — "where am I, what's approved, what's next" in one glance.
- `troupe config show --resolved` — fully expanded config; no magic.

## 4. Configuration Schema (`troupe.config.yaml`)

Everything optional; defaults ship for known models. Two-level indirection
`stages → agents → providers` so one line changes every review stage, while any
stage can still pin its own provider/model inline.

```yaml
project:
  name: MyApp
  test: npm test
  lint: npm run lint
  typecheck: npm run typecheck

mode: duo                        # solo | duo | full (preset → expands to agents block)

providers:
  claude:  { adapter: claude }
  codex:   { adapter: codex }
  gemini:
    adapter: generic
    command: 'gemini -m {model} -p {promptfile} --json'
    resume: none                 # none | flag:<--resume> | replay

models:                          # tuning profiles (all fields optional)
  fable-deep:
    provider: claude
    model: fable
    thinking: extended           # off | auto | extended
    effort: high                 # low | medium | high | xhigh
    context_window: 200k         # engine budgets prompt size; warns on overflow
    max_output: 32k
    timeout: 20m
    speed: quality               # fast | balanced | quality
    cost: { in: 15, out: 75 }    # $/Mtok → ledger cost accounting
  sol-reviewer:
    provider: codex
    model: gpt-5.6-sol
    effort: xhigh
    context_window: 400k
    cost: { in: 1.25, out: 10 }

agents:                          # named role → profile or inline binding
  writer:   { profile: fable-deep }
  reviewer: { profile: sol-reviewer }
  worker:   { provider: codex, model: gpt-5.6-luna }

stages:
  plan:          { agent: writer, interactive: true }
  plan-review:   { agent: reviewer, max_rounds: 3 }
  design:        { agent: writer, flavor: technical }  # technical | ui | both
  design-review: { agent: reviewer, max_rounds: 3, enabled: true }
  implement:     { agent: worker, parallel: 2 }        # max concurrent workers
  code-review:   { agent: reviewer, max_rounds: 3 }
  release:       { agent: writer, approval: human }    # human | auto
  memory-sync:   { agent: writer }                     # post-release ARCHI update

gates:                           # engine-enforced prerequisites
  implement: [plan-review: APPROVED, design-review: APPROVED]
  release:   [code-review: APPROVED, tests: PASS]

memory:
  file: docs/troupe/ARCHI.md
  max_tokens: 8k                 # exceeds → automatic compaction pass

budget:                          # cost caps, enforced by the engine
  per_run: 25                    # $; warn at 80%, act at 100%
  per_stage: { code-review: 5 }  # optional finer-grained caps
  action: pause                  # warn | pause (pause → `troupe run resume` after human review)
```

Rules:

- zod-validated at load; plain-English errors with YAML path.
- `enabled: false` on a non-core stage removes it and auto-drops it from
  downstream gates (hybrid pipeline: 3 commands, config-defined sub-stages).
- Impossible gates (referencing disabled/unknown stages) fail at load, not mid-run.
- Built-in model profiles (context window, cost) ship for known models;
  `troupe models list` shows resolved profiles.
- Env-var overrides (`TROUPE_STAGE_<stage>_MODEL`, etc.) for one-off runs.

## 5. Multi-Agent Model

**One stage invocation = one agent**: a provider CLI process launched by the
engine with a role prompt template, model+knobs, and a sandbox level from config.

```
              conductor (interactive Claude session, thin skills)
                              │  calls `troupe`
                              ▼
                    troupe CLI (stage engine)
        ┌───────────────┬──────────────────┐
        ▼               ▼                  ▼
  writer agent    reviewer agent     worker agents ×N (parallel implement)
  resumable        fresh/resumed      one per batch, own git worktree
  session          thread
```

Mechanics:

1. **Persistent sessions** — `.troupe/sessions/` stores each agent's
   session/thread id. Review loops resume the same reviewer thread across rounds
   (it remembers earlier findings); the writer resumes its own session to apply
   fixes. Adapters abstract resume (`--resume` for claude, thread id for codex,
   transcript replay for generic).
2. **Role separation enforced structurally** — writer and reviewer are never the
   same session; by default not the same provider/model (configurable).
3. **Loops are code** — spawn reviewer → parse JSON verdict → route findings to
   writer → revise → re-invoke reviewer → until APPROVED or max_rounds →
   escalate to human. No agent decides to skip a round.
4. **Parallel workers** — batch DAG fan-out (see §8).

## 6. Stage State Machine & Verdicts

A **run** = one feature moving through the pipeline.
`troupe run start "dark-mode"` creates `.troupe/runs/<date>-dark-mode/` with a
transactional JSON state file (write-temp + rename).

Stage statuses: `pending → running → needs_review → approved | failed | skipped`.
The engine is the only writer; every transition appends to the ledger.

**Verdict schema** (all review stages, zod-validated):

```json
{
  "verdict": "REQUEST_CHANGES",          // APPROVED | REQUEST_CHANGES | BLOCKED
  "round": 2,
  "findings": [
    { "severity": "major",               // critical | major | minor | nit
      "file": "src/auth.ts", "line": 42,
      "summary": "token never expires",
      "suggestion": "add TTL check" }
  ],
  "notes": "optional free text"
}
```

- Reviewer prompts demand JSON output; on parse failure: one retry with a
  "fix your JSON" message, then verdict `BLOCKED`.
- `max_rounds` exhausted → stage status `needs_review`; human decides:
  `troupe gate approve <stage>` / `troupe gate reject <stage>`. Overrides are
  always recorded in the ledger as `approvedBy: human`.
- Gates are pure checks against run state; refusal messages say exactly which
  verdict is missing and how to obtain it.
- **Interactive stages use the same machinery**: plan and design take their
  verdict from the human — `troupe gate approve plan` records
  `{verdict: APPROVED, approvedBy: human}` with the identical schema and ledger
  entry as agent verdicts. One uniform state machine, no special-casing.

## 7. Provider Adapters

```ts
interface Adapter {
  capabilities(): { resume: 'native' | 'replay' | 'none';
                    sandboxLevels: SandboxLevel[]; jsonOutput: boolean }
  invoke(req: {
    prompt: string; model: string;
    knobs: { thinking?, effort?, maxOutput?, timeout, speed? };
    sandbox: 'read-only' | 'workspace-write';
    sessionId?: string; cwd: string;
  }): Promise<{ text: string; sessionId?: string;
                usage: { tokensIn: number; tokensOut: number } }>
}
```

- **claude**: `claude -p --output-format stream-json --model <m>`; resume
  `--resume <sessionId>`; sandbox via permission mode/allowed tools; thinking →
  extended-thinking flags.
- **codex**: `codex exec --json -c model=<m> -c model_reasoning_effort=<effort>
  --sandbox <level>`; resume via captured thread id.
- **generic** (Gemini, OpenCode, Mistral Vibe, anything): user command template
  with `{model}` `{promptfile}` `{outputfile}` `{sessionid}` placeholders +
  declared resume strategy. `replay` does **not** resend full transcripts: the
  engine maintains a per-session **rolling digest** (findings + their
  resolutions, token-capped) and prepends only that — cost stays linear in
  rounds, not quadratic. Providers with native resume (claude, codex) never pay
  any replay cost.
- Normalized knobs are adapter-mapped; unsupported knobs warn and skip, never fail.
- **Role→sandbox policy engine-enforced**: reviewers get `read-only`;
  writers/workers get `workspace-write` scoped to their worktree. An adapter
  lacking read-only capability cannot be bound to a reviewer role (config load
  error).
- **Failure taxonomy**: `timeout | auth | crash | parse`. Transient → retry with
  backoff (2 attempts); persistent → stage fails with stderr tail in the ledger.
- Template substitution is a safe string replace (no awk/gsub `&` corruption);
  prompt content is passed via files, not shell interpolation.

## 8. Parallel Implement (Batch DAG + Worktrees)

- Plan docs carry a machine-readable **batch manifest** (YAML frontmatter):
  `batches: [{id, title, files, depends_on: []}]`.
- **Schema-guided authoring**: the engine hands the plan agent a strict JSON
  schema for the manifest and validates the output immediately with the same
  parse-retry loop as verdicts (one retry with the validation errors, then
  escalate to human). The manifest is never trusted-by-prose.
- `depends_on` may be omitted: the engine **auto-derives dependencies from
  file-list overlaps** (two batches touching the same file are serialized)
  rather than failing. Explicit deps are validated: no cycles, no unknown ids.
- `troupe plan validate` runs the full manifest check standalone, so a human
  editing the plan gets the same guarantees as the agent.
- Execution: engine tops up to `parallel: N` workers. Per batch:
  worktree `.troupe/worktrees/<run>/<batch-id>` branched off the run branch →
  worker implements → engine runs test/lint/typecheck in the worktree →
  **delta code-review** (same loop mechanics as §6) → merge into run branch in
  dependency order.
- **Merge conflicts** pause the batch and escalate to the human; no agent
  auto-resolves conflicts in v1.
- `parallel: 1` degrades to TRIP's proven serial batch flow.
- Final pass after all merges: full-tree test gate + fresh-thread full code
  review (never a thread that wrote the code) → release-eligible.

## 9. Ledger, Cost Tracking & Memory

- `.troupe/ledger.ndjson`, append-only, one entry per agent invocation and
  state transition: `{ts, run, stage, round, agent, provider, model, tokensIn,
  tokensOut, cost, durationMs, outcome, approvedBy}`.
- `troupe report [--run X | --all]`: cost/tokens per stage and per model, review
  rounds per stage, human overrides — the data for A/B-ing model configs.
- **Budget enforcement**: the engine checks the ledger against `budget:` before
  every agent invocation — warn at 80%, `warn|pause` at cap. A paused run keeps
  all state and resumes with `troupe run resume` after human review. Ad-hoc
  invocations count against the run budget too.
- **Cost posture** (how troupe stays cheap by construction):
  - Reviewers receive **delta diffs + only the relevant docs**, never
    whole-repo context dumps.
  - Mechanical stages run in **fresh minimal-context threads** instead of one
    long interactive session that re-sends an ever-growing context every turn.
  - **Cheap models are routable per stage** (e.g., a low-effort model for batch
    delta reviews, the expensive one only for plan review).
  - Native session resume on claude/codex means loops add zero replay overhead;
    generic providers use token-capped digests (§7).
- **ARCHI.md** kept as long-term architectural memory at `docs/troupe/ARCHI.md`.
  Post-release `memory-sync` stage: agent receives release diff + ARCHI.md,
  updates stale claims, reports drift findings. Token budget breach triggers an
  automatic compaction pass (TRIP's `/TRIP-compact`, now a stage, not a chore).

## 10. Error Handling & Recovery

- **Config**: validated at load; plain-English errors with YAML path.
- **Crash recovery**: transactional run state; `troupe run resume` re-enters at
  the last incomplete stage; sessions re-attached where supported, else replayed.
- **Orphans**: `troupe clean` removes dead worktrees/stale sessions; the engine
  refuses to start a batch on an uncleaned worktree, with the fix-it command in
  the error message.
- **Instruction-following guarantee**: skills hold no state; all mutations go
  through the CLI which validates transitions. Worst case with a disobedient
  agent: nothing happens, loudly.

## 11. Testing Strategy

- **Unit**: config loader/presets, state machine (every legal/illegal edge),
  verdict parser (malformed JSON, retry path), DAG validator (including
  auto-derived deps from file overlaps), gate auto-drop for disabled stages,
  budget threshold math, rolling-digest token caps, template substitution.
- **Adapter contract tests**: fake provider binaries with record/replay fixtures
  exercise invoke/resume/timeout/failure per adapter — no real API calls.
- **E2E**: a `mock` adapter (scripted responses) drives full pipeline runs in a
  temp git repo: plan → release including a REQUEST_CHANGES→APPROVED loop and a
  parallel-batch merge.

## 12. Implementation Phases

1. **Phase 1 — core**: config + presets, stage engine + gates, verdicts, claude &
   codex adapters, serial implement, ledger, `init`/`status`/`stage run`/`gate`,
   thin skills.
2. **Phase 2 — breadth**: generic adapter (Gemini/OpenCode), ad-hoc mode,
   `report` with cost accounting, model profiles + context budgeting,
   memory-sync + compaction.
3. **Phase 3 — parallelism**: batch DAG validation, worktree workers, delta
   reviews, merge sequencing, `clean`/`resume` hardening.

## 13. Out of Scope (v1)

- Headless full-pipeline mode (`troupe run --headless`) — architecture permits,
  not built.
- Agent auto-resolution of merge conflicts.
- Web dashboard (ledger is the data source when wanted).
- MCP servers, issue-tracker integrations.

## 14. Decisions Log

| Decision | Choice |
|---|---|
| Pipeline shape | Hybrid: 3 user commands, config-defined sub-stages |
| Design/design-review in cycle | Yes — default sub-stages of Plan, toggleable |
| Orchestrator form | CLI tool + thin skills (split driver) |
| Design stage output | Technical or UI or both — per-project `flavor` |
| Providers v1 | claude, codex first-class; gemini/opencode via generic |
| Language | TypeScript/Node, npm distribution |
| v1 scope | Parallel batches + cost tracking + drift detection (phased) |
| Name | `troupe` — agents performing on stages, gated acts |
| Cost control | Budget caps (warn/pause) + delta reviews + per-stage cheap-model routing + native resume; rolling digests for resume-less providers |
| Batch manifest trust | Schema-guided authoring with verdict-style parse-retry; deps auto-derived from file overlaps; `troupe plan validate` |
