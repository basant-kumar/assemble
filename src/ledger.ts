import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageStatus } from "./protocol.js";
import type { StageDef } from "./config.js";

export type LedgerEvent = {
  ts: string;
  type: "stage_started" | "stage_completed" | "stage_failed" | "review_verdict" | "gate_approved" | "gate_rejected" | "stage_skipped" | "cost" | "budget_abort" | "memory_synced";
  stage: string;
  agent?: string;
  worker?: string;
  model?: string;
  verdict?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  approvedBy?: string;
  notes?: string;
  /** For `review_verdict`: reviewer session/thread id, for resumable re-review. */
  sessionId?: string;
  /** For `memory_synced`: HEAD sha the sync was taken against (base for next diff). */
  sha?: string;
};

// A stage is an "agent-review" stage when it emits a verdict that must reach
// APPROVED before its gate is offered. Explicit `review:` wins; otherwise any
// stage whose id mentions "review" is one by convention.
export function isReviewStage(stage: StageDef): boolean {
  return stage.review ?? /review/.test(stage.id);
}

const ledgerPath = (dir: string) => join(dir, ".assemble", "ledger.ndjson");

export function appendEvent(dir: string, e: Omit<LedgerEvent, "ts">): LedgerEvent {
  mkdirSync(join(dir, ".assemble"), { recursive: true });
  const event: LedgerEvent = { ts: new Date().toISOString(), ...e };
  appendFileSync(ledgerPath(dir), JSON.stringify(event) + "\n");
  return event;
}

export function readLedger(dir: string): LedgerEvent[] {
  try {
    return readFileSync(ledgerPath(dir), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

export function deriveStageStatus(events: LedgerEvent[], stage: StageDef): StageStatus {
  // A statically disabled stage is always skipped; it never runs and never
  // blocks a downstream gate.
  if (stage.enabled === false) return "skipped";
  const review = isReviewStage(stage);
  // When a stage completes, decide its next status. For an agent-review stage
  // completion only means "verdict pending" (awaiting_review) — a machine gate
  // that must clear before the human gate (if any) is offered. For an ordinary
  // stage, a human gate parks it at awaiting_gate; otherwise it is approved.
  const afterCompletion: StageStatus = review
    ? "awaiting_review"
    : stage.gate === "human" ? "awaiting_gate" : "approved";
  // A verdict that clears the machine gate: APPROVED still defers to the human
  // gate when the stage declares one; otherwise it is approved outright.
  const afterApproved: StageStatus = stage.gate === "human" ? "awaiting_gate" : "approved";

  let status: StageStatus = "pending";
  let reviewRounds = 0;
  for (const e of events) {
    if (e.stage !== stage.id) continue;
    switch (e.type) {
      case "stage_started": status = "running"; break;
      case "stage_completed": status = afterCompletion; break;
      case "stage_failed": status = "failed"; break;
      case "review_verdict":
        reviewRounds++;
        if (e.verdict === "APPROVED") status = afterApproved;
        // Bounded convergence: once the round budget is spent without an
        // APPROVED verdict, escalate to a human gate instead of looping.
        else if (reviewRounds >= stage.maxRounds) status = "awaiting_gate";
        else status = "needs_rework";
        break;
      case "gate_approved": status = "approved"; break;
      case "gate_rejected": status = "needs_rework"; break;
      case "stage_skipped": status = "skipped"; break;
    }
  }
  return status;
}

// Count of review verdicts recorded for a stage so far (the round number).
export function reviewRoundCount(events: LedgerEvent[], stageId: string): number {
  return events.filter(e => e.stage === stageId && e.type === "review_verdict").length;
}

// The most recent reviewer session id recorded for a stage, if any — used to
// resume the reviewer's thread for incremental re-review.
export function lastReviewSession(events: LedgerEvent[], stageId: string): string | undefined {
  let sid: string | undefined;
  for (const e of events) {
    if (e.stage === stageId && e.type === "review_verdict" && e.sessionId) sid = e.sessionId;
  }
  return sid;
}

// The reviewer's concerns from the most recent rework bounce, so a re-run
// author can address them. Reads the notes of the latest `gate_rejected` event
// for a stage — the reviewer's verdict output, routed here via `reworkTarget`.
export function lastReworkNotes(events: LedgerEvent[], stageId: string): string | undefined {
  let notes: string | undefined;
  for (const e of events) {
    if (e.stage === stageId && e.type === "gate_rejected") notes = e.notes;
  }
  return notes;
}

// The most recent session id a stage's own run recorded, if any — used to
// resume the author's thread so a rework re-run keeps its prior context
// instead of starting cold.
export function lastStageSession(events: LedgerEvent[], stageId: string): string | undefined {
  let sid: string | undefined;
  for (const e of events) {
    if (e.stage === stageId && e.type === "stage_completed" && e.sessionId) sid = e.sessionId;
  }
  return sid;
}

// A stage counts as "satisfied" for the purpose of unblocking a later stage
// when it is either approved or skipped — both mean "no outstanding work here".
export function isStageSatisfied(status: StageStatus): boolean {
  return status === "approved" || status === "skipped";
}
