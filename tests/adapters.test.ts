import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, codexAdapter, getAdapter, AdapterError } from "../src/adapters.js";

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "asm-bin-"));
  const p = join(dir, "fake");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("claudeAdapter", () => {
  it("parses JSON output and usage", async () => {
    const bin = fakeBin(`echo '{"result":"done: $2","usage":{"input_tokens":11,"output_tokens":7}}'`);
    const r = await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() });
    expect(r.output).toContain("done");
    expect(r.tokensIn).toBe(11);
    expect(r.tokensOut).toBe(7);
  });
  it("throws AdapterError on non-zero exit with stderr", async () => {
    const bin = fakeBin(`echo "boom" >&2; exit 3`);
    await expect(claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() }))
      .rejects.toThrow(/boom/);
  });
});

describe("codexAdapter", () => {
  it("returns plain text with zero token counts", async () => {
    const bin = fakeBin(`echo "plain output"`);
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output.trim()).toBe("plain output");
    expect(r.tokensIn).toBe(0);
  });
});

describe("getAdapter", () => {
  it("resolves known providers", () => {
    expect(getAdapter("claude").name).toBe("claude");
    expect(getAdapter("codex").name).toBe("codex");
  });
  it("throws on unknown provider", () => {
    expect(() => getAdapter("skynet")).toThrow(AdapterError);
  });
});
