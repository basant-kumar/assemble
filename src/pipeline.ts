import type { AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus, appendEvent, isStageSatisfied } from "./ledger.js";
import { runStage, type RunStageOpts } from "./engine.js";
import { checkBudget, BudgetError } from "./budget.js";

export async function runPipeline(dir: string, config: AssembleConfig, opts: RunStageOpts = {}): Promise<{ ran: string[]; stoppedAt: string | null }> {
  const ran: string[] = [];
  // The review loop re-runs an author then resumes its reviewer each round;
  // `maxRounds` escalates a stuck review to a human gate, so passes converge.
  // This cap is a backstop against a pathological no-progress loop so a run can
  // never spend unbounded budget.
  const roundCeiling = config.stages.reduce((m, s) => Math.max(m, s.maxRounds ?? 1), 1);
  const maxIterations = config.stages.length * (roundCeiling + 1) + 10;

  for (let i = 0; ; i++) {
    // Always drive the earliest stage that still has outstanding work. When a
    // reviewer bounces an author back, that earlier stage becomes the next one
    // to run — so the same forward scan naturally re-runs the author, then the
    // reviewer, until the review converges or escalates.
    const next = config.stages.find((s) => !isStageSatisfied(deriveStageStatus(readLedger(dir), s)));
    if (!next) return { ran, stoppedAt: null };

    // A human gate (or a review that escalated to one on its round budget) is a
    // hard stop: the machine cannot advance past awaiting_gate on its own.
    if (deriveStageStatus(readLedger(dir), next) === "awaiting_gate") return { ran, stoppedAt: next.id };
    // Backstop: give up rather than loop forever if a stage never converges.
    if (i >= maxIterations) return { ran, stoppedAt: next.id };

    await runStage(dir, config, next.id, opts);
    ran.push(next.id);

    // Budget enforcement: the stage just recorded its cost events, so decide
    // whether accumulated spend has breached a cap before advancing.
    const decision = checkBudget(config, readLedger(dir));
    if (decision.breached) {
      const notes = decision.breaches
        .map((b) => `${b.scope} spent ${b.spent} > cap ${b.cap}`)
        .join("; ");
      if (decision.policy === "warn") {
        opts.log?.(`budget warning: ${notes}`);
      } else if (decision.policy === "block") {
        appendEvent(dir, { type: "budget_abort", stage: next.id, notes });
        throw new BudgetError(decision.breaches);
      } else {
        // pause: consult the approver; continue only on explicit approval.
        const approved = opts.approveBudget?.(decision) ?? false;
        if (!approved) {
          appendEvent(dir, { type: "budget_abort", stage: next.id, notes });
          return { ran, stoppedAt: next.id };
        }
      }
    }

    // needs_rework means a reviewer bounced the author back (or a stage awaits a
    // re-run): keep looping so the author re-runs and the reviewer re-reviews.
    // Any other non-satisfied status (awaiting_gate / awaiting_review) stops.
    const status = deriveStageStatus(readLedger(dir), next);
    if (!isStageSatisfied(status) && status !== "needs_rework") return { ran, stoppedAt: next.id };
  }
}
