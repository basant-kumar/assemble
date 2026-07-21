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
  // Resume a prior reviewer session/thread for incremental re-review. When set,
  // the adapter continues that conversation (with its accumulated findings)
  // instead of starting fresh. Inert on adapters that don't support resume.
  resumeSessionId?: string;
};
// `sessionId` is the provider's thread/session id, captured so a later run can
// resume the same conversation (see resumeSessionId). Undefined when the
// provider doesn't expose one.
export type RunResult = { output: string; tokensIn: number; tokensOut: number; sessionId?: string };
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
    async run({ prompt, model, cwd, thinking, timeoutMs, resumeSessionId }) {
      let env: NodeJS.ProcessEnv | undefined;
      const budget = thinking ? THINKING_BUDGET[thinking] : null;
      if (budget !== null) env = { ...process.env, MAX_THINKING_TOKENS: budget };
      const args = ["-p", prompt, "--model", model, "--output-format", "json"];
      // Resume the prior session so re-review keeps its accumulated context.
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      const stdout = await spawn(bin, args, cwd, { timeoutMs, env });
      let parsed: { result?: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      try { parsed = JSON.parse(stdout); }
      catch { throw new AdapterError(`claude returned non-JSON output: ${stdout.slice(0, 200)}`); }
      return {
        output: parsed.result ?? "",
        tokensIn: parsed.usage?.input_tokens ?? 0,
        tokensOut: parsed.usage?.output_tokens ?? 0,
        sessionId: parsed.session_id,
      };
    },
  };
}

type CodexEvent = { type?: string; text?: string; thread_id?: string; input_tokens?: number; output_tokens?: number };

export function codexAdapter(bin = "codex"): Adapter {
  return {
    name: "codex",
    async run({ prompt, model, cwd, effort, timeoutMs, resumeSessionId }) {
      // Resume the prior thread so re-review keeps its accumulated findings.
      // `codex exec resume <id>` inherits the original session's sandbox and
      // does not accept --sandbox/--color.
      const args = resumeSessionId
        ? ["exec", "resume", resumeSessionId, "--json", "--model", model]
        : ["exec", "--json", "--model", model];
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push(prompt);
      const stdout = await spawn(bin, args, cwd, { timeoutMs });
      const lines = stdout.trim().split("\n").filter(Boolean);
      let output = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let sessionId: string | undefined;
      for (const line of lines) {
        let event: CodexEvent;
        try { event = JSON.parse(line); }
        catch { throw new AdapterError(`codex returned a non-JSON event line: ${line.slice(0, 200)}`); }
        // Capture the thread id from the first thread.started event so a later
        // run can resume this conversation.
        if (event.type === "thread.started" && typeof event.thread_id === "string" && !sessionId)
          sessionId = event.thread_id;
        if (event.type === "message" && typeof event.text === "string") output += event.text;
        if (event.type === "token_count") {
          tokensIn = Number(event.input_tokens ?? tokensIn);
          tokensOut = Number(event.output_tokens ?? tokensOut);
        }
      }
      return { output, tokensIn, tokensOut, sessionId };
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
