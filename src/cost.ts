import type { AssembleConfig } from "./config.js";
import type { LedgerEvent } from "./ledger.js";

export function computeCost(config: AssembleConfig, model: string, tokensIn: number, tokensOut: number): number {
  const rate = config.pricing[model];
  if (!rate) return 0;
  return tokensIn * rate.input + tokensOut * rate.output;
}

export type CostSummary = {
  byWorker: Record<string, number>;
  byStage: Record<string, number>;
  total: number;
};

export function aggregateCost(events: LedgerEvent[]): CostSummary {
  const byWorker: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  let total = 0;
  for (const e of events) {
    if (e.type !== "cost") continue;
    const usd = e.costUsd ?? 0;
    const worker = e.worker ?? e.agent ?? "unknown";
    byWorker[worker] = (byWorker[worker] ?? 0) + usd;
    byStage[e.stage] = (byStage[e.stage] ?? 0) + usd;
    total += usd;
  }
  return { byWorker, byStage, total };
}
