import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDocumentSaveCoordinatorForTests,
  awaitAllCoordinatedDocumentMutations,
  createDocumentSaveSession,
  DocumentMutationLeaseActiveError,
  isExclusiveDocumentLeaseActive,
  runCoordinatedDocumentSave,
  runExclusiveDocumentMutation,
  StaleRetiredDocumentSaveError,
  subscribeExclusiveDocumentLease,
} from "./documentSaveCoordinator";

const key = { kind: "tree", id: "scene-1", storage: "database" } as const;

describe("runCoordinatedDocumentSave", () => {
  beforeEach(_resetDocumentSaveCoordinatorForTests);

  it("serializes the same document and captures the second snapshot late", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = runCoordinatedDocumentSave(key, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const secondSave = vi.fn(async () => {
      order.push("second");
    });
    const second = runCoordinatedDocumentSave(key, secondSave);

    await Promise.resolve();
    expect(secondSave).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different documents to save concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runCoordinatedDocumentSave(key, () => gate);
    const otherSave = vi.fn(async () => {});
    await runCoordinatedDocumentSave(
      { kind: "tree", id: "scene-2", storage: "database" },
      otherSave,
    );
    expect(otherSave).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it("rejects a detached retry after another editor saves the document", async () => {
    const detached = createDocumentSaveSession();
    detached.retire(key);
    const failedSave = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(
      runCoordinatedDocumentSave(key, failedSave, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toThrow("disk full");

    const replacement = createDocumentSaveSession();
    await runCoordinatedDocumentSave(key, async () => true, {
      session: replacement,
      didPersist: Boolean,
    });

    const staleRetry = vi.fn(async () => true);
    await expect(
      runCoordinatedDocumentSave(key, staleRetry, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toBeInstanceOf(StaleRetiredDocumentSaveError);
    expect(staleRetry).not.toHaveBeenCalled();
  });

  it("allows a retired session to drain its own coalesced saves", async () => {
    const retiring = createDocumentSaveSession();
    retiring.retire(key);

    await runCoordinatedDocumentSave(key, async () => true, {
      session: retiring,
      didPersist: Boolean,
    });
    await expect(
      runCoordinatedDocumentSave(key, async () => true, {
        session: retiring,
        didPersist: Boolean,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a detached retry after an authoritative replacement advances a foreign revision", async () => {
    const detached = createDocumentSaveSession();
    detached.retire(key);
    await expect(
      runCoordinatedDocumentSave(
        key,
        async () => {
          throw new Error("disk full");
        },
        {
          session: detached,
          didPersist: Boolean,
        },
      ),
    ).rejects.toThrow("disk full");

    await runExclusiveDocumentMutation(key, async () => true, {
      didMutate: Boolean,
    });

    const staleRetry = vi.fn(async () => true);
    await expect(
      runCoordinatedDocumentSave(key, staleRetry, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toBeInstanceOf(StaleRetiredDocumentSaveError);
    expect(staleRetry).not.toHaveBeenCalled();
  });

  it("does not stale a detached session when an exclusive callback declines the replacement", async () => {
    const detached = createDocumentSaveSession();
    detached.retire(key);

    await runExclusiveDocumentMutation(key, async () => false, {
      didMutate: Boolean,
    });

    await expect(
      runCoordinatedDocumentSave(key, async () => true, {
        session: detached,
        didPersist: Boolean,
      }),
    ).resolves.toBe(true);
  });

  it("keeps the foreign revision when a later side effect fails after the content commit", async () => {
    const detached = createDocumentSaveSession();
    detached.retire(key);

    await expect(
      runExclusiveDocumentMutation(
        key,
        async ({ markAuthoritativeMutation }) => {
          markAuthoritativeMutation();
          throw new Error("metadata update failed");
        },
        { didMutate: Boolean },
      ),
    ).rejects.toThrow("metadata update failed");

    const staleRetry = vi.fn(async () => true);
    await expect(
      runCoordinatedDocumentSave(key, staleRetry, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toBeInstanceOf(StaleRetiredDocumentSaveError);
    expect(staleRetry).not.toHaveBeenCalled();
  });

  it("publishes an exact-document lease synchronously and runs behind an earlier save", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const events: string[] = [];
    const earlierSave = runCoordinatedDocumentSave(key, async () => {
      events.push("save:start");
      await saveGate;
      events.push("save:end");
    });
    const listener = vi.fn();
    const unsubscribe = subscribeExclusiveDocumentLease(key, listener);

    const replacement = runExclusiveDocumentMutation(key, async () => {
      events.push("replace");
    });

    expect(isExclusiveDocumentLeaseActive(key)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(events).toEqual(["save:start"]);

    await expect(
      runCoordinatedDocumentSave(key, async () => {}),
    ).rejects.toBeInstanceOf(DocumentMutationLeaseActiveError);

    releaseSave();
    await Promise.all([earlierSave, replacement]);
    expect(events).toEqual(["save:start", "save:end", "replace"]);
    expect(isExclusiveDocumentLeaseActive(key)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps unrelated documents writable and exposes replacement work to quiescence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacement = runExclusiveDocumentMutation(key, () => gate);
    const otherSave = vi.fn(async () => {});

    await runCoordinatedDocumentSave(
      { kind: "tree", id: "scene-2", storage: "database" },
      otherSave,
    );
    expect(otherSave).toHaveBeenCalledOnce();

    let drained = false;
    const drain = awaitAllCoordinatedDocumentMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await Promise.all([replacement, drain]);
    expect(drained).toBe(true);
  });
});
