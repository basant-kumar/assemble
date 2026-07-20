import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssembleConfig } from "./config.js";
import { ConfigError, parseDurationMs } from "./config.js";
import { getAdapter, spawn, type Adapter, type RunOpts } from "./adapters.js";
import { appendEvent, readLedger, type LedgerEvent } from "./ledger.js";
import { computeCost } from "./cost.js";
import { DEFAULT_ARCHI } from "./init.js";

/**
 * Resolve which agent runs `memory-sync`. Prefers the explicitly configured
 * `memory.agent`; otherwise falls back to the first agent whose role mentions
 * "memory" (the roster's `jarvis` by default).
 */
export function resolveMemoryAgent(config: AssembleConfig): string {
  const configured = config.memory.agent;
  if (configured) {
    if (!config.agents[configured])
      throw new ConfigError(`memory.agent '${configured}' is not a defined agent`);
    return configured;
  }
  const byRole = Object.entries(config.agents).find(([, a]) => /memory/i.test(a.role));
  if (byRole) return byRole[0];
  throw new ConfigError(
    "no memory agent configured — set `memory.agent` in assemble.config.yaml (or give an agent a role mentioning 'memory')",
  );
}

/** The sha the last successful `memory-sync` was taken against, if any. */
export function lastSyncedSha(events: LedgerEvent[]): string | undefined {
  let sha: string | undefined;
  for (const e of events) if (e.type === "memory_synced" && e.sha) sha = e.sha;
  return sha;
}

/** Build the prompt handed to the memory agent to refresh ARCHI.md. */
export function buildMemoryPrompt(current: string, diff: string): string {
  return [
    "You maintain this project's architectural memory (ARCHI.md).",
    "Update the document to reflect the changes below. Rules:",
    "- Preserve the section structure and any hand-written notes (treat them as",
    "  ground truth — refine, never discard).",
    "- Add new architectural decisions newest-first; correct now-stale claims;",
    "  note any code/doc disagreement under 'Known drift / open questions'.",
    "- Output the COMPLETE updated ARCHI.md in Markdown and nothing else.",
    "",
    "=== CURRENT ARCHI.md ===",
    current,
    "",
    "=== CHANGES SINCE LAST SYNC ===",
    diff || "(no diff available)",
  ].join("\n");
}

/**
 * Collect a compact "release diff" for the memory agent: the commit subjects and
 * the changed-file stat since `base` (the last sync sha, or a bounded window
 * when there is no baseline). Returns the current HEAD sha so the next sync can
 * diff forward from here.
 */
export async function collectReleaseDiff(
  dir: string,
  gitBin: string,
  base?: string,
): Promise<{ headSha: string | null; diff: string }> {
  let headSha: string | null = null;
  try {
    headSha = (await spawn(gitBin, ["rev-parse", "HEAD"], dir)).trim() || null;
  } catch {
    // Not a git repo / no commits yet — memory-sync still works, just without a diff.
    return { headSha: null, diff: "" };
  }
  const range = base ? `${base}..HEAD` : "HEAD";
  const safe = async (args: string[]): Promise<string> => {
    try { return (await spawn(gitBin, args, dir)).trim(); } catch { return ""; }
  };
  const log = base
    ? await safe(["log", "--oneline", range])
    : await safe(["log", "--oneline", "-n", "50"]);
  const stat = base
    ? await safe(["diff", "--stat", range])
    : await safe(["show", "--stat", "--oneline", "HEAD"]);
  const diff = [
    log && `Commits:\n${log}`,
    stat && `Changed files:\n${stat}`,
  ].filter(Boolean).join("\n\n");
  return { headSha, diff };
}

export type SyncMemoryOpts = {
  /** Injected memory-agent adapter (defaults to the provider's real adapter). */
  adapter?: Adapter;
  /** Injected git binary (defaults to "git"). */
  gitBin?: string;
  /** Base git ref for the release diff (defaults to the last sync's sha). */
  since?: string;
  log?: (line: string) => void;
};

export type SyncMemoryResult = {
  path: string;
  created: boolean;
  updated: boolean;
  headSha: string | null;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Create ARCHI.md if it does not exist, then update it from the release diff
 * using the memory agent. Records a `cost` event and a `memory_synced` event
 * (carrying the HEAD sha, which becomes the base for the next sync).
 */
export async function syncMemory(
  dir: string,
  config: AssembleConfig,
  opts: SyncMemoryOpts = {},
): Promise<SyncMemoryResult> {
  const rel = config.memory.path;
  const archiPath = join(dir, rel);

  // Create-if-missing: memory-sync can bootstrap the file too, not just `init`.
  let created = false;
  if (!existsSync(archiPath)) {
    mkdirSync(dirname(archiPath), { recursive: true });
    writeFileSync(archiPath, DEFAULT_ARCHI);
    created = true;
  }
  const current = readFileSync(archiPath, "utf8");

  const agentName = resolveMemoryAgent(config);
  const agent = config.agents[agentName];
  const adapter = opts.adapter ?? getAdapter(agent.provider);

  const gitBin = opts.gitBin ?? "git";
  const base = opts.since ?? lastSyncedSha(readLedger(dir));
  const { headSha, diff } = await collectReleaseDiff(dir, gitBin, base);

  const runOpts: RunOpts = { prompt: buildMemoryPrompt(current, diff), model: agent.model, cwd: dir };
  if (agent.provider === "claude" && agent.thinking) runOpts.thinking = agent.thinking;
  if (agent.provider === "codex" && agent.effort) runOpts.effort = agent.effort;
  if (agent.timeout) runOpts.timeoutMs = parseDurationMs(agent.timeout);

  const result = await adapter.run(runOpts);
  const next = result.output.trim();
  let updated = false;
  if (next && next !== current.trim()) {
    writeFileSync(archiPath, next.endsWith("\n") ? next : `${next}\n`);
    updated = true;
  }

  appendEvent(dir, {
    type: "cost", stage: "memory-sync", worker: agentName, model: agent.model,
    tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    costUsd: computeCost(config, agent.model, result.tokensIn, result.tokensOut),
  });
  appendEvent(dir, { type: "memory_synced", stage: "memory-sync", sha: headSha ?? undefined, notes: rel });

  opts.log?.(
    `✎ memory-sync — ${updated ? "updated" : created ? "created" : "no changes"} ${rel}` +
    (headSha ? ` @ ${headSha.slice(0, 7)}` : ""),
  );
  return { path: rel, created, updated, headSha, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
}
