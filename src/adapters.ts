import { execFile } from "node:child_process";

export type RunOpts = { prompt: string; model: string; cwd: string };
export type RunResult = { output: string; tokensIn: number; tokensOut: number };
export interface Adapter { readonly name: string; run(opts: RunOpts): Promise<RunResult> }
export class AdapterError extends Error {}

function spawn(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new AdapterError(`${bin} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    name: "claude",
    async run({ prompt, model, cwd }) {
      const stdout = await spawn(bin, ["-p", prompt, "--model", model, "--output-format", "json"], cwd);
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

export function codexAdapter(bin = "codex"): Adapter {
  return {
    name: "codex",
    async run({ prompt, model, cwd }) {
      const stdout = await spawn(bin, ["exec", "--model", model, prompt], cwd);
      return { output: stdout, tokensIn: 0, tokensOut: 0 };
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
