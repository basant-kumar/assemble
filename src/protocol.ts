export const PROTOCOL_VERSION = 1;

export const VERDICTS = ["APPROVED", "REQUEST_CHANGES", "BLOCKED"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STAGE_STATUSES = ["pending", "running", "awaiting_gate", "approved", "needs_rework", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const RESERVED_STAGE_IDS = ["run","init","status","gate","report","models","config","clean","adhoc","resume"] as const;

export function parseVerdict(output: string): Verdict | null {
  const re = /\b(APPROVED|REQUEST_CHANGES|BLOCKED)\b/g;
  let last: Verdict | null = null;
  for (const m of output.matchAll(re)) last = m[1] as Verdict;
  return last;
}
