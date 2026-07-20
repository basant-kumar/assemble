import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.js";

export const DEFAULT_CONFIG = `# assemble — Avengers, assemble your AI dev team (default MCU theme; names are a swappable skin)
project: MyApp
agents:
  thor:   { role: implementer,   provider: claude, model: opus }
  vision: { role: code reviewer, provider: codex,  model: gpt-5-codex }
stages:
  - { id: implement,   agent: thor,   gate: auto,  prompt: "Implement the approved plan. Follow existing project conventions." }
  - { id: code-review, agent: vision, gate: human, prompt: "Review the latest diff. End with exactly one verdict: APPROVED, REQUEST_CHANGES, or BLOCKED." }
`;

export function initProject(dir: string): { created: string[] } {
  const cfgPath = join(dir, "assemble.config.yaml");
  if (existsSync(cfgPath)) throw new ConfigError(`assemble.config.yaml already exists in ${dir}`);
  writeFileSync(cfgPath, DEFAULT_CONFIG);
  mkdirSync(join(dir, ".assemble"), { recursive: true });
  return { created: ["assemble.config.yaml", ".assemble/"] };
}
