import { describe, it, expect } from "vitest";
import { computeCost, aggregateCost } from "../src/cost.js";
import { deriveStageStatus } from "../src/ledger.js";
import type { AssembleConfig, StageDef } from "../src/config.js";
import type { LedgerEvent } from "../src/ledger.js";

const config: AssembleConfig = {
  project: "MyApp",
  agents: { thor: { role: "implementer", provider: "claude", model: "opus" } },
  stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
  pricing: { opus: { input: 0.000015, output: 0.000075 } },
};

describe("computeCost", () => {
  it("multiplies tokens by the configured rate", () => {
    expect(computeCost(config, "opus", 1000, 500)).toBeCloseTo(1000 * 0.000015 + 500 * 0.000075, 10);
  });
  it("returns 0 for a model with no pricing entry", () => {
    expect(computeCost(config, "gemini-flash", 1000, 1000)).toBe(0);
  });
  it("returns 0 for zero tokens even when priced", () => {
    expect(computeCost(config, "opus", 0, 0)).toBe(0);
  });
});

describe("aggregateCost", () => {
  const ev = (worker: string, stage: string, costUsd: number): LedgerEvent =>
    ({ ts: "2026-07-20T00:00:00Z", type: "cost", stage, worker, costUsd });

  it("sums cost by worker, by stage, and overall", () => {
    const events = [ev("thor", "implement", 0.01), ev("utility", "implement", 0.001), ev("vision", "code-review", 0.02)];
    const summary = aggregateCost(events);
    expect(summary.byWorker).toEqual({ thor: 0.01, utility: 0.001, vision: 0.02 });
    expect(summary.byStage).toEqual({ implement: 0.011, "code-review": 0.02 });
    expect(summary.total).toBeCloseTo(0.031, 10);
  });
  it("ignores non-cost events", () => {
    const events: LedgerEvent[] = [
      { ts: "2026-07-20T00:00:00Z", type: "stage_started", stage: "implement", agent: "thor" },
      ev("thor", "implement", 0.01),
    ];
    expect(aggregateCost(events).total).toBe(0.01);
  });
  it("returns all-zero summary for an empty ledger", () => {
    expect(aggregateCost([])).toEqual({ byWorker: {}, byStage: {}, total: 0 });
  });
});

describe("deriveStageStatus ignores cost events", () => {
  const auto: StageDef = { id: "implement", agent: "thor", gate: "auto", prompt: "x" };
  it("a cost event does not change stage status", () => {
    const events: LedgerEvent[] = [
      { ts: "2026-07-20T00:00:00Z", type: "stage_started", stage: "implement", agent: "thor" },
      { ts: "2026-07-20T00:00:01Z", type: "cost", stage: "implement", worker: "thor", costUsd: 0.01 },
    ];
    expect(deriveStageStatus(events, auto)).toBe("running"); // unchanged by the trailing cost event
  });
});
