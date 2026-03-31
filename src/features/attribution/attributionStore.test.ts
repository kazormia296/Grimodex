import { describe, it, expect, beforeEach } from "vitest";
import { useAttributionStore } from "./attributionStore";

describe("useAttributionStore", () => {
  beforeEach(() => {
    useAttributionStore.setState({ showAttribution: false });
  });

  it("starts with attribution hidden", () => {
    expect(useAttributionStore.getState().showAttribution).toBe(false);
  });

  it("toggles attribution visibility", () => {
    useAttributionStore.getState().toggleAttribution();
    expect(useAttributionStore.getState().showAttribution).toBe(true);

    useAttributionStore.getState().toggleAttribution();
    expect(useAttributionStore.getState().showAttribution).toBe(false);
  });
});
