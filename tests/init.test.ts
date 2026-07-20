import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, ARCHI_PATH, SKILL_PATH } from "../src/init.js";
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
  it("scaffolds an example pricing table for the default agents' models", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    const cfg = loadConfig(dir);
    expect(cfg.pricing["claude-opus-4-8"]).toBeDefined();
    expect(cfg.pricing["gpt-5-codex"]).toBeDefined();
  });
  it("leaves memory opt-in: disabled by default and does not seed ARCHI.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const r = initProject(dir);
    // Memory is opt-in (best for single-source-of-truth projects), so init
    // must not create ARCHI.md nor report it as created.
    expect(loadConfig(dir).memory.enabled).toBe(false);
    expect(existsSync(join(dir, ARCHI_PATH))).toBe(false);
    expect(r.created).not.toContain(ARCHI_PATH);
  });
  it("defaults the memory path to docs/assemble/ARCHI.md and exposes it in config", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    expect(ARCHI_PATH).toBe("docs/assemble/ARCHI.md");
    expect(loadConfig(dir).memory.path).toBe("docs/assemble/ARCHI.md");
  });
  it("installs the assemble skill at the repo level (not globally) and reports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const r = initProject(dir);
    expect(SKILL_PATH).toBe(".claude/skills/assemble");
    expect(existsSync(join(dir, SKILL_PATH, "SKILL.md"))).toBe(true);
    expect(r.created).toContain(SKILL_PATH + "/");
  });
});
