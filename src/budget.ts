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
 * Thrown when a "block" policy budget breach halts the pipeline. Carries the
 * offending breaches so callers can surface them and write a budget_abort
 * ledger event.
 */
export class BudgetError extends Error {
  readonly breaches: Breach[];
  constructor(breaches: Breach[]) {
    const summary = breaches
      .map((b) => `${b.scope} spent ${b.spent} > cap ${b.cap}`)
      .join("; ");
    super(`budget breached (block): ${summary}`);
    this.name = "BudgetError";
    this.breaches = breaches;
  }
}

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
