import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus } from "./ledger.js";
import { GateError } from "./engine.js";

function requireAwaiting(dir: string, config: AssembleConfig, stageId: string) {
  const stage = config.stages.find(s => s.id === stageId);
  if (!stage) throw new GateError(`unknown stage '${stageId}'`);
  const status = deriveStageStatus(readLedger(dir), stage);
  if (status !== "awaiting_gate")
    throw new GateError(`stage '${stageId}' is ${status}, not awaiting_gate — nothing to decide`);
}

export function approveGate(dir: string, config: AssembleConfig, stageId: string, by = "council"): void {
  requireAwaiting(dir, config, stageId);
  appendEvent(dir, { type: "gate_approved", stage: stageId, approvedBy: by });
}

export function rejectGate(dir: string, config: AssembleConfig, stageId: string, notes: string, by = "council"): void {
  requireAwaiting(dir, config, stageId);
  appendEvent(dir, { type: "gate_rejected", stage: stageId, approvedBy: by, notes });
}
