import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";
import { appendEvent, readLedger } from "../src/ledger.js";
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

// Budget enforcement (M3). Pricing makes the fake adapter's 1+1 tokens cost $2/stage.
const PRICED = YAML + `pricing:\n  opus: { input: 1, output: 1 }\n  gpt-5-codex: { input: 1, output: 1 }\n`;
function pricedProject(budgetYaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), PRICED + budgetYaml);
  return { dir, config: loadConfig(dir) };
}

describe("runPipeline budget enforcement", () => {
  it("under-cap budget does not change behavior (regression guard)", async () => {
    const { dir, config } = pricedProject(`budget:\n  policy: block\n  total: 100\n`);
    const r = await runPipeline(dir, config, { adapters: { fake: ok } });
    expect(r.ran).toEqual(["implement", "code-review"]);
    expect(r.stoppedAt).toBe("code-review");
  });

  it("block policy aborts before the next stage and records a budget_abort event", async () => {
    const { dir, config } = pricedProject(`budget:\n  policy: block\n  total: 1\n`);
    await expect(runPipeline(dir, config, { adapters: { fake: ok } })).rejects.toThrow(/budget/i);
    const events = readLedger(dir);
    expect(events.some(e => e.type === "budget_abort")).toBe(true);
    expect(events.some(e => e.type === "stage_started" && e.stage === "code-review")).toBe(false);
  });

  it("warn policy logs but completes the run", async () => {
    const { dir, config } = pricedProject(`budget:\n  policy: warn\n  total: 1\n`);
    const lines: string[] = [];
    const r = await runPipeline(dir, config, { adapters: { fake: ok }, log: l => lines.push(l) });
    expect(r.ran).toEqual(["implement", "code-review"]);
    expect(lines.some(l => /budget/i.test(l))).toBe(true);
  });

  it("pause policy stops the run when there is no approver", async () => {
    const { dir, config } = pricedProject(`budget:\n  policy: pause\n  total: 1\n`);
    const r = await runPipeline(dir, config, { adapters: { fake: ok } });
    expect(r.stoppedAt).toBe("implement");
    expect(r.ran).toEqual(["implement"]);
  });

  it("pause policy continues when the approver allows it", async () => {
    const { dir, config } = pricedProject(`budget:\n  policy: pause\n  total: 1\n`);
    const r = await runPipeline(dir, config, { adapters: { fake: ok }, approveBudget: () => true });
    expect(r.ran).toEqual(["implement", "code-review"]);
    expect(r.stoppedAt).toBe("code-review");
  });
});
