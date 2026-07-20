import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, ARCHI_PATH, SKILL_PATH, AGENTS_PATH, mergeAgentsMd } from "../src/init.js";
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
  it("drops a codex AGENTS.md referencing the assemble skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const r = initProject(dir);
    expect(AGENTS_PATH).toBe("AGENTS.md");
    const agents = readFileSync(join(dir, AGENTS_PATH), "utf8");
    expect(agents).toContain(".claude/skills/assemble/SKILL.md");
    expect(agents).toContain("<!-- assemble:start -->");
    expect(r.created).toContain(AGENTS_PATH);
  });
});

describe("mergeAgentsMd", () => {
  const block = "<!-- assemble:start -->\nBODY\n<!-- assemble:end -->";
  it("creates the block when no AGENTS.md exists", () => {
    expect(mergeAgentsMd(null, block)).toBe(block + "\n");
  });
  it("preserves user content and appends when no assemble block present", () => {
    const merged = mergeAgentsMd("# My project rules\n", block);
    expect(merged).toContain("# My project rules");
    expect(merged).toContain(block);
    expect(merged.indexOf("My project rules")).toBeLessThan(merged.indexOf("assemble:start"));
  });
  it("refreshes a stale block in place without duplicating or clobbering", () => {
    const stale = "top\n\n<!-- assemble:start -->\nOLD\n<!-- assemble:end -->\n\nbottom\n";
    const merged = mergeAgentsMd(stale, block);
    expect(merged).toContain("top");
    expect(merged).toContain("bottom");
    expect(merged).toContain("BODY");
    expect(merged).not.toContain("OLD");
    expect(merged.match(/assemble:start/g)?.length).toBe(1);
  });
  it("is idempotent across repeated init runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    const first = readFileSync(join(dir, AGENTS_PATH), "utf8");
    // Simulate a re-init by merging the same block again over existing content.
    const second = mergeAgentsMd(first, first.trim());
    expect(second.match(/assemble:start/g)?.length).toBe(1);
  });
  it("keeps user content added around the block on re-merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    initProject(dir);
    const agentsFile = join(dir, AGENTS_PATH);
    const withUser = "# House rules\n\n" + readFileSync(agentsFile, "utf8");
    writeFileSync(agentsFile, withUser);
    const remerged = mergeAgentsMd(readFileSync(agentsFile, "utf8"), block);
    expect(remerged).toContain("# House rules");
    expect(remerged.match(/assemble:start/g)?.length).toBe(1);
  });
});
