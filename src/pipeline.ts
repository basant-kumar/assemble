import type { AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus, appendEvent } from "./ledger.js";
import { runStage, type RunStageOpts } from "./engine.js";
import { checkBudget, BudgetError } from "./budget.js";

export async function runPipeline(dir: string, config: AssembleConfig, opts: RunStageOpts = {}): Promise<{ ran: string[]; stoppedAt: string | null }> {
  const ran: string[] = [];
  for (const stage of config.stages) {
    if (deriveStageStatus(readLedger(dir), stage) === "approved") continue;
    await runStage(dir, config, stage.id, opts);
    ran.push(stage.id);

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
        appendEvent(dir, { type: "budget_abort", stage: stage.id, notes });
        throw new BudgetError(decision.breaches);
      } else {
        // pause: consult the approver; continue only on explicit approval.
        const approved = opts.approveBudget?.(decision) ?? false;
        if (!approved) {
          appendEvent(dir, { type: "budget_abort", stage: stage.id, notes });
          return { ran, stoppedAt: stage.id };
        }
      }
    }

    const status = deriveStageStatus(readLedger(dir), stage);
    if (status !== "approved") return { ran, stoppedAt: stage.id };
  }
  return { ran, stoppedAt: null };
}
