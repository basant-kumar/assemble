import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, DEFAULT_ARCHI_PATH } from "./config.js";
import { defaultConfigYaml } from "./configure.js";

/** The full seeded default config (all roster heroes pre-configured). */
export const DEFAULT_CONFIG = defaultConfigYaml("MyApp");

/** Where `init` seeds the architectural-memory file. Configurable per-project
 * via `memory.path`; this is the default a fresh config ships with. */
export const ARCHI_PATH = DEFAULT_ARCHI_PATH;
export const DEFAULT_ARCHI = `# ARCHI.md — architectural memory

> Long-term architectural memory for this project, maintained by assemble's
> post-release \`memory-sync\` stage. Each release, the memory agent reads the
> release diff against this file, updates stale claims, and records new
> decisions. Edit by hand freely — the agent treats your notes as ground truth.
> When this file grows past its token budget, a compaction pass condenses it.

## Overview

_What this system is and does. (One or two paragraphs — filled in as the
architecture takes shape.)_

## Key components

_The major modules/services and their responsibilities._

## Architectural decisions

_Durable choices and their rationale (the "why"), newest first._

## Conventions & invariants

_Rules the codebase relies on: naming, boundaries, things that must stay true._

## Known drift / open questions

_Places the code and this document may disagree; flagged by memory-sync for
follow-up._
`;

export function initProject(dir: string): { created: string[] } {
  const cfgPath = join(dir, "assemble.config.yaml");
  if (existsSync(cfgPath)) throw new ConfigError(`assemble.config.yaml already exists in ${dir}`);
  writeFileSync(cfgPath, DEFAULT_CONFIG);
  mkdirSync(join(dir, ".assemble"), { recursive: true });

  // Architectural memory is opt-in (memory.enabled: false by default), so init
  // does not seed ARCHI.md. When enabled, `memory-sync` bootstraps the file on
  // first run (create-if-missing in syncMemory).
  return { created: ["assemble.config.yaml", ".assemble/"] };
}
