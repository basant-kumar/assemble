import type { AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus } from "./ledger.js";
import { runStage, type RunStageOpts } from "./engine.js";

export async function runPipeline(dir: string, config: AssembleConfig, opts: RunStageOpts = {}): Promise<{ ran: string[]; stoppedAt: string | null }> {
  const ran: string[] = [];
  for (const stage of config.stages) {
    if (deriveStageStatus(readLedger(dir), stage) === "approved") continue;
    await runStage(dir, config, stage.id, opts);
    ran.push(stage.id);
    const status = deriveStageStatus(readLedger(dir), stage);
    if (status !== "approved") return { ran, stoppedAt: stage.id };
  }
  return { ran, stoppedAt: null };
}
