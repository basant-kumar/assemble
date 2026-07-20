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
  it("mode: solo collapses every stage onto one claude/fable-5 agent", () => {
    const cfg = loadConfig(writeCfg(VALID.replace("project: MyApp", "project: MyApp\nmode: solo")));
    expect(cfg.stages.every(s => s.agent === "solo")).toBe(true);
    expect(cfg.agents.solo).toMatchObject({ provider: "claude", model: "fable-5" });
    expect(cfg.pricing["fable-5"]).toEqual({ input: 10 / 1_000_000, output: 50 / 1_000_000 });
  });
  it("mode: duo wires writer for build stages and reviewer for review stages", () => {
    const cfg = loadConfig(writeCfg(VALID.replace("project: MyApp", "project: MyApp\nmode: duo")));
    expect(cfg.stages.find(s => s.id === "implement")!.agent).toBe("writer");
    expect(cfg.stages.find(s => s.id === "code-review")!.agent).toBe("reviewer");
    expect(cfg.agents.writer).toMatchObject({ provider: "claude", model: "fable-5" });
    expect(cfg.agents.reviewer).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(cfg.pricing["gpt-5.6-sol"]).toEqual({ input: 5 / 1_000_000, output: 30 / 1_000_000 });
  });
  it("a file agent overrides the preset profile of the same name (duo reviewer bump)", () => {
    const bumped = VALID.replace("project: MyApp", "project: MyApp\nmode: duo")
      .replace("  vision:", "  reviewer: { role: code reviewer, provider: codex, model: gpt-5.6-terra }\n  vision:");
    const cfg = loadConfig(writeCfg(bumped));
    expect(cfg.agents.reviewer.model).toBe("gpt-5.6-terra"); // file wins over preset
    expect(cfg.stages.find(s => s.id === "code-review")!.agent).toBe("reviewer");
  });
  it("mode: full leaves the roster and stage wiring untouched", () => {
    const cfg = loadConfig(writeCfg(VALID.replace("project: MyApp", "project: MyApp\nmode: full")));
    expect(cfg.stages.find(s => s.id === "implement")!.agent).toBe("thor");
    expect(cfg.stages.find(s => s.id === "code-review")!.agent).toBe("vision");
    expect(cfg.agents.solo).toBeUndefined();
  });
  it("a bare mode config needs no agents block of its own", () => {
    const bare = `
project: Bare
mode: duo
stages:
  - { id: implement, agent: x, gate: auto, prompt: "Build it." }
  - { id: code-review, agent: y, gate: human, prompt: "Review it." }
`;
    const cfg = loadConfig(writeCfg(bare));
    expect(cfg.stages.find(s => s.id === "implement")!.agent).toBe("writer");
    expect(cfg.stages.find(s => s.id === "code-review")!.agent).toBe("reviewer");
  });
  it("applies ASSEMBLE_STAGE_<id>_MODEL override per stage", () => {
    const cfg = loadConfig(writeCfg(VALID), { "ASSEMBLE_STAGE_code-review_MODEL": "gemini-flash" });
    const stage = cfg.stages.find(s => s.id === "code-review")!;
    expect(cfg.agents[stage.agent].model).toBe("gpt-5-codex"); // base agent untouched
    expect((stage as any).modelOverride).toBe("gemini-flash");
  });
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
  it("utilityModel is undefined by default", () => {
    const cfg = loadConfig(writeCfg(VALID));
    expect(cfg.utilityModel).toBeUndefined();
  });
  it("parses a configured utilityModel", () => {
    const withUtility = VALID + `utilityModel: haiku\n`;
    const cfg = loadConfig(writeCfg(withUtility));
    expect(cfg.utilityModel).toBe("haiku");
  });
  it("budget is undefined by default", () => {
    const cfg = loadConfig(writeCfg(VALID));
    expect(cfg.budget).toBeUndefined();
  });
  it("parses a budget block with policy and caps", () => {
    const withBudget = VALID +
      `budget:\n  policy: block\n  total: 5\n  perStage: { implement: 2 }\n  perWorker: { thor: 1.5 }\n`;
    const cfg = loadConfig(writeCfg(withBudget));
    expect(cfg.budget).toEqual({
      policy: "block",
      total: 5,
      perStage: { implement: 2 },
      perWorker: { thor: 1.5 },
    });
  });
  it("defaults budget policy to warn when omitted", () => {
    const withBudget = VALID + `budget:\n  total: 3\n`;
    const cfg = loadConfig(writeCfg(withBudget));
    expect(cfg.budget?.policy).toBe("warn");
  });
  it("rejects a negative budget cap", () => {
    const bad = VALID + `budget:\n  total: -1\n`;
    expect(() => loadConfig(writeCfg(bad))).toThrow(ConfigError);
  });
  it("rejects an invalid budget policy", () => {
    const bad = VALID + `budget:\n  policy: explode\n  total: 1\n`;
    expect(() => loadConfig(writeCfg(bad))).toThrow(ConfigError);
  });
});
