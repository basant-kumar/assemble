import type { AssembleConfig } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus, isStageSatisfied } from "./ledger.js";
import { getAdapter, type Adapter } from "./adapters.js";
import { renderAgent } from "./theme.js";
import { commitStageChanges } from "./sideops.js";
import { computeCost } from "./cost.js";

export class GateError extends Error {}

/**
 * Prefix an agent's declared skills onto its stage prompt so the adapter runs
 * with that reusable toolkit in context. Returns the prompt unchanged when the
 * agent has no skills.
 */
export function withSkills(skills: string[] | undefined, prompt: string): string {
  if (!skills || skills.length === 0) return prompt;
  return `Active skills: ${skills.join(", ")}.\n\n${prompt}`;
}

/**
 * Runtime-skip a stage without editing config. Only permitted for stages
 * declared `when: auto`; records a `stage_skipped` event so the stage counts as
 * satisfied and no longer blocks downstream gates.
 */
export function skipStage(dir: string, config: AssembleConfig, stageId: string, by = "council", reason?: string): void {
  const stage = config.stages.find(s => s.id === stageId);
  if (!stage) throw new GateError(`unknown stage '${stageId}' — defined stages: ${config.stages.map(s => s.id).join(", ")}`);
  if (stage.when !== "auto")
    throw new GateError(`stage '${stageId}' is not skippable: set \`when: auto\` to allow runtime skips`);
  const status = deriveStageStatus(readLedger(dir), stage);
  if (status === "approved" || status === "skipped")
    throw new GateError(`stage '${stageId}' is already ${status} — nothing to skip`);
  appendEvent(dir, { type: "stage_skipped", stage: stageId, approvedBy: by, notes: reason });
}

export type RunStageOpts = {
  adapters?: Record<string, Adapter>;
  log?: (line: string) => void;
  autoCommit?: { adapter: Adapter; gitBin?: string };
  /**
   * Consulted when a "pause"-policy budget breach is detected. Return true to
   * approve the overspend and continue the run; false (or omit) to stop.
   */
  approveBudget?: (decision: import("./budget.js").BudgetDecision) => boolean;
};

export async function runStage(dir: string, config: AssembleConfig, stageId: string, opts: RunStageOpts = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const idx = config.stages.findIndex(s => s.id === stageId);
  if (idx < 0) throw new GateError(`unknown stage '${stageId}' — defined stages: ${config.stages.map(s => s.id).join(", ")}`);
  const stage = config.stages[idx];

  if (stage.enabled === false)
    throw new GateError(`stage '${stageId}' is disabled (enabled: false) — nothing to run`);

  const events = readLedger(dir);
  for (const earlier of config.stages.slice(0, idx)) {
    const status = deriveStageStatus(events, earlier);
    if (!isStageSatisfied(status))
      throw new GateError(`stage '${stageId}' is blocked: earlier stage '${earlier.id}' is ${status} (must be approved or skipped first)`);
  }

  const agent = config.agents[stage.agent];
  const adapter = opts.adapters?.[agent.provider] ?? getAdapter(agent.provider);
  const model = stage.modelOverride ?? agent.model;
  const prompt = withSkills(agent.skills, stage.prompt);

  appendEvent(dir, { type: "stage_started", stage: stage.id, agent: stage.agent });
  log(`▶ ${stage.id} — ${renderAgent(stage.agent, config)} on ${model}`);
  try {
    const result = await adapter.run({ prompt, model, cwd: dir });
    appendEvent(dir, { type: "stage_completed", stage: stage.id, agent: stage.agent, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    appendEvent(dir, {
      type: "cost", stage: stage.id, worker: stage.agent, model,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      costUsd: computeCost(config, model, result.tokensIn, result.tokensOut),
    });
    log(`✔ ${stage.id} — ${renderAgent(stage.agent, config)} done`);
    if (opts.autoCommit && config.utilityModel) {
      const commit = await commitStageChanges(dir, config, stage.id, {
        adapter: opts.autoCommit.adapter, gitBin: opts.autoCommit.gitBin, diffSummary: result.output,
      });
      appendEvent(dir, {
        type: "cost", stage: stage.id, worker: "utility", model: config.utilityModel,
        tokensIn: commit.tokensIn, tokensOut: commit.tokensOut,
        costUsd: computeCost(config, config.utilityModel, commit.tokensIn, commit.tokensOut),
      });
      log(`◆ ${stage.id} — committed: ${commit.message}`);
    }
  } catch (err) {
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: stage.agent, notes: String(err) });
    throw err;
  }
}
