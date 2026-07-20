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
