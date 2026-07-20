import type { AssembleConfig, StageDef } from "./config.js";
import { parseDurationMs } from "./config.js";
import { appendEvent, readLedger, deriveStageStatus, isStageSatisfied } from "./ledger.js";
import { getAdapter, type Adapter, type RunOpts } from "./adapters.js";
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
 * Classify a display role into the review specialty it covers, for `flavor`
 * routing. A "ui"/"design" role reviews interface changes; a "code"/"technical"
 * role reviews implementation. Returns null for neutral roles (architect, final
 * reviewer, implementer …) that carry no specialty.
 */
export function agentSpecialty(role: string): "technical" | "ui" | null {
  if (/\b(ui|ux|design(?:er)?|visual|front-?end)\b/i.test(role)) return "ui";
  if (/\b(code|technical|back-?end|api|security|architecture)\b/i.test(role)) return "technical";
  return null;
}

/**
 * Resolve which agent actually runs a stage, honouring its `flavor` routing
 * hint. When a stage declares `flavor: technical|ui`, the engine auto-selects
 * the roster's matching reviewer instead of the configured agent — unless that
 * agent already matches (an author pin) or no matching reviewer exists. A
 * `flavor: both` (or unset) stage always runs its configured agent verbatim;
 * "both" fans out to per-flavor stages, it is not a single auto-swap.
 */
export function resolveStageAgent(config: AssembleConfig, stage: StageDef): { name: string; auto: boolean } {
  const configured = stage.agent;
  const flavor = stage.flavor;
  if (!flavor || flavor === "both") return { name: configured, auto: false };

  const current = config.agents[configured];
  // Author already pinned a correctly-specialised reviewer — leave it be.
  if (current && agentSpecialty(current.role) === flavor) return { name: configured, auto: false };

  const match = Object.entries(config.agents).find(([, a]) => agentSpecialty(a.role) === flavor);
  if (match) return { name: match[0], auto: true };

  // No reviewer of the requested flavor in the roster: fall back to configured.
  return { name: configured, auto: false };
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

  const resolved = resolveStageAgent(config, stage);
  const agentName = resolved.name;
  const agent = config.agents[agentName];
  if (!agent) throw new GateError(`stage '${stageId}' references unknown agent '${agentName}'`);
  if (resolved.auto)
    log(`  ↳ flavor:${stage.flavor} → auto-selected ${renderAgent(agentName, config)} (${agent.role})`);
  const adapter = opts.adapters?.[agent.provider] ?? getAdapter(agent.provider);
  const model = stage.modelOverride ?? agent.model;
  const prompt = withSkills(agent.skills, stage.prompt);

  // Resolve the agent's per-model knobs into adapter run options. Each adapter
  // applies only what its provider supports; the "wrong" knob is inert.
  const runOpts: RunOpts = { prompt, model, cwd: dir };
  if (agent.provider === "claude" && agent.thinking) runOpts.thinking = agent.thinking;
  if (agent.provider === "codex" && agent.effort) runOpts.effort = agent.effort;
  if (agent.timeout) runOpts.timeoutMs = parseDurationMs(agent.timeout);

  appendEvent(dir, { type: "stage_started", stage: stage.id, agent: agentName });
  log(`▶ ${stage.id} — ${renderAgent(agentName, config)} on ${model}`);
  try {
    const result = await adapter.run(runOpts);
    appendEvent(dir, { type: "stage_completed", stage: stage.id, agent: agentName, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    appendEvent(dir, {
      type: "cost", stage: stage.id, worker: agentName, model,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      costUsd: computeCost(config, model, result.tokensIn, result.tokensOut),
    });
    log(`✔ ${stage.id} — ${renderAgent(agentName, config)} done`);
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
    appendEvent(dir, { type: "stage_failed", stage: stage.id, agent: agentName, notes: String(err) });
    throw err;
  }
}
