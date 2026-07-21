<!-- assemble:start -->
# AGENTS.md — assemble

> Codex reads `AGENTS.md` the way Claude reads a skill. This mirrors the
> `assemble` Claude skill so **codex**-driven agents follow the same protocol.
> Full details live in [`.claude/skills/assemble/SKILL.md`](.claude/skills/assemble/SKILL.md)
> and [`.claude/skills/assemble/reference/protocol.md`](.claude/skills/assemble/reference/protocol.md).

`assemble` orchestrates an AI dev team. It shells out to provider CLIs
(`claude`, `codex`) headlessly — one worker per pipeline stage — records every
event to an append-only ledger, and pauses at **human gates** for approval.

## Mental model

- **Roster** (`agents`): named heroes, each with a `role`, `provider`
  (`claude`/`codex`), `model`, optional `thinking`/`effort`, `skills`, `timeout`.
- **Pipeline** (`stages`): ordered stages, each with an `id`, a `flavor`
  (`technical`/`ui`/`both`), a `gate` (`human`/`auto`), and a `prompt`.
- **Ledger** (`.assemble/ledger.ndjson`): append-only NDJSON. Status is always
  *derived* from these events — never stored. Do not edit it by hand.
- **Gates**: a `gate: human` stage stops at `awaiting_gate` after it runs.
  Nothing downstream proceeds until a human approves.
- **Cost/budget**: every worker call logs tokens + cost. The ledger is the only
  window into spend, since workers run silently.

## Command reference

```
assemble status               # derived pipeline status — who's working / awaiting gate
assemble run [--auto-commit]  # run the whole pipeline serially
assemble <stage-id>           # run one stage
assemble budget               # per-scope spend vs caps + remaining headroom
assemble gate approve <stage> # human sign-off (World Security Council)
assemble gate reject  <stage> --notes "<why>"
assemble gate skip    <stage> [--reason "<why>"]   # only for `when: auto` stages
```

## Guardrails (do NOT skip)

1. **Check budget before running.** Run `assemble budget` before `assemble run`
   or any stage on a paid provider. Workers run silently; the ledger is your
   only cost signal.
2. **Never fake a gate.** A `gate: human` stage MUST be advanced with
   `assemble gate approve/reject`. Never write `gate_approved` into the ledger
   directly and never edit `.assemble/ledger.ndjson`.
3. **Respect blocking order.** A stage is blocked until every earlier stage is
   `approved` or `skipped`. Resolve the earliest unsatisfied gate first — don't
   force it.
4. **Read the stage output before approving.** Surface the completed stage's
   result to the user and let *them* make the gate call. You are the driver; the
   human is the Council.
5. **`gate skip` is only for `when: auto` stages.** Trying to skip a
   `when: always` stage will error.

For the full event protocol, status-derivation table, flavor→hero selection,
pricing schema, and the exact CLI-to-adapter wiring, see the skill files linked
above.
<!-- assemble:end -->
