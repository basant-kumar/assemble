import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveGate, rejectGate } from "../src/gate.js";
import { GateError } from "../src/engine.js";
import { loadConfig } from "../src/config.js";
import { appendEvent, readLedger } from "../src/ledger.js";

const YAML = `
project: MyApp
agents:
  vision: { role: code reviewer, provider: claude, model: opus }
stages:
  - { id: code-review, agent: vision, gate: human, prompt: "Review." }
`;

// code-review is an agent-review stage: it must clear its machine gate (an
// APPROVED verdict) before the human gate is offered. Drive it to awaiting_gate.
function awaiting() {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  writeFileSync(join(dir, "assemble.config.yaml"), YAML);
  const config = loadConfig(dir);
  appendEvent(dir, { type: "stage_completed", stage: "code-review", agent: "vision" });
  appendEvent(dir, { type: "review_verdict", stage: "code-review", agent: "vision", verdict: "APPROVED" });
  return { dir, config };
}

describe("gates", () => {
  it("approve appends gate_approved with approvedBy", () => {
    const { dir, config } = awaiting();
    approveGate(dir, config, "code-review");
    const last = readLedger(dir).at(-1)!;
    expect(last.type).toBe("gate_approved");
    expect(last.approvedBy).toBe("council");
  });
  it("reject appends gate_rejected with notes", () => {
    const { dir, config } = awaiting();
    rejectGate(dir, config, "code-review", "tests missing", "basant");
    const last = readLedger(dir).at(-1)!;
    expect(last.type).toBe("gate_rejected");
    expect(last.notes).toBe("tests missing");
    expect(last.approvedBy).toBe("basant");
  });
  it("throws GateError when the stage is not awaiting_gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    writeFileSync(join(dir, "assemble.config.yaml"), YAML);
    const config = loadConfig(dir);
    expect(() => approveGate(dir, config, "code-review")).toThrow(GateError);
  });
});
