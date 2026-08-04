import { describe, expect, it, vi } from "vitest";
import { createStickyDraftController } from "./stickyDraftController";

describe("sticky draft controller", () => {
  it("retries a failed persistence without losing the latest draft", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const controller = createStickyDraftController("sticky-1", "initial");
    controller.setPersist(persist);
    controller.markDirty("draft");

    await expect(controller.save()).rejects.toThrow("offline");
    expect(controller.dirty).toBe(true);

    await controller.save();
    expect(persist).toHaveBeenNthCalledWith(2, "draft");
    expect(controller.dirty).toBe(false);
  });

  it("drains edits made while the first save is in flight", async () => {
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockImplementationOnce(async () => firstSave)
      .mockResolvedValue(undefined);
    const controller = createStickyDraftController("sticky-1", "initial");
    controller.setPersist(persist);
    controller.markDirty("first");

    const pending = controller.save();
    controller.markDirty("second");
    releaseFirst();
    await pending;

    expect(persist).toHaveBeenNthCalledWith(1, "first");
    expect(persist).toHaveBeenNthCalledWith(2, "second");
    expect(controller.dirty).toBe(false);
  });
});
