import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLedger, deriveStageStatus, reviewRoundCount, lastReviewSession, type LedgerEvent } from "../src/ledger.js";
import type { StageDef } from "../src/config.js";

const human: StageDef = { id: "ship", agent: "vision", gate: "human", prompt: "x" };
const auto: StageDef = { id: "implement", agent: "thor", gate: "auto", prompt: "x" };
// Agent-review stages: emit a verdict that must clear before any human gate.
const review: StageDef = { id: "code-review", agent: "vision", gate: "human", prompt: "x", maxRounds: 3 };
const reviewAuto: StageDef = { id: "design-review", agent: "vision", gate: "auto", prompt: "x", maxRounds: 2 };
const ev = (type: LedgerEvent["type"], stage: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ ts: "2026-07-20T00:00:00Z", type, stage, ...extra });

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
    expect(deriveStageStatus([ev("stage_completed", "ship")], human)).toBe("awaiting_gate");
  });
  it("gate_approved / gate_rejected resolve the gate", () => {
    expect(deriveStageStatus([ev("stage_completed", "ship"), ev("gate_approved", "ship")], human)).toBe("approved");
    expect(deriveStageStatus([ev("stage_completed", "ship"), ev("gate_rejected", "ship")], human)).toBe("needs_rework");
  });
  it("ignores other stages' events", () => {
    expect(deriveStageStatus([ev("stage_started", "implement")], human)).toBe("pending");
  });
});

describe("deriveStageStatus — agent-review stages (two-phase gate)", () => {
  it("completion parks a review stage at awaiting_review, not the gate", () => {
    expect(deriveStageStatus([ev("stage_completed", "code-review")], review)).toBe("awaiting_review");
  });
  it("an APPROVED verdict clears the machine gate but still defers to the human gate", () => {
    expect(
      deriveStageStatus(
        [ev("stage_completed", "code-review"), ev("review_verdict", "code-review", { verdict: "APPROVED" })],
        review,
      ),
    ).toBe("awaiting_gate");
  });
  it("an APPROVED verdict approves outright when the review stage has no human gate", () => {
    expect(
      deriveStageStatus(
        [ev("stage_completed", "design-review"), ev("review_verdict", "design-review", { verdict: "APPROVED" })],
        reviewAuto,
      ),
    ).toBe("approved");
  });
  it("a non-APPROVED verdict sends the stage back for rework", () => {
    expect(
      deriveStageStatus(
        [ev("stage_completed", "code-review"), ev("review_verdict", "code-review", { verdict: "REQUEST_CHANGES" })],
        review,
      ),
    ).toBe("needs_rework");
  });
  it("escalates to a human gate once the round budget is spent without an APPROVED", () => {
    const events = [ev("stage_completed", "code-review")];
    for (let i = 0; i < review.maxRounds!; i++) {
      events.push(ev("review_verdict", "code-review", { verdict: "REQUEST_CHANGES" }));
    }
    expect(deriveStageStatus(events, review)).toBe("awaiting_gate");
  });
  it("a later APPROVED still wins after earlier rework rounds", () => {
    expect(
      deriveStageStatus(
        [
          ev("stage_completed", "code-review"),
          ev("review_verdict", "code-review", { verdict: "REQUEST_CHANGES" }),
          ev("review_verdict", "code-review", { verdict: "APPROVED" }),
        ],
        review,
      ),
    ).toBe("awaiting_gate");
  });
});

describe("reviewRoundCount / lastReviewSession", () => {
  it("counts only review_verdict events for the stage", () => {
    const events = [
      ev("stage_completed", "code-review"),
      ev("review_verdict", "code-review", { verdict: "REQUEST_CHANGES" }),
      ev("review_verdict", "design-review", { verdict: "APPROVED" }),
      ev("review_verdict", "code-review", { verdict: "APPROVED" }),
    ];
    expect(reviewRoundCount(events, "code-review")).toBe(2);
  });
  it("returns the most recent reviewer session id, or undefined when none", () => {
    expect(lastReviewSession([ev("stage_completed", "code-review")], "code-review")).toBeUndefined();
    const events = [
      ev("review_verdict", "code-review", { verdict: "REQUEST_CHANGES", sessionId: "sess-1" }),
      ev("review_verdict", "code-review", { verdict: "APPROVED", sessionId: "sess-2" }),
    ];
    expect(lastReviewSession(events, "code-review")).toBe("sess-2");
  });
});
