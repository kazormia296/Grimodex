import { describe, expect, it } from "vitest";
import * as commandCenter from "./index";

describe("commandCenter public API", () => {
  it("exposes only the dedicated search-panel stores, not a permanent header bar", () => {
    const exports = Object.keys(commandCenter);
    expect(exports).toContain("usePanelStore");
    expect(exports).toContain("useResultsPanelStore");
    expect(exports).not.toEqual(
      expect.arrayContaining([
        "CommandCenterBar",
        "useBarStore",
        "useCommandCenterStore",
        "selectPopoverOpen",
      ]),
    );
  });
});
