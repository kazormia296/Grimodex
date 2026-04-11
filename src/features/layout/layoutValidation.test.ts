import { describe, it, expect } from "vitest";
import {
  validateSerializedLayout,
  validateRuntimeLayout,
} from "./layoutValidation";
import type { DockviewApi } from "dockview-react";

/* ── helpers to build minimal serialized layouts ── */

function leafNode(data: Record<string, unknown> = {}, size = 300) {
  return { type: "leaf", data, size };
}

function branchNode(children: unknown[]) {
  return { type: "branch", data: children };
}

function makeLayout(overrides?: {
  root?: unknown;
  width?: number;
  height?: number;
  panels?: Record<string, unknown>;
}) {
  return {
    grid: {
      root: overrides?.root ?? branchNode([leafNode(), leafNode()]),
      width: overrides?.width ?? 1200,
      height: overrides?.height ?? 800,
      orientation: 0,
    },
    panels: overrides?.panels ?? { panel1: {}, panel2: {} },
  };
}

/* ── validateSerializedLayout ── */

describe("validateSerializedLayout", () => {
  it("accepts a valid layout with branch root and 2 leaf nodes", () => {
    const result = validateSerializedLayout(makeLayout());
    expect(result.valid).toBe(true);
  });

  it("accepts a nested branch tree with multiple leaves", () => {
    const layout = makeLayout({
      root: branchNode([branchNode([leafNode(), leafNode()]), leafNode()]),
      panels: { p1: {}, p2: {}, p3: {} },
    });
    const result = validateSerializedLayout(layout);
    expect(result.valid).toBe(true);
  });

  it("rejects null", () => {
    const result = validateSerializedLayout(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects undefined", () => {
    const result = validateSerializedLayout(undefined);
    expect(result.valid).toBe(false);
  });

  it("rejects a non-object (string)", () => {
    const result = validateSerializedLayout("bad");
    expect(result.valid).toBe(false);
  });

  it("rejects layout without grid", () => {
    const result = validateSerializedLayout({ panels: {} });
    expect(result.valid).toBe(false);
  });

  it("rejects layout without grid.root", () => {
    const result = validateSerializedLayout({
      grid: { width: 1200, height: 800 },
      panels: { p1: {}, p2: {} },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects layout with grid.width = 0", () => {
    const result = validateSerializedLayout(makeLayout({ width: 0 }));
    expect(result.valid).toBe(false);
  });

  it("rejects layout with grid.height = 0", () => {
    const result = validateSerializedLayout(makeLayout({ height: 0 }));
    expect(result.valid).toBe(false);
  });

  it("rejects layout with negative grid.width", () => {
    const result = validateSerializedLayout(makeLayout({ width: -100 }));
    expect(result.valid).toBe(false);
  });

  it("rejects degenerate layout: single leaf root (1 group = 100%)", () => {
    const layout = makeLayout({
      root: leafNode(),
      panels: { p1: {} },
    });
    const result = validateSerializedLayout(layout);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects layout with only 1 leaf even in a branch", () => {
    const layout = makeLayout({
      root: branchNode([leafNode()]),
      panels: { p1: {} },
    });
    const result = validateSerializedLayout(layout);
    expect(result.valid).toBe(false);
  });

  it("rejects layout with fewer than 2 panel entries", () => {
    const layout = makeLayout({
      root: branchNode([leafNode(), leafNode()]),
      panels: { p1: {} },
    });
    const result = validateSerializedLayout(layout);
    expect(result.valid).toBe(false);
  });

  it("rejects layout with empty panels record", () => {
    const layout = makeLayout({
      panels: {},
    });
    const result = validateSerializedLayout(layout);
    expect(result.valid).toBe(false);
  });

  it("result includes reason when invalid", () => {
    const result = validateSerializedLayout(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

/* ── validateRuntimeLayout ── */

function makeApi(groups: { width: number }[], totalWidth = 1200) {
  return {
    groups,
    width: totalWidth,
  } as unknown as DockviewApi;
}

describe("validateRuntimeLayout", () => {
  it("accepts layout with 2 groups of equal width", () => {
    const result = validateRuntimeLayout(
      makeApi([{ width: 600 }, { width: 600 }]),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts layout with 3 groups", () => {
    const result = validateRuntimeLayout(
      makeApi([{ width: 400 }, { width: 400 }, { width: 400 }]),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts layout where one group takes exactly 85%", () => {
    // 1020/1200 = 85% — boundary: should still be valid (threshold is strictly > 85%)
    const result = validateRuntimeLayout(
      makeApi([{ width: 1020 }, { width: 180 }]),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects layout with 0 groups", () => {
    const result = validateRuntimeLayout(makeApi([]));
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects layout with 1 group", () => {
    const result = validateRuntimeLayout(makeApi([{ width: 1200 }]));
    expect(result.valid).toBe(false);
  });

  it("rejects layout where single group takes > 85% of total width", () => {
    // 1021/1200 ≈ 85.08% > 85%
    const result = validateRuntimeLayout(
      makeApi([{ width: 1021 }, { width: 179 }]),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects degenerate layout: 1 group = 100% width", () => {
    const result = validateRuntimeLayout(makeApi([{ width: 1200 }], 1200));
    expect(result.valid).toBe(false);
  });
});
