import { describe, it, expect } from "vitest";
import { VERDICTS, STAGE_STATUSES, RESERVED_STAGE_IDS, parseVerdict } from "../src/protocol.js";

describe("protocol constants", () => {
  it("verdict strings are exact and unthemed", () => {
    expect(VERDICTS).toEqual(["APPROVED", "REQUEST_CHANGES", "BLOCKED"]);
  });
  it("stage statuses are exact", () => {
    expect(STAGE_STATUSES).toEqual(["pending", "running", "awaiting_review", "awaiting_gate", "approved", "needs_rework", "failed", "skipped"]);
  });
  it("reserved stage ids match the spec list", () => {
    expect(RESERVED_STAGE_IDS).toEqual(["run","init","status","gate","report","models","config","clean","adhoc","resume"]);
  });
});

describe("parseVerdict", () => {
  it("finds a verdict inside prose", () => {
    expect(parseVerdict("Looks good.\nVerdict: APPROVED\n")).toBe("APPROVED");
  });
  it("last verdict wins when the model quotes earlier ones", () => {
    expect(parseVerdict("Earlier run said APPROVED but now REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
  });
  it("does not match substrings of other words", () => {
    expect(parseVerdict("the DISAPPROVED plan")).toBeNull();
  });
  it("returns null when absent", () => {
    expect(parseVerdict("no verdict here")).toBeNull();
  });
});
