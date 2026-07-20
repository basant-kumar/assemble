import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLedger, deriveStageStatus, type LedgerEvent } from "../src/ledger.js";
import type { StageDef } from "../src/config.js";

const human: StageDef = { id: "code-review", agent: "vision", gate: "human", prompt: "x" };
const auto: StageDef = { id: "implement", agent: "thor", gate: "auto", prompt: "x" };
const ev = (type: LedgerEvent["type"], stage: string): LedgerEvent => ({ ts: "2026-07-20T00:00:00Z", type, stage });

describe("ledger file", () => {
  it("appends NDJSON to .assemble/ledger.ndjson and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    appendEvent(dir, { type: "stage_started", stage: "implement", agent: "thor" });
    appendEvent(dir, { type: "stage_completed", stage: "implement", tokensIn: 10, tokensOut: 5 });
    const raw = readFileSync(join(dir, ".assemble", "ledger.ndjson"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const events = readLedger(dir);
    expect(events[1].tokensOut).toBe(5);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("readLedger returns [] when no ledger exists", () => {
    expect(readLedger(mkdtempSync(join(tmpdir(), "asm-")))).toEqual([]);
  });
});

describe("deriveStageStatus", () => {
  it("pending with no events", () => {
    expect(deriveStageStatus([], auto)).toBe("pending");
  });
  it("running after stage_started", () => {
    expect(deriveStageStatus([ev("stage_started", "implement")], auto)).toBe("running");
  });
  it("auto-gate stages approve on completion", () => {
    expect(deriveStageStatus([ev("stage_started", "implement"), ev("stage_completed", "implement")], auto)).toBe("approved");
  });
  it("human-gate stages await the Council", () => {
    expect(deriveStageStatus([ev("stage_completed", "code-review")], human)).toBe("awaiting_gate");
  });
  it("gate_approved / gate_rejected resolve the gate", () => {
    expect(deriveStageStatus([ev("stage_completed", "code-review"), ev("gate_approved", "code-review")], human)).toBe("approved");
    expect(deriveStageStatus([ev("stage_completed", "code-review"), ev("gate_rejected", "code-review")], human)).toBe("needs_rework");
  });
  it("ignores other stages' events", () => {
    expect(deriveStageStatus([ev("stage_started", "implement")], human)).toBe("pending");
  });
});
