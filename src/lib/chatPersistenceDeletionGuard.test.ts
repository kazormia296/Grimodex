import { describe, expect, it, vi } from "vitest";
import { createChatPersistenceDeletionGuard } from "./chatPersistenceDeletionGuard";

describe("chatPersistenceDeletionGuard", () => {
  it("fails closed while the installed pending assertion rejects", () => {
    const guard = createChatPersistenceDeletionGuard();
    const pending = new Error("pending Chat persistence");

    guard.installPendingAssertion(() => {
      throw pending;
    });

    expect(() => guard.assertDeletionAllowed()).toThrow(pending);
  });

  it("removes only the assertion owned by its disposer", () => {
    const guard = createChatPersistenceDeletionGuard();
    const older = vi.fn();
    const disposeOlder = guard.installPendingAssertion(() => {
      older();
    });
    guard.installPendingAssertion(() => {
      throw new Error("newer");
    });

    disposeOlder();

    expect(() => guard.assertDeletionAllowed()).toThrow("newer");
    expect(older).not.toHaveBeenCalled();
  });

  it("keeps factory-created guards isolated", () => {
    const releasedGuard = createChatPersistenceDeletionGuard();
    const isolatedGuard = createChatPersistenceDeletionGuard();
    const isolatedAssertion = vi.fn(() => {
      throw new Error("still installed");
    });
    const disposeReleased = releasedGuard.installPendingAssertion(() => {
      throw new Error("reset me");
    });
    isolatedGuard.installPendingAssertion(isolatedAssertion);

    disposeReleased();

    expect(() => releasedGuard.assertDeletionAllowed()).not.toThrow();
    expect(() => isolatedGuard.assertDeletionAllowed()).toThrow(
      "still installed",
    );
    expect(isolatedAssertion).toHaveBeenCalledOnce();
  });
});
