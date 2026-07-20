import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { initProject } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { runConfigureWizard, inferArchetype, ROSTER, type WizardIO, type Choice } from "../src/configure.js";

/**
 * WizardIO that replays scripted answers. `select` answers match a choice by
 * value (stringified) or by name; `input` answers are used verbatim, and an
 * empty string falls back to the prompt's default (as a real TTY would).
 */
function scriptedIO(answers: string[]): WizardIO & { remaining: () => number } {
  let i = 0;
  return {
    select<T>(message: string, choices: Choice<T>[], def?: T): Promise<T> {
      // The team-shape (mode) prompt is orthogonal to hero config: tests that
      // don't exercise it may omit an answer and get the default. Only consume a
      // scripted answer here if the next one is an actual mode value.
      if (message.startsWith("Team shape")) {
        const next = answers[i];
        const hit = next !== undefined && choices.find(c => String(c.value) === next);
        if (hit) { i++; return Promise.resolve(hit.value); }
        return Promise.resolve(def as T);
      }
      const a = answers[i++];
      if (a === undefined) throw new Error(`ran out of scripted answers at select: ${message}`);
      if (a === "" && def !== undefined) return Promise.resolve(def); // Enter = keep default
      const found = choices.find(c => String(c.value) === a || c.name === a);
      if (!found) throw new Error(`no choice '${a}' for: ${message} (have: ${choices.map(c => c.value).join(", ")})`);
      return Promise.resolve(found.value);
    },
    input(_message: string, def = ""): Promise<string> {
      const a = answers[i++];
      return Promise.resolve(a === undefined || a === "" ? def : a);
    },
    out() {},
    remaining: () => answers.length - i,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "asm-cfg-"));
  initProject(dir); // thor (implementer, claude/opus) + vision (code reviewer, codex/gpt-5-codex)
  return dir;
}

describe("inferArchetype", () => {
  it("routes heroes by keyword", () => {
    expect(inferArchetype("vision", "code reviewer")).toBe("reviewer");
    expect(inferArchetype("strange", "architect / planner")).toBe("architect");
    expect(inferArchetype("hawkeye", "precision minor edits")).toBe("precision");
    expect(inferArchetype("jarvis", "memory sync")).toBe("fast");
    expect(inferArchetype("thor", "implementer")).toBe("implementer");
  });
});

describe("runConfigureWizard", () => {
  it("accepting the recommendation applies the archetype preset per hero", async () => {
    const dir = setup();
    // pick thor -> accept; pick vision -> accept; then save & exit
    const io = scriptedIO(["thor", "accept", "vision", "accept", "__done__"]);
    await runConfigureWizard(dir, io);

    const cfg = loadConfig(dir);
    expect(cfg.agents.thor.provider).toBe("claude");
    expect(cfg.agents.thor.model).toBe("opus");
    expect(cfg.agents.vision.provider).toBe("codex");
    expect(cfg.agents.vision.effort).toBe("high");
    expect(cfg.pricing["gpt-5-codex"].input).toBeCloseTo(1.25 / 1_000_000);
    expect(io.remaining()).toBe(0);
  });

  it("cancel leaves a hero untouched", async () => {
    const dir = setup();
    const before = parse(readFileSync(join(dir, "assemble.config.yaml"), "utf8"));
    const io = scriptedIO(["thor", "cancel", "__done__"]);
    await runConfigureWizard(dir, io);
    const after = parse(readFileSync(join(dir, "assemble.config.yaml"), "utf8"));
    expect(after.agents.thor).toEqual(before.agents.thor);
  });

  it("switching provider to claude re-derives claude model/knob/pricing defaults", async () => {
    const dir = setup();
    // Edit vision (recommended codex/gpt-5-codex). Switch provider to claude and
    // accept every default: model must become opus, knob must be `thinking`,
    // and pricing must default to the claude rates — not the codex ones.
    const io = scriptedIO([
      "vision", "edit",
      "claude",  // provider -> claude
      "",        // model (default should now be opus, not gpt-5-codex)
      "",        // role
      "",        // skills
      "",        // thinking (default auto)
      "",        // timeout
      "",        // context_window
      "",        // max_output
      "",        // input $/Mtok (default 15)
      "",        // output $/Mtok (default 75)
      "__done__",
    ]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.vision.provider).toBe("claude");
    expect(cfg.agents.vision.model).toBe("opus");
    expect(cfg.agents.vision.effort).toBeUndefined();
    expect(cfg.pricing.opus.input).toBeCloseTo(15 / 1_000_000);
  });

  it("edit honors explicit overrides", async () => {
    const dir = setup();
    const io = scriptedIO([
      "thor", "edit",
      "codex",             // provider
      "gpt-5-codex-mini",  // model (select-only; must be a known model)
      "refactorer",        // role (constrained select; must be a valid role)
      "",                  // skills
      "low",               // effort
      "5m",                // timeout
      "200k",              // context_window
      "",                  // max_output
      "0.25",              // input $/Mtok
      "1",                 // output $/Mtok
      "__done__",
    ]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.thor.provider).toBe("codex");
    expect(cfg.agents.thor.model).toBe("gpt-5-codex-mini");
    expect(cfg.agents.thor.effort).toBe("low");
    expect(cfg.pricing["gpt-5-codex-mini"].output).toBeCloseTo(1 / 1_000_000);
  });

  it("can add a new hero that wasn't in the config", async () => {
    const dir = setup();
    const io = scriptedIO(["__add__", "banner", "accept", "__done__"]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.banner).toBeDefined();
    expect(cfg.agents.banner.provider).toBe("claude"); // implementer archetype
    expect(cfg.agents.banner.model).toBe("opus");
  });

  it("backfills the full roster into an older two-hero config without clobbering it", async () => {
    // Simulate a config written before the roster change: only thor + vision,
    // with a customized thor the user must not lose.
    const dir = mkdtempSync(join(tmpdir(), "asm-cfg-stale-"));
    const stale = {
      project: "legacy",
      agents: {
        thor: { role: "implementer", provider: "codex", model: "gpt-5-codex-mini", effort: "low" },
        vision: { role: "code reviewer", provider: "codex", model: "gpt-5-codex" },
      },
      stages: [
        { id: "implement", agent: "thor", gate: "auto", prompt: "x" },
        { id: "code-review", agent: "vision", gate: "human", prompt: "y" },
      ],
      pricing: { "gpt-5-codex": { input: 1.25 / 1_000_000, output: 10 / 1_000_000 } },
      utilityModel: "haiku",
    };
    writeFileSync(join(dir, "assemble.config.yaml"), stringify(stale));

    // Just open and save — the backfill happens on load.
    await runConfigureWizard(dir, scriptedIO(["__done__"]));

    const cfg = loadConfig(dir);
    // Every roster hero is now present...
    for (const { name } of ROSTER) expect(cfg.agents[name]).toBeDefined();
    // ...and the user's customized thor was preserved verbatim.
    expect(cfg.agents.thor.provider).toBe("codex");
    expect(cfg.agents.thor.model).toBe("gpt-5-codex-mini");
    expect(cfg.agents.thor.effort).toBe("low");
  });

  it("picking fable-5 pre-fills its Anthropic list price", async () => {
    const dir = setup();
    const io = scriptedIO([
      "thor", "edit",
      "claude",   // provider (thor already claude)
      "fable-5",  // model — newly known
      "", "",     // role, skills
      "",         // thinking
      "", "", "", // timeout, context_window, max_output
      "",         // input $/Mtok (default should be 10, not opus' 15)
      "",         // output $/Mtok (default should be 50)
      "__done__",
    ]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.thor.model).toBe("fable-5");
    expect(cfg.pricing["fable-5"].input).toBeCloseTo(10 / 1_000_000);
    expect(cfg.pricing["fable-5"].output).toBeCloseTo(50 / 1_000_000);
  });

  it("picking gpt-5.6-sol pre-fills its OpenAI list price", async () => {
    const dir = setup();
    const io = scriptedIO([
      "vision", "edit",
      "codex",        // provider (vision already codex)
      "gpt-5.6-sol",  // model — newly known
      "", "",         // role, skills
      "",             // effort
      "", "", "",     // timeout, context_window, max_output
      "",             // input $/Mtok (default 5)
      "",             // output $/Mtok (default 30)
      "__done__",
    ]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.vision.model).toBe("gpt-5.6-sol");
    expect(cfg.pricing["gpt-5.6-sol"].input).toBeCloseTo(5 / 1_000_000);
    expect(cfg.pricing["gpt-5.6-sol"].output).toBeCloseTo(30 / 1_000_000);
  });

  it("custom-model entry lets an unknown model through with hand-entered pricing", async () => {
    const dir = setup();
    const io = scriptedIO([
      "thor", "edit",
      "codex",              // provider
      "__custom__",         // model -> custom escape hatch
      "gpt-6-experimental", // custom model id
      "refactorer", "",     // role, skills
      "",                   // effort
      "", "", "",           // timeout, context_window, max_output
      "2",                  // input $/Mtok (no list price — hand-entered)
      "12",                 // output $/Mtok
      "__done__",
    ]);
    await runConfigureWizard(dir, io);
    const cfg = loadConfig(dir);
    expect(cfg.agents.thor.model).toBe("gpt-6-experimental");
    expect(cfg.pricing["gpt-6-experimental"].input).toBeCloseTo(2 / 1_000_000);
    expect(cfg.pricing["gpt-6-experimental"].output).toBeCloseTo(12 / 1_000_000);
  });
  it("writes the chosen mode and the loader expands it", async () => {
    const dir = setup();
    // Answer the team-shape prompt with 'duo', then save immediately.
    const io = scriptedIO(["duo", "__done__"]);
    await runConfigureWizard(dir, io);
    const doc = parse(readFileSync(join(dir, "assemble.config.yaml"), "utf8"));
    expect(doc.mode).toBe("duo");
    const cfg = loadConfig(dir);
    expect(cfg.stages.find(s => s.id === "implement")!.agent).toBe("writer");
    expect(cfg.stages.find(s => s.id === "code-review")!.agent).toBe("reviewer");
  });
  it("selecting full mode omits the mode field (roster used as written)", async () => {
    const dir = setup();
    const io = scriptedIO(["full", "__done__"]);
    await runConfigureWizard(dir, io);
    const doc = parse(readFileSync(join(dir, "assemble.config.yaml"), "utf8"));
    expect(doc.mode).toBeUndefined();
    expect(loadConfig(dir).stages.find(s => s.id === "implement")!.agent).toBe("thor");
  });
});
