import { describe, expect, it, vi } from "vitest";
import { createLatestValueDraftController } from "./latestValueDraftController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestValueDraftController", () => {
  it("drains a value typed during an in-flight save before becoming clean", async () => {
    const first = deferred<void>();
    const persisted: string[] = [];
    const persist = vi.fn(async (value: string) => {
      persisted.push(value);
      if (persisted.length === 1) await first.promise;
    });
    const controller = createLatestValueDraftController<string>(
      "title:scene-1",
      "old",
      persist,
    );

    controller.markDirty("first");
    const saving = controller.save();
    controller.markDirty("latest");
    first.resolve();
    await saving;

    expect(persisted).toEqual(["first", "latest"]);
    expect(controller.latestValue).toBe("latest");
    expect(controller.dirty).toBe(false);
  });

  it("upgrades an existing drain with a strict preexisting-draft permit", async () => {
    const first = deferred<void>();
    const contexts: boolean[] = [];
    const persist = vi.fn(
      async (_value: string, context: { preexistingDraft: boolean }) => {
        contexts.push(context.preexistingDraft);
        if (contexts.length === 1) await first.promise;
      },
    );
    const controller = createLatestValueDraftController<string>(
      "title:scene-1",
      "old",
      persist,
    );

    controller.markDirty("first");
    const saving = controller.save();
    controller.markDirty("latest");
    expect(controller.save({ preexistingDraft: true })).toBe(saving);
    first.resolve();
    await saving;

    expect(contexts).toEqual([false, true]);
  });

  it("retains the latest generation after failure and retries it", async () => {
    const first = deferred<void>();
    const persisted: string[] = [];
    const persist = vi.fn(async (value: string) => {
      persisted.push(value);
      if (persisted.length === 1) await first.promise;
    });
    const controller = createLatestValueDraftController<string>(
      "title:scene-1",
      "old",
      persist,
    );

    controller.markDirty("first");
    const saving = controller.save();
    controller.markDirty("latest");
    first.reject(new Error("disk full"));
    await expect(saving).rejects.toThrow("disk full");
    expect(controller.dirty).toBe(true);
    expect(controller.latestValue).toBe("latest");

    await controller.save();
    expect(persisted).toEqual(["first", "latest"]);
    expect(controller.dirty).toBe(false);
  });
});
