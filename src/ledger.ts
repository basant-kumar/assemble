import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageStatus } from "./protocol.js";
import type { StageDef } from "./config.js";

export type LedgerEvent = {
  ts: string;
  type: "stage_started" | "stage_completed" | "stage_failed" | "gate_approved" | "gate_rejected" | "cost";
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
};

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
  let status: StageStatus = "pending";
  for (const e of events) {
    if (e.stage !== stage.id) continue;
    switch (e.type) {
      case "stage_started": status = "running"; break;
      case "stage_completed": status = stage.gate === "human" ? "awaiting_gate" : "approved"; break;
      case "stage_failed": status = "failed"; break;
      case "gate_approved": status = "approved"; break;
      case "gate_rejected": status = "needs_rework"; break;
    }
  }
  return status;
}
