import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { ConfigError, loadConfig, THINKING_LEVELS, EFFORT_LEVELS } from "./config.js";

export type Choice<T> = { name: string; value: T; description?: string };

/**
 * Higher-level IO so the wizard can drive a real arrow-key TUI in the CLI while
 * tests replay scripted answers. `select` returns the chosen value; `input`
 * returns the entered string (or the default on an empty line).
 */
export type WizardIO = {
  select<T>(message: string, choices: Choice<T>[], def?: T): Promise<T>;
  input(message: string, def?: string): Promise<string>;
  out(s: string): void;
};

const MTOK = 1_000_000;
const DONE = "__done__";
const ADD = "__add__";

type Provider = "claude" | "codex";

type AgentDoc = {
  role: string;
  provider: string;
  model: string;
  skills?: string[];
  thinking?: string;
  effort?: string;
  timeout?: string;
  context_window?: string;
  max_output?: string;
};

type Preset = {
  role: string;
  provider: Provider;
  model: string;
  thinking?: string;
  effort?: string;
  timeout: string;
  context_window: string;
  /** $ per million tokens; converted to $/token on write. */
  pricing: { input: number; output: number };
  why: string;
};

/** Sensible per-provider fallback when the user switches provider mid-edit. */
const PROVIDER_DEFAULTS: Record<Provider, { model: string; thinking?: string; effort?: string; pricing: { input: number; output: number } }> = {
  claude: { model: "opus", thinking: "auto", pricing: { input: 15, output: 75 } },
  codex: { model: "gpt-5-codex", effort: "high", pricing: { input: 1.25, output: 10 } },
};

/** Recommended profiles by hero archetype — accepted wholesale or tweaked. */
const PRESETS: Record<string, Preset> = {
  architect: { role: "architect", provider: "claude", model: "opus", thinking: "extended", timeout: "20m", context_window: "200k", pricing: { input: 15, output: 75 }, why: "deep reasoning for plan/design work" },
  reviewer: { role: "code reviewer", provider: "codex", model: "gpt-5-codex", effort: "high", timeout: "20m", context_window: "400k", pricing: { input: 1.25, output: 10 }, why: "cross-provider heavyweight for review" },
  implementer: { role: "implementer", provider: "claude", model: "opus", thinking: "auto", timeout: "15m", context_window: "200k", pricing: { input: 15, output: 75 }, why: "strong general implementer" },
  worker: { role: "implementer", provider: "claude", model: "sonnet", thinking: "auto", timeout: "10m", context_window: "200k", pricing: { input: 3, output: 15 }, why: "workhorse for big batches / refactors" },
  fast: { role: "fast worker", provider: "claude", model: "haiku", thinking: "off", timeout: "5m", context_window: "200k", pricing: { input: 1, output: 5 }, why: "cheap + fast for small batches / memory" },
  precision: { role: "precision editor", provider: "codex", model: "gpt-5-codex-mini", effort: "low", timeout: "5m", context_window: "200k", pricing: { input: 0.25, output: 1 }, why: "cheap precision for minor edits" },
};

/**
 * The full hero roster (design doc §Naming layer). Each hero maps to a model
 * profile (archetype) but keeps its own display role. Engine components
 * (fury/pepper/heimdall/ronin/Damage Control) are orchestration internals, not
 * model-backed agents, so they are intentionally NOT configurable heroes here.
 */
export const ROSTER: { name: string; archetype: keyof typeof PRESETS; role: string }[] = [
  { name: "stark", archetype: "architect", role: "architect" },
  { name: "shuri", archetype: "architect", role: "UI designer" },
  { name: "strange", archetype: "architect", role: "plan/design reviewer" },
  { name: "vision", archetype: "reviewer", role: "code reviewer" },
  { name: "danvers", archetype: "reviewer", role: "final reviewer" },
  { name: "thor", archetype: "implementer", role: "implementer" },
  { name: "hulk", archetype: "worker", role: "refactorer" },
  { name: "spidey", archetype: "fast", role: "small batches" },
  { name: "hawkeye", archetype: "precision", role: "minor edits" },
  { name: "cap", archetype: "worker", role: "release" },
  { name: "jarvis", archetype: "fast", role: "memory" },
];

/** Valid roles for the constrained role picker (derived from the roster). */
export const ROLES: string[] = [...new Set(ROSTER.map(r => r.role))];

/** Known models per provider — the model picker is select-only to prevent typos. */
export const KNOWN_MODELS: Record<Provider, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5-codex", "gpt-5-codex-mini"],
};

/** Build the full default config (all roster heroes seeded) — used by `assemble init`. */
export function defaultRosterDoc(project: string): Record<string, unknown> {
  const agents: Record<string, AgentDoc> = {};
  const pricing: Record<string, { input: number; output: number }> = {};
  for (const { name, archetype, role } of ROSTER) {
    const preset = PRESETS[archetype];
    agents[name] = agentFromPreset(preset, role);
    pricing[preset.model] = {
      input: preset.pricing.input / MTOK,
      output: preset.pricing.output / MTOK,
    };
  }
  return {
    project,
    agents,
    stages: [
      { id: "implement", agent: "thor", gate: "auto", prompt: "Implement the approved plan. Follow existing project conventions." },
      { id: "code-review", agent: "vision", gate: "human", prompt: "Review the latest diff. End with exactly one verdict: APPROVED, REQUEST_CHANGES, or BLOCKED." },
    ],
    pricing,
    utilityModel: "haiku",
  };
}

const CONFIG_HEADER = `# assemble — Avengers, assemble your AI dev team (default MCU theme; names are a swappable skin)
# Every hero below is pre-configured with a sensible default profile.
# Run \`assemble configure\` to tweak any of them; unpriced models cost $0.`;

/** Full default config as YAML text (header comment + seeded roster). */
export function defaultConfigYaml(project: string): string {
  return `${CONFIG_HEADER}\n${stringify(defaultRosterDoc(project))}`;
}

/** Infer the archetype from the hero's name + role using keyword matching. */
export function inferArchetype(name: string, role: string): keyof typeof PRESETS {
  const s = `${name} ${role}`.toLowerCase();
  if (/review/.test(s)) return "reviewer";
  if (/architect|plan|design/.test(s)) return "architect";
  if (/precision|minor|delta/.test(s)) return "precision";
  if (/memory|sync|compact|triage/.test(s)) return "fast";
  if (/small|fast|cheap/.test(s)) return "fast";
  if (/refactor|batch|big|worker/.test(s)) return "worker";
  return "implementer";
}

function agentFromPreset(p: Preset, role: string, skills?: string[]): AgentDoc {
  const a: AgentDoc = { role, provider: p.provider, model: p.model };
  if (skills?.length) a.skills = skills;
  if (p.provider === "claude" && p.thinking && p.thinking !== "auto") a.thinking = p.thinking;
  if (p.provider === "codex" && p.effort) a.effort = p.effort;
  a.timeout = p.timeout;
  a.context_window = p.context_window;
  return a;
}

function summarizePreset(p: Preset): string {
  const knob = p.provider === "claude" ? `thinking=${p.thinking}` : `effort=${p.effort}`;
  return `${p.provider}/${p.model} · ${knob} · ${p.timeout} · ctx ${p.context_window} · $${p.pricing.input}/$${p.pricing.output} per Mtok`;
}

function summarizeAgent(a: AgentDoc): string {
  const knob = a.provider === "claude" ? `thinking=${a.thinking ?? "auto"}` : `effort=${a.effort ?? "medium"}`;
  return `${a.provider}/${a.model} · ${knob}`;
}

function splitCsv(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

/** Per-knob edit flow. Switching provider re-derives model/knob/pricing defaults. */
async function editHero(io: WizardIO, preset: Preset, cur: AgentDoc, role0: string): Promise<{ agent: AgentDoc; rates: { input: number; output: number } }> {
  const provider = await io.select<Provider>("provider", [
    { name: "claude", value: "claude" },
    { name: "codex", value: "codex" },
  ], preset.provider);

  // When the chosen provider matches the recommendation, use its values;
  // otherwise fall back to that provider's sane defaults (this is the fix for
  // "picked claude but was asked for codex settings").
  const base = provider === preset.provider
    ? { model: preset.model, thinking: preset.thinking, effort: preset.effort, pricing: preset.pricing }
    : { ...PROVIDER_DEFAULTS[provider] };

  const modelDef = provider === cur.provider ? (cur.model || base.model) : base.model;
  // Model & role are select-only. If the current value isn't in the known list
  // (e.g. an older hand-edited config), keep it selectable so we never silently
  // drop it — but new picks come from the constrained menu.
  const known = KNOWN_MODELS[provider];
  const modelChoices = (known.includes(modelDef) ? known : [modelDef, ...known]).map(m => ({ name: m, value: m }));
  const model = await io.select("model", modelChoices, modelDef);
  const roleDef = cur.role || role0;
  const roleChoices = (ROLES.includes(roleDef) ? ROLES : [roleDef, ...ROLES]).map(r => ({ name: r, value: r }));
  const role = await io.select("role", roleChoices, roleDef);
  const skills = splitCsv(await io.input("skills (comma-separated, blank for none)", (cur.skills ?? []).join(", ")));

  const agent: AgentDoc = { role, provider, model };
  if (skills.length) agent.skills = skills;

  if (provider === "claude") {
    const thinking = await io.select("thinking", THINKING_LEVELS.map(v => ({ name: v, value: v })), base.thinking ?? "auto");
    if (thinking !== "auto") agent.thinking = thinking; // auto is the default — keep the file clean
  } else {
    agent.effort = await io.select("effort", EFFORT_LEVELS.map(v => ({ name: v, value: v })), base.effort ?? "medium");
  }

  const timeout = await io.input("timeout (blank for none)", cur.timeout ?? preset.timeout);
  if (timeout) agent.timeout = timeout;
  const ctx = await io.input("context_window (advisory, blank to skip)", cur.context_window ?? preset.context_window);
  if (ctx) agent.context_window = ctx;
  const maxOut = await io.input("max_output (advisory, blank to skip)", cur.max_output ?? "");
  if (maxOut) agent.max_output = maxOut;

  const inRate = await io.input("input $/Mtok", String(base.pricing.input));
  const outRate = await io.input("output $/Mtok", String(base.pricing.output));
  return { agent, rates: { input: Number(inRate) || 0, output: Number(outRate) || 0 } };
}

async function configureHero(io: WizardIO, name: string, agents: Record<string, AgentDoc>, pricing: Record<string, { input: number; output: number }>): Promise<void> {
  const cur: AgentDoc = agents[name] ?? ({} as AgentDoc);
  const preset = PRESETS[inferArchetype(name, cur.role ?? "")];
  const role = cur.role || preset.role;

  io.out(`\n${name} (${role})`);
  io.out(`  recommended: ${summarizePreset(preset)}`);
  io.out(`  why: ${preset.why}`);

  const action = await io.select(`apply to ${name}`, [
    { name: `Accept recommendation (${preset.provider}/${preset.model})`, value: "accept" },
    { name: "Edit each setting…", value: "edit" },
    { name: "Cancel (leave unchanged)", value: "cancel" },
  ], "accept");
  if (action === "cancel") return;

  let agent: AgentDoc;
  let rates: { input: number; output: number };
  if (action === "edit") {
    ({ agent, rates } = await editHero(io, preset, cur, role));
  } else {
    agent = agentFromPreset(preset, role, cur.skills);
    rates = preset.pricing;
  }

  agents[name] = agent;
  pricing[agent.model] = { input: rates.input / MTOK, output: rates.output / MTOK };
  io.out(`  ✔ ${name} → ${summarizeAgent(agent)}`);
}

/**
 * Interactive, menu-driven wizard. Shows all heroes with their current model,
 * lets the user pick one to configure (arrow keys in the CLI), add new heroes,
 * or save & exit. Each hero shows a recommendation you accept or edit — the
 * wizard never asks you to build a profile from scratch. Rewrites
 * assemble.config.yaml in place on save (YAML comments are not preserved).
 */
export async function runConfigureWizard(dir: string, io: WizardIO): Promise<{ path: string }> {
  const path = join(dir, "assemble.config.yaml");
  if (!existsSync(path)) throw new ConfigError(`no assemble.config.yaml in ${dir} — run \`assemble init\` first`);

  const doc = (parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
  const agents = (doc.agents ??= {}) as Record<string, AgentDoc>;
  const pricing = (doc.pricing ??= {}) as Record<string, { input: number; output: number }>;

  // Backfill any roster heroes missing from an older/partial config so the full
  // team always shows up. Existing entries are never overwritten — only gaps are
  // filled — so user customizations survive.
  for (const { name, archetype, role } of ROSTER) {
    if (agents[name]) continue;
    const preset = PRESETS[archetype];
    agents[name] = agentFromPreset(preset, role);
    pricing[preset.model] ??= {
      input: preset.pricing.input / MTOK,
      output: preset.pricing.output / MTOK,
    };
  }

  const heroes = Object.keys(agents);

  for (;;) {
    const choices: Choice<string>[] = heroes.map(name => ({
      name: `${name.padEnd(12)} ${(agents[name].role || "—").padEnd(18)} ${summarizeAgent(agents[name])}`,
      value: name,
    }));
    choices.push({ name: "➕ Add a hero", value: ADD });
    choices.push({ name: "✔ Save & exit", value: DONE });

    const pick = await io.select("Configure which hero?", choices, DONE);
    if (pick === DONE) break;

    if (pick === ADD) {
      const name = (await io.input("new hero name")).trim();
      if (!name) continue;
      if (!heroes.includes(name)) {
        heroes.push(name);
        agents[name] = { role: "", provider: "claude", model: "opus" };
      }
      await configureHero(io, name, agents, pricing);
      continue;
    }

    await configureHero(io, pick, agents, pricing);
  }

  writeFileSync(path, stringify(doc));
  io.out(`\n✔ wrote ${path}`);

  // Re-validate through the real loader so a bad entry surfaces now rather than
  // at the next `assemble run`.
  try {
    loadConfig(dir);
    io.out("✔ config is valid");
  } catch (e) {
    io.out(`⚠ config written but does not validate: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { path };
}
