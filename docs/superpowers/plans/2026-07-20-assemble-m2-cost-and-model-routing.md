# assemble — Milestone 2: Cost Tracking + Utility-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real per-run cost accounting for the `assemble` pipeline — true token counts from every provider adapter, a configurable per-model pricing table, cost derived and recorded in the ledger for both pipeline stages and orchestrator side-operations, and an `assemble cost` CLI report — Milestone 2 of the spec at `docs/superpowers/specs/2026-07-20-assemble-orchestrator-design.md`, building on Milestone 1 (`docs/superpowers/plans/2026-07-20-assemble-m1-core-engine.md`).

**SCOPE = option (a):** this milestone is strictly *token accounting + pricing + utility-model routing + cost reporting*. It does **not** add budget caps/enforcement, pause-on-budget, verdict parse-retry / `REQUEST_CHANGES` rework loops, parallel batch execution, or real Slack/Jira side-operation adapters. Those remain later milestones — see **Out of Scope** at the end of this doc. Everything in this plan traces directly to the three locked design decisions below; there is no scope creep beyond them.

**Locked design decisions (do not re-litigate):**
1. **Model routing = "Utility model."** Per-stage agent models are untouched. Config gains exactly ONE new global field, `utilityModel` (e.g. `haiku`). All orchestrator *side-operations* — work the orchestrator itself initiates, not a configured stage agent — route to the utility model instead of a premium reasoning model. M2 wires this for `git` (drafting commit messages); `slack` and `jira` are declared as future config-supported targets but are not implemented yet.
2. **Cost source = "Pricing table."** Config gains a `pricing` map of per-model `$/token` rates. `cost = real_tokens × rate`. Hard prerequisite: adapters must emit true token counts. The codex adapter currently hardcodes `tokensIn: 0, tokensOut: 0` — Task 1 fixes that and verifies the claude adapter's counts before anything else depends on them.
3. **Cost storage = "Ledger + report."** A new `cost` ledger event type is appended to the existing NDJSON ledger once per stage run and once per side-operation run. A new `assemble cost` CLI command aggregates cost by worker (agent key or `"utility"`) and by stage, and prints totals.

**Architecture:** Extends M1's event-sourced core without breaking it. The ledger remains the only source of truth; `cost` is a new, purely additive event type — `deriveStageStatus`'s switch already ignores event types it doesn't recognize, so stage-status derivation is untouched. A new `src/cost.ts` module holds the pure `computeCost`/`aggregateCost` functions (pricing × tokens in, cost summaries out — no I/O, easy to unit test). A new `src/sideops.ts` module generalizes "orchestrator calls an LLM for something that isn't a pipeline stage": it resolves the utility model, drafts short LLM outputs (e.g. a commit message) through an injected `Adapter` (same interface as stage adapters — no new adapter type), and — for the `git` side-operation — shells out to an injectable `git` binary using the same `execFile`-based `spawn` helper adapters already use. `engine.ts`'s `runStage` grows two new *purely additive* behaviors, both optional and both no-ops for any M1-style config/call: (a) it always appends a `cost` ledger event after `stage_completed`, computed from the pricing table (`$0` if the model has no configured rate — never throws), and (b) if the caller opts into `RunStageOpts.autoCommit` *and* `config.utilityModel` is set, it drafts a commit message via the utility model and commits the stage's changes, then ledgers a second `cost` event for that utility-model run.

**Builds on:** No new runtime dependencies. Everything uses the existing `zod`, `yaml`, `commander`, `node:child_process`/`node:fs`, and `vitest` already in `package.json` from M1.

## Global Constraints

- All M1 global constraints still apply (verdict/status/reserved-id constants, `renderAgent` display convention, ledger path, TDD + commit-per-green-cycle).
- Pricing rates are `$` **per token** (not per-thousand or per-million) — config authors pre-scale (e.g. a $15/M-token rate is entered as `0.000015`). `cost = tokensIn × rate.input + tokensOut × rate.output`.
- A model with no entry in `pricing` costs `$0` — this is a warning-free default, never a `ConfigError`. Pricing coverage is opt-in per model.
- `utilityModel` is optional. Side-operations (`resolveSideOpModel`) throw `ConfigError` if invoked with no `utilityModel` configured; nothing that doesn't opt into side-operations is affected.
- The `cost` ledger event's `worker` field is `"utility"` for side-operation runs, or the agent key (e.g. `"thor"`) for stage runs — this is exactly what `assemble cost` groups by.
- No budget enforcement anywhere in M2 — `assemble cost` is a read-only report. Pipelines never pause or fail because of cost.
- Existing M1 ledger event types, CLI commands, and public function signatures are unchanged and additive-only, with one explicit exception: `runStage` now appends one extra `cost` ledger event per successful stage, so the M1 assertions that pattern-match the *exact* list of event types in `tests/engine.test.ts` must be updated (call out explicitly in Task 4 — this is the only intentional M1 test change in this plan).

## File Structure

```
assemble/
├── src/
│   ├── adapters.ts            # MODIFY: real codex token counts; export `spawn` for reuse
│   ├── config.ts              # MODIFY: + `pricing` map, + `utilityModel`, ASSEMBLE_PRICING_JSON override
│   ├── init.ts                # MODIFY: DEFAULT_CONFIG gains example `pricing:` + `utilityModel:`
│   ├── sideops.ts             # CREATE: generic side-operation model routing + git commit drafting
│   ├── cost.ts                # CREATE: computeCost, aggregateCost — pure functions
│   ├── ledger.ts              # MODIFY: LedgerEvent gains "cost" type + worker/model/costUsd fields
│   ├── engine.ts              # MODIFY: ledgers a cost event per stage; optional autoCommit side-op
│   └── cli.ts                 # MODIFY: `run --auto-commit` flag; new `assemble cost` command
└── tests/                     # adapters/config/init/engine/cli extended; sideops.test.ts, cost.test.ts new
```

---

### Task 1: Real Token Accounting in Adapters (prerequisite)

**Files:**
- Modify: `src/adapters.ts`, `tests/adapters.test.ts`

**Interfaces:**
- Modifies: `codexAdapter(bin?: string): Adapter` — now spawns `<bin> exec --json --model <model> <prompt>` and parses the NDJSON event stream on stdout instead of returning hardcoded `0/0`. Recognizes `{"type":"message","text":"..."}` events (concatenated into `output`) and a `{"type":"token_count","input_tokens":N,"output_tokens":N}` event (the final token totals). Throws `AdapterError` on any unparsable line.
- Modifies: `claudeAdapter(bin?: string): Adapter` — unchanged parsing logic, but this task adds a regression test proving it *normalizes* a missing `usage` block to `0/0` instead of throwing, so the pricing math in Task 4 never receives `NaN`/`undefined`.
- No other module depends on adapters yet — this task cannot regress `engine.ts`/`gate.ts`/`pipeline.ts`.

- [ ] **Step 1: Write failing tests**

Replace `tests/adapters.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, codexAdapter, getAdapter, AdapterError } from "../src/adapters.js";

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "asm-bin-"));
  const p = join(dir, "fake");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("claudeAdapter", () => {
  it("parses JSON output and usage", async () => {
    const bin = fakeBin(`echo '{"result":"done: $2","usage":{"input_tokens":11,"output_tokens":7}}'`);
    const r = await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() });
    expect(r.output).toContain("done");
    expect(r.tokensIn).toBe(11);
    expect(r.tokensOut).toBe(7);
  });
  it("throws AdapterError on non-zero exit with stderr", async () => {
    const bin = fakeBin(`echo "boom" >&2; exit 3`);
    await expect(claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() }))
      .rejects.toThrow(/boom/);
  });
  it("normalizes a missing usage block to zero tokens instead of throwing", async () => {
    const bin = fakeBin(`echo '{"result":"no usage field"}'`);
    const r = await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() });
    expect(r.tokensIn).toBe(0);
    expect(r.tokensOut).toBe(0);
  });
});

describe("codexAdapter", () => {
  it("parses real token counts from the --json NDJSON event stream", async () => {
    const bin = fakeBin(
      `printf '%s\\n' '{"type":"message","text":"plain output"}' '{"type":"token_count","input_tokens":9,"output_tokens":6}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output).toBe("plain output");
    expect(r.tokensIn).toBe(9);
    expect(r.tokensOut).toBe(6);
  });
  it("accumulates text across multiple message events", async () => {
    const bin = fakeBin(
      `printf '%s\\n' '{"type":"message","text":"part one "}' '{"type":"message","text":"part two"}' '{"type":"token_count","input_tokens":2,"output_tokens":3}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output).toBe("part one part two");
  });
  it("throws AdapterError on an unparsable event line", async () => {
    const bin = fakeBin(`echo 'not json'`);
    await expect(codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() }))
      .rejects.toThrow(AdapterError);
  });
});

describe("getAdapter", () => {
  it("resolves known providers", () => {
    expect(getAdapter("claude").name).toBe("claude");
    expect(getAdapter("codex").name).toBe("codex");
  });
  it("throws on unknown provider", () => {
    expect(() => getAdapter("skynet")).toThrow(AdapterError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/adapters.test.ts`
Expected: FAIL — the old `codexAdapter` returns `tokensIn: 0` unconditionally and never reads `token_count` events, so the new codex assertions fail.

- [ ] **Step 3: Implementation**

Replace `src/adapters.ts` with:
```ts
import { execFile } from "node:child_process";

export type RunOpts = { prompt: string; model: string; cwd: string };
export type RunResult = { output: string; tokensIn: number; tokensOut: number };
export interface Adapter { readonly name: string; run(opts: RunOpts): Promise<RunResult> }
export class AdapterError extends Error {}

function spawn(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new AdapterError(`${bin} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    name: "claude",
    async run({ prompt, model, cwd }) {
      const stdout = await spawn(bin, ["-p", prompt, "--model", model, "--output-format", "json"], cwd);
      let parsed: { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      try { parsed = JSON.parse(stdout); }
      catch { throw new AdapterError(`claude returned non-JSON output: ${stdout.slice(0, 200)}`); }
      return {
        output: parsed.result ?? "",
        tokensIn: parsed.usage?.input_tokens ?? 0,
        tokensOut: parsed.usage?.output_tokens ?? 0,
      };
    },
  };
}

type CodexEvent = { type?: string; text?: string; input_tokens?: number; output_tokens?: number };

export function codexAdapter(bin = "codex"): Adapter {
  return {
    name: "codex",
    async run({ prompt, model, cwd }) {
      const stdout = await spawn(bin, ["exec", "--json", "--model", model, prompt], cwd);
      const lines = stdout.trim().split("\n").filter(Boolean);
      let output = "";
      let tokensIn = 0;
      let tokensOut = 0;
      for (const line of lines) {
        let event: CodexEvent;
        try { event = JSON.parse(line); }
        catch { throw new AdapterError(`codex returned a non-JSON event line: ${line.slice(0, 200)}`); }
        if (event.type === "message" && typeof event.text === "string") output += event.text;
        if (event.type === "token_count") {
          tokensIn = Number(event.input_tokens ?? tokensIn);
          tokensOut = Number(event.output_tokens ?? tokensOut);
        }
      }
      return { output, tokensIn, tokensOut };
    },
  };
}

export function getAdapter(provider: string, bins: Record<string, string> = {}): Adapter {
  switch (provider) {
    case "claude": return claudeAdapter(bins.claude);
    case "codex": return codexAdapter(bins.codex);
    default: throw new AdapterError(`unknown provider '${provider}' (M1 supports: claude, codex)`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/adapters.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters.ts tests/adapters.test.ts
git commit -m "fix: real codex token accounting via --json event stream; verify claude usage parsing"
```

---

### Task 2: Pricing Table in Config Schema

**Files:**
- Modify: `src/config.ts`, `src/init.ts`, `tests/config.test.ts`, `tests/init.test.ts`

**Interfaces:**
- Consumes: nothing new (independent of Task 1's adapter change; only depended on for the milestone's overall cost math in Task 4).
- Produces:
  - `type PricingEntry = { input: number; output: number }` (both `$`-per-token, `>= 0`).
  - `AssembleConfig.pricing: Record<string, PricingEntry>` — defaults to `{}` when omitted from YAML.
  - `loadConfig` merges an optional `ASSEMBLE_PRICING_JSON` env var (a JSON object matching the `pricing` shape) over file-configured pricing, entry-by-entry replacement per model key. Throws `ConfigError` if the env var is present but not valid JSON, or fails schema validation.
  - `initProject`'s scaffolded `assemble.config.yaml` now includes an example `pricing:` block for the two default agents' models.

- [ ] **Step 1: Write failing tests**

Add to `tests/config.test.ts` (inside/after the existing `describe("loadConfig", ...)` block, using the existing `VALID`/`writeCfg` helpers):
```ts
  it("defaults pricing to an empty map when omitted", () => {
    const cfg = loadConfig(writeCfg(VALID));
    expect(cfg.pricing).toEqual({});
  });
  it("parses a pricing table keyed by model", () => {
    const withPricing = VALID + `pricing:\n  opus: { input: 0.000015, output: 0.000075 }\n`;
    const cfg = loadConfig(writeCfg(withPricing));
    expect(cfg.pricing.opus).toEqual({ input: 0.000015, output: 0.000075 });
  });
  it("rejects negative pricing rates", () => {
    const bad = VALID + `pricing:\n  opus: { input: -1, output: 0 }\n`;
    expect(() => loadConfig(writeCfg(bad))).toThrow(ConfigError);
  });
  it("merges ASSEMBLE_PRICING_JSON over file-configured pricing", () => {
    const withPricing = VALID + `pricing:\n  opus: { input: 0.01, output: 0.02 }\n`;
    const cfg = loadConfig(writeCfg(withPricing), {
      "ASSEMBLE_PRICING_JSON": JSON.stringify({ opus: { input: 0.5, output: 0.6 } }),
    });
    expect(cfg.pricing.opus).toEqual({ input: 0.5, output: 0.6 });
  });
  it("rejects malformed ASSEMBLE_PRICING_JSON", () => {
    expect(() => loadConfig(writeCfg(VALID), { "ASSEMBLE_PRICING_JSON": "{not json" })).toThrow(ConfigError);
  });
```

Add to `tests/init.test.ts`, inside `describe("initProject", ...)`:
```ts
  it("scaffolds an example pricing table for the default agents' models", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    const cfg = loadConfig(dir);
    expect(cfg.pricing.opus).toBeDefined();
    expect(cfg.pricing["gpt-5-codex"]).toBeDefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts tests/init.test.ts`
Expected: FAIL — `pricing` is not a recognized schema field yet (`cfg.pricing` is `undefined`), and `ASSEMBLE_PRICING_JSON` is not read.

- [ ] **Step 3: Implementation**

Replace `src/config.ts` with:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RESERVED_STAGE_IDS } from "./protocol.js";

export class ConfigError extends Error {}

const AgentSchema = z.object({
  role: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
const StageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "stage ids are kebab-case"),
  agent: z.string().min(1),
  gate: z.enum(["human", "auto"]).default("auto"),
  prompt: z.string().min(1),
  modelOverride: z.string().optional(),
});
const PricingEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
const ConfigSchema = z.object({
  project: z.string().min(1),
  agents: z.record(AgentSchema),
  stages: z.array(StageSchema).min(1),
  pricing: z.record(PricingEntrySchema).default({}),
  utilityModel: z.string().min(1).optional(),
});

export type AgentDef = z.infer<typeof AgentSchema>;
export type StageDef = z.infer<typeof StageSchema>;
export type PricingEntry = z.infer<typeof PricingEntrySchema>;
export type AssembleConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(dir: string, env: NodeJS.ProcessEnv = process.env): AssembleConfig {
  const path = join(dir, "assemble.config.yaml");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`no assemble.config.yaml in ${dir} — run \`assemble init\` first`);
  }
  const parsed = ConfigSchema.safeParse(parse(raw));
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const cfg = parsed.data;

  const seen = new Set<string>();
  for (const s of cfg.stages) {
    if ((RESERVED_STAGE_IDS as readonly string[]).includes(s.id))
      throw new ConfigError(`stage id '${s.id}' is reserved (reserved list may grow between versions)`);
    if (seen.has(s.id)) throw new ConfigError(`duplicate stage id '${s.id}'`);
    seen.add(s.id);
    if (!cfg.agents[s.agent]) throw new ConfigError(`stage '${s.id}' references unknown agent '${s.agent}'`);
    const override = env[`ASSEMBLE_STAGE_${s.id}_MODEL`];
    if (override) s.modelOverride = override;
  }

  const pricingOverride = env["ASSEMBLE_PRICING_JSON"];
  if (pricingOverride) {
    let rawPricing: unknown;
    try { rawPricing = JSON.parse(pricingOverride); }
    catch { throw new ConfigError(`ASSEMBLE_PRICING_JSON is not valid JSON`); }
    const validated = z.record(PricingEntrySchema).safeParse(rawPricing);
    if (!validated.success)
      throw new ConfigError(`ASSEMBLE_PRICING_JSON: ${validated.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    cfg.pricing = { ...cfg.pricing, ...validated.data };
  }

  return cfg;
}
```

Add a `pricing:` block to `DEFAULT_CONFIG` in `src/init.ts` (insert after the `stages:` block, keeping everything else identical):
```ts
export const DEFAULT_CONFIG = `# assemble — Avengers, assemble your AI dev team (default MCU theme; names are a swappable skin)
project: MyApp
agents:
  thor:   { role: implementer,   provider: claude, model: opus }
  vision: { role: code reviewer, provider: codex,  model: gpt-5-codex }
stages:
  - { id: implement,   agent: thor,   gate: auto,  prompt: "Implement the approved plan. Follow existing project conventions." }
  - { id: code-review, agent: vision, gate: human, prompt: "Review the latest diff. End with exactly one verdict: APPROVED, REQUEST_CHANGES, or BLOCKED." }
# $/token rates — cost = tokens x rate. Add an entry per model you use; unpriced models cost $0.
pricing:
  opus:         { input: 0.000015,  output: 0.000075 }
  gpt-5-codex:  { input: 0.0000011, output: 0.0000044 }
`;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts tests/init.test.ts`
Expected: 11 tests PASS in `config.test.ts`, 3 in `init.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/init.ts tests/config.test.ts tests/init.test.ts
git commit -m "feat: pricing table in config schema with ASSEMBLE_PRICING_JSON override"
```

---

### Task 3: `utilityModel` + Generic Side-Operation Routing (wired to git)

**Files:**
- Create: `src/sideops.ts`, `tests/sideops.test.ts`
- Modify: `src/config.ts` *(already added `utilityModel` in Task 2's replacement above — this task only adds tests for it)*, `src/adapters.ts`, `src/init.ts`, `src/engine.ts`, `src/cli.ts`, `tests/config.test.ts`, `tests/engine.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces:
  - `SIDE_OPERATIONS: readonly ["git","slack","jira"]`, `type SideOperation` — `slack`/`jira` are declared config-supported targets for future milestones; only `"git"` is implemented in M2.
  - `resolveSideOpModel(config: AssembleConfig): string` — returns `config.utilityModel`; throws `ConfigError` if unset. This is the single choke point every side-operation routes through, so "utility model routing" is enforced in one place, not duplicated per side-operation.
  - `draftCommitMessage(config, adapter: Adapter, opts: { stageId, diffSummary, cwd }): Promise<{ message, tokensIn, tokensOut }>` — runs the given adapter *on the utility model* (never the stage's own agent model) and takes the first line of its output as the commit message.
  - `commitStageChanges(dir, config, stageId, opts: { adapter, gitBin?, diffSummary }): Promise<{ message, tokensIn, tokensOut }>` — drafts the message, then shells out to `<gitBin ?? "git"> commit -a -m <message>` in `dir` via the same injectable-binary pattern as `src/adapters.ts` (tests use a fake `git` script, never a real repo).
- Modifies: `src/adapters.ts` — the internal `spawn` helper is now `export`ed so `sideops.ts` can reuse the same `execFile`-wrapping/`AdapterError` behavior for the `git` binary.
- Modifies: `RunStageOpts` (`src/engine.ts`) — gains `autoCommit?: { adapter: Adapter; gitBin?: string }`. When set *and* `config.utilityModel` is configured, `runStage` calls `commitStageChanges` after a successful `stage_completed` using the stage's own output as `diffSummary`. When `autoCommit` is omitted (every M1-era call site), behavior is byte-for-byte unchanged. When `autoCommit` is set but `utilityModel` is not configured, `runStage` silently skips the side-operation (fail-open at the engine layer — the CLI fails fast instead, see below).
- Modifies: `src/cli.ts` — `assemble run` gains a `--auto-commit` flag. If passed, the command calls `resolveSideOpModel(cfg)` *before* running the pipeline so a missing `utilityModel` is reported immediately, not after stages have already run.

- [ ] **Step 1: Write failing tests**

`tests/sideops.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSideOpModel, draftCommitMessage, commitStageChanges } from "../src/sideops.js";
import { ConfigError, type AssembleConfig } from "../src/config.js";
import type { Adapter } from "../src/adapters.js";

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "asm-bin-"));
  const p = join(dir, "fake");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

const baseConfig: AssembleConfig = {
  project: "MyApp",
  agents: { thor: { role: "implementer", provider: "claude", model: "opus" } },
  stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
  pricing: {},
};

const fakeAdapter = (output = "feat: add widget"): Adapter => ({
  name: "fake",
  async run() { return { output, tokensIn: 2, tokensOut: 3 }; },
});

describe("resolveSideOpModel", () => {
  it("throws when utilityModel is not configured", () => {
    expect(() => resolveSideOpModel(baseConfig)).toThrow(ConfigError);
  });
  it("returns the configured utility model", () => {
    expect(resolveSideOpModel({ ...baseConfig, utilityModel: "haiku" })).toBe("haiku");
  });
});

describe("draftCommitMessage", () => {
  it("runs the adapter on the utility model, not the stage agent's model", async () => {
    const config = { ...baseConfig, utilityModel: "haiku" };
    const calls: string[] = [];
    const adapter: Adapter = { name: "fake", async run({ model }) { calls.push(model); return { output: "feat: x", tokensIn: 1, tokensOut: 1 }; } };
    await draftCommitMessage(config, adapter, { stageId: "implement", diffSummary: "diff", cwd: process.cwd() });
    expect(calls).toEqual(["haiku"]);
  });
  it("takes only the first line of multi-line adapter output", async () => {
    const config = { ...baseConfig, utilityModel: "haiku" };
    const r = await draftCommitMessage(config, fakeAdapter("feat: add widget\nextra body text"), {
      stageId: "implement", diffSummary: "diff", cwd: process.cwd(),
    });
    expect(r.message).toBe("feat: add widget");
  });
});

describe("commitStageChanges", () => {
  it("drafts a message and shells out to the injected git binary", async () => {
    const config = { ...baseConfig, utilityModel: "haiku" };
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const bin = fakeBin(`exit 0`);
    const r = await commitStageChanges(dir, config, "implement", {
      adapter: fakeAdapter("feat: add widget"), gitBin: bin, diffSummary: "diff",
    });
    expect(r.message).toBe("feat: add widget");
  });
  it("propagates AdapterError when the git binary fails", async () => {
    const config = { ...baseConfig, utilityModel: "haiku" };
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const bin = fakeBin(`echo "not a git repo" >&2; exit 128`);
    await expect(commitStageChanges(dir, config, "implement", {
      adapter: fakeAdapter("feat: add widget"), gitBin: bin, diffSummary: "diff",
    })).rejects.toThrow(/not a git repo/);
  });
});
```

Add to `tests/config.test.ts`, inside `describe("loadConfig", ...)`:
```ts
  it("utilityModel is undefined by default", () => {
    const cfg = loadConfig(writeCfg(VALID));
    expect(cfg.utilityModel).toBeUndefined();
  });
  it("parses a configured utilityModel", () => {
    const withUtility = VALID + `utilityModel: haiku\n`;
    const cfg = loadConfig(writeCfg(withUtility));
    expect(cfg.utilityModel).toBe("haiku");
  });
```

Add to `tests/engine.test.ts` — first widen the imports to include `chmodSync`:
```ts
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
```
then add, inside `describe("runStage", ...)`:
```ts
  it("drafts and commits via the utility model when autoCommit is configured", async () => {
    const { dir, config } = project();
    const withUtility = { ...config, utilityModel: "haiku" };
    const gitDir = mkdtempSync(join(tmpdir(), "asm-bin-"));
    const gitBin = join(gitDir, "fake-git");
    writeFileSync(gitBin, `#!/bin/sh\nexit 0\n`);
    chmodSync(gitBin, 0o755);
    const commitCalls: string[] = [];
    const utilityAdapter: Adapter = {
      name: "fake",
      async run({ model }) { commitCalls.push(model); return { output: "feat: implement", tokensIn: 1, tokensOut: 1 }; },
    };
    await runStage(dir, withUtility, "implement", {
      adapters: { fake: okAdapter() },
      autoCommit: { adapter: utilityAdapter, gitBin },
    });
    expect(commitCalls).toEqual(["haiku"]);
  });
  it("skips auto-commit silently when utilityModel is not configured", async () => {
    const { dir, config } = project();
    const calls: string[] = [];
    const utilityAdapter: Adapter = { name: "fake", async run({ model }) { calls.push(model); return { output: "x", tokensIn: 0, tokensOut: 0 }; } };
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() }, autoCommit: { adapter: utilityAdapter, gitBin: "true" } });
    expect(calls).toEqual([]);
  });
```
`tests/engine.test.ts` also needs `import { tmpdir } from "node:os";` and `import { join } from "node:path";` — both already imported at the top of the existing file; no change needed there.

Add to `tests/cli.test.ts`, inside `describe("buildProgram", ...)`:
```ts
  it("run --auto-commit requires utilityModel to be configured first", async () => {
    const dir = project();
    const { io } = capture();
    await expect(buildProgram(dir, io).parseAsync(["node", "assemble", "run", "--auto-commit"]))
      .rejects.toThrow(/utilityModel/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/sideops.test.ts tests/config.test.ts tests/engine.test.ts tests/cli.test.ts`
Expected: FAIL — `../src/sideops.js` doesn't exist yet; `RunStageOpts` has no `autoCommit`; `run` has no `--auto-commit` flag.

- [ ] **Step 3: Implementation**

Export `spawn` in `src/adapters.ts` — change:
```ts
function spawn(bin: string, args: string[], cwd: string): Promise<string> {
```
to:
```ts
export function spawn(bin: string, args: string[], cwd: string): Promise<string> {
```
(no other change to `src/adapters.ts`).

`src/sideops.ts`:
```ts
import type { AssembleConfig } from "./config.js";
import { ConfigError } from "./config.js";
import type { Adapter } from "./adapters.js";
import { spawn } from "./adapters.js";

/** Side-operations are orchestrator-initiated LLM calls that are NOT a pipeline stage.
 *  M2 wires "git"; "slack" and "jira" are config-supported future targets, not implemented yet. */
export const SIDE_OPERATIONS = ["git", "slack", "jira"] as const;
export type SideOperation = (typeof SIDE_OPERATIONS)[number];

export function resolveSideOpModel(config: AssembleConfig): string {
  if (!config.utilityModel)
    throw new ConfigError("utilityModel must be set in assemble.config.yaml to run side-operations (git, slack, jira)");
  return config.utilityModel;
}

export async function draftCommitMessage(
  config: AssembleConfig,
  adapter: Adapter,
  opts: { stageId: string; diffSummary: string; cwd: string },
): Promise<{ message: string; tokensIn: number; tokensOut: number }> {
  const model = resolveSideOpModel(config);
  const prompt = `Write a single-line conventional commit message summarizing this diff from stage '${opts.stageId}':\n\n${opts.diffSummary}`;
  const result = await adapter.run({ prompt, model, cwd: opts.cwd });
  const message = result.output.trim().split("\n")[0] || `chore: ${opts.stageId} changes`;
  return { message, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
}

export type CommitStageChangesOpts = { adapter: Adapter; gitBin?: string; diffSummary: string };

export async function commitStageChanges(
  dir: string,
  config: AssembleConfig,
  stageId: string,
  opts: CommitStageChangesOpts,
): Promise<{ message: string; tokensIn: number; tokensOut: number }> {
  const draft = await draftCommitMessage(config, opts.adapter, { stageId, diffSummary: opts.diffSummary, cwd: dir });
  await spawn(opts.gitBin ?? "git", ["commit", "-a", "-m", draft.message], dir);
  return draft;
}
```

Add an `autoCommit` option and the side-operation call to `src/engine.ts` — replace the whole file with:
```ts
import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus } from "./ledger.js";
import { getAdapter, type Adapter } from "./adapters.js";
import { renderAgent } from "./theme.js";
import { commitStageChanges } from "./sideops.js";

export class GateError extends Error {}

export type RunStageOpts = {
  adapters?: Record<string, Adapter>;
  log?: (line: string) => void;
  autoCommit?: { adapter: Adapter; gitBin?: string };
};

export async function runStage(dir: string, config: AssembleConfig, stageId: string, opts: RunStageOpts = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const idx = config.stages.findIndex(s => s.id === stageId);
  if (idx < 0) throw new GateError(`unknown stage '${stageId}' — defined stages: ${config.stages.map(s => s.id).join(", ")}`);
  const stage = config.stages[idx];

  const events = readLedger(dir);
  for (const earlier of config.stages.slice(0, idx)) {
    const status = deriveStageStatus(events, earlier);
    if (status !== "approved")
      throw new GateError(`stage '${stageId}' is blocked: earlier stage '${earlier.id}' is ${status} (gate must be approved first)`);
  }

  const agent = config.agents[stage.agent];
  const adapter = opts.adapters?.[agent.provider] ?? getAdapter(agent.provider);
  const model = stage.modelOverride ?? agent.model;

  appendEvent(dir, { type: "stage_started", stage: stage.id, agent: stage.agent });
  log(`▶ ${stage.id} — ${renderAgent(stage.agent, config)} on ${model}`);
  try {
    const result = await adapter.run({ prompt: stage.prompt, model, cwd: dir });
    appendEvent(dir, { type: "stage_completed", stage: stage.id, agent: stage.agent, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    log(`✔ ${stage.id} — ${renderAgent(stage.agent, config)} done`);
    if (opts.autoCommit && config.utilityModel) {
      const commit = await commitStageChanges(dir, config, stage.id, {
        adapter: opts.autoCommit.adapter, gitBin: opts.autoCommit.gitBin, diffSummary: result.output,
      });
      log(`◆ ${stage.id} — committed: ${commit.message}`);
    }
  } catch (err) {
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: stage.agent, notes: String(err) });
    throw err;
  }
}
```
*(Task 4 below extends this same file again to append `cost` ledger events — this task's version deliberately does not touch cost yet, keeping each task's diff reviewable.)*

Add `utilityModel: haiku` to `DEFAULT_CONFIG` in `src/init.ts` (insert after the `pricing:` block added in Task 2):
```ts
pricing:
  opus:         { input: 0.000015,  output: 0.000075 }
  gpt-5-codex:  { input: 0.0000011, output: 0.0000044 }
# side-operations (git commits, and future slack/jira integrations) run on this model — never a premium reasoning model
utilityModel: haiku
`;
```

Wire `--auto-commit` into `src/cli.ts` — in `buildProgram`, add the import:
```ts
import { getAdapter } from "./adapters.js";
import { resolveSideOpModel } from "./sideops.js";
import type { RunStageOpts } from "./engine.js";
```
and replace the `run` command registration with:
```ts
  program.command("run").description("run the full pipeline serially")
    .option("--auto-commit", "draft a utility-model commit message and commit each stage's changes")
    .action(async (opts: { autoCommit?: boolean }) => {
      const cfg = requireConfig();
      const runOpts: RunStageOpts = { log: io.out };
      if (opts.autoCommit) {
        resolveSideOpModel(cfg); // fail fast if utilityModel isn't configured — before any stage runs
        runOpts.autoCommit = { adapter: getAdapter("claude") };
      }
      const r = await runPipeline(dir, cfg, runOpts);
      if (r.stoppedAt) io.out(`stopped at '${r.stoppedAt}' — resolve with: assemble gate approve ${r.stoppedAt}`);
      printStatus(cfg);
    });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sideops.test.ts tests/config.test.ts tests/engine.test.ts tests/cli.test.ts`
Expected: 6 tests PASS in `sideops.test.ts`; 13 in `config.test.ts`; 8 in `engine.test.ts`; 5 in `cli.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/sideops.ts src/adapters.ts src/config.ts src/init.ts src/engine.ts src/cli.ts tests/sideops.test.ts tests/config.test.ts tests/engine.test.ts tests/cli.test.ts
git commit -m "feat: utilityModel config + generic side-operation routing, wired to git commits"
```

---

### Task 4: `cost` Ledger Event + Cost Derivation

**Files:**
- Create: `src/cost.ts`, `tests/cost.test.ts`
- Modify: `src/ledger.ts`, `src/engine.ts`, `tests/engine.test.ts` *(updates two existing M1 assertions — see Step 1 note)*

**Interfaces:**
- Consumes: `AssembleConfig.pricing` (Task 2), `commitStageChanges`'s returned token counts (Task 3).
- Produces:
  - `LedgerEvent.type` gains `"cost"`; `LedgerEvent` gains optional `worker?: string`, `model?: string`, `costUsd?: number` fields (`tokensIn`/`tokensOut` already existed).
  - `computeCost(config: AssembleConfig, model: string, tokensIn: number, tokensOut: number): number` — pure; `0` when `model` has no `pricing` entry.
  - `aggregateCost(events: LedgerEvent[]): { byWorker: Record<string, number>; byStage: Record<string, number>; total: number }` — pure; ignores non-`"cost"` events (`readLedger`'s full event list can be passed directly, no pre-filtering required).
- Modifies: `runStage` — after every successful `stage_completed`, appends one `cost` event (`worker` = the stage's agent key). After a successful `autoCommit` side-operation, appends a second `cost` event (`worker: "utility"`). Neither ledgers on a failed stage.
- No change to `deriveStageStatus` — its `switch` has no `"cost"` case, so it's a silent no-op for that event type by construction (verified by a new `ledger.test.ts`-style assertion in this task's test additions, folded into `tests/cost.test.ts` for locality).

- [ ] **Step 1: Write failing tests**

`tests/cost.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeCost, aggregateCost } from "../src/cost.js";
import { deriveStageStatus } from "../src/ledger.js";
import type { AssembleConfig, StageDef } from "../src/config.js";
import type { LedgerEvent } from "../src/ledger.js";

const config: AssembleConfig = {
  project: "MyApp",
  agents: { thor: { role: "implementer", provider: "claude", model: "opus" } },
  stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
  pricing: { opus: { input: 0.000015, output: 0.000075 } },
};

describe("computeCost", () => {
  it("multiplies tokens by the configured rate", () => {
    expect(computeCost(config, "opus", 1000, 500)).toBeCloseTo(1000 * 0.000015 + 500 * 0.000075, 10);
  });
  it("returns 0 for a model with no pricing entry", () => {
    expect(computeCost(config, "gemini-flash", 1000, 1000)).toBe(0);
  });
  it("returns 0 for zero tokens even when priced", () => {
    expect(computeCost(config, "opus", 0, 0)).toBe(0);
  });
});

describe("aggregateCost", () => {
  const ev = (worker: string, stage: string, costUsd: number): LedgerEvent =>
    ({ ts: "2026-07-20T00:00:00Z", type: "cost", stage, worker, costUsd });

  it("sums cost by worker, by stage, and overall", () => {
    const events = [ev("thor", "implement", 0.01), ev("utility", "implement", 0.001), ev("vision", "code-review", 0.02)];
    const summary = aggregateCost(events);
    expect(summary.byWorker).toEqual({ thor: 0.01, utility: 0.001, vision: 0.02 });
    expect(summary.byStage).toEqual({ implement: 0.011, "code-review": 0.02 });
    expect(summary.total).toBeCloseTo(0.031, 10);
  });
  it("ignores non-cost events", () => {
    const events: LedgerEvent[] = [
      { ts: "2026-07-20T00:00:00Z", type: "stage_started", stage: "implement", agent: "thor" },
      ev("thor", "implement", 0.01),
    ];
    expect(aggregateCost(events).total).toBe(0.01);
  });
  it("returns all-zero summary for an empty ledger", () => {
    expect(aggregateCost([])).toEqual({ byWorker: {}, byStage: {}, total: 0 });
  });
});

describe("deriveStageStatus ignores cost events", () => {
  const auto: StageDef = { id: "implement", agent: "thor", gate: "auto", prompt: "x" };
  it("a cost event does not change stage status", () => {
    const events: LedgerEvent[] = [
      { ts: "2026-07-20T00:00:00Z", type: "stage_started", stage: "implement", agent: "thor" },
      { ts: "2026-07-20T00:00:01Z", type: "cost", stage: "implement", worker: "thor", costUsd: 0.01 },
    ];
    expect(deriveStageStatus(events, auto)).toBe("running"); // unchanged by the trailing cost event
  });
});
```

Update `tests/engine.test.ts` — the M1 test that pattern-matches the exact ledger event list must be widened to include the new `cost` event (this is the one intentional M1 assertion change in this plan):
```ts
  it("runs the first stage and ledgers started+completed with tokens", async () => {
    const { dir, config } = project();
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() } });
    const events = readLedger(dir);
    expect(events.map(e => e.type)).toEqual(["stage_started", "stage_completed", "cost"]);
    expect(events[0].agent).toBe("thor");
    expect(events[1].tokensOut).toBe(4);
  });
```
Add one more test to the same `describe("runStage", ...)` block:
```ts
  it("ledgers a cost event derived from the pricing table", async () => {
    const { dir, config } = project();
    const priced = { ...config, pricing: { opus: { input: 0.000015, output: 0.000075 } } };
    await runStage(dir, priced, "implement", { adapters: { fake: okAdapter() } });
    const costEvent = readLedger(dir).find(e => e.type === "cost")!;
    expect(costEvent.worker).toBe("thor");
    expect(costEvent.model).toBe("opus");
    expect(costEvent.costUsd).toBeCloseTo(3 * 0.000015 + 4 * 0.000075, 10);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cost.test.ts tests/engine.test.ts`
Expected: FAIL — `../src/cost.js` doesn't exist; the M1-era event-list assertion still expects only two events; no `cost` event is ledgered yet.

- [ ] **Step 3: Implementation**

`src/cost.ts`:
```ts
import type { AssembleConfig } from "./config.js";
import type { LedgerEvent } from "./ledger.js";

export function computeCost(config: AssembleConfig, model: string, tokensIn: number, tokensOut: number): number {
  const rate = config.pricing[model];
  if (!rate) return 0;
  return tokensIn * rate.input + tokensOut * rate.output;
}

export type CostSummary = {
  byWorker: Record<string, number>;
  byStage: Record<string, number>;
  total: number;
};

export function aggregateCost(events: LedgerEvent[]): CostSummary {
  const byWorker: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  let total = 0;
  for (const e of events) {
    if (e.type !== "cost") continue;
    const usd = e.costUsd ?? 0;
    const worker = e.worker ?? e.agent ?? "unknown";
    byWorker[worker] = (byWorker[worker] ?? 0) + usd;
    byStage[e.stage] = (byStage[e.stage] ?? 0) + usd;
    total += usd;
  }
  return { byWorker, byStage, total };
}
```

Widen `LedgerEvent` in `src/ledger.ts` — replace the type definition at the top of the file:
```ts
export type LedgerEvent = {
  ts: string;
  type: "stage_started" | "stage_completed" | "stage_failed" | "gate_approved" | "gate_rejected" | "cost";
  stage: string;
  agent?: string;
  worker?: string;
  model?: string;
  verdict?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  approvedBy?: string;
  notes?: string;
};
```
(no other change to `src/ledger.ts` — `deriveStageStatus`'s `switch` already ignores unmatched `type` values).

Extend `src/engine.ts`'s `runStage` to ledger cost — replace the `try` block's success path with:
```ts
  try {
    const result = await adapter.run({ prompt: stage.prompt, model, cwd: dir });
    appendEvent(dir, { type: "stage_completed", stage: stage.id, agent: stage.agent, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    appendEvent(dir, {
      type: "cost", stage: stage.id, worker: stage.agent, model,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      costUsd: computeCost(config, model, result.tokensIn, result.tokensOut),
    });
    log(`✔ ${stage.id} — ${renderAgent(stage.agent, config)} done`);
    if (opts.autoCommit && config.utilityModel) {
      const commit = await commitStageChanges(dir, config, stage.id, {
        adapter: opts.autoCommit.adapter, gitBin: opts.autoCommit.gitBin, diffSummary: result.output,
      });
      appendEvent(dir, {
        type: "cost", stage: stage.id, worker: "utility", model: config.utilityModel,
        tokensIn: commit.tokensIn, tokensOut: commit.tokensOut,
        costUsd: computeCost(config, config.utilityModel, commit.tokensIn, commit.tokensOut),
      });
      log(`◆ ${stage.id} — committed: ${commit.message}`);
    }
  } catch (err) {
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: stage.agent, notes: String(err) });
    throw err;
  }
```
and add the import at the top of `src/engine.ts`:
```ts
import { computeCost } from "./cost.js";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cost.test.ts tests/engine.test.ts`
Expected: 8 tests PASS in `cost.test.ts`; 9 in `engine.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cost.ts src/ledger.ts src/engine.ts tests/cost.test.ts tests/engine.test.ts
git commit -m "feat: cost ledger events derived from pricing table (stage + utility-model runs)"
```

---

### Task 5: `assemble cost` CLI Command

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `aggregateCost` (Task 4), `readLedger` (M1).
- Produces: a new `assemble cost` command — no arguments, no flags. Reads the full ledger, aggregates with `aggregateCost`, and prints one line per worker, one line per stage, and a `total` line, each with a `$`-prefixed amount formatted to 4 decimal places.

- [ ] **Step 1: Write failing test**

Add to `tests/cli.test.ts`, inside `describe("buildProgram", ...)` (the file already imports `appendEvent` from `../src/ledger.js`):
```ts
  it("cost aggregates ledgered cost events by worker, stage, and total", async () => {
    const dir = project();
    appendEvent(dir, { type: "cost", stage: "implement", worker: "thor", model: "opus", tokensIn: 100, tokensOut: 50, costUsd: 0.01 });
    appendEvent(dir, { type: "cost", stage: "implement", worker: "utility", model: "haiku", tokensIn: 20, tokensOut: 10, costUsd: 0.0005 });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "cost"]);
    const out = lines.join("\n");
    expect(out).toMatch(/thor.*\$0\.0100/);
    expect(out).toMatch(/utility.*\$0\.0005/);
    expect(out).toMatch(/total.*\$0\.0105/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `assemble cost` is not a registered command (`commander` reports unknown command).

- [ ] **Step 3: Implementation**

In `src/cli.ts`, add the import:
```ts
import { aggregateCost } from "./cost.js";
```
and register the command (place it directly after the `status` command registration):
```ts
  program.command("cost").description("aggregate token cost by worker and stage").action(() => {
    const summary = aggregateCost(readLedger(dir));
    for (const [worker, usd] of Object.entries(summary.byWorker))
      io.out(`worker  ${worker.padEnd(14)} $${usd.toFixed(4)}`);
    for (const [stage, usd] of Object.entries(summary.byStage))
      io.out(`stage   ${stage.padEnd(14)} $${usd.toFixed(4)}`);
    io.out(`total   ${"".padEnd(14)} $${summary.total.toFixed(4)}`);
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: assemble cost CLI command — aggregate ledgered cost by worker and stage"
```

---

### Task 6: Milestone Review Pass

**Files:** none (verification-only gate over Tasks 1–5; no production code changes, so no commit at the end of this task).

**Interfaces:** none produced — this task validates that Tasks 1–5 together satisfy the three locked design decisions and leave M1 fully intact.

- [ ] **Step 1: Full suite + build**

Run: `npm test && npm run build`
Expected: every test file passes (`smoke`, `protocol`, `config`, `theme`, `ledger`, `adapters`, `engine`, `gate`, `pipeline`, `init`, `cli`, `sideops`, `cost`); `tsc` exits 0 with no type errors across the modified/created files.

- [ ] **Step 2: Traceability check (read-only — confirm, don't re-litigate)**

- Decision 1 (utility model): `utilityModel` field → Task 2/3; `resolveSideOpModel` single choke point → Task 3; wired to `git` via `commitStageChanges` → Task 3; `slack`/`jira` declared in `SIDE_OPERATIONS` but unimplemented → Task 3 (explicitly out of scope beyond the declaration).
- Decision 2 (pricing table): real codex tokens (prerequisite) → Task 1; claude usage verified/normalized → Task 1; `pricing` schema + `ASSEMBLE_PRICING_JSON` → Task 2; `computeCost` → Task 4.
- Decision 3 (ledger + report): `cost` ledger event type → Task 4 (`ledger.ts`) and Task 4 (`engine.ts` emission sites); `assemble cost` CLI → Task 5.
- M1 regression surface: the only M1 assertion intentionally changed anywhere in this plan is the ledgered-event-list check in `tests/engine.test.ts` (Task 4, Step 1) — confirm no other M1 test file was edited for a reason other than pure *addition* of new `it(...)` blocks.

- [ ] **Step 3: Confirm no budget/enforcement scope crept in**

Grep for accidental scope creep: `grep -rn "budget\|pause\|REQUEST_CHANGES.*retry\|parse-retry" src/` should return nothing new from this milestone (M1's existing `REQUEST_CHANGES` constant is fine; a *retry loop* built on it is not — that's M3+ per Out of Scope below).

- [ ] **Step 4: Record milestone completion**

Run: `git log --oneline -6` and confirm exactly 5 M2 commits landed (Tasks 1–5) on top of the M1 history, each green at commit time. No new commit is made by this step — it is a verification gate, not a code change.

---

## Out of Scope (follow-up plans)

- **M3:** budget caps (warn/pause based on `assemble cost` totals), enforcement/blocking on overspend, `jarvis` (memory) compaction, rolling digests for resume-less providers, `assemble report` / `models list` / `config show` / `clean` / `adhoc`, gemini + opencode adapters.
- **M4 (carried from M1's plan):** verdict parse-retry (`parseVerdict` retry protocol) and `REQUEST_CHANGES` rework cycles, parallel batch implement (`shuri` (batch implementer)), batch-manifest schema + `assemble plan validate`, interactive TUI status, theme packs, `--headless`, npm publish pipeline.
- **Real Slack/Jira side-operations:** `SIDE_OPERATIONS` declares `"slack"` and `"jira"` as config-supported targets so the type is stable for future milestones, but no adapter, no CLI surface, and no routing logic exists for them yet — only `"git"` is implemented in M2.
- **Auto-commit is opt-in only:** `assemble run` never commits unless `--auto-commit` is explicitly passed; there is no default-on auto-commit behavior, no push, and no conflict resolution.

## Self-Review Notes

- Spec coverage against the three locked decisions: utility-model routing → T3; pricing table → T2/T4; real token counts (prerequisite) → T1; cost ledger events → T4; `assemble cost` report → T5; milestone-level verification → T6.
- Type check: `PricingEntry` (T2) consumed by `computeCost` (T4); `RunStageOpts.autoCommit` (T3) consumed by `runStage`'s cost-emission block (T4); `LedgerEvent.worker`/`model`/`costUsd` (T4) consumed by `aggregateCost` (T4) and printed by the `cost` command (T5); all imports use `.js` NodeNext suffixes, matching M1.
- Backward compatibility: every M1 call site (`pipeline.ts`, `gate.ts`, all M1 CLI commands) is untouched; the sole intentional M1 test edit is called out in T4 and T6.
- No placeholders: every step has complete code/commands.
