# assemble — Milestone 1: Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `assemble` CLI that runs a serial staged pipeline (plan → implement → …) via provider adapters, records everything in an NDJSON ledger, and enforces human gates — Milestone 1 of the spec at `docs/superpowers/specs/2026-07-20-assemble-orchestrator-design.md`.

**Architecture:** Event-sourced core — the ledger (`.assemble/ledger.ndjson`) is the only source of truth; stage status is *derived* from ledger events, never stored elsewhere. A thin CLI (commander) registers built-in commands plus one dynamic top-level command per stage id found in `assemble.config.yaml`. Provider adapters wrap external agent CLIs behind one interface with injectable binaries so tests use fake shell scripts.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Node ≥ 20, commander, zod, yaml, vitest.

## Global Constraints

- Package + bin name: `assemble`; config file name: `assemble.config.yaml`; state dir: `.assemble/`; ledger path: `.assemble/ledger.ndjson`.
- Verdict strings are EXACTLY `APPROVED`, `REQUEST_CHANGES`, `BLOCKED` — protocol constants are unthemed.
- Stage statuses are EXACTLY: `pending`, `running`, `awaiting_gate`, `approved`, `needs_rework`, `failed`.
- Reserved stage ids (rejected at config load): `run`, `init`, `status`, `gate`, `report`, `models`, `config`, `clean`, `adhoc`, `resume`.
- Env override pattern (verbatim from spec): `ASSEMBLE_STAGE_<stage-id>_MODEL`, e.g. `ASSEMBLE_STAGE_code-review_MODEL=gemini-flash`.
- UI always renders agents as `name (role)` — e.g. `thor (implementer)` — via `renderAgent()`; never print a bare hero name.
- Hero names are a display theme only; no engine logic may branch on a hero name.
- The orchestrator writes no project code itself — adapters do all agent work.
- TDD for every task; commit after every green test cycle.

## File Structure

```
assemble/
├── package.json              # bin: assemble → dist/cli.js
├── tsconfig.json
├── src/
│   ├── protocol.ts           # verdicts, statuses, reserved words, parseVerdict
│   ├── config.ts             # zod schema, loadConfig, env overrides
│   ├── theme.ts              # renderAgent — Name (role)
│   ├── ledger.ts             # append/read NDJSON, deriveStageStatus
│   ├── adapters.ts           # Adapter interface, claude + codex adapters
│   ├── engine.ts             # runStage: ordering + gate enforcement
│   ├── gate.ts               # approveGate / rejectGate
│   ├── pipeline.ts           # runPipeline (serial `assemble run`)
│   ├── init.ts               # `assemble init` scaffolding
│   └── cli.ts                # commander wiring + dynamic stage commands
├── templates/assemble.config.example.yaml   # exists (design phase)
└── tests/                    # one test file per src module
```

---

### Task 1: Package Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/protocol.ts` (stub), `tests/smoke.test.ts`

**Interfaces:**
- Produces: a compiling, testable TS package. All later tasks add `src/<module>.ts` + `tests/<module>.test.ts` and rely on `npm test` and `npm run build` working.

- [ ] **Step 1: Write the failing smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "../src/protocol.js";

describe("smoke", () => {
  it("exposes a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Scaffold the package, run test to verify it fails**

`package.json`:
```json
{
  "name": "assemble",
  "version": "0.1.0",
  "type": "module",
  "bin": { "assemble": "dist/cli.js" },
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": { "commander": "^12.1.0", "yaml": "^2.5.0", "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.14.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "NodeNext", "moduleResolution": "NodeNext", "target": "ES2022",
    "strict": true, "outDir": "dist", "rootDir": "src", "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

Run: `npm install && npm test`
Expected: FAIL — `Cannot find module '../src/protocol.js'` (or missing export).

- [ ] **Step 3: Minimal implementation**

`src/protocol.ts`:
```ts
export const PROTOCOL_VERSION = 1;
```

- [ ] **Step 4: Run tests + build**

Run: `npm test && npm run build`
Expected: 1 test PASS; `dist/cli.js` absent is fine (no cli.ts yet), tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/protocol.ts tests/smoke.test.ts
git commit -m "feat: scaffold assemble TypeScript package with vitest"
```

---

### Task 2: Protocol Constants + Verdict Parsing

**Files:**
- Modify: `src/protocol.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Produces:
  - `VERDICTS: readonly ["APPROVED","REQUEST_CHANGES","BLOCKED"]`, `type Verdict`
  - `STAGE_STATUSES` and `type StageStatus` (`"pending"|"running"|"awaiting_gate"|"approved"|"needs_rework"|"failed"`)
  - `RESERVED_STAGE_IDS: readonly string[]` (exact list from Global Constraints)
  - `parseVerdict(output: string): Verdict | null` — LAST verdict token wins; `null` if none (caller does parse-retry in M2).

- [ ] **Step 1: Write failing tests**

`tests/protocol.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VERDICTS, STAGE_STATUSES, RESERVED_STAGE_IDS, parseVerdict } from "../src/protocol.js";

describe("protocol constants", () => {
  it("verdict strings are exact and unthemed", () => {
    expect(VERDICTS).toEqual(["APPROVED", "REQUEST_CHANGES", "BLOCKED"]);
  });
  it("stage statuses are exact", () => {
    expect(STAGE_STATUSES).toEqual(["pending", "running", "awaiting_gate", "approved", "needs_rework", "failed"]);
  });
  it("reserved stage ids match the spec list", () => {
    expect(RESERVED_STAGE_IDS).toEqual(["run","init","status","gate","report","models","config","clean","adhoc","resume"]);
  });
});

describe("parseVerdict", () => {
  it("finds a verdict inside prose", () => {
    expect(parseVerdict("Looks good.\nVerdict: APPROVED\n")).toBe("APPROVED");
  });
  it("last verdict wins when the model quotes earlier ones", () => {
    expect(parseVerdict("Earlier run said APPROVED but now REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
  });
  it("does not match substrings of other words", () => {
    expect(parseVerdict("the DISAPPROVED plan")).toBeNull();
  });
  it("returns null when absent", () => {
    expect(parseVerdict("no verdict here")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL — `VERDICTS` is not exported.

- [ ] **Step 3: Implementation**

Replace `src/protocol.ts` with:
```ts
export const PROTOCOL_VERSION = 1;

export const VERDICTS = ["APPROVED", "REQUEST_CHANGES", "BLOCKED"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STAGE_STATUSES = ["pending", "running", "awaiting_gate", "approved", "needs_rework", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const RESERVED_STAGE_IDS = ["run","init","status","gate","report","models","config","clean","adhoc","resume"] as const;

export function parseVerdict(output: string): Verdict | null {
  const re = /\b(APPROVED|REQUEST_CHANGES|BLOCKED)\b/g;
  let last: Verdict | null = null;
  for (const m of output.matchAll(re)) last = m[1] as Verdict;
  return last;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/protocol.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts tests/protocol.test.ts
git commit -m "feat: protocol constants and verdict parsing"
```

---

### Task 3: Config Schema + Loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `RESERVED_STAGE_IDS` from Task 2.
- Produces:
  - `type AgentDef = { role: string; provider: string; model: string }`
  - `type StageDef = { id: string; agent: string; gate: "human" | "auto"; prompt: string }`
  - `type AssembleConfig = { project: string; agents: Record<string, AgentDef>; stages: StageDef[] }`
  - `loadConfig(dir: string, env?: NodeJS.ProcessEnv): AssembleConfig` — reads `<dir>/assemble.config.yaml`; throws `ConfigError` (exported class) on: missing file, schema violation, reserved/duplicate stage id, stage referencing unknown agent. Applies `ASSEMBLE_STAGE_<id>_MODEL` env override to the referenced agent's model (per-stage copy — other stages using that agent are unaffected).

- [ ] **Step 1: Write failing tests**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

const VALID = `
project: MyApp
agents:
  thor: { role: implementer, provider: claude, model: opus }
  vision: { role: code reviewer, provider: codex, model: gpt-5-codex }
stages:
  - { id: implement, agent: thor, gate: auto, prompt: "Implement the plan." }
  - { id: code-review, agent: vision, gate: human, prompt: "Review the diff." }
`;

function writeCfg(yamlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), yamlText);
  return dir;
}

describe("loadConfig", () => {
  it("parses a valid config", () => {
    const cfg = loadConfig(writeCfg(VALID));
    expect(cfg.project).toBe("MyApp");
    expect(cfg.stages.map(s => s.id)).toEqual(["implement", "code-review"]);
    expect(cfg.agents.thor.role).toBe("implementer");
  });
  it("throws ConfigError when file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
  it("rejects reserved stage ids", () => {
    const bad = VALID.replace("id: implement", "id: status");
    expect(() => loadConfig(writeCfg(bad))).toThrow(/reserved/);
  });
  it("rejects duplicate stage ids", () => {
    const bad = VALID.replace("id: code-review", "id: implement");
    expect(() => loadConfig(writeCfg(bad))).toThrow(/duplicate/);
  });
  it("rejects stages referencing unknown agents", () => {
    const bad = VALID.replace("agent: vision", "agent: loki");
    expect(() => loadConfig(writeCfg(bad))).toThrow(/unknown agent/);
  });
  it("applies ASSEMBLE_STAGE_<id>_MODEL override per stage", () => {
    const cfg = loadConfig(writeCfg(VALID), { "ASSEMBLE_STAGE_code-review_MODEL": "gemini-flash" });
    const stage = cfg.stages.find(s => s.id === "code-review")!;
    expect(cfg.agents[stage.agent].model).toBe("gpt-5-codex"); // base agent untouched
    expect((stage as any).modelOverride).toBe("gemini-flash");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implementation**

`src/config.ts`:
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
const ConfigSchema = z.object({
  project: z.string().min(1),
  agents: z.record(AgentSchema),
  stages: z.array(StageSchema).min(1),
});

export type AgentDef = z.infer<typeof AgentSchema>;
export type StageDef = z.infer<typeof StageSchema>;
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
  return cfg;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config schema, loader, env overrides, reserved-word validation"
```

---

### Task 4: Theme Rendering — `Name (role)`

**Files:**
- Create: `src/theme.ts`
- Test: `tests/theme.test.ts`

**Interfaces:**
- Consumes: `AssembleConfig` from Task 3.
- Produces: `renderAgent(key: string, config: AssembleConfig): string` → `"thor (implementer)"`; unknown keys render as `"<key> (unknown)"` — never throws (display layer must not crash the engine).

- [ ] **Step 1: Write failing tests**

`tests/theme.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderAgent } from "../src/theme.js";
import type { AssembleConfig } from "../src/config.js";

const cfg = {
  project: "MyApp",
  agents: { thor: { role: "implementer", provider: "claude", model: "opus" } },
  stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
} as AssembleConfig;

describe("renderAgent", () => {
  it("renders Name (role)", () => {
    expect(renderAgent("thor", cfg)).toBe("thor (implementer)");
  });
  it("never throws on unknown keys", () => {
    expect(renderAgent("loki", cfg)).toBe("loki (unknown)");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/theme.test.ts`
Expected: FAIL — cannot resolve `../src/theme.js`.

- [ ] **Step 3: Implementation**

`src/theme.ts`:
```ts
import type { AssembleConfig } from "./config.js";

/** UI always renders agents as `name (role)` — spec display convention. */
export function renderAgent(key: string, config: AssembleConfig): string {
  return `${key} (${config.agents[key]?.role ?? "unknown"})`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/theme.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/theme.ts tests/theme.test.ts
git commit -m "feat: Name (role) agent rendering"
```

---

### Task 5: Ledger + Status Derivation

**Files:**
- Create: `src/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `StageStatus` from Task 2, `StageDef` from Task 3.
- Produces:
  - `type LedgerEvent = { ts: string; type: "stage_started"|"stage_completed"|"stage_failed"|"gate_approved"|"gate_rejected"; stage: string; agent?: string; verdict?: string; tokensIn?: number; tokensOut?: number; approvedBy?: string; notes?: string }`
  - `appendEvent(dir: string, e: Omit<LedgerEvent,"ts">): LedgerEvent` — appends one JSON line to `<dir>/.assemble/ledger.ndjson`, creating the dir/file; stamps ISO `ts`.
  - `readLedger(dir: string): LedgerEvent[]` — `[]` when absent.
  - `deriveStageStatus(events: LedgerEvent[], stage: StageDef): StageStatus` — last matching event wins: none→`pending`; `stage_started`→`running`; `stage_completed`→`awaiting_gate` if `stage.gate==="human"` else `approved`; `stage_failed`→`failed`; `gate_approved`→`approved`; `gate_rejected`→`needs_rework`.

- [ ] **Step 1: Write failing tests**

`tests/ledger.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLedger, deriveStageStatus, type LedgerEvent } from "../src/ledger.js";
import type { StageDef } from "../src/config.js";

const human: StageDef = { id: "code-review", agent: "vision", gate: "human", prompt: "x" };
const auto: StageDef = { id: "implement", agent: "thor", gate: "auto", prompt: "x" };
const ev = (type: LedgerEvent["type"], stage: string): LedgerEvent => ({ ts: "2026-07-20T00:00:00Z", type, stage });

describe("ledger file", () => {
  it("appends NDJSON to .assemble/ledger.ndjson and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    appendEvent(dir, { type: "stage_started", stage: "implement", agent: "thor" });
    appendEvent(dir, { type: "stage_completed", stage: "implement", tokensIn: 10, tokensOut: 5 });
    const raw = readFileSync(join(dir, ".assemble", "ledger.ndjson"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const events = readLedger(dir);
    expect(events[1].tokensOut).toBe(5);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("readLedger returns [] when no ledger exists", () => {
    expect(readLedger(mkdtempSync(join(tmpdir(), "asm-")))).toEqual([]);
  });
});

describe("deriveStageStatus", () => {
  it("pending with no events", () => {
    expect(deriveStageStatus([], auto)).toBe("pending");
  });
  it("running after stage_started", () => {
    expect(deriveStageStatus([ev("stage_started", "implement")], auto)).toBe("running");
  });
  it("auto-gate stages approve on completion", () => {
    expect(deriveStageStatus([ev("stage_started", "implement"), ev("stage_completed", "implement")], auto)).toBe("approved");
  });
  it("human-gate stages await the Council", () => {
    expect(deriveStageStatus([ev("stage_completed", "code-review")], human)).toBe("awaiting_gate");
  });
  it("gate_approved / gate_rejected resolve the gate", () => {
    expect(deriveStageStatus([ev("stage_completed", "code-review"), ev("gate_approved", "code-review")], human)).toBe("approved");
    expect(deriveStageStatus([ev("stage_completed", "code-review"), ev("gate_rejected", "code-review")], human)).toBe("needs_rework");
  });
  it("ignores other stages' events", () => {
    expect(deriveStageStatus([ev("stage_started", "implement")], human)).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL — cannot resolve `../src/ledger.js`.

- [ ] **Step 3: Implementation**

`src/ledger.ts`:
```ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageStatus } from "./protocol.js";
import type { StageDef } from "./config.js";

export type LedgerEvent = {
  ts: string;
  type: "stage_started" | "stage_completed" | "stage_failed" | "gate_approved" | "gate_rejected";
  stage: string;
  agent?: string;
  verdict?: string;
  tokensIn?: number;
  tokensOut?: number;
  approvedBy?: string;
  notes?: string;
};

const ledgerPath = (dir: string) => join(dir, ".assemble", "ledger.ndjson");

export function appendEvent(dir: string, e: Omit<LedgerEvent, "ts">): LedgerEvent {
  mkdirSync(join(dir, ".assemble"), { recursive: true });
  const event: LedgerEvent = { ts: new Date().toISOString(), ...e };
  appendFileSync(ledgerPath(dir), JSON.stringify(event) + "\n");
  return event;
}

export function readLedger(dir: string): LedgerEvent[] {
  try {
    return readFileSync(ledgerPath(dir), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

export function deriveStageStatus(events: LedgerEvent[], stage: StageDef): StageStatus {
  let status: StageStatus = "pending";
  for (const e of events) {
    if (e.stage !== stage.id) continue;
    switch (e.type) {
      case "stage_started": status = "running"; break;
      case "stage_completed": status = stage.gate === "human" ? "awaiting_gate" : "approved"; break;
      case "stage_failed": status = "failed"; break;
      case "gate_approved": status = "approved"; break;
      case "gate_rejected": status = "needs_rework"; break;
    }
  }
  return status;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ledger.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: NDJSON ledger with event-sourced stage status"
```

---

### Task 6: Provider Adapters (claude, codex)

**Files:**
- Create: `src/adapters.ts`
- Test: `tests/adapters.test.ts`

**Interfaces:**
- Produces:
  - `type RunOpts = { prompt: string; model: string; cwd: string }`
  - `type RunResult = { output: string; tokensIn: number; tokensOut: number }`
  - `interface Adapter { readonly name: string; run(opts: RunOpts): Promise<RunResult> }`
  - `class AdapterError extends Error` — thrown on non-zero exit (message includes stderr).
  - `claudeAdapter(bin?: string): Adapter` — spawns `<bin> -p <prompt> --model <model> --output-format json`; parses stdout JSON `{ result, usage: { input_tokens, output_tokens } }`.
  - `codexAdapter(bin?: string): Adapter` — spawns `<bin> exec --model <model> <prompt>`; plain-text stdout; tokens 0/0 (codex CLI reports no usage in M1).
  - `getAdapter(provider: string, bins?: Record<string,string>): Adapter` — `"claude"`/`"codex"` or throws `AdapterError("unknown provider ...")`.
  - `bin` defaults to the provider name; tests inject fake executables.

- [ ] **Step 1: Write failing tests (fake CLI binaries)**

`tests/adapters.test.ts`:
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
});

describe("codexAdapter", () => {
  it("returns plain text with zero token counts", async () => {
    const bin = fakeBin(`echo "plain output"`);
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output.trim()).toBe("plain output");
    expect(r.tokensIn).toBe(0);
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
Expected: FAIL — cannot resolve `../src/adapters.js`.

- [ ] **Step 3: Implementation**

`src/adapters.ts`:
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

export function codexAdapter(bin = "codex"): Adapter {
  return {
    name: "codex",
    async run({ prompt, model, cwd }) {
      const stdout = await spawn(bin, ["exec", "--model", model, prompt], cwd);
      return { output: stdout, tokensIn: 0, tokensOut: 0 };
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
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters.ts tests/adapters.test.ts
git commit -m "feat: claude and codex provider adapters with injectable binaries"
```

---

### Task 7: Stage Engine

**Files:**
- Create: `src/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `loadConfig` types (Task 3), ledger (Task 5), `getAdapter`/`Adapter` (Task 6), `renderAgent` (Task 4).
- Produces:
  - `class GateError extends Error`
  - `runStage(dir: string, config: AssembleConfig, stageId: string, opts?: { adapters?: Record<string, Adapter>; log?: (line: string) => void }): Promise<void>` — behavior:
    1. Unknown stage id → `GateError("unknown stage ...")`.
    2. Every EARLIER stage in `config.stages` order must derive to `approved`, else `GateError` naming the blocking stage and its status (this is the spec's "next `assemble <stage>` invocation hard-fails on a missing/failed gate").
    3. Appends `stage_started` (with `agent`), invokes the stage agent's adapter (model = `stage.modelOverride ?? agent.model`), then appends `stage_completed` with `tokensIn`/`tokensOut`; on adapter throw appends `stage_failed` with `notes` and re-throws.
    4. `log` lines use `renderAgent` (`Name (role)`); default log is a no-op so tests stay silent.
  - `opts.adapters` maps provider name → Adapter, letting tests/pipeline inject fakes without touching `getAdapter`.

- [ ] **Step 1: Write failing tests**

`tests/engine.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, GateError } from "../src/engine.js";
import { loadConfig } from "../src/config.js";
import { appendEvent, readLedger } from "../src/ledger.js";
import type { Adapter } from "../src/adapters.js";

const YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  vision: { role: code reviewer, provider: fake, model: gpt-5-codex }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
  - { id: code-review, agent: vision, gate: auto, prompt: "Review." }
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  return { dir, config: loadConfig(dir) };
}
const okAdapter = (calls: string[] = []): Adapter => ({
  name: "fake",
  async run({ model }) { calls.push(model); return { output: "ok", tokensIn: 3, tokensOut: 4 }; },
});

describe("runStage", () => {
  it("runs the first stage and ledgers started+completed with tokens", async () => {
    const { dir, config } = project();
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() } });
    const events = readLedger(dir);
    expect(events.map(e => e.type)).toEqual(["stage_started", "stage_completed"]);
    expect(events[0].agent).toBe("thor");
    expect(events[1].tokensOut).toBe(4);
  });
  it("hard-fails when an earlier gate is not approved", async () => {
    const { dir, config } = project();
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() } }); // now awaiting_gate
    await expect(runStage(dir, config, "code-review", { adapters: { fake: okAdapter() } }))
      .rejects.toThrow(/implement.*awaiting_gate/);
  });
  it("runs the next stage once the gate is approved", async () => {
    const { dir, config } = project();
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() } });
    appendEvent(dir, { type: "gate_approved", stage: "implement", approvedBy: "council" });
    const calls: string[] = [];
    await runStage(dir, config, "code-review", { adapters: { fake: okAdapter(calls) } });
    expect(calls).toEqual(["gpt-5-codex"]);
  });
  it("uses modelOverride when set", async () => {
    const { dir } = project();
    const config = loadConfig(dir, { "ASSEMBLE_STAGE_implement_MODEL": "haiku" });
    const calls: string[] = [];
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter(calls) } });
    expect(calls).toEqual(["haiku"]);
  });
  it("ledgers stage_failed and re-throws on adapter failure", async () => {
    const { dir, config } = project();
    const boom: Adapter = { name: "fake", async run() { throw new Error("provider down"); } };
    await expect(runStage(dir, config, "implement", { adapters: { fake: boom } })).rejects.toThrow("provider down");
    expect(readLedger(dir).map(e => e.type)).toEqual(["stage_started", "stage_failed"]);
  });
  it("rejects unknown stage ids", async () => {
    const { dir, config } = project();
    await expect(runStage(dir, config, "nope", {})).rejects.toThrow(GateError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/engine.test.ts`
Expected: FAIL — cannot resolve `../src/engine.js`.

- [ ] **Step 3: Implementation**

`src/engine.ts`:
```ts
import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus } from "./ledger.js";
import { getAdapter, type Adapter } from "./adapters.js";
import { renderAgent } from "./theme.js";

export class GateError extends Error {}

export type RunStageOpts = { adapters?: Record<string, Adapter>; log?: (line: string) => void };

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
  } catch (err) {
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: stage.agent, notes: String(err) });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/engine.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/engine.test.ts
git commit -m "feat: stage engine with gate enforcement and ledger writes"
```

---

### Task 8: Gate Approve / Reject

**Files:**
- Create: `src/gate.ts`
- Test: `tests/gate.test.ts`

**Interfaces:**
- Consumes: ledger (Task 5), `GateError` (Task 7), config types (Task 3).
- Produces:
  - `approveGate(dir: string, config: AssembleConfig, stageId: string, by?: string): void`
  - `rejectGate(dir: string, config: AssembleConfig, stageId: string, notes: string, by?: string): void`
  - Both throw `GateError` unless the stage's derived status is `awaiting_gate`; `by` defaults to `"council"` (World Security Council = human approver). Approve appends `gate_approved` (`approvedBy`); reject appends `gate_rejected` (`approvedBy`, `notes`).

- [ ] **Step 1: Write failing tests**

`tests/gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveGate, rejectGate } from "../src/gate.js";
import { GateError } from "../src/engine.js";
import { loadConfig } from "../src/config.js";
import { appendEvent, readLedger } from "../src/ledger.js";

const YAML = `
project: MyApp
agents:
  vision: { role: code reviewer, provider: claude, model: opus }
stages:
  - { id: code-review, agent: vision, gate: human, prompt: "Review." }
`;

function awaiting() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  const config = loadConfig(dir);
  appendEvent(dir, { type: "stage_completed", stage: "code-review", agent: "vision" });
  return { dir, config };
}

describe("gates", () => {
  it("approve appends gate_approved with approvedBy", () => {
    const { dir, config } = awaiting();
    approveGate(dir, config, "code-review");
    const last = readLedger(dir).at(-1)!;
    expect(last.type).toBe("gate_approved");
    expect(last.approvedBy).toBe("council");
  });
  it("reject appends gate_rejected with notes", () => {
    const { dir, config } = awaiting();
    rejectGate(dir, config, "code-review", "tests missing", "basant");
    const last = readLedger(dir).at(-1)!;
    expect(last.type).toBe("gate_rejected");
    expect(last.notes).toBe("tests missing");
    expect(last.approvedBy).toBe("basant");
  });
  it("throws GateError when the stage is not awaiting_gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    writeFileSync(join(dir, "assemble.config.yaml"), YAML);
    const config = loadConfig(dir);
    expect(() => approveGate(dir, config, "code-review")).toThrow(GateError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/gate.test.ts`
Expected: FAIL — cannot resolve `../src/gate.js`.

- [ ] **Step 3: Implementation**

`src/gate.ts`:
```ts
import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus } from "./ledger.js";
import { GateError } from "./engine.js";

function requireAwaiting(dir: string, config: AssembleConfig, stageId: string) {
  const stage = config.stages.find(s => s.id === stageId);
  if (!stage) throw new GateError(`unknown stage '${stageId}'`);
  const status = deriveStageStatus(readLedger(dir), stage);
  if (status !== "awaiting_gate")
    throw new GateError(`stage '${stageId}' is ${status}, not awaiting_gate — nothing to decide`);
}

export function approveGate(dir: string, config: AssembleConfig, stageId: string, by = "council"): void {
  requireAwaiting(dir, config, stageId);
  appendEvent(dir, { type: "gate_approved", stage: stageId, approvedBy: by });
}

export function rejectGate(dir: string, config: AssembleConfig, stageId: string, notes: string, by = "council"): void {
  requireAwaiting(dir, config, stageId);
  appendEvent(dir, { type: "gate_rejected", stage: stageId, approvedBy: by, notes });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/gate.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts tests/gate.test.ts
git commit -m "feat: human gate approve/reject"
```

---

### Task 9: Serial Pipeline + Init

**Files:**
- Create: `src/pipeline.ts`, `src/init.ts`
- Test: `tests/pipeline.test.ts`, `tests/init.test.ts`

**Interfaces:**
- Consumes: `runStage`/`RunStageOpts` (Task 7), ledger derivation (Task 5).
- Produces:
  - `runPipeline(dir: string, config: AssembleConfig, opts?: RunStageOpts): Promise<{ ran: string[]; stoppedAt: string | null }>` — serially runs each stage whose derived status is not `approved`, skipping already-approved ones (resume-by-ledger); STOPS (no throw) returning `stoppedAt: stageId` when a stage lands in `awaiting_gate`, `needs_rework`, or `failed`; `stoppedAt: null` when all stages end `approved`.
  - `initProject(dir: string): { created: string[] }` — writes a starter `assemble.config.yaml` (embedded DEFAULT_CONFIG below, MCU default theme) and `.assemble/` dir; throws `ConfigError` if config already exists.

- [ ] **Step 1: Write failing tests**

`tests/pipeline.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";
import { appendEvent } from "../src/ledger.js";
import type { Adapter } from "../src/adapters.js";

const YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  vision: { role: code reviewer, provider: fake, model: gpt-5-codex }
stages:
  - { id: implement, agent: thor, gate: auto, prompt: "Implement." }
  - { id: code-review, agent: vision, gate: human, prompt: "Review." }
`;
const ok: Adapter = { name: "fake", async run() { return { output: "ok", tokensIn: 1, tokensOut: 1 }; } };

function project() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  return { dir, config: loadConfig(dir) };
}

describe("runPipeline", () => {
  it("runs stages serially and stops at the human gate", async () => {
    const { dir, config } = project();
    const r = await runPipeline(dir, config, { adapters: { fake: ok } });
    expect(r.ran).toEqual(["implement", "code-review"]);
    expect(r.stoppedAt).toBe("code-review"); // awaiting the Council
  });
  it("resumes past approved stages using the ledger", async () => {
    const { dir, config } = project();
    await runPipeline(dir, config, { adapters: { fake: ok } });
    appendEvent(dir, { type: "gate_approved", stage: "code-review", approvedBy: "council" });
    const r = await runPipeline(dir, config, { adapters: { fake: ok } });
    expect(r.ran).toEqual([]); // everything already approved
    expect(r.stoppedAt).toBeNull();
  });
});
```

`tests/init.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/init.js";
import { loadConfig, ConfigError } from "../src/config.js";

describe("initProject", () => {
  it("writes a loadable default config and state dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    expect(existsSync(join(dir, ".assemble"))).toBe(true);
    const cfg = loadConfig(dir); // must validate against our own schema
    expect(cfg.stages.length).toBeGreaterThanOrEqual(2);
    expect(cfg.agents.thor.role).toBe("implementer");
  });
  it("refuses to overwrite an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    expect(() => initProject(dir)).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/pipeline.test.ts tests/init.test.ts`
Expected: FAIL — cannot resolve `../src/pipeline.js` / `../src/init.js`.

- [ ] **Step 3: Implementation**

`src/pipeline.ts`:
```ts
import type { AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus } from "./ledger.js";
import { runStage, type RunStageOpts } from "./engine.js";

export async function runPipeline(dir: string, config: AssembleConfig, opts: RunStageOpts = {}): Promise<{ ran: string[]; stoppedAt: string | null }> {
  const ran: string[] = [];
  for (const stage of config.stages) {
    if (deriveStageStatus(readLedger(dir), stage) === "approved") continue;
    await runStage(dir, config, stage.id, opts);
    ran.push(stage.id);
    const status = deriveStageStatus(readLedger(dir), stage);
    if (status !== "approved") return { ran, stoppedAt: stage.id };
  }
  return { ran, stoppedAt: null };
}
```

`src/init.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.js";

export const DEFAULT_CONFIG = `# assemble — Avengers, assemble your AI dev team (default MCU theme; names are a swappable skin)
project: MyApp
agents:
  thor:   { role: implementer,   provider: claude, model: opus }
  vision: { role: code reviewer, provider: codex,  model: gpt-5-codex }
stages:
  - { id: implement,   agent: thor,   gate: auto,  prompt: "Implement the approved plan. Follow existing project conventions." }
  - { id: code-review, agent: vision, gate: human, prompt: "Review the latest diff. End with exactly one verdict: APPROVED, REQUEST_CHANGES, or BLOCKED." }
`;

export function initProject(dir: string): { created: string[] } {
  const cfgPath = join(dir, "assemble.config.yaml");
  if (existsSync(cfgPath)) throw new ConfigError(`assemble.config.yaml already exists in ${dir}`);
  writeFileSync(cfgPath, DEFAULT_CONFIG);
  mkdirSync(join(dir, ".assemble"), { recursive: true });
  return { created: ["assemble.config.yaml", ".assemble/"] };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pipeline.test.ts tests/init.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts src/init.ts tests/pipeline.test.ts tests/init.test.ts
git commit -m "feat: serial pipeline with ledger resume; assemble init scaffold"
```

---

### Task 10: CLI Wiring + Dynamic Stage Commands

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `buildProgram(dir: string, io?: { out: (s: string) => void }): Command` (commander) — exported for tests; `src/cli.ts` ends with a `main()` that runs it against `process.cwd()` when executed directly.
  - Built-in commands: `init`, `status`, `run`, `gate approve <stage>` / `gate reject <stage> --notes <text>`, `stage run <id>` (explicit long-form).
  - Dynamic commands: if a loadable config exists in `dir`, each `stage.id` is registered as a top-level command running that stage (`assemble implement`, `assemble code-review`, custom stages included). No config → only built-ins (so `assemble init` works anywhere).
  - `status` prints one line per stage: `<icon> <stage-id>  <name (role)>  <status>` with icons `✔ approved`, `⏸ awaiting_gate`, `✖ failed/needs_rework`, `▶ running`, `· pending`.

- [ ] **Step 1: Write failing tests**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { appendEvent } from "../src/ledger.js";

const YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: claude, model: opus }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
  - { id: verify-fix, agent: thor, gate: auto, prompt: "Verify." }
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  return dir;
}
const capture = () => { const lines: string[] = []; return { lines, io: { out: (s: string) => lines.push(s) } }; };

describe("buildProgram", () => {
  it("registers built-ins plus one top-level command per stage id", () => {
    const names = buildProgram(project()).commands.map(c => c.name());
    for (const n of ["init", "status", "run", "gate", "stage", "implement", "verify-fix"]) expect(names).toContain(n);
  });
  it("offers only built-ins when no config exists", () => {
    const names = buildProgram(mkdtempSync(join(tmpdir(), "asm-"))).commands.map(c => c.name());
    expect(names).toContain("init");
    expect(names).not.toContain("implement");
  });
  it("status renders Name (role) and derived statuses", async () => {
    const dir = project();
    appendEvent(dir, { type: "stage_completed", stage: "implement", agent: "thor" });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "status"]);
    const out = lines.join("\n");
    expect(out).toContain("thor (implementer)");
    expect(out).toMatch(/implement.*awaiting_gate/);
    expect(out).toMatch(/verify-fix.*pending/);
  });
  it("gate approve flips the stage to approved", async () => {
    const dir = project();
    appendEvent(dir, { type: "stage_completed", stage: "implement", agent: "thor" });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "gate", "approve", "implement"]);
    expect(lines.join("\n")).toMatch(/implement.*approved/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implementation**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError, type AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus } from "./ledger.js";
import { renderAgent } from "./theme.js";
import { runStage } from "./engine.js";
import { runPipeline } from "./pipeline.js";
import { approveGate, rejectGate } from "./gate.js";
import { initProject } from "./init.js";
import type { StageStatus } from "./protocol.js";

const ICONS: Record<StageStatus, string> = {
  approved: "✔", awaiting_gate: "⏸", failed: "✖", needs_rework: "✖", running: "▶", pending: "·",
};

export function buildProgram(dir: string, io: { out: (s: string) => void } = { out: console.log }): Command {
  const program = new Command("assemble").description("Avengers, assemble your AI dev team");
  let config: AssembleConfig | null = null;
  try { config = loadConfig(dir); } catch { /* no config yet — built-ins only */ }

  const printStatus = (cfg: AssembleConfig) => {
    const events = readLedger(dir);
    for (const s of cfg.stages) {
      const st = deriveStageStatus(events, s);
      io.out(`${ICONS[st]} ${s.id.padEnd(14)} ${renderAgent(s.agent, cfg).padEnd(28)} ${st}`);
    }
  };
  const requireConfig = (): AssembleConfig => {
    if (!config) throw new ConfigError(`no assemble.config.yaml in ${dir} — run \`assemble init\` first`);
    return config;
  };

  program.command("init").description("scaffold assemble.config.yaml (default MCU theme)").action(() => {
    const r = initProject(dir);
    io.out(`created ${r.created.join(", ")} — edit assemble.config.yaml, then: assemble run`);
  });

  program.command("status").description("pipeline status — who's working").action(() => printStatus(requireConfig()));

  program.command("run").description("run the full pipeline serially").action(async () => {
    const cfg = requireConfig();
    const r = await runPipeline(dir, cfg, { log: io.out });
    if (r.stoppedAt) io.out(`stopped at '${r.stoppedAt}' — resolve with: assemble gate approve ${r.stoppedAt}`);
    printStatus(cfg);
  });

  const gate = program.command("gate").description("human (World Security Council) gate decisions");
  gate.command("approve <stage>").action((stage: string) => {
    const cfg = requireConfig();
    approveGate(dir, cfg, stage);
    printStatus(cfg);
  });
  gate.command("reject <stage>").requiredOption("--notes <text>").action((stage: string, opts: { notes: string }) => {
    const cfg = requireConfig();
    rejectGate(dir, cfg, stage, opts.notes);
    printStatus(cfg);
  });

  const stageRunner = (id: string) => async () => {
    const cfg = requireConfig();
    await runStage(dir, cfg, id, { log: io.out });
    printStatus(cfg);
  };
  program.command("stage").description("explicit long-form stage invocation")
    .command("run <id>").action((id: string) => stageRunner(id)());
  for (const s of config?.stages ?? [])
    program.command(s.id).description(`run stage '${s.id}' — ${renderAgent(s.agent, config!)}`).action(stageRunner(s.id));

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildProgram(process.cwd()).parseAsync(process.argv).catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run full suite + build**

Run: `npm test && npm run build`
Expected: all tests PASS (Tasks 1–10; 35+ tests), tsc exits 0, `dist/cli.js` exists.

- [ ] **Step 5: Smoke the real binary end-to-end**

```bash
cd "$(mktemp -d)" && node /Users/basant/workspace/assemble/dist/cli.js init && node /Users/basant/workspace/assemble/dist/cli.js status
```
Expected: `created assemble.config.yaml, .assemble/ …` then two `·  pending` stage lines showing `thor (implementer)` and `vision (code reviewer)`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: assemble CLI with dynamic top-level stage commands"
```

---

## Out of Scope (follow-up plans)

- **M2:** review loops with verdict parse-retry (`parseVerdict` retry protocol), `REQUEST_CHANGES` rework cycles, parallel batch implement (shuri (batch implementer)), batch-manifest schema + `assemble plan validate`.
- **M3:** budget caps (warn/pause), jarvis (memory) compaction, rolling digests for resume-less providers, `assemble report` / `models list` / `config show` / `clean` / `adhoc`, gemini + opencode adapters.
- **M4:** interactive TUI status, theme packs (swappable rosters), `--headless`, npm publish pipeline.

## Self-Review Notes

- Spec coverage (M1 scope: "codex adapters, serial implement, ledger, init/status/stage run/gate"): config+reserved words → T3; Name (role) → T4/T10; ledger source-of-truth → T5; claude+codex adapters → T6; gate hard-fail → T7; human gates → T8; serial run + resume-by-ledger → T9; dynamic stage commands + long-form → T10. Verdict constants land in T2 (M1 only parses; retry loops are M2 as spec milestones dictate).
- Type check: `StageDef.modelOverride` (T3) consumed in T7; `RunStageOpts` (T7) reused by T9/T10; `GateError` defined once in T7, imported by T8; all imports use `.js` NodeNext suffixes.
- No placeholders: every step has complete code/commands.
