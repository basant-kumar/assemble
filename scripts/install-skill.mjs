#!/usr/bin/env node
// Copies the bundled `assemble` skill into the user's Claude skills directory
// (~/.claude/skills/assemble) so Claude Code can discover it. Runs on install.
//
// Never fails the install: any error is logged and swallowed (exit 0). Skip with
// ASSEMBLE_SKIP_SKILL_INSTALL=1 or in CI.
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

function main() {
  if (process.env.ASSEMBLE_SKIP_SKILL_INSTALL || process.env.CI) {
    console.log("assemble: skipping skill install (ASSEMBLE_SKIP_SKILL_INSTALL/CI set)");
    return;
  }
  const home = homedir();
  if (!home) return;

  const src = join(HERE, "..", "skills", "assemble");
  if (!existsSync(src)) return; // not present in this layout — nothing to do

  const destRoot = join(home, ".claude", "skills");
  const dest = join(destRoot, "assemble");

  mkdirSync(destRoot, { recursive: true });
  // Force update: wipe any existing copy so stale files (renamed/removed
  // references, old SKILL.md) never linger. Then copy the bundled skill fresh.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`assemble: force-updated skill → ${dest}`);
}

try {
  main();
} catch (err) {
  console.warn(
    `assemble: could not install Claude skill (non-fatal): ${err instanceof Error ? err.message : err}`,
  );
}
