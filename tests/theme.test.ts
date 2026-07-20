import { describe, it, expect } from "vitest";
import { renderAgent } from "../src/theme.js";
import type { AssembleConfig } from "../src/config.js";

const cfg = {
  project: "MyApp",
  agents: { thor: { role: "implementer", provider: "claude", model: "opus" } },
  stages: [{ id: "implement", agent: "thor", gate: "auto", prompt: "x" }],
} as AssembleConfig;

describe("renderAgent", () => {
  it("renders Name (role)", () => {
    expect(renderAgent("thor", cfg)).toBe("thor (implementer)");
  });
  it("never throws on unknown keys", () => {
    expect(renderAgent("loki", cfg)).toBe("loki (unknown)");
  });
});
