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
