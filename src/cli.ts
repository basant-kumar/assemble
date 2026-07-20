#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError, type AssembleConfig } from "./config.js";
import { readLedger, deriveStageStatus } from "./ledger.js";
import { renderAgent } from "./theme.js";
import { runStage } from "./engine.js";
import { runPipeline } from "./pipeline.js";
import { approveGate, rejectGate } from "./gate.js";
import { initProject } from "./init.js";
import type { StageStatus } from "./protocol.js";
import { getAdapter } from "./adapters.js";
import { resolveSideOpModel } from "./sideops.js";
import type { RunStageOpts } from "./engine.js";
import { aggregateCost } from "./cost.js";
import { budgetReport } from "./budget.js";

const ICONS: Record<StageStatus, string> = {
  approved: "✔", awaiting_gate: "⏸", failed: "✖", needs_rework: "✖", running: "▶", pending: "·",
};

export function buildProgram(dir: string, io: { out: (s: string) => void } = { out: console.log }): Command {
  const program = new Command("assemble").description("Avengers, assemble your AI dev team");
  let config: AssembleConfig | null = null;
  try { config = loadConfig(dir); } catch { /* no config yet — built-ins only */ }

  const printStatus = (cfg: AssembleConfig) => {
    const events = readLedger(dir);
    for (const s of cfg.stages) {
      const st = deriveStageStatus(events, s);
      io.out(`${ICONS[st]} ${s.id.padEnd(14)} ${renderAgent(s.agent, cfg).padEnd(28)} ${st}`);
    }
  };
  const requireConfig = (): AssembleConfig => {
    if (!config) throw new ConfigError(`no assemble.config.yaml in ${dir} — run \`assemble init\` first`);
    return config;
  };

  program.command("init").description("scaffold assemble.config.yaml (default MCU theme)").action(() => {
    const r = initProject(dir);
    io.out(`created ${r.created.join(", ")} — edit assemble.config.yaml, then: assemble run`);
  });

  program.command("status").description("pipeline status — who's working").action(() => printStatus(requireConfig()));

  program.command("cost").description("aggregate token cost by worker and stage").action(() => {
    const summary = aggregateCost(readLedger(dir));
    const budget = config?.budget;
    const rem = (cap: number | undefined, spent: number) =>
      cap !== undefined ? `   remaining $${(cap - spent).toFixed(4)}` : "";
    for (const [worker, usd] of Object.entries(summary.byWorker))
      io.out(`worker  ${worker.padEnd(14)} $${usd.toFixed(4)}${rem(budget?.perWorker[worker], usd)}`);
    for (const [stage, usd] of Object.entries(summary.byStage))
      io.out(`stage   ${stage.padEnd(14)} $${usd.toFixed(4)}${rem(budget?.perStage[stage], usd)}`);
    io.out(`total   ${"".padEnd(14)} $${summary.total.toFixed(4)}${rem(budget?.total, summary.total)}`);
  });

  program.command("budget").description("per-scope spend vs configured caps, with remaining headroom").action(() => {
    const cfg = requireConfig();
    const lines = budgetReport(cfg, readLedger(dir));
    if (lines.length === 0) {
      io.out("no budget configured — add a `budget:` block to assemble.config.yaml");
      return;
    }
    for (const l of lines)
      io.out(`${l.scope.padEnd(20)} spent $${l.spent.toFixed(4)}   cap $${l.cap.toFixed(4)}   remaining $${l.remaining.toFixed(4)}`);
  });

  program.command("run").description("run the full pipeline serially")
    .option("--auto-commit", "draft a utility-model commit message and commit each stage's changes")
    .action(async (opts: { autoCommit?: boolean }) => {
      const cfg = requireConfig();
      const runOpts: RunStageOpts = { log: io.out };
      if (opts.autoCommit) {
        resolveSideOpModel(cfg); // fail fast if utilityModel isn't configured — before any stage runs
        runOpts.autoCommit = { adapter: getAdapter("claude") };
      }
      const r = await runPipeline(dir, cfg, runOpts);
      if (r.stoppedAt) io.out(`stopped at '${r.stoppedAt}' — resolve with: assemble gate approve ${r.stoppedAt}`);
      printStatus(cfg);
    });

  const gate = program.command("gate").description("human (World Security Council) gate decisions");
  gate.command("approve <stage>").action((stage: string) => {
    const cfg = requireConfig();
    approveGate(dir, cfg, stage);
    printStatus(cfg);
  });
  gate.command("reject <stage>").requiredOption("--notes <text>").action((stage: string, opts: { notes: string }) => {
    const cfg = requireConfig();
    rejectGate(dir, cfg, stage, opts.notes);
    printStatus(cfg);
  });

  const stageRunner = (id: string) => async () => {
    const cfg = requireConfig();
    await runStage(dir, cfg, id, { log: io.out });
    printStatus(cfg);
  };
  program.command("stage").description("explicit long-form stage invocation")
    .command("run <id>").action((id: string) => stageRunner(id)());
  for (const s of config?.stages ?? [])
    program.command(s.id).description(`run stage '${s.id}' — ${renderAgent(s.agent, config!)}`).action(stageRunner(s.id));

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildProgram(process.cwd()).parseAsync(process.argv).catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
