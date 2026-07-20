# assemble 🦸

**The Avengers, but for your codebase.** A multi-agent dev workflow
orchestrator: Plan → Design → Implement → Release, with a different AI model
cast for every role — and gates that agents *cannot* skip, because the state
machine lives in a CLI (the Director), not in prose.

Successor to [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow):
same philosophy (writer ≠ reviewer, long-term ARCHI.md memory, few commands),
but models are config, gates are code, and any provider CLI can join the team.

> Fury (orchestrator) never writes code. He assembles the team, hands out
> missions, guards the gates, keeps the ledger — and calls **you** (the World
> Security Council) when a mission needs a human decision.

## The roster

| Agent | Mission | Default casting |
|---|---|---|
| 🕶️ **fury (orchestrator)** | The Director — the CLI engine itself. Orchestrates, enforces, never fights | deterministic code |
| 🤖 **stark (architect)** | Plans the mission & designs the architecture | strongest reasoning model |
| 🧬 **shuri (UI designer)** | UI/product design (`flavor: ui`) | strong + fast |
| 🔮 **strange (plan/design reviewer)** | Reviews plans & designs — checks 14,000,605 futures, approves the one that works | cross-provider reviewer, `effort: xhigh` |
| 🟡 **vision (code reviewer)** | Delta code-review on each batch — precise, worthy | mid-tier |
| ✨ **danvers (final reviewer)** | Final full-tree code review — flies in fresh, zero context contamination | big-context model |
| 🔨 **thor (implementer)** / 💪 **hulk (refactorer)** | Heavy implementation batches & big refactors | strong workers |
| 🕷️ **spidey (small batches)** / 🏹 **hawkeye (minor edits)** | Fast small batches / precision minor edits | cheap + fast |
| 🛡️ **cap (release)** | Release: assembles notes, holds the line — ship order comes from you | reliable mid-tier |
| 🧠 **jarvis (memory)** | memory-sync: keeps `ARCHI.md` (long-term memory) current, compacts it | cheap |
| 💼 **pepper (ledger)** | The ledger: every token & dollar. Budget breached → **Pepper freezes the card** (run pauses) | deterministic code |
| 🌈 **heimdall (gates)** | The gates. Nothing crosses without a recorded verdict | deterministic code |
| 🥷 **ronin (ad-hoc)** | Ad-hoc off-book missions (`--adhoc`): review anything, mutate nothing | any |
| 🧹 **Damage Control (cleanup)** | `assemble clean` — dead worktrees, stale sessions | deterministic code |
| 🏛️ **You (human)** | World Security Council: human gates, escalations, budget overrides | human |

Hero names are **agent roles in config** — cast any provider/model into any
role. Protocol constants stay boring (`APPROVED`, `plan-review`) so tooling
never depends on flavor.

> **Theme disclaimer:** this project is not affiliated with, endorsed by, or
> sponsored by Marvel or Disney. The MCU character names are just the default,
> fully swappable display theme; protocol constants and machine-readable
> identifiers are unthemed.

## The mission loop

```mermaid
flowchart TD
    subgraph P["/assemble-plan"]
        plan["🤖 stark (architect)<br/>plan (interactive)"] --> pr["🔮 strange (plan/design reviewer)<br/>plan-review"]
        pr -->|REQUEST_CHANGES ≤ max_rounds| plan
        pr -->|APPROVED| design["🤖 stark (architect) / 🧬 shuri (UI designer)<br/>design"]
        design --> dr["🔮 strange (plan/design reviewer)<br/>design-review"]
        dr -->|REQUEST_CHANGES| design
    end
    dr -->|APPROVED| GATE1{{"🌈 heimdall (gates)<br/>plan-review APPROVED<br/>design-review APPROVED"}}
    GATE1 --> subI

    subgraph subI["/assemble-implement"]
        direction TB
        dag["batch DAG from stark (architect)'s manifest"] --> w1["🔨 thor (implementer)<br/>batch A · worktree"]
        dag --> w2["🕷️ spidey (small batches)<br/>batch B · worktree"]
        w1 --> t1["✅ tests/lint"] --> cr1["🟡 vision (code reviewer)<br/>delta review"]
        w2 --> t2["✅ tests/lint"] --> cr2["🟡 vision (code reviewer)<br/>delta review"]
        cr1 -->|REQUEST_CHANGES| w1
        cr2 -->|REQUEST_CHANGES| w2
        cr1 -->|APPROVED| merge["merge in dependency order"]
        cr2 -->|APPROVED| merge
        merge --> full["✨ danvers (final reviewer)<br/>full review · fresh thread"]
    end
    full --> GATE2{{"🌈 heimdall (gates)<br/>code-review APPROVED<br/>tests PASS"}}
    GATE2 --> subR

    subgraph subR["/assemble-release"]
        rel["🛡️ cap (release)<br/>release · 🏛️ Council (human) approves"] --> mem["🧠 jarvis (memory)<br/>memory-sync → ARCHI.md"]
    end
    subI -.every invocation.-> pepper["💼 pepper (ledger)<br/>ledger + budget caps"]
```

## How a hero gets cast (config resolution)

```mermaid
flowchart LR
    S["stages:<br/>code-review:<br/>&nbsp;&nbsp;agent: vision"] --> A["agents:<br/>vision:<br/>&nbsp;&nbsp;profile: sol-reviewer"]
    A --> M["models:<br/>sol-reviewer:<br/>&nbsp;&nbsp;provider: codex<br/>&nbsp;&nbsp;model: gpt-5.6-sol<br/>&nbsp;&nbsp;effort: xhigh"]
    M --> PR["providers:<br/>codex:<br/>&nbsp;&nbsp;adapter: codex"]
    PR --> CLI["codex exec --json<br/>-c model=gpt-5.6-sol<br/>--sandbox read-only"]
    ENV["ASSEMBLE_STAGE_code-review_MODEL=…"] -.overrides.-> S
```

Recast one hero (edit one profile) and every stage they work changes. Or pin a
stage inline: `code-review: {provider: claude, model: haiku-4.5}`.

## The review loop (why agents can't skip gates)

```mermaid
sequenceDiagram
    participant F as 🕶️ fury (orchestrator)
    participant T as 🔨 thor (implementer)
    participant V as 🟡 vision (code reviewer)
    participant C as 🏛️ Council (human — you)
    F->>V: batch diff + docs (read-only sandbox)
    V-->>F: JSON verdict {REQUEST_CHANGES, findings[]}
    F->>T: findings (resumed session)
    T-->>F: fixes applied
    F->>V: re-review (same thread, remembers round 1)
    V-->>F: {APPROVED}
    Note over F: verdict recorded → heimdall (gates) opens the gate
    Note over F,C: max_rounds exhausted → Council decides:<br/>assemble gate approve / reject
```

Reviewers must emit schema-validated JSON verdicts. No verdict on file → the
next stage refuses to start. A disobedient agent can stall — never skip.

## Quick start

```bash
npm i -g @assemble/cli             # trademark-safe OSS publish name
cd your-repo && assemble assemble  # zero-config defaults, or pick a preset
/assemble-plan "add dark mode"     # in Claude Code — stark (architect) plans,
                                   #   strange (plan/design reviewer) reviews
/assemble-implement                # batched, gated, parallel if configured
/assemble-release                  # cap (release) ships it on your order,
                                   #   jarvis (memory) remembers
assemble status                    # mission board · assemble report →
                                   #   pepper (ledger)'s books
```

`assemble assemble` also writes a workflow note into `CLAUDE.md`/`AGENTS.md`,
so any agent that opens the repo discovers the pipeline on its own.

Example board mid-mission:

```
run 2026-07-20-dark-mode          budget $9.40 / $25
  plan-review    APPROVED  (strange (plan/design reviewer), round 2)
  design-review  APPROVED  (strange (plan/design reviewer), round 1)
  implement      RUNNING
    🔨 thor (implementer)        batch auth-api    round 2 · vision (code reviewer) reviewing
    🕷️ spidey (small batches)    batch ui-toggle   merged ✓
  code-review    pending → danvers (final reviewer)
```

## Cast any model into any role

Copy profiles from **[`templates/assemble.config.example.yaml`](templates/assemble.config.example.yaml)** —
a catalog of ready-made profiles for Claude (fable, opus, sonnet, haiku), Codex
(gpt-5.6 family, codex-mini), Gemini, OpenCode and Mistral Vibe, with knobs and
$/Mtok pricing for pepper (ledger)'s books. Presets:

| `mode:` | meaning |
|---|---|
| `solo` | one model plays every hero (cheapest, no cross-check) |
| `duo`  | stark (architect) writes, strange (plan/design reviewer) reviews cross-provider (TRIP's proven setup) |
| `full` | the whole roster, each hero tuned separately |

## Design docs

Full architecture & decisions: [`docs/superpowers/specs/2026-07-20-assemble-orchestrator-design.md`](docs/superpowers/specs/2026-07-20-assemble-orchestrator-design.md)
