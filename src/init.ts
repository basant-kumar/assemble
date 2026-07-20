import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.js";
import { defaultConfigYaml } from "./configure.js";

/** The full seeded default config (all roster heroes pre-configured). */
export const DEFAULT_CONFIG = defaultConfigYaml("MyApp");

export function initProject(dir: string): { created: string[] } {
  const cfgPath = join(dir, "assemble.config.yaml");
  if (existsSync(cfgPath)) throw new ConfigError(`assemble.config.yaml already exists in ${dir}`);
  writeFileSync(cfgPath, DEFAULT_CONFIG);
  mkdirSync(join(dir, ".assemble"), { recursive: true });
  return { created: ["assemble.config.yaml", ".assemble/"] };
}
