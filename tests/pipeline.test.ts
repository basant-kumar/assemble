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
// Emits an APPROVED verdict so a review stage clears its machine gate on the
// first pass; the run then stops at the human gate rather than looping rework.
const ok: Adapter = { name: "fake", async run() { return { output: "APPROVED", tokensIn: 1, tokensOut: 1 }; } };

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

// The automatic planner↔reviewer loop: a REQUEST_CHANGES verdict bounces the
// author back with the reviewer's concerns; the author re-runs (resuming its
// thread), then the reviewer re-reviews (resuming its thread) until APPROVED.
const LOOP_YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  vision: { role: code reviewer, provider: fake, model: gpt-5-codex }
stages:
  - { id: implement, agent: thor, gate: auto, prompt: "Implement." }
  - { id: code-review, agent: vision, gate: auto, reworkTarget: implement, prompt: "Review." }
`;
function loopProject() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), LOOP_YAML);
  return { dir, config: loadConfig(dir) };
}

describe("runPipeline review loop", () => {
  it("bounces the author back with concerns, then re-reviews to APPROVED", async () => {
    const { dir, config } = loopProject();
    const seen: { model: string; prompt: string; resume?: string }[] = [];
    let reviewCalls = 0;
    const adapter: Adapter = {
      name: "fake",
      async run(o) {
        seen.push({ model: o.model, prompt: o.prompt, resume: o.resumeSessionId });
        if (o.model === "gpt-5-codex") {
          reviewCalls++;
          const output = reviewCalls === 1 ? "REQUEST_CHANGES: tighten error handling" : "APPROVED";
          return { output, tokensIn: 1, tokensOut: 1, sessionId: "rev-sess" };
        }
        return { output: "done", tokensIn: 1, tokensOut: 1, sessionId: "author-sess" };
      },
    };
    const r = await runPipeline(dir, config, { adapters: { fake: adapter } });

    // Author and reviewer each ran twice; the loop converged (no human gate).
    expect(r.ran).toEqual(["implement", "code-review", "implement", "code-review"]);
    expect(r.stoppedAt).toBeNull();

    // The author's re-run carried the reviewer's concerns and resumed its thread.
    const authorRuns = seen.filter(s => s.model === "opus");
    expect(authorRuns).toHaveLength(2);
    expect(authorRuns[1].prompt).toContain("tighten error handling");
    expect(authorRuns[1].resume).toBe("author-sess");

    // The reviewer resumed its own thread for the re-review.
    const reviewRuns = seen.filter(s => s.model === "gpt-5-codex");
    expect(reviewRuns[1].resume).toBe("rev-sess");
  });

  it("escalates to a human gate after maxRounds without APPROVED", async () => {
    const { dir, config } = loopProject();
    // Reviewer never approves: the loop must not run forever — it escalates to
    // awaiting_gate once the round budget (default 3) is spent.
    const adapter: Adapter = {
      name: "fake",
      async run(o) {
        if (o.model === "gpt-5-codex") return { output: "REQUEST_CHANGES: still not right", tokensIn: 1, tokensOut: 1, sessionId: "rev" };
        return { output: "done", tokensIn: 1, tokensOut: 1, sessionId: "auth" };
      },
    };
    const r = await runPipeline(dir, config, { adapters: { fake: adapter } });
    expect(r.stoppedAt).toBe("code-review");
    // 3 review rounds (default maxRounds) + the author re-runs between them.
    expect(r.ran.filter(s => s === "code-review")).toHaveLength(3);
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
