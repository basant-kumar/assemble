import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RESERVED_STAGE_IDS } from "./protocol.js";

export class ConfigError extends Error {}

// Provider-specific reasoning knobs, applied by the matching adapter.
export const THINKING_LEVELS = ["off", "auto", "extended"] as const; // claude
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const; // codex
// Preset team shapes. `mode: solo|duo|full` is a shorthand that the loader
// expands into the agents block + stage wiring (see MODE_PRESETS / loadConfig).
export const MODES = ["solo", "duo", "full"] as const;
export type Mode = (typeof MODES)[number];
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
  // Mark a stage as an agent-review stage: its agent emits a verdict
  // (APPROVED / REQUEST_CHANGES / BLOCKED) that must reach APPROVED before the
  // stage's gate is offered. When omitted, any stage whose id contains
  // "review" is treated as one (see isReviewStage). Set `review: false` to
  // opt a "review"-named stage out.
  review: z.boolean().optional(),
  // Convergence budget for a review stage. After this many non-approving
  // rounds without an APPROVED verdict, the stage escalates to a human gate
  // instead of looping forever.
  maxRounds: z.number().int().positive().default(3),
  // On a BLOCKED verdict, bounce this earlier stage back to needs_rework
  // (e.g. a code review that blocks routes back to the plan). Must reference an
  // earlier stage id. When omitted, BLOCKED loops the review stage itself.
  reworkTarget: z.string().optional(),
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
/** Default location of the architectural-memory file, relative to the repo
 * root. Overridable via `memory.path` in assemble.config.yaml. */
export const DEFAULT_ARCHI_PATH = "docs/assemble/ARCHI.md";
const MemorySchema = z.object({
  // Opt-in, default off. The architectural-memory feature (ARCHI.md +
  // `memory-sync`) is designed for single-source-of-truth projects, where the
  // local ledger's last-synced SHA is a reliable base to diff from. Leave it
  // off for repos with remote contributors, where a locally-synced ARCHI.md
  // would silently go stale. Flip to `true` to enable.
  enabled: z.boolean().default(false),
  path: z.string().min(1).default(DEFAULT_ARCHI_PATH),
  // Which agent runs `memory-sync`. When omitted, the agent whose role mentions
  // "memory" is used (see resolveMemoryAgent).
  agent: z.string().min(1).optional(),
}).default({ enabled: false, path: DEFAULT_ARCHI_PATH });
const ConfigSchema = z.object({
  project: z.string().min(1),
  // Preset shorthand. When set to solo/duo, the loader seeds the agents block
  // and rewires stage agents (see MODE_PRESETS). `full` (or omitted) means the
  // agents block below is used exactly as written.
  mode: z.enum(MODES).optional(),
  // Optional: a bare `mode: solo|duo` config needs no roster of its own.
  agents: z.record(AgentSchema).default({}),
  stages: z.array(StageSchema).min(1),
  pricing: z.record(PricingEntrySchema).default({}),
  utilityModel: z.string().min(1).optional(),
  budget: BudgetSchema.optional(),
  memory: MemorySchema,
});

export type AgentDef = z.infer<typeof AgentSchema>;
export type StageDef = z.infer<typeof StageSchema>;
export type PricingEntry = z.infer<typeof PricingEntrySchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type MemoryConfig = z.infer<typeof MemorySchema>;
export type AssembleConfig = z.infer<typeof ConfigSchema>;

const MTOK = 1_000_000;
type ModePreset = {
  agents: Record<string, AgentDef>;
  pricing: Record<string, PricingEntry>;
  /** Which mode agent handles a given stage, by role. */
  assign: (stage: StageDef) => string;
};
/**
 * `mode` presets. A preset seeds the agents block and rewires every stage's
 * agent at load time:
 *   solo — one model plays every hero (claude/fable-5)
 *   duo  — writer (claude/fable-5) + cross-provider reviewer (codex/gpt-5.6-sol)
 *   full — no expansion; the file's agents block is used as written (the roster)
 * A file `agents:` entry with the same name (writer/reviewer/solo) overrides the
 * preset's profile — bump the reviewer's model by redefining `reviewer`. To pin
 * individual stages to specific agents, use `mode: full` (or omit mode).
 */
const MODE_PRESETS: Record<"solo" | "duo", ModePreset> = {
  solo: {
    agents: {
      solo: { role: "implementer", provider: "claude", model: "fable-5", skills: [] },
    },
    pricing: { "fable-5": { input: 10 / MTOK, output: 50 / MTOK } },
    assign: () => "solo",
  },
  duo: {
    agents: {
      writer:   { role: "implementer",   provider: "claude", model: "fable-5",     skills: [] },
      reviewer: { role: "code reviewer", provider: "codex",  model: "gpt-5.6-sol", skills: [], effort: "high" },
    },
    pricing: {
      "fable-5":     { input: 10 / MTOK, output: 50 / MTOK },
      "gpt-5.6-sol": { input: 5 / MTOK,  output: 30 / MTOK },
    },
    // Review-flavored stages (code-review, plan-review, design-review) → reviewer.
    assign: stage => (/review/.test(stage.id) ? "reviewer" : "writer"),
  },
};

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

  // Expand a `mode` preset: seed the mode's agents (a file agent of the same
  // name wins), add its pricing (file pricing wins), and rewire every stage to
  // the mode agent for its role. `full`/omitted leaves the config untouched.
  if (cfg.mode && cfg.mode !== "full") {
    const preset = MODE_PRESETS[cfg.mode];
    cfg.agents = { ...preset.agents, ...cfg.agents };
    cfg.pricing = { ...preset.pricing, ...cfg.pricing };
    for (const s of cfg.stages) s.agent = preset.assign(s);
  }

  const seen = new Set<string>();
  for (const s of cfg.stages) {
    if ((RESERVED_STAGE_IDS as readonly string[]).includes(s.id))
      throw new ConfigError(`stage id '${s.id}' is reserved (reserved list may grow between versions)`);
    if (seen.has(s.id)) throw new ConfigError(`duplicate stage id '${s.id}'`);
    seen.add(s.id);
    if (!cfg.agents[s.agent]) throw new ConfigError(`stage '${s.id}' references unknown agent '${s.agent}'`);
    if (s.reworkTarget !== undefined) {
      if (s.reworkTarget === s.id)
        throw new ConfigError(`stage '${s.id}': reworkTarget cannot reference itself`);
      if (!seen.has(s.reworkTarget))
        throw new ConfigError(`stage '${s.id}': reworkTarget '${s.reworkTarget}' must be an earlier stage id`);
    }
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
