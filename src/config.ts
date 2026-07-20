import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RESERVED_STAGE_IDS } from "./protocol.js";

export class ConfigError extends Error {}

const AgentSchema = z.object({
  role: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
const StageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "stage ids are kebab-case"),
  agent: z.string().min(1),
  gate: z.enum(["human", "auto"]).default("auto"),
  prompt: z.string().min(1),
  modelOverride: z.string().optional(),
});
const ConfigSchema = z.object({
  project: z.string().min(1),
  agents: z.record(AgentSchema),
  stages: z.array(StageSchema).min(1),
});

export type AgentDef = z.infer<typeof AgentSchema>;
export type StageDef = z.infer<typeof StageSchema>;
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
  return cfg;
}
