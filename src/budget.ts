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

export type BudgetLine = { scope: string; cap: number; spent: number; remaining: number };

/**
 * Build a per-scope spend/cap/remaining report from the ledger. Pure: no I/O.
 * Returns an empty array when no budget is configured so callers can degrade
 * gracefully. `remaining` may be negative when a cap has been exceeded.
 */
export function budgetReport(config: AssembleConfig, events: LedgerEvent[]): BudgetLine[] {
  const budget = config.budget;
  if (!budget) return [];

  const { byWorker, byStage, total } = aggregateCost(events);
  const lines: BudgetLine[] = [];

  if (budget.total !== undefined) {
    lines.push({ scope: "total", cap: budget.total, spent: total, remaining: budget.total - total });
  }
  for (const [stage, cap] of Object.entries(budget.perStage)) {
    const spent = byStage[stage] ?? 0;
    lines.push({ scope: `stage:${stage}`, cap, spent, remaining: cap - spent });
  }
  for (const [worker, cap] of Object.entries(budget.perWorker)) {
    const spent = byWorker[worker] ?? 0;
    lines.push({ scope: `worker:${worker}`, cap, spent, remaining: cap - spent });
  }

  return lines;
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
