# troupe 🎭

**Multi-agent dev workflow orchestrator.** Plan → Design → Implement → Release,
with a different AI model at every stage if you want — and gates that agents
*cannot* skip, because the state machine lives in a CLI, not in prose.

Successor to [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow):
same philosophy (writer ≠ reviewer, long-term ARCHI.md memory, few commands),
but models are config, gates are code, and any provider CLI can play.

## The troupe loop

Three commands drive the whole pipeline. Every box is an **agent** — a
provider CLI process (claude, codex, gemini, …) launched with the model and
knobs *you* configured for that stage.

```mermaid
flowchart TD
    subgraph P["/troupe-plan"]
        plan["📝 plan<br/><i>writer agent</i><br/>(interactive)"] --> pr["🔍 plan-review<br/><i>reviewer agent</i>"]
        pr -->|REQUEST_CHANGES ≤ max_rounds| plan
        pr -->|APPROVED| design["📐 design<br/><i>writer agent</i>"]
        design --> dr["🔍 design-review<br/><i>reviewer agent</i>"]
        dr -->|REQUEST_CHANGES| design
    end
    dr -->|APPROVED| GATE1{{"🚧 gate:<br/>plan-review APPROVED<br/>design-review APPROVED"}}
    GATE1 --> subI

    subgraph subI["/troupe-implement"]
        direction TB
        dag["batch DAG from plan manifest"] --> w1["⚙️ worker agent<br/>batch A · worktree"]
        dag --> w2["⚙️ worker agent<br/>batch B · worktree"]
        w1 --> t1["✅ tests/lint"] --> cr1["🔍 delta code-review<br/><i>reviewer agent</i>"]
        w2 --> t2["✅ tests/lint"] --> cr2["🔍 delta code-review<br/><i>reviewer agent</i>"]
        cr1 -->|REQUEST_CHANGES| w1
        cr2 -->|REQUEST_CHANGES| w2
        cr1 -->|APPROVED| merge["merge in dependency order"]
        cr2 -->|APPROVED| merge
        merge --> full["🔍 full code-review<br/><i>fresh reviewer thread</i>"]
    end
    full --> GATE2{{"🚧 gate:<br/>code-review APPROVED<br/>tests PASS"}}
    GATE2 --> subR

    subgraph subR["/troupe-release"]
        rel["🚀 release<br/><i>writer agent</i><br/>(human approval)"] --> mem["🧠 memory-sync<br/>updates ARCHI.md"]
    end
```

## How an agent gets picked (config resolution)

Each stage names an **agent role**, roles bind to **model profiles**, profiles
name a **provider**, and the provider's **adapter** launches the real CLI.
Override at any level; env vars win for one-off runs.

```mermaid
flowchart LR
    S["stages:<br/>code-review:<br/>&nbsp;&nbsp;agent: reviewer"] --> A["agents:<br/>reviewer:<br/>&nbsp;&nbsp;profile: sol-reviewer"]
    A --> M["models:<br/>sol-reviewer:<br/>&nbsp;&nbsp;provider: codex<br/>&nbsp;&nbsp;model: gpt-5.6-sol<br/>&nbsp;&nbsp;effort: xhigh"]
    M --> PR["providers:<br/>codex:<br/>&nbsp;&nbsp;adapter: codex"]
    PR --> CLI["codex exec --json<br/>-c model=gpt-5.6-sol<br/>--sandbox read-only"]
    ENV["TROUPE_STAGE_code-review_MODEL=…"] -.overrides.-> S
```

Swap the reviewer model for **every** review stage by editing one profile —
or pin a single stage inline: `code-review: {provider: claude, model: haiku-4.5}`.

## The review loop (what "gates are code" means)

```mermaid
sequenceDiagram
    participant E as troupe engine
    participant W as writer agent
    participant R as reviewer agent
    participant H as human
    E->>R: diff + docs (read-only sandbox)
    R-->>E: JSON verdict {REQUEST_CHANGES, findings[]}
    E->>W: findings (resumed session)
    W-->>E: fixes applied
    E->>R: re-review (same thread, remembers round 1)
    R-->>E: {APPROVED}
    Note over E: verdict recorded → gate opens
    Note over E,H: max_rounds exhausted → escalate:<br/>troupe gate approve/reject
```

The reviewer must emit schema-validated JSON. No verdict on file → the next
stage refuses to start. An agent that ignores instructions can stall — never skip.

## Quick start

```bash
npm i -g @troupe/cli
cd your-repo && troupe init     # zero-config defaults, or pick a preset
/troupe-plan "add dark mode"    # in Claude Code — plan + reviews
/troupe-implement               # batched, gated, parallel if configured
/troupe-release                 # human-approved ship + memory sync
troupe status                   # where am I? · troupe report → cost per stage/model
```

`troupe init` also writes a workflow note into `CLAUDE.md`/`AGENTS.md`, so any
agent that opens the repo discovers the pipeline on its own.

## Configure any model for any stage

Copy profiles from **[`templates/troupe.config.example.yaml`](templates/troupe.config.example.yaml)**
into your `troupe.config.yaml` — it catalogs ready-made profiles for Claude
(fable, opus, sonnet, haiku), Codex (gpt-5.6 family, codex-mini), Gemini,
OpenCode and Mistral Vibe, with sensible knobs and $/Mtok pricing for the cost
ledger. Presets if you don't want to think:

| `mode:` | meaning |
|---|---|
| `solo` | one model everywhere (cheapest, no cross-check) |
| `duo`  | writer + cross-provider reviewer (TRIP's proven setup) |
| `full` | distinct tuned model per stage |

## Design docs

Full architecture & decisions: [`docs/superpowers/specs/2026-07-20-troupe-orchestrator-design.md`](docs/superpowers/specs/2026-07-20-troupe-orchestrator-design.md)
