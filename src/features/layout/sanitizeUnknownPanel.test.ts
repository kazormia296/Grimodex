import { describe, it, expect } from "vitest";
import {
  buildDefaultLayoutState,
  ensureLayoutStateV3,
  validateLayoutState,
} from "./layoutStateUtils";

/**
 * Guards the migration path for removing a tool window (e.g. `timelapse`):
 * persisted layouts still carrying the removed id must be sanitized on load so
 * `panelIcons` / `PANEL_COMPONENT_MAP` lookups can't hit `undefined` and crash.
 *
 * Fixtures start from a real `buildDefaultLayoutState()` (so region sizes / slot
 * ids are valid) and inject a fake removed id `__removed__`, then assert
 * `ensureLayoutStateV3` strips it and the result still validates.
 */
const VIEWPORT = { width: 1600, height: 1000 };

describe("ensureLayoutStateV3 — strip unknown panels (panel-removal migration)", () => {
  it("drops an unknown panel from a slot and reassigns an orphaned activePanel", () => {
    const base = buildDefaultLayoutState();
    const slot = base.regions.right.slots[0];
    const survivor = slot.panels[0];
    // Pre-removal shape: unknown id sits in front of a real panel and is active.
    slot.panels = ["__removed__", ...slot.panels] as never;
    slot.activePanel = "__removed__" as never;

    const out = ensureLayoutStateV3(base);
    const r = out.regions.right.slots.find((s) => s.id === slot.id)!;
    expect(r.panels).not.toContain("__removed__");
    expect(r.panels).toContain(survivor);
    // activePanel was the removed id → falls back to a surviving panel, not null.
    expect(r.activePanel).toBe(r.panels[0]);
    expect(validateLayoutState(out, { viewport: VIEWPORT }).valid).toBe(true);
  });

  it("removes a slot left empty after stripping its only (unknown) panel", () => {
    const base = buildDefaultLayoutState();
    base.regions.right.slots.push({
      id: "r-stale",
      sizeRatio: 1,
      panels: ["__removed__"] as never,
      activePanel: "__removed__" as never,
    });

    const out = ensureLayoutStateV3(base);
    expect(
      out.regions.right.slots.find((s) => s.id === "r-stale"),
    ).toBeUndefined();
    expect(validateLayoutState(out, { viewport: VIEWPORT }).valid).toBe(true);
  });

  it("drops a center tool segment that held only the unknown panel, keeps the editor", () => {
    const base = buildDefaultLayoutState();
    base.center.segments.push({
      id: "ct-stale",
      kind: "tool",
      sizeRatio: 1,
      panels: ["__removed__"] as never,
      activePanel: "__removed__" as never,
    });

    const out = ensureLayoutStateV3(base);
    expect(out.center.segments.some((s) => s.id === "ct-stale")).toBe(false);
    expect(out.center.segments.some((s) => s.kind === "editor")).toBe(true);
    expect(validateLayoutState(out, { viewport: VIEWPORT }).valid).toBe(true);
  });

  it("leaves a clean default layout valid and is idempotent", () => {
    const once = ensureLayoutStateV3(buildDefaultLayoutState());
    expect(validateLayoutState(once, { viewport: VIEWPORT }).valid).toBe(true);
    const twice = ensureLayoutStateV3(once);
    expect(twice.regions).toEqual(once.regions);
    expect(twice.center).toEqual(once.center);
  });
});
