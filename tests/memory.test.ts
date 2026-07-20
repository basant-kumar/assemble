import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { appendEvent, readLedger } from "../src/ledger.js";
import type { Adapter } from "../src/adapters.js";
import {
  resolveMemoryAgent,
  lastSyncedSha,
  buildMemoryPrompt,
  syncMemory,
} from "../src/memory.js";

const YAML = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  jarvis: { role: memory keeper, provider: fake, model: haiku }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
`;

function project(yaml = YAML) {
  const dir = mkdtempSync(join(tmpdir(), "asm-mem-"));
  writeFileSync(join(dir, "assemble.config.yaml"), yaml);
  return { dir, config: loadConfig(dir) };
}

// A fake `git` that answers rev-parse/log/diff/show with fixed output so
// collectReleaseDiff has something to work with without a real repo.
function fakeGit(sha = "abc1234def"): string {
  const dir = mkdtempSync(join(tmpdir(), "asm-git-"));
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  rev-parse) echo ${sha} ;;\n  *) echo "fake-diff" ;;\nesac\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const memAdapter = (output: string, calls: string[] = []): Adapter => ({
  name: "fake",
  async run({ model, prompt }) { calls.push(model); void prompt; return { output, tokensIn: 5, tokensOut: 9 }; },
});

describe("resolveMemoryAgent", () => {
  it("prefers the explicitly configured memory.agent", () => {
    const { config } = project();
    expect(resolveMemoryAgent(config)).toBe("jarvis");
  });

  it("falls back to an agent whose role mentions 'memory'", () => {
    const yaml = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
  friday: { role: architectural memory, provider: fake, model: haiku }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
`;
    const { config } = project(yaml);
    // no memory.agent set -> resolves by role
    expect(config.memory.agent).toBeUndefined();
    expect(resolveMemoryAgent(config)).toBe("friday");
  });

  it("throws when no memory agent can be resolved", () => {
    const yaml = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
`;
    const { config } = project(yaml);
    expect(() => resolveMemoryAgent(config)).toThrow(/no memory agent/);
  });

  it("throws when memory.agent names an undefined agent", () => {
    const yaml = `
project: MyApp
agents:
  thor: { role: implementer, provider: fake, model: opus }
memory: { agent: ghost }
stages:
  - { id: implement, agent: thor, gate: human, prompt: "Implement." }
`;
    const { config } = project(yaml);
    expect(() => resolveMemoryAgent(config)).toThrow(/not a defined agent/);
  });
});

describe("lastSyncedSha", () => {
  it("returns undefined with no sync events", () => {
    const { dir } = project();
    expect(lastSyncedSha(readLedger(dir))).toBeUndefined();
  });

  it("returns the most recent memory_synced sha", () => {
    const { dir } = project();
    appendEvent(dir, { type: "memory_synced", stage: "memory-sync", sha: "aaa1111" });
    appendEvent(dir, { type: "memory_synced", stage: "memory-sync", sha: "bbb2222" });
    expect(lastSyncedSha(readLedger(dir))).toBe("bbb2222");
  });
});

describe("buildMemoryPrompt", () => {
  it("embeds the current doc and the diff", () => {
    const p = buildMemoryPrompt("# ARCHI\ncurrent", "Commits:\nx feat");
    expect(p).toContain("# ARCHI\ncurrent");
    expect(p).toContain("Commits:\nx feat");
    expect(p).toContain("COMPLETE updated ARCHI.md");
  });

  it("notes a missing diff", () => {
    expect(buildMemoryPrompt("cur", "")).toContain("(no diff available)");
  });
});

describe("syncMemory", () => {
  it("creates ARCHI.md when missing and records events", async () => {
    const { dir, config } = project();
    const path = join(dir, config.memory.path);
    expect(existsSync(path)).toBe(false);

    const r = await syncMemory(dir, config, {
      adapter: memAdapter("# ARCHI.md\n\nUpdated memory."),
      gitBin: fakeGit("deadbeef123"),
    });

    expect(r.created).toBe(true);
    expect(r.updated).toBe(true);
    expect(r.path).toBe("docs/assemble/ARCHI.md");
    expect(r.headSha).toBe("deadbeef123");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Updated memory.");

    const events = readLedger(dir);
    const cost = events.find(e => e.type === "cost" && e.stage === "memory-sync");
    expect(cost?.worker).toBe("jarvis");
    expect(cost?.tokensIn).toBe(5);
    const synced = events.find(e => e.type === "memory_synced");
    expect(synced?.sha).toBe("deadbeef123");
  });

  it("updates an existing file and diffs against the last synced sha", async () => {
    const { dir, config } = project();
    const path = join(dir, config.memory.path);
    // pre-create with old content + a prior sync baseline
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "docs/assemble"), { recursive: true });
    writeFileSync(path, "# ARCHI.md\n\nold content\n");
    appendEvent(dir, { type: "memory_synced", stage: "memory-sync", sha: "base999" });

    const r = await syncMemory(dir, config, {
      adapter: memAdapter("# ARCHI.md\n\nfresh content"),
      gitBin: fakeGit("newhead77"),
    });

    expect(r.created).toBe(false);
    expect(r.updated).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("fresh content");
    expect(lastSyncedSha(readLedger(dir))).toBe("newhead77");
  });

  it("reports no update when the agent returns identical content", async () => {
    const { dir, config } = project();
    const r = await syncMemory(dir, config, {
      adapter: memAdapter(""), // empty output -> no write
      gitBin: fakeGit(),
    });
    expect(r.updated).toBe(false);
  });

  it("works without a git repo (null head, empty diff)", async () => {
    const { dir, config } = project();
    const r = await syncMemory(dir, config, {
      adapter: memAdapter("# ARCHI.md\n\ncontent"),
      gitBin: "false", // rev-parse fails -> no git path
    });
    expect(r.headSha).toBeNull();
    expect(r.updated).toBe(true);
    const synced = readLedger(dir).find(e => e.type === "memory_synced");
    expect(synced?.sha).toBeUndefined();
  });
});
