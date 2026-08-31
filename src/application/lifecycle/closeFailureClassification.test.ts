import { describe, expect, it, vi } from "vitest";
import { StrictQuiescenceError } from "./quiescenceCoordinator";
import {
  applyCloseFailureToDialogState,
  classifyCloseFailure,
} from "./closeFailureClassification";

describe("close failure classification", () => {
  it("keeps a hostile rejection total and preserves its original identity", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const setCloseFailures = vi.fn();

    expect(() =>
      applyCloseFailureToDialogState(setCloseFailures, revoked.proxy),
    ).not.toThrow();
    const failures = setCloseFailures.mock.calls[0]?.[0];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: "participants",
      error: expect.any(Error),
    });
    expect(failures[0].originalError).toBe(revoked.proxy);
    expect(failures[0].error.message).toBe(
      "Document lifecycle did not reach quiescence",
    );
  });

  it("passes through exact StrictQuiescenceError failures for the dialog", () => {
    const first = new Error("first failure");
    const failures = [
      { stage: "autosave" as const, error: first, originalError: first },
    ];
    const strictError = new StrictQuiescenceError(failures);

    expect(classifyCloseFailure(strictError)).toBe(strictError.failures);
  });
});
