import { describe, it, expect } from "vitest";
import { findTwoPlacesConflicts, twoPlacesEventIds } from "./twoPlaces";

function ev(o: {
  id: string;
  codex?: string | null;
  s?: number | null;
  e?: number | null;
  loc?: string | null;
}) {
  return {
    id: o.id,
    primaryCodexId: o.codex ?? "alice",
    startTime: o.s ?? null,
    endTime: o.e ?? null,
    locationCodexId: o.loc ?? null,
  };
}

describe("findTwoPlacesConflicts", () => {
  it("同一人物・区間が重なる・別場所 → 矛盾", () => {
    const c = findTwoPlacesConflicts({
      events: [
        ev({ id: "a", s: 0, e: 10, loc: "home" }),
        ev({ id: "b", s: 5, e: 15, loc: "forest" }),
      ],
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      eventA: "a",
      eventB: "b",
      codexId: "alice",
      locationA: "home",
      locationB: "forest",
    });
  });

  it("接するだけ(strict非重なり)は矛盾なし", () => {
    const c = findTwoPlacesConflicts({
      events: [
        ev({ id: "a", s: 0, e: 10, loc: "home" }),
        ev({ id: "b", s: 10, e: 20, loc: "forest" }),
      ],
    });
    expect(c).toHaveLength(0);
  });

  it("同じ場所なら矛盾なし", () => {
    const c = findTwoPlacesConflicts({
      events: [
        ev({ id: "a", s: 0, e: 10, loc: "home" }),
        ev({ id: "b", s: 5, e: 15, loc: "home" }),
      ],
    });
    expect(c).toHaveLength(0);
  });

  it("別人物なら矛盾なし", () => {
    const c = findTwoPlacesConflicts({
      events: [
        ev({ id: "a", codex: "alice", s: 0, e: 10, loc: "home" }),
        ev({ id: "b", codex: "bob", s: 5, e: 15, loc: "forest" }),
      ],
    });
    expect(c).toHaveLength(0);
  });

  it("point(endTime無し)や場所無しは対象外", () => {
    const c = findTwoPlacesConflicts({
      events: [
        ev({ id: "a", s: 0, e: null, loc: "home" }),
        ev({ id: "b", s: 5, e: 15, loc: null }),
      ],
    });
    expect(c).toHaveLength(0);
  });

  it("twoPlacesEventIds は両端を含む", () => {
    const ids = twoPlacesEventIds([
      {
        eventA: "a",
        eventB: "b",
        codexId: "alice",
        locationA: "home",
        locationB: "forest",
      },
    ]);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });
});
