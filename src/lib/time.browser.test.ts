import { describe, expect, it } from "vitest";
import {
  canonicalInstantString,
  plainDateAtEpochMilliseconds,
  Temporal,
} from "./time";

describe("time boundary in Chromium", () => {
  it("uses the browser Temporal implementation through the shared boundary", () => {
    expect(Temporal).toBe(
      (globalThis as typeof globalThis & { Temporal?: unknown }).Temporal,
    );
    expect(canonicalInstantString("2026-07-15 12:34:56")).toBe(
      "2026-07-15T12:34:56.000Z",
    );
    expect(
      plainDateAtEpochMilliseconds(
        Date.UTC(2026, 6, 15, 15, 30),
        "Asia/Tokyo",
      ).toString(),
    ).toBe("2026-07-16");
  });
});
