// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { openAiPolicySettings } from "./openAiPolicySettings";

describe("openAiPolicySettings", () => {
  it("opens the AI category where project AI policy controls live", () => {
    const listener = vi.fn();
    window.addEventListener("open-settings", listener);
    openAiPolicySettings();
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      category: "ai",
    });
    window.removeEventListener("open-settings", listener);
  });
});
