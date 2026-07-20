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
