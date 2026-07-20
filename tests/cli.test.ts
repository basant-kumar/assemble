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

const YAML_BUDGET = `
project: MyApp
agents:
  thor: { role: implementer, provider: claude, model: opus }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
pricing:
  opus: { input: 0.0001, output: 0.0001 }
budget:
  policy: warn
  total: 1.0
  perStage:
    implement: 0.5
  perWorker:
    thor: 0.5
`;

function budgetProject() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML_BUDGET);
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
  it("cost aggregates ledgered cost events by worker, stage, and total", async () => {
    const dir = project();
    appendEvent(dir, { type: "cost", stage: "implement", worker: "thor", model: "opus", tokensIn: 100, tokensOut: 50, costUsd: 0.01 });
    appendEvent(dir, { type: "cost", stage: "implement", worker: "utility", model: "haiku", tokensIn: 20, tokensOut: 10, costUsd: 0.0005 });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "cost"]);
    const out = lines.join("\n");
    expect(out).toMatch(/thor.*\$0\.0100/);
    expect(out).toMatch(/utility.*\$0\.0005/);
    expect(out).toMatch(/total.*\$0\.0105/);
  });
  it("run --auto-commit requires utilityModel to be configured first", async () => {
    const dir = project();
    const { io } = capture();
    await expect(buildProgram(dir, io).parseAsync(["node", "assemble", "run", "--auto-commit"]))
      .rejects.toThrow(/utilityModel/);
  });

  it("budget prints per-scope spend, cap, and remaining headroom", async () => {
    const dir = budgetProject();
    appendEvent(dir, { type: "cost", stage: "implement", worker: "thor", model: "opus", tokensIn: 0, tokensOut: 0, costUsd: 0.2 });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "budget"]);
    const out = lines.join("\n");
    // spent 0.2000, cap, remaining
    expect(out).toMatch(/total.*0\.2000.*1\.0000.*0\.8000/);
    expect(out).toMatch(/stage:implement.*0\.2000.*0\.5000.*0\.3000/);
    expect(out).toMatch(/worker:thor.*0\.2000.*0\.5000.*0\.3000/);
  });

  it("budget shows negative remaining when a cap is exceeded", async () => {
    const dir = budgetProject();
    appendEvent(dir, { type: "cost", stage: "implement", worker: "thor", model: "opus", tokensIn: 0, tokensOut: 0, costUsd: 0.7 });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "budget"]);
    const out = lines.join("\n");
    expect(out).toMatch(/stage:implement.*0\.7000.*0\.5000.*-0\.2000/);
  });

  it("budget degrades gracefully when no budget is configured", async () => {
    const dir = project();
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "budget"]);
    expect(lines.join("\n")).toMatch(/no budget configured/i);
  });

  it("cost appends a remaining column against the total budget when configured", async () => {
    const dir = budgetProject();
    appendEvent(dir, { type: "cost", stage: "implement", worker: "thor", model: "opus", tokensIn: 0, tokensOut: 0, costUsd: 0.2 });
    const { lines, io } = capture();
    await buildProgram(dir, io).parseAsync(["node", "assemble", "cost"]);
    const out = lines.join("\n");
    expect(out).toMatch(/total.*\$0\.2000.*0\.8000/);
  });
});
