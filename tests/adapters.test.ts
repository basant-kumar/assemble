import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
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
  it("normalizes a missing usage block to zero tokens instead of throwing", async () => {
    const bin = fakeBin(`echo '{"result":"no usage field"}'`);
    const r = await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() });
    expect(r.tokensIn).toBe(0);
    expect(r.tokensOut).toBe(0);
  });
  it("grants implementers write access so headless edits aren't auto-denied", async () => {
    const argfile = join(mkdtempSync(join(tmpdir(), "asm-args-")), "args");
    const bin = fakeBin(`printf '%s\\n' "$@" > ${argfile}\n` + `echo '{"result":"ok"}'`);
    await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd() });
    expect(readFileSync(argfile, "utf8")).toContain("--dangerously-skip-permissions");
  });
  it("keeps reviewers read-only (no write-permission flag)", async () => {
    const argfile = join(mkdtempSync(join(tmpdir(), "asm-args-")), "args");
    const bin = fakeBin(`printf '%s\\n' "$@" > ${argfile}\n` + `echo '{"result":"ok"}'`);
    await claudeAdapter(bin).run({ prompt: "hi", model: "opus", cwd: process.cwd(), readOnly: true });
    expect(readFileSync(argfile, "utf8")).not.toContain("--dangerously-skip-permissions");
  });
});

describe("codexAdapter", () => {
  it("parses real token counts from the --json NDJSON event stream", async () => {
    const bin = fakeBin(
      `printf '%s\\n' '{"type":"message","text":"plain output"}' '{"type":"token_count","input_tokens":9,"output_tokens":6}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output).toBe("plain output");
    expect(r.tokensIn).toBe(9);
    expect(r.tokensOut).toBe(6);
  });
  it("accumulates text across multiple message events", async () => {
    const bin = fakeBin(
      `printf '%s\\n' '{"type":"message","text":"part one "}' '{"type":"message","text":"part two"}' '{"type":"token_count","input_tokens":2,"output_tokens":3}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output).toBe("part one part two");
  });
  it("throws AdapterError on an unparsable event line", async () => {
    const bin = fakeBin(`echo 'not json'`);
    await expect(codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() }))
      .rejects.toThrow(AdapterError);
  });
  it("parses the current item/turn NDJSON schema (last agent_message wins)", async () => {
    const bin = fakeBin(
      `printf '%s\\n' ` +
      `'{"type":"item.completed","item":{"type":"agent_message","text":"thinking out loud"}}' ` +
      `'{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}' ` +
      `'{"type":"turn.completed","usage":{"input_tokens":42,"output_tokens":13}}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.output).toBe("final answer");
    expect(r.tokensIn).toBe(42);
    expect(r.tokensOut).toBe(13);
  });
  it("captures the thread id from thread.started for resume", async () => {
    const bin = fakeBin(
      `printf '%s\\n' ` +
      `'{"type":"thread.started","thread_id":"abc-123"}' ` +
      `'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`
    );
    const r = await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    expect(r.sessionId).toBe("abc-123");
  });
  it("surfaces a fatal error event as an AdapterError", async () => {
    const bin = fakeBin(`echo '{"type":"error","message":"model not supported"}'`);
    await expect(codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() }))
      .rejects.toThrow(/model not supported/);
  });
  it("surfaces a turn.failed event as an AdapterError", async () => {
    const bin = fakeBin(`echo '{"type":"turn.failed","error":{"message":"boom"}}'`);
    await expect(codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() }))
      .rejects.toThrow(/boom/);
  });
  it("runs non-interactively: never-approval + read-only sandbox for reviewers", async () => {
    const argfile = join(mkdtempSync(join(tmpdir(), "asm-args-")), "args");
    const bin = fakeBin(
      `printf '%s\\n' "$@" > ${argfile}\n` +
      `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`
    );
    await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd(), readOnly: true });
    const args = readFileSync(argfile, "utf8");
    expect(args).toContain(`approval_policy="never"`);
    expect(args).toContain(`sandbox_mode="read-only"`);
    expect(args).toContain("--skip-git-repo-check");
  });
  it("gives implementers a workspace-write sandbox", async () => {
    const argfile = join(mkdtempSync(join(tmpdir(), "asm-args-")), "args");
    const bin = fakeBin(
      `printf '%s\\n' "$@" > ${argfile}\n` +
      `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`
    );
    await codexAdapter(bin).run({ prompt: "hi", model: "gpt-5-codex", cwd: process.cwd() });
    const args = readFileSync(argfile, "utf8");
    expect(args).toContain(`sandbox_mode="workspace-write"`);
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
