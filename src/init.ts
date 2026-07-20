import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, DEFAULT_ARCHI_PATH } from "./config.js";
import { defaultConfigYaml } from "./configure.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Path to the bundled `assemble` skill shipped in this package. `skills/` is a
 * sibling of both `dist/` (published) and `src/` (dev/tests), so `../skills`
 * resolves correctly whether we run from compiled output or straight from TS. */
const BUNDLED_SKILL_DIR = join(HERE, "..", "skills", "assemble");

/** Where the skill is copied inside the target repo, relative to its root. */
export const SKILL_PATH = ".claude/skills/assemble";

/** Codex reads `AGENTS.md` from the repo root (the codex analog of a Claude
 * skill). We drop a marked block that points codex workers at the same
 * protocol, so a stage with `provider: codex` behaves like a `claude` one. */
export const AGENTS_PATH = "AGENTS.md";
const AGENTS_START = "<!-- assemble:start -->";
const AGENTS_END = "<!-- assemble:end -->";

/** Wrap the bundled AGENTS.md body in idempotency markers. */
function assembleAgentsBlock(): string {
  const body = readFileSync(join(BUNDLED_SKILL_DIR, "AGENTS.md"), "utf8").trimEnd();
  return `${AGENTS_START}\n${body}\n${AGENTS_END}`;
}

/** Insert (or refresh) the assemble block in a repo-root AGENTS.md without
 * clobbering the user's own content. Returns the file's new text. */
export function mergeAgentsMd(existing: string | null, block: string): string {
  if (existing == null) return block + "\n";
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start) {
    // Replace the stale assemble block in place, preserving surrounding content.
    const before = existing.slice(0, start);
    const after = existing.slice(end + AGENTS_END.length);
    return before + block + after;
  }
  // No assemble block yet — append after the user's content.
  return existing.trimEnd() + "\n\n" + block + "\n";
}

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

  const created = ["assemble.config.yaml", ".assemble/"];

  // Install the `assemble` Claude skill at the repo level (not globally) so
  // Claude Code discovers it for this project. Copied fresh on init; a stale
  // copy is wiped first so renamed/removed references never linger.
  if (existsSync(BUNDLED_SKILL_DIR)) {
    const skillDest = join(dir, SKILL_PATH);
    mkdirSync(dirname(skillDest), { recursive: true });
    rmSync(skillDest, { recursive: true, force: true });
    cpSync(BUNDLED_SKILL_DIR, skillDest, { recursive: true });
    created.push(SKILL_PATH + "/");

    // Codex analog: merge an assemble block into repo-root AGENTS.md so
    // `provider: codex` workers get the same protocol. Preserves user content.
    const agentsDest = join(dir, AGENTS_PATH);
    const prior = existsSync(agentsDest) ? readFileSync(agentsDest, "utf8") : null;
    writeFileSync(agentsDest, mergeAgentsMd(prior, assembleAgentsBlock()));
    created.push(prior == null ? AGENTS_PATH : AGENTS_PATH + " (updated)");
  }

  // Architectural memory is opt-in (memory.enabled: false by default), so init
  // does not seed ARCHI.md. When enabled, `memory-sync` bootstraps the file on
  // first run (create-if-missing in syncMemory).
  return { created };
}
