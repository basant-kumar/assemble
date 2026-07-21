import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, skipStage, withSkills, GateError } from "../src/engine.js";
import { runPipeline } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";
import { deriveStageStatus, readLedger } from "../src/ledger.js";
import type { Adapter } from "../src/adapters.js";

// design is `when: auto` so it can be runtime-skipped; code-review carries skills.
const YAML = `
project: MyApp
agents:
  romanoff: { role: designer, provider: fake, model: opus }
  thor: { role: implementer, provider: fake, model: opus }
  vision:
    role: code reviewer
    provider: fake
    model: gpt-5-codex
    skills: [security-audit, perf-review]
stages:
  - { id: design, agent: romanoff, gate: auto, prompt: "Design.", when: auto, flavor: ui }
  - { id: implement, agent: thor, gate: auto, prompt: "Implement." }
  - { id: code-review, agent: vision, gate: auto, prompt: "Review." }
`;

function project(overrides = "") {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), overrides || YAML);
  return { dir, config: loadConfig(dir) };
}
// Stands in for any agent, including a reviewer: its output carries an APPROVED
// verdict so an agent-review stage clears its machine gate in pipeline tests.
const capturingAdapter = (prompts: string[] = []): Adapter => ({
  name: "fake",
  async run({ prompt }) { prompts.push(prompt); return { output: "APPROVED", tokensIn: 1, tokensOut: 1 }; },
});

describe("agent skills", () => {
  it("parses skills onto the agent and defaults to an empty list", () => {
    const { config } = project();
    expect(config.agents.vision.skills).toEqual(["security-audit", "perf-review"]);
    expect(config.agents.thor.skills).toEqual([]);
  });
  it("withSkills prefixes declared skills and leaves skill-less prompts untouched", () => {
    expect(withSkills(["security-audit"], "Review.")).toBe("Active skills: security-audit.\n\nReview.");
    expect(withSkills([], "Review.")).toBe("Review.");
  });
  it("injects the agent's skills into the prompt the adapter receives", async () => {
    const { dir, config } = project();
    // skip design + implement out of the way, then run the review with skills
    skipStage(dir, config, "design");
    const prompts: string[] = [];
    await runStage(dir, config, "implement", { adapters: { fake: capturingAdapter() } });
    await runStage(dir, config, "code-review", { adapters: { fake: capturingAdapter(prompts) } });
    expect(prompts[0]).toBe("Active skills: security-audit, perf-review.\n\nReview.");
  });
});

describe("design skip", () => {
  it("statically disabled stages read as skipped and never block downstream", async () => {
    const disabled = YAML.replace("prompt: \"Design.\", when: auto, flavor: ui", "prompt: \"Design.\", enabled: false");
    const { dir, config } = project(disabled);
    expect(deriveStageStatus(readLedger(dir), config.stages[0])).toBe("skipped");
    // implement runs even though the earlier design stage never executed
    await runStage(dir, config, "implement", { adapters: { fake: capturingAdapter() } });
    expect(deriveStageStatus(readLedger(dir), config.stages[1])).toBe("approved");
  });
  it("refuses to runStage a disabled stage", async () => {
    const disabled = YAML.replace("prompt: \"Design.\", when: auto, flavor: ui", "prompt: \"Design.\", enabled: false");
    const { dir, config } = project(disabled);
    await expect(runStage(dir, config, "design", { adapters: { fake: capturingAdapter() } }))
      .rejects.toThrow(/disabled/);
  });
  it("runtime-skips a `when: auto` stage and unblocks the next one", async () => {
    const { dir, config } = project();
    skipStage(dir, config, "design", "council", "pure-logic change");
    expect(deriveStageStatus(readLedger(dir), config.stages[0])).toBe("skipped");
    const skipEvent = readLedger(dir).find(e => e.type === "stage_skipped")!;
    expect(skipEvent.approvedBy).toBe("council");
    expect(skipEvent.notes).toBe("pure-logic change");
    await runStage(dir, config, "implement", { adapters: { fake: capturingAdapter() } });
    expect(deriveStageStatus(readLedger(dir), config.stages[1])).toBe("approved");
  });
  it("refuses to skip a stage that is not `when: auto`", async () => {
    const { dir, config } = project();
    expect(() => skipStage(dir, config, "implement")).toThrow(GateError);
    expect(() => skipStage(dir, config, "implement")).toThrow(/when: auto/);
  });
  it("a pipeline run steps over a runtime-skipped stage", async () => {
    const { dir, config } = project();
    skipStage(dir, config, "design");
    const r = await runPipeline(dir, config, { adapters: { fake: capturingAdapter() } });
    expect(r.ran).toEqual(["implement", "code-review"]);
    expect(r.stoppedAt).toBeNull();
  });
});

describe("stage flavor", () => {
  it("parses an optional review-routing flavor and leaves it undefined otherwise", () => {
    const { config } = project();
    expect(config.stages[0].flavor).toBe("ui");
    expect(config.stages[1].flavor).toBeUndefined();
  });
});
