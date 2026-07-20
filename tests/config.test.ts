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
