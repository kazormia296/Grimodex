import { describe, expect, it } from "vitest";

import { isWorkLayerLiveEnabled } from "./workLayerLiveFlag";

describe("isWorkLayerLiveEnabled", () => {
  it.each(["true", "1"])("enables only for %s", (value) => {
    expect(isWorkLayerLiveEnabled({ VITE_WORK_LAYER_LIVE: value })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "yes"])(
    "stays closed for %s",
    (value) => {
      expect(isWorkLayerLiveEnabled({ VITE_WORK_LAYER_LIVE: value })).toBe(
        false,
      );
    },
  );
});
