import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RESERVED_STAGE_IDS } from "./protocol.js";

export class ConfigError extends Error {}

// Provider-specific reasoning knobs, applied by the matching adapter.
export const THINKING_LEVELS = ["off", "auto", "extended"] as const; // claude
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const; // codex
export type Thinking = (typeof THINKING_LEVELS)[number];
export type Effort = (typeof EFFORT_LEVELS)[number];

// e.g. "500ms", "30s", "10m", "2h"
const DurationSchema = z.string().regex(/^\d+(ms|s|m|h)$/, "duration like '30s', '10m', '2h'");

/** Parse a duration string ("30s", "10m", "2h", "500ms") into milliseconds. */
export function parseDurationMs(d: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) throw new ConfigError(`invalid duration '${d}' — use e.g. '30s', '10m', '2h'`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

const AgentSchema = z.object({
  role: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  // Named capabilities injected into this agent's prompt preamble. Lets a role
  // (e.g. a code reviewer) carry a reusable toolkit of instructions.
  skills: z.array(z.string().min(1)).default([]),
  // Reasoning knobs applied by the matching adapter at call time:
  //   thinking (claude) → MAX_THINKING_TOKENS on the child process
  //   effort   (codex)  → -c model_reasoning_effort=...
  // A knob for the "wrong" provider is simply ignored by the adapter.
  thinking: z.enum(THINKING_LEVELS).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  // Wall-clock ceiling for a single call. Enforced by the adapter — the child
  // process is killed if it runs longer.
  timeout: DurationSchema.optional(),
  // Advisory metadata: recorded and displayed, but NOT injected as CLI flags —
  // neither the claude nor codex CLI exposes a reliable knob for these.
  context_window: z.string().optional(),
  max_output: z.string().optional(),
});
const StageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "stage ids are kebab-case"),
  agent: z.string().min(1),
  gate: z.enum(["human", "auto"]).default("auto"),
  prompt: z.string().min(1),
  modelOverride: z.string().optional(),
  // Statically disable a stage: it is treated as "skipped" and never blocks
  // downstream stages. Use to turn off e.g. a design pass for a pure-logic repo.
  enabled: z.boolean().default(true),
  // "always" runs every pipeline pass. "auto" makes the stage skippable at
  // runtime (`assemble gate skip <id>`) when a human deems it unnecessary,
  // without editing config.
  when: z.enum(["always", "auto"]).default("always"),
  // Optional routing hint for review stages: a "ui" change wants a design
  // reviewer, "technical" wants a code reviewer, "both" wants each.
  flavor: z.enum(["technical", "ui", "both"]).optional(),
});
const PricingEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
const BudgetSchema = z.object({
  policy: z.enum(["warn", "pause", "block"]).default("warn"),
  total: z.number().nonnegative().optional(),
  perStage: z.record(z.number().nonnegative()).default({}),
  perWorker: z.record(z.number().nonnegative()).default({}),
});
const ConfigSchema = z.object({
  project: z.string().min(1),
  agents: z.record(AgentSchema),
  stages: z.array(StageSchema).min(1),
  pricing: z.record(PricingEntrySchema).default({}),
  utilityModel: z.string().min(1).optional(),
  budget: BudgetSchema.optional(),
});

export type AgentDef = z.infer<typeof AgentSchema>;
export type StageDef = z.infer<typeof StageSchema>;
export type PricingEntry = z.infer<typeof PricingEntrySchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type AssembleConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(dir: string, env: NodeJS.ProcessEnv = process.env): AssembleConfig {
  const path = join(dir, "assemble.config.yaml");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`no assemble.config.yaml in ${dir} — run \`assemble init\` first`);
  }
  const parsed = ConfigSchema.safeParse(parse(raw));
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const cfg = parsed.data;

  const seen = new Set<string>();
  for (const s of cfg.stages) {
    if ((RESERVED_STAGE_IDS as readonly string[]).includes(s.id))
      throw new ConfigError(`stage id '${s.id}' is reserved (reserved list may grow between versions)`);
    if (seen.has(s.id)) throw new ConfigError(`duplicate stage id '${s.id}'`);
    seen.add(s.id);
    if (!cfg.agents[s.agent]) throw new ConfigError(`stage '${s.id}' references unknown agent '${s.agent}'`);
    const override = env[`ASSEMBLE_STAGE_${s.id}_MODEL`];
    if (override) s.modelOverride = override;
  }

  const pricingOverride = env["ASSEMBLE_PRICING_JSON"];
  if (pricingOverride) {
    let rawPricing: unknown;
    try { rawPricing = JSON.parse(pricingOverride); }
    catch { throw new ConfigError(`ASSEMBLE_PRICING_JSON is not valid JSON`); }
    const validated = z.record(PricingEntrySchema).safeParse(rawPricing);
    if (!validated.success)
      throw new ConfigError(`ASSEMBLE_PRICING_JSON: ${validated.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    cfg.pricing = { ...cfg.pricing, ...validated.data };
  }

  return cfg;
}
