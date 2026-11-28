import { describe, expect, it, vi, beforeEach } from "vitest";

const stopText = vi.hoisted(() => vi.fn((): string | null => null));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  aiPolicyStopText: stopText,
}));

import { AiPolicyWriteBlockedError } from "@/features/ai-policy/writeBlockedError";
import { toolFailureScreenText } from "./toolFailureScreenText";

beforeEach(() => {
  stopText.mockReset();
  stopText.mockReturnValue(null);
});

describe("toolFailureScreenText", () => {
  const blocked = new AiPolicyWriteBlockedError("bodyWrite");

  it("shows the stop reason of a damaged or unloaded Project", () => {
    stopText.mockReturnValue("理由の文");
    expect(toolFailureScreenText(blocked, blocked.message)).toBe("理由の文");
    expect(stopText).toHaveBeenCalledWith("bodyWrite");
  });

  it("keeps the message when the policy is simply off", () => {
    expect(toolFailureScreenText(blocked, blocked.message)).toBe(
      "bodyWrite policy is off",
    );
  });

  it("does not consult the policy for other failures", () => {
    expect(toolFailureScreenText(new Error("disk full"), "disk full")).toBe(
      "disk full",
    );
    expect(stopText).not.toHaveBeenCalled();
  });
});
