import { describe, expect, it } from "vitest";

import { shouldSkipUpdaterProductionGate } from "./useUpdateChecker";

describe("updater production gate", () => {
  it("enables automatic checks in packaged Electron and Tauri shells", () => {
    expect(
      shouldSkipUpdaterProductionGate({
        electron: true,
        tauri: false,
        dev: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipUpdaterProductionGate({
        electron: false,
        tauri: true,
        dev: false,
      }),
    ).toBe(false);
  });

  it("skips development builds and plain browser previews", () => {
    expect(
      shouldSkipUpdaterProductionGate({
        electron: true,
        tauri: false,
        dev: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipUpdaterProductionGate({
        electron: false,
        tauri: false,
        dev: false,
      }),
    ).toBe(true);
  });
});
