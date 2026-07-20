import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus } from "./ledger.js";
import { getAdapter, type Adapter } from "./adapters.js";
import { renderAgent } from "./theme.js";
import { commitStageChanges } from "./sideops.js";

export class GateError extends Error {}

export type RunStageOpts = {
  adapters?: Record<string, Adapter>;
  log?: (line: string) => void;
  autoCommit?: { adapter: Adapter; gitBin?: string };
};

export async function runStage(dir: string, config: AssembleConfig, stageId: string, opts: RunStageOpts = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const idx = config.stages.findIndex(s => s.id === stageId);
  if (idx < 0) throw new GateError(`unknown stage '${stageId}' — defined stages: ${config.stages.map(s => s.id).join(", ")}`);
  const stage = config.stages[idx];

  const events = readLedger(dir);
  for (const earlier of config.stages.slice(0, idx)) {
    const status = deriveStageStatus(events, earlier);
    if (status !== "approved")
      throw new GateError(`stage '${stageId}' is blocked: earlier stage '${earlier.id}' is ${status} (gate must be approved first)`);
  }

  const agent = config.agents[stage.agent];
  const adapter = opts.adapters?.[agent.provider] ?? getAdapter(agent.provider);
  const model = stage.modelOverride ?? agent.model;

  appendEvent(dir, { type: "stage_started", stage: stage.id, agent: stage.agent });
  log(`▶ ${stage.id} — ${renderAgent(stage.agent, config)} on ${model}`);
  try {
    const result = await adapter.run({ prompt: stage.prompt, model, cwd: dir });
    appendEvent(dir, { type: "stage_completed", stage: stage.id, agent: stage.agent, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    log(`✔ ${stage.id} — ${renderAgent(stage.agent, config)} done`);
    if (opts.autoCommit && config.utilityModel) {
      const commit = await commitStageChanges(dir, config, stage.id, {
        adapter: opts.autoCommit.adapter, gitBin: opts.autoCommit.gitBin, diffSummary: result.output,
      });
      log(`◆ ${stage.id} — committed: ${commit.message}`);
    }
  } catch (err) {
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: stage.agent, notes: String(err) });
    throw err;
  }
}
