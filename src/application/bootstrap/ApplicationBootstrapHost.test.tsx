import { describe, expect, it, vi } from "vitest";
import { StrictQuiescenceError } from "@/application/lifecycle/quiescenceCoordinator";
import {
  applyCloseFailureToDialogState,
  classifyCloseFailure,
} from "./ApplicationBootstrapHost";

describe("ApplicationBootstrapHost close failure state", () => {
  it("installs a safe fallback dialog failure for a revoked Proxy", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const setCloseFailures = vi.fn();

    expect(() =>
      applyCloseFailureToDialogState(setCloseFailures, revoked.proxy),
    ).not.toThrow();
    expect(setCloseFailures).toHaveBeenCalledOnce();
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

  it("preserves exact StrictQuiescenceError failures for the dialog", () => {
    const first = new Error("first failure");
    const failures = [
      { stage: "autosave" as const, error: first, originalError: first },
    ];
    const strictError = new StrictQuiescenceError(failures);

    expect(classifyCloseFailure(strictError)).toBe(strictError.failures);
  });
});
