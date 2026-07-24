import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultLayoutState } from "./layoutStateUtils";

const patchGlobalSettings = vi.hoisted(() => vi.fn());
const recordLayoutSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/globalSettings/repository", () => ({
  globalSettingsRepository: {
    patch: patchGlobalSettings,
  },
}));

vi.mock("@/features/timelapse/captureLayout", () => ({
  recordLayoutSnapshot,
}));

import { scheduleSave } from "./layoutPersistence";

function snapshot() {
  return {
    layout: buildDefaultLayoutState({ allInactive: true }),
    activePresetId: "builtin:default",
    customPresets: [],
    builtinPresetOverrides: {},
    hiddenStripePanels: new Set(),
  };
}

describe("layout persistence on a phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    patchGlobalSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not let a phone save request become a delayed desktop save", async () => {
    let viewport = { width: 390, height: 844 };
    scheduleSave(snapshot, () => viewport);

    viewport = { width: 1440, height: 900 };
    await vi.advanceTimersByTimeAsync(501);

    expect(recordLayoutSnapshot).not.toHaveBeenCalled();
    expect(patchGlobalSettings).not.toHaveBeenCalled();
  });

  it("cancels a pending desktop save when the viewport becomes a phone", async () => {
    let viewport = { width: 1440, height: 900 };
    scheduleSave(snapshot, () => viewport);

    viewport = { width: 390, height: 844 };
    await vi.advanceTimersByTimeAsync(501);

    expect(recordLayoutSnapshot).not.toHaveBeenCalled();
    expect(patchGlobalSettings).not.toHaveBeenCalled();
  });
});
