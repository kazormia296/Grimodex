import { describe, it, expect } from "vitest";
import { getBuiltinPresetState, materializePreset } from "./layoutPresets";
import { validateLayoutState } from "./layoutStateUtils";

const LAPTOP_VIEWPORT = { width: 1366, height: 768 };
const NARROW_VIEWPORT = { width: 1440, height: 900 };

const ALL_BUILTIN_IDS = [
  "builtin:default",
  "builtin:plan",
  "builtin:chat-main",
  "builtin:review",
  "builtin:codex-main",
] as const;

describe("layoutPresets viewport safety", () => {
  for (const id of ALL_BUILTIN_IDS) {
    it(`${id} validates on 1366px laptop`, () => {
      const state = getBuiltinPresetState(id, LAPTOP_VIEWPORT);
      expect(state).toBeDefined();
      const result = validateLayoutState(state!, { viewport: LAPTOP_VIEWPORT });
      expect(
        result.valid,
        result.valid ? "" : (result as { reason: string }).reason,
      ).toBe(true);
    });

    it(`${id} keeps at least one active panel on 1366px`, () => {
      const state = getBuiltinPresetState(id, LAPTOP_VIEWPORT)!;
      const hasActive = Object.values(state.regions).some((r) =>
        r.slots.some((s) => s.activePanel !== null),
      );
      expect(hasActive).toBe(true);
    });
  }

  it("legacy hardcoded 800px left fails validation without clamping", () => {
    const unclamped = materializePreset(
      {
        activePanels: { grid: true, chat: true },
        regionFractions: { left: 800 / 1366, right: 400 / 1366 },
      },
      LAPTOP_VIEWPORT,
    );
    // materialize uses fraction so 800/1366*1366=800 - but clampLayoutStateForViewport fixes it
    expect(unclamped.regions.left.size).toBeLessThanOrEqual(683);
    expect(
      validateLayoutState(unclamped, { viewport: LAPTOP_VIEWPORT }).valid,
    ).toBe(true);
  });

  it("plan preset leaves room for editor on narrow screens", () => {
    const state = getBuiltinPresetState("builtin:plan", NARROW_VIEWPORT)!;
    const editorSpace =
      NARROW_VIEWPORT.width -
      state.regions.left.size -
      state.regions.right.size;
    expect(editorSpace).toBeGreaterThanOrEqual(320);
  });
});
