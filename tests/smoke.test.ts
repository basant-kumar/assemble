import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "../src/protocol.js";

describe("smoke", () => {
  it("exposes a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
