import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { appendEvent } from "../src/ledger.js";

const YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: claude, model: opus }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
  - { id: verify-fix, agent: thor, gate: auto, prompt: "Verify." }
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  return dir;
}
const capture = () => { const lines: string[] = []; return { lines, io: { out: (s: string) => lines.push(s) } }; };

describe("buildProgram", () => {
  it("registers built-ins plus one top-level command per stage id", () => {
    const names = buildProgram(project()).commands.map(c => c.name());
    for (const n of ["init", "status", "run", "gate", "stage", "implement", "verify-fix"]) expect(names).toContain(n);
  });
  it("offers only built-ins when no config exists", () => {
    const names = buildProgram(mkdtempSync(join(tmpdir(), "asm-"))).commands.map(c => c.name());
    expect(names).toContain("init");
    expect(names).not.toContain("implement");
  });
  it("status renders Name (role) and derived statuses", async () => {
    const dir = project();
    appendEvent(dir, { type: "stage_completed", stage: "implement", agent: "thor" });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "status"]);
    const out = lines.join("\n");
    expect(out).toContain("thor (implementer)");
    expect(out).toMatch(/implement.*awaiting_gate/);
    expect(out).toMatch(/verify-fix.*pending/);
  });
  it("gate approve flips the stage to approved", async () => {
    const dir = project();
    appendEvent(dir, { type: "stage_completed", stage: "implement", agent: "thor" });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "gate", "approve", "implement"]);
    expect(lines.join("\n")).toMatch(/implement.*approved/);
  });
  it("run --auto-commit requires utilityModel to be configured first", async () => {
    const dir = project();
    const { io } = capture();
    await expect(buildProgram(dir, io).parseAsync(["node", "assemble", "run", "--auto-commit"]))
      .rejects.toThrow(/utilityModel/);
  });
});
