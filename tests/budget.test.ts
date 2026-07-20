import { describe, it, expect } from "vitest";
import { checkBudget } from "../src/budget.js";
import type { AssembleConfig } from "../src/config.js";
import type { LedgerEvent } from "../src/ledger.js";

function cfg(budget: AssembleConfig["budget"]): AssembleConfig {
  return {
    project: "MyApp",
    agents: {},
    stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
    pricing: {},
    budget,
  } as AssembleConfig;
}

function cost(stage: string, worker: string, usd: number): LedgerEvent {
  return { ts: "t", type: "cost", stage, worker, costUsd: usd } as LedgerEvent;
}

describe("checkBudget", () => {
  it("returns not-breached when no budget configured", () => {
    const d = checkBudget(cfg(undefined), [cost("implement", "thor", 99)]);
    expect(d.breached).toBe(false);
    expect(d.breaches).toEqual([]);
  });

  it("is not breached when spend is under the total cap", () => {
    const d = checkBudget(cfg({ policy: "warn", total: 5, perStage: {}, perWorker: {} }), [
      cost("implement", "thor", 3),
    ]);
    expect(d.breached).toBe(false);
  });

  it("breaches when total spend exceeds the total cap", () => {
    const d = checkBudget(cfg({ policy: "block", total: 5, perStage: {}, perWorker: {} }), [
      cost("implement", "thor", 4),
      cost("code-review", "vision", 3),
    ]);
    expect(d.breached).toBe(true);
    expect(d.policy).toBe("block");
    expect(d.breaches).toContainEqual({ scope: "total", cap: 5, spent: 7 });
  });

  it("breaches on a per-stage cap with the correct scope", () => {
    const d = checkBudget(cfg({ policy: "warn", perStage: { implement: 2 }, perWorker: {} }), [
      cost("implement", "thor", 3),
    ]);
    expect(d.breached).toBe(true);
    expect(d.breaches).toContainEqual({ scope: "stage:implement", cap: 2, spent: 3 });
  });

  it("breaches on a per-worker cap with the correct scope", () => {
    const d = checkBudget(cfg({ policy: "warn", perStage: {}, perWorker: { thor: 1 } }), [
      cost("implement", "thor", 2),
    ]);
    expect(d.breached).toBe(true);
    expect(d.breaches).toContainEqual({ scope: "worker:thor", cap: 1, spent: 2 });
  });

  it("reports multiple simultaneous breaches", () => {
    const d = checkBudget(
      cfg({ policy: "block", total: 5, perStage: { implement: 2 }, perWorker: { thor: 1 } }),
      [cost("implement", "thor", 6)],
    );
    expect(d.breached).toBe(true);
    expect(d.breaches.map(b => b.scope).sort()).toEqual(["stage:implement", "total", "worker:thor"]);
  });

  it("does not breach a scope exactly at its cap (only strictly over)", () => {
    const d = checkBudget(cfg({ policy: "warn", total: 5, perStage: {}, perWorker: {} }), [
      cost("implement", "thor", 5),
    ]);
    expect(d.breached).toBe(false);
  });
});
