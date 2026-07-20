import type { AssembleConfig } from "./config.js";
import { ConfigError } from "./config.js";
import type { Adapter } from "./adapters.js";
import { spawn } from "./adapters.js";

/** Side-operations are orchestrator-initiated LLM calls that are NOT a pipeline stage.
 *  M2 wires "git"; "slack" and "jira" are config-supported future targets, not implemented yet. */
export const SIDE_OPERATIONS = ["git", "slack", "jira"] as const;
export type SideOperation = (typeof SIDE_OPERATIONS)[number];

export function resolveSideOpModel(config: AssembleConfig): string {
  if (!config.utilityModel)
    throw new ConfigError("utilityModel must be set in assemble.config.yaml to run side-operations (git, slack, jira)");
  return config.utilityModel;
}

export async function draftCommitMessage(
  config: AssembleConfig,
  adapter: Adapter,
  opts: { stageId: string; diffSummary: string; cwd: string },
): Promise<{ message: string; tokensIn: number; tokensOut: number }> {
  const model = resolveSideOpModel(config);
  const prompt = `Write a single-line conventional commit message summarizing this diff from stage '${opts.stageId}':\n\n${opts.diffSummary}`;
  const result = await adapter.run({ prompt, model, cwd: opts.cwd });
  const message = result.output.trim().split("\n")[0] || `chore: ${opts.stageId} changes`;
  return { message, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
}

export type CommitStageChangesOpts = { adapter: Adapter; gitBin?: string; diffSummary: string };

export async function commitStageChanges(
  dir: string,
  config: AssembleConfig,
  stageId: string,
  opts: CommitStageChangesOpts,
): Promise<{ message: string; tokensIn: number; tokensOut: number }> {
  const draft = await draftCommitMessage(config, opts.adapter, { stageId, diffSummary: opts.diffSummary, cwd: dir });
  await spawn(opts.gitBin ?? "git", ["commit", "-a", "-m", draft.message], dir);
  return draft;
}
