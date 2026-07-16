import { describe, expect, it } from "vitest";
import { isCancellationRequestedOrTerminal } from "./workflowState";

describe("scan workflow failure classification", () => {
  it.each(["cancel_requested", "cancelled", "deleted"] as const)(
    "preserves %s when a concurrent step fails",
    (status) => {
      expect(isCancellationRequestedOrTerminal(status)).toBe(true);
    },
  );

  it("still classifies ordinary active failures as failed", () => {
    expect(isCancellationRequestedOrTerminal("extracting")).toBe(false);
  });
});
