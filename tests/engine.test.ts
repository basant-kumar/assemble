import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, GateError, agentSpecialty, resolveStageAgent } from "../src/engine.js";
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
    expect(events.map(e => e.type)).toEqual(["stage_started", "stage_completed", "cost"]);
    expect(events[0].agent).toBe("thor");
    expect(events[1].tokensOut).toBe(4);
  });
  it("ledgers a cost event derived from the pricing table", async () => {
    const { dir, config } = project();
    const priced = { ...config, pricing: { opus: { input: 0.000015, output: 0.000075 } } };
    await runStage(dir, priced, "implement", { adapters: { fake: okAdapter() } });
    const costEvent = readLedger(dir).find(e => e.type === "cost")!;
    expect(costEvent.worker).toBe("thor");
    expect(costEvent.model).toBe("opus");
    expect(costEvent.costUsd).toBeCloseTo(3 * 0.000015 + 4 * 0.000075, 10);
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
});

const FLAVOR_YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  vision: { role: code reviewer, provider: fake, model: gpt-5-codex }
  shuri: { role: UI designer, provider: fake, model: sonnet }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
  - { id: review, agent: thor, gate: auto, prompt: "Review.", flavor: ui }
`;
function flavorProject(yaml = FLAVOR_YAML) {
  const dir = mkdtempSync(join(tmpdir(), "asm-flavor-"));
  writeFileSync(join(dir, "assemble.config.yaml"), yaml);
  return { dir, config: loadConfig(dir) };
}

describe("agentSpecialty", () => {
  it("classifies ui/design roles as ui", () => {
    expect(agentSpecialty("UI designer")).toBe("ui");
    expect(agentSpecialty("plan/design reviewer")).toBe("ui");
    expect(agentSpecialty("frontend reviewer")).toBe("ui");
  });
  it("classifies code/technical roles as technical", () => {
    expect(agentSpecialty("code reviewer")).toBe("technical");
    expect(agentSpecialty("technical reviewer")).toBe("technical");
    expect(agentSpecialty("security auditor")).toBe("technical");
  });
  it("returns null for neutral roles", () => {
    expect(agentSpecialty("implementer")).toBeNull();
    expect(agentSpecialty("final reviewer")).toBeNull();
    expect(agentSpecialty("architect")).toBeNull();
  });
});

describe("resolveStageAgent", () => {
  const cfg = () => loadConfigFrom(FLAVOR_YAML);
  function loadConfigFrom(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), "asm-r-"));
    writeFileSync(join(dir, "assemble.config.yaml"), yaml);
    return loadConfig(dir);
  }
  it("auto-selects the ui reviewer for a flavor:ui stage", () => {
    const config = cfg();
    const stage = config.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(config, stage)).toEqual({ name: "shuri", auto: true });
  });
  it("auto-selects the technical reviewer for a flavor:technical stage", () => {
    const config = loadConfigFrom(FLAVOR_YAML.replace("flavor: ui", "flavor: technical"));
    const stage = config.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(config, stage)).toEqual({ name: "vision", auto: true });
  });
  it("honours an author-pinned matching agent without an auto-swap", () => {
    const config = loadConfigFrom(FLAVOR_YAML.replace("agent: thor, gate: auto, prompt: \"Review.\", flavor: ui", "agent: shuri, gate: auto, prompt: \"Review.\", flavor: ui"));
    const stage = config.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(config, stage)).toEqual({ name: "shuri", auto: false });
  });
  it("leaves the configured agent when flavor is unset or 'both'", () => {
    const both = loadConfigFrom(FLAVOR_YAML.replace("flavor: ui", "flavor: both"));
    const bstage = both.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(both, bstage)).toEqual({ name: "thor", auto: false });
    const none = loadConfigFrom(FLAVOR_YAML.replace(", flavor: ui", ""));
    const nstage = none.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(none, nstage)).toEqual({ name: "thor", auto: false });
  });
  it("falls back to the configured agent when no reviewer of that flavor exists", () => {
    const config = loadConfigFrom(FLAVOR_YAML.replace(/  shuri:.*\n/, ""));
    const stage = config.stages.find(s => s.id === "review")!;
    expect(resolveStageAgent(config, stage)).toEqual({ name: "thor", auto: false });
  });
});

describe("runStage flavor routing", () => {
  it("runs the auto-selected reviewer and ledgers it as the stage agent", async () => {
    const { dir, config } = flavorProject();
    await runStage(dir, config, "implement", { adapters: { fake: okAdapter() } });
    appendEvent(dir, { type: "gate_approved", stage: "implement", approvedBy: "council" });
    const calls: string[] = [];
    await runStage(dir, config, "review", { adapters: { fake: okAdapter(calls) } });
    expect(calls).toEqual(["sonnet"]); // shuri's model, not thor's opus
    const completed = readLedger(dir).filter(e => e.type === "stage_completed" && e.stage === "review")[0];
    expect(completed.agent).toBe("shuri");
  });
});
