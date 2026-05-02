import { describe, it, expect } from "vitest";
import { deriveCellDisplay } from "./deriveCellRender";
import type { CellInfo } from "./deriveCells";

function makeInfo(
  topSource: "body" | "beat" | "relation",
  opts: { sources?: ("body" | "beat" | "relation")[]; role?: string } = {},
): CellInfo {
  const sources = new Set(opts.sources ?? [topSource]) as Set<
    "body" | "beat" | "relation"
  >;
  return {
    topSource,
    sources,
    role: (opts.role ?? "mentioned") as "mentioned" | "actor" | "target",
  };
}

describe("deriveCellDisplay – dot mode", () => {
  it("returns null for undefined cellInfo", () => {
    const result = deriveCellDisplay(undefined, "e1", null, null, "dot");
    expect(result).toBeNull();
  });

  it("returns dot display for body source", () => {
    const info = makeInfo("body");
    const result = deriveCellDisplay(info, "e1", null, null, "dot");
    expect(result?.kind).toBe("dot");
    if (result?.kind === "dot") expect(result.source).toBe("body");
  });

  it("returns dot display for relation source", () => {
    const info = makeInfo("relation");
    const result = deriveCellDisplay(info, "e1", null, null, "dot");
    expect(result?.kind).toBe("dot");
    if (result?.kind === "dot") expect(result.source).toBe("relation");
  });
});

describe("deriveCellDisplay – count mode", () => {
  it("returns null when no cell info", () => {
    const result = deriveCellDisplay(undefined, "e1", null, null, "count");
    expect(result).toBeNull();
  });

  it("returns count = number of sources present", () => {
    const info = makeInfo("body", { sources: ["body", "beat"] });
    const result = deriveCellDisplay(info, "e1", null, null, "count");
    expect(result?.kind).toBe("count");
    if (result?.kind === "count") expect(result.count).toBe(2);
  });

  it("count is 1 for single source", () => {
    const info = makeInfo("relation");
    const result = deriveCellDisplay(info, "e1", null, null, "count");
    if (result?.kind === "count") expect(result.count).toBe(1);
  });
});

describe("deriveCellDisplay – heatmap mode", () => {
  it("returns null when no cell info", () => {
    const result = deriveCellDisplay(undefined, "e1", null, null, "heatmap");
    expect(result).toBeNull();
  });

  it("intensity 1 for single relation source", () => {
    const info = makeInfo("relation");
    const result = deriveCellDisplay(info, "e1", null, null, "heatmap");
    expect(result?.kind).toBe("heatmap");
    if (result?.kind === "heatmap") expect(result.intensity).toBe(1);
  });

  it("intensity 2 for beat source", () => {
    const info = makeInfo("beat");
    const result = deriveCellDisplay(info, "e1", null, null, "heatmap");
    if (result?.kind === "heatmap") expect(result.intensity).toBe(2);
  });

  it("intensity 3 for body source", () => {
    const info = makeInfo("body");
    const result = deriveCellDisplay(info, "e1", null, null, "heatmap");
    if (result?.kind === "heatmap") expect(result.intensity).toBe(3);
  });
});

describe("deriveCellDisplay – pov mode (show='pov' or 'location')", () => {
  it("returns pov cell when colEntryId matches povCharacterId", () => {
    const result = deriveCellDisplay(
      undefined,
      "char1",
      "char1", // povCharacterId
      null,
      "dot",
      "pov",
    );
    expect(result?.kind).toBe("pov");
    if (result?.kind === "pov") expect(result.isPov).toBe(true);
  });

  it("returns null when colEntryId does NOT match povCharacterId", () => {
    const result = deriveCellDisplay(
      undefined,
      "char2",
      "char1", // different
      null,
      "dot",
      "pov",
    );
    expect(result).toBeNull();
  });

  it("returns pov cell when colEntryId matches locationId (location show mode)", () => {
    const result = deriveCellDisplay(
      undefined,
      "loc1",
      null,
      "loc1", // locationId
      "dot",
      "location",
    );
    expect(result?.kind).toBe("pov");
    if (result?.kind === "pov") expect(result.isPov).toBe(true);
  });
});

describe("deriveCellDisplay – role-aware mode", () => {
  it("returns null when no cell info", () => {
    const result = deriveCellDisplay(undefined, "e1", null, null, "role-aware");
    expect(result).toBeNull();
  });

  it("returns role-aware with actor role", () => {
    const info = makeInfo("beat", { role: "actor" });
    const result = deriveCellDisplay(info, "e1", null, null, "role-aware");
    expect(result?.kind).toBe("role-aware");
    if (result?.kind === "role-aware") expect(result.role).toBe("actor");
  });

  it("role-aware marks isPov true when entry is the POV character", () => {
    const info = makeInfo("body");
    const result = deriveCellDisplay(
      info,
      "char1",
      "char1", // povCharacterId matches colEntryId
      null,
      "role-aware",
    );
    expect(result?.kind).toBe("role-aware");
    if (result?.kind === "role-aware") expect(result.isPov).toBe(true);
  });
});
