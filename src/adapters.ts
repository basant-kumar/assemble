import { execFile } from "node:child_process";
import type { Thinking, Effort } from "./config.js";

export type RunOpts = {
  prompt: string;
  model: string;
  cwd: string;
  // Resolved by the engine from the agent's config. Each adapter applies only
  // the knobs its provider understands and ignores the rest.
  thinking?: Thinking; // claude
  effort?: Effort; // codex
  timeoutMs?: number; // both — child is killed if it runs longer
};
export type RunResult = { output: string; tokensIn: number; tokensOut: number };
export interface Adapter { readonly name: string; run(opts: RunOpts): Promise<RunResult> }
export class AdapterError extends Error {}

type SpawnOpts = { timeoutMs?: number; env?: NodeJS.ProcessEnv };

export function spawn(bin: string, args: string[], cwd: string, opts: SpawnOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 0, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed && opts.timeoutMs)
            reject(new AdapterError(`${bin} timed out after ${opts.timeoutMs}ms`));
          else reject(new AdapterError(`${bin} failed: ${stderr || err.message}`));
        } else resolve(stdout);
      },
    );
  });
}

// Claude Code reads a thinking-token budget from MAX_THINKING_TOKENS. "auto"
// (and undefined) leaves it unset so the model decides on its own.
const THINKING_BUDGET: Record<Thinking, string | null> = { off: "0", auto: null, extended: "31999" };

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    name: "claude",
    async run({ prompt, model, cwd, thinking, timeoutMs }) {
      let env: NodeJS.ProcessEnv | undefined;
      const budget = thinking ? THINKING_BUDGET[thinking] : null;
      if (budget !== null) env = { ...process.env, MAX_THINKING_TOKENS: budget };
      const stdout = await spawn(bin, ["-p", prompt, "--model", model, "--output-format", "json"], cwd, { timeoutMs, env });
      let parsed: { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      try { parsed = JSON.parse(stdout); }
      catch { throw new AdapterError(`claude returned non-JSON output: ${stdout.slice(0, 200)}`); }
      return {
        output: parsed.result ?? "",
        tokensIn: parsed.usage?.input_tokens ?? 0,
        tokensOut: parsed.usage?.output_tokens ?? 0,
      };
    },
  };
}

type CodexEvent = { type?: string; text?: string; input_tokens?: number; output_tokens?: number };

export function codexAdapter(bin = "codex"): Adapter {
  return {
    name: "codex",
    async run({ prompt, model, cwd, effort, timeoutMs }) {
      const args = ["exec", "--json", "--model", model];
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push(prompt);
      const stdout = await spawn(bin, args, cwd, { timeoutMs });
      const lines = stdout.trim().split("\n").filter(Boolean);
      let output = "";
      let tokensIn = 0;
      let tokensOut = 0;
      for (const line of lines) {
        let event: CodexEvent;
        try { event = JSON.parse(line); }
        catch { throw new AdapterError(`codex returned a non-JSON event line: ${line.slice(0, 200)}`); }
        if (event.type === "message" && typeof event.text === "string") output += event.text;
        if (event.type === "token_count") {
          tokensIn = Number(event.input_tokens ?? tokensIn);
          tokensOut = Number(event.output_tokens ?? tokensOut);
        }
      }
      return { output, tokensIn, tokensOut };
    },
  };
}

export function getAdapter(provider: string, bins: Record<string, string> = {}): Adapter {
  switch (provider) {
    case "claude": return claudeAdapter(bins.claude);
    case "codex": return codexAdapter(bins.codex);
    default: throw new AdapterError(`unknown provider '${provider}' (M1 supports: claude, codex)`);
  }
}
