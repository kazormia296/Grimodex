import { describe, expect, it } from "vitest";
import {
  buildDefaultLayoutState,
  validateLayoutState,
} from "./layoutStateUtils";
import { reduceLayout } from "./layoutReducer";

const viewport = { width: 1440, height: 900 };

describe("layoutReducer", () => {
  it("keeps editor close/open transitions valid and restores collapsed sizes", () => {
    const initial = buildDefaultLayoutState({ allInactive: false });
    const closed = reduceLayout(initial, { type: "editor/close", viewport });
    const reopened = reduceLayout(closed, { type: "editor/open", viewport });

    expect(validateLayoutState(closed, { viewport }).valid).toBe(true);
    expect(validateLayoutState(reopened, { viewport }).valid).toBe(true);
    expect(reopened.center.editorOpen).toBe(true);
  });

  it("separates live resize from finalize semantics", () => {
    const initial = buildDefaultLayoutState({ allInactive: false });
    const live = reduceLayout(initial, {
      type: "resize/live",
      region: "left",
      size: 320,
      viewport,
    });
    const finalized = reduceLayout(live, {
      type: "resize/finalize",
      viewport,
    });

    expect(live.regions.left.size).toBe(320);
    expect(validateLayoutState(finalized, { viewport }).valid).toBe(true);
  });

  it("rejects an invalid preset instead of replacing the last valid layout", () => {
    const initial = buildDefaultLayoutState({ allInactive: false });
    const invalid = { ...initial, center: { ...initial.center, segments: [] } };
    const next = reduceLayout(initial, {
      type: "preset/apply",
      snapshot: invalid,
      viewport,
    });

    expect(next).toEqual(initial);
  });
});
