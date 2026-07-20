import type { AssembleConfig } from "./config.js";

/** UI always renders agents as `name (role)` — spec display convention. */
export function renderAgent(key: string, config: AssembleConfig): string {
  return `${key} (${config.agents[key]?.role ?? "unknown"})`;
}
