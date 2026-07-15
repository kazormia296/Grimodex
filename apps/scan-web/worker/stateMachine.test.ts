import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminalStatus,
} from "./stateMachine";

describe("scan status state machine", () => {
  it("allows only forward pipeline transitions and explicit cancellation", () => {
    expect(canTransition("queued", "validating")).toBe(true);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("completed", "queued")).toBe(false);
    expect(() => assertTransition("completed", "queued")).toThrow(
      "invalid scan status transition",
    );
  });

  it("identifies terminal states", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("cancel_requested")).toBe(false);
  });
});
