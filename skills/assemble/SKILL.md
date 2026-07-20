---
name: assemble
description: >-
  Drive the `assemble` CLI — a multi-agent dev-workflow orchestrator that runs a
  gated pipeline (design → plan-review → implement → code-review → design-review
  → release) where each stage is handled by a configured model/provider (Claude,
  Codex, …). Use when the user wants to run, inspect, gate, configure, or debug
  an assemble pipeline; mentions assemble, the roster/ledger/gates, ARCHI.md
  memory, per-stage model config, or files like assemble.config.yaml /
  .assemble/ledger.ndjson. Also use before spawning provider workers so you
  respect budgets and human gates.
---

# assemble

`assemble` orchestrates an AI dev team. It shells out to provider CLIs
(`claude`, `codex`) headlessly — one worker per pipeline stage — records every
event to an append-only ledger, and pauses at **human gates** for approval.

## Mental model (read this first)

- **Roster** (`agents` in `assemble.config.yaml`): named heroes, each with a
  `role`, `provider` (`claude`/`codex`), `model`, optional `thinking`/`effort`,
  `skills`, `timeout`.
- **Pipeline** (`stages`): ordered stages, each with an `id`, a `flavor`
  (`technical`/`ui`/`both`) used to auto-pick a matching hero, a `gate`
  (`human`/`auto`), and a `prompt`.
- **Ledger** (`.assemble/ledger.ndjson`): append-only NDJSON. **Status is always
  *derived* from these events — never stored.** Do not edit it by hand.
- **Gates**: a stage with `gate: human` stops at `awaiting_gate` after it runs.
  Nothing downstream proceeds until a human (the "World Security Council")
  approves. Approval is `isStageSatisfied = approved || skipped`.
- **Memory**: `assemble memory-sync` refreshes architectural memory
  (`docs/assemble/ARCHI.md`) from the release diff.
- **Cost/budget**: every worker call logs tokens + `computeCost`. The ledger is
  the *only* window into spend, since workers run silently.

## Command reference

```
assemble init                 # scaffold assemble.config.yaml (MCU theme)
assemble status               # derived pipeline status — who's working / awaiting gate
assemble configure|config     # interactive wizard: model + knobs per hero
assemble cost                 # aggregate token cost by worker and stage
assemble budget               # per-scope spend vs configured caps + remaining headroom
assemble run [--auto-commit]  # run the whole pipeline serially
assemble <stage-id>           # run one stage (dynamic command per configured stage)
assemble stage run <id>       # explicit long-form single-stage invocation
assemble memory-sync [--since <ref>]   # refresh ARCHI.md from the release diff

# Human gate decisions (World Security Council):
assemble gate approve <stage>
assemble gate reject  <stage> --notes "<why>"
assemble gate skip    <stage> [--reason "<why>"]   # only for `when: auto` stages
```

## Typical workflows

**Start a project**
```
assemble init            # then edit assemble.config.yaml, or:
assemble configure       # wizard to assign models/knobs per hero
assemble status          # confirm the roster + stage order
```

**Run and gate**
```
assemble run             # runs stages until one hits a human gate → awaiting_gate
assemble status          # see which stage is awaiting_gate + read its output
assemble gate approve code-review     # or: gate reject code-review --notes "…"
assemble run             # resume from the next unsatisfied stage
```

**Inspect spend**
```
assemble cost            # tokens/$ by worker + stage
assemble budget          # spend vs caps; do this BEFORE a big run
```

## Guardrails (do NOT skip)

1. **Check budget before running.** Run `assemble budget` before `assemble run`
   or any stage mapped to a paid provider. Workers run silently; the ledger is
   your only cost signal.
2. **Recursion awareness.** If you (Claude) invoke `assemble` and a stage's
   provider is `claude`, you are spawning `claude -p` sub-workers — Claude
   orchestrating Claude. This is intended and isolated, but each worker consumes
   quota independently and cannot ask questions (it's one-shot `-p`). That is
   exactly why human gates exist.
3. **Never fake a gate.** A `gate: human` stage MUST be advanced with
   `assemble gate approve/reject`. Never write `gate_approved` into the ledger
   directly and never edit `.assemble/ledger.ndjson`.
4. **Respect blocking order.** A stage is blocked until every earlier stage is
   `approved` or `skipped`. If `assemble run` errors with "stage X is blocked:
   earlier stage Y is …", resolve Y's gate first — don't force it.
5. **Read the stage output before approving.** Surface the completed stage's
   result to the user and let *them* make the gate call. You are the driver, the
   human is the Council.
6. **`gate skip` is only for `when: auto` stages** (e.g. skip `design` on a
   pure-logic change). Trying to skip a `when: always` stage will error.

## Config quick-reference

`assemble.config.yaml` top level: `agents`, `stages`, `pricing`,
`utilityModel`, `memory`, `theme`.

- **agent**: `role`, `provider` (`claude`|`codex`), `model`, `skills[]`,
  `thinking` (`off`|`auto`|`extended`, claude), `effort`
  (`low`|`medium`|`high`|`xhigh`, codex), `timeout` (e.g. `"5m"`).
- **stage**: `id`, `agent`, `flavor` (`technical`|`ui`|`both`), `gate`
  (`human`|`auto`, default `auto`), `when` (`always`|`auto`, default `always`),
  `enabled` (default `true`), `modelOverride`, `prompt`.
- **env overrides**: `ASSEMBLE_PRICING_JSON` (merge/override pricing table).

For the full event protocol, status-derivation table, flavor→hero selection,
pricing schema, and the exact CLI-to-adapter wiring, see
[reference/protocol.md](reference/protocol.md).
