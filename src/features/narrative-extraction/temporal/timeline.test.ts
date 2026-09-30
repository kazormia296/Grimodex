import { describe, expect, it } from "vitest";
import { isTemporalTimelineRef, temporalTimelineKey } from "./timeline";

describe("temporalTimelineKey", () => {
  it("keeps primary separate from keyed non-primary timelines", () => {
    expect(temporalTimelineKey({ kind: "primary" })).toBe("primary");
    expect(temporalTimelineKey({ kind: "alternate", key: "route-a" })).toBe(
      "alternate:route-a",
    );
    expect(temporalTimelineKey({ kind: "embedded-fiction", key: "play" })).toBe(
      "embedded-fiction:play",
    );
    expect(temporalTimelineKey({ kind: "hypothetical", key: "dream" })).toBe(
      "hypothetical:dream",
    );
  });

  it("rejects empty, control-character, and invalid-unicode keys", () => {
    expect(isTemporalTimelineRef({ kind: "alternate", key: "" })).toBe(false);
    expect(isTemporalTimelineRef({ kind: "alternate", key: "   " })).toBe(
      false,
    );
    expect(isTemporalTimelineRef({ kind: "alternate", key: "a\u0000b" })).toBe(
      false,
    );
    expect(isTemporalTimelineRef({ kind: "alternate", key: "\ud800" })).toBe(
      false,
    );
    expect(isTemporalTimelineRef({ kind: "primary", key: "unexpected" })).toBe(
      false,
    );
  });
});
