import type { AssembleConfig } from "./config.js";
import type { LedgerEvent } from "./ledger.js";
import { aggregateCost } from "./cost.js";

export type Breach = { scope: string; cap: number; spent: number };
export type BudgetPolicy = "warn" | "pause" | "block";
export type BudgetDecision = {
  breached: boolean;
  policy: BudgetPolicy;
  breaches: Breach[];
};

/**
 * Deterministically decide whether the ledger's spend has breached any
 * configured budget cap. Pure: no I/O, no model calls. A scope breaches only
 * when spend is *strictly* over its cap.
 */
export function checkBudget(config: AssembleConfig, events: LedgerEvent[]): BudgetDecision {
  const budget = config.budget;
  if (!budget) return { breached: false, policy: "warn", breaches: [] };

  const { byWorker, byStage, total } = aggregateCost(events);
  const breaches: Breach[] = [];

  if (budget.total !== undefined && total > budget.total) {
    breaches.push({ scope: "total", cap: budget.total, spent: total });
  }
  for (const [stage, cap] of Object.entries(budget.perStage)) {
    const spent = byStage[stage] ?? 0;
    if (spent > cap) breaches.push({ scope: `stage:${stage}`, cap, spent });
  }
  for (const [worker, cap] of Object.entries(budget.perWorker)) {
    const spent = byWorker[worker] ?? 0;
    if (spent > cap) breaches.push({ scope: `worker:${worker}`, cap, spent });
  }

  return { breached: breaches.length > 0, policy: budget.policy, breaches };
}
