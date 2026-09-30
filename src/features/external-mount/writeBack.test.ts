import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWriteExternalFile, mockSaveSceneContent, mockUpdateNode } =
  vi.hoisted(() => ({
    mockWriteExternalFile: vi.fn().mockResolvedValue(undefined),
    mockSaveSceneContent: vi
      .fn()
      .mockResolvedValue({ placedBeatPreview: null }),
    mockUpdateNode: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("./api", () => ({
  writeExternalFile: mockWriteExternalFile,
}));

vi.mock("@/features/tree/api", () => ({
  saveSceneContent: mockSaveSceneContent,
  updateNode: mockUpdateNode,
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleSceneIndex: vi.fn(),
}));

vi.mock("./markdownBridge", () => ({
  pmJsonToMarkdown: (json: string) => {
    const doc = JSON.parse(json) as {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    return doc.content?.[0]?.content?.[0]?.text ?? "";
  },
}));

import { useExternalRootStore } from "./externalRootStore";
import {
  _resetWriteBackTimers,
  cancelWriteBack,
  flushAllWriteBacksStrict,
  flushWriteBacksForScenes,
  hasPendingWriteBack,
  scheduleWriteBack,
} from "./writeBack";

describe("writeBack mute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWriteExternalFile.mockReset().mockResolvedValue(undefined);
    mockSaveSceneContent.mockReset().mockResolvedValue({
      placedBeatPreview: null,
    });
    mockUpdateNode.mockReset().mockResolvedValue(undefined);
    useExternalRootStore.setState({ mutedWrites: [] });
    _resetWriteBackTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetWriteBackTimers();
  });

  it("mutes the path after flushing a write-back", async () => {
    const pmJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "loop guard" }],
        },
      ],
    });

    scheduleWriteBack(
      "scene-1",
      "external-root://root-1/chapter/01.md",
      pmJson,
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(mockWriteExternalFile).toHaveBeenCalledWith(
      "root-1",
      "chapter/01.md",
      "loop guard",
    );
    expect(
      useExternalRootStore.getState().isMuted("root-1", "chapter/01.md"),
    ).toBe(true);
  });

  it("strict flush runs a debounced write immediately and propagates failure", async () => {
    mockWriteExternalFile.mockRejectedValueOnce(new Error("read-only mount"));
    scheduleWriteBack(
      "scene-2",
      "external-root://root-1/chapter/02.md",
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [] }],
      }),
    );

    await expect(flushAllWriteBacksStrict()).rejects.toThrow(
      "external write-backs failed",
    );
    expect(mockWriteExternalFile).toHaveBeenCalledOnce();

    mockWriteExternalFile.mockResolvedValue(undefined);
    await expect(flushAllWriteBacksStrict()).resolves.toBeUndefined();
    expect(mockWriteExternalFile).toHaveBeenCalledTimes(2);
  });

  it("strict flush drains a write scheduled while an earlier write is in flight", async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockWriteExternalFile
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce(undefined);

    const document = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    });
    scheduleWriteBack(
      "scene-first",
      "external-root://root-1/chapter/first.md",
      document,
    );
    const flush = flushAllWriteBacksStrict();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockWriteExternalFile).toHaveBeenCalledTimes(1);

    scheduleWriteBack(
      "scene-late",
      "external-root://root-1/chapter/late.md",
      document,
    );
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await expect(flush).resolves.toBeUndefined();

    expect(mockWriteExternalFile).toHaveBeenCalledTimes(2);
    expect(mockWriteExternalFile).toHaveBeenLastCalledWith(
      "root-1",
      "chapter/late.md",
      "",
    );
  });

  it("cancels a scheduled draft before it can overwrite an external reload", async () => {
    scheduleWriteBack(
      "scene-cancel",
      "external-root://root-1/chapter/cancel.md",
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "stale local" }],
          },
        ],
      }),
    );
    expect(hasPendingWriteBack("scene-cancel")).toBe(true);

    await cancelWriteBack("scene-cancel");
    await vi.advanceTimersByTimeAsync(500);

    expect(hasPendingWriteBack("scene-cancel")).toBe(false);
    expect(mockWriteExternalFile).not.toHaveBeenCalled();
  });

  it("waits for an in-flight native write before cancellation resolves", async () => {
    let releaseWrite!: () => void;
    const nativeWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    mockWriteExternalFile.mockReturnValueOnce(nativeWrite);
    scheduleWriteBack(
      "scene-in-flight",
      "external-root://root-1/chapter/in-flight.md",
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [] }],
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(mockWriteExternalFile).toHaveBeenCalledOnce();

    let cancelled = false;
    const cancellation = cancelWriteBack("scene-in-flight").then(() => {
      cancelled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(false);

    releaseWrite();
    await cancellation;
    expect(cancelled).toBe(true);
    expect(hasPendingWriteBack("scene-in-flight")).toBe(false);
  });

  it("does not let an older disk write revert a newer DB snapshot", async () => {
    let releaseDisk!: () => void;
    const diskWrite = new Promise<void>((resolve) => {
      releaseDisk = resolve;
    });
    mockWriteExternalFile.mockReturnValueOnce(diskWrite);
    const oldPmJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "old local snapshot" }],
        },
      ],
    });
    const newerPmJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "newer local snapshot" }],
        },
      ],
    });

    scheduleWriteBack(
      "scene-order",
      "external-root://root-1/chapter/order.md",
      oldPmJson,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(mockWriteExternalFile).toHaveBeenCalledOnce();

    // This represents the next editor save, which already owns DB
    // persistence before its own OUT draft is scheduled.
    await mockSaveSceneContent("scene-order", newerPmJson);
    releaseDisk();
    await expect(flushAllWriteBacksStrict()).resolves.toBeUndefined();

    expect(mockSaveSceneContent).toHaveBeenCalledOnce();
    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-order",
      newerPmJson,
    );
    expect(mockSaveSceneContent).not.toHaveBeenCalledWith(
      "scene-order",
      oldPmJson,
    );
  });

  it("flushes only selected Scene write-backs", async () => {
    const pmJson = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    });
    scheduleWriteBack(
      "scene-target",
      "external-root://root-1/chapter/target.md",
      pmJson,
    );
    scheduleWriteBack(
      "scene-outside",
      "external-root://root-1/chapter/outside.md",
      pmJson,
    );

    await expect(
      flushWriteBacksForScenes(["scene-target"]),
    ).resolves.toBeUndefined();

    expect(mockWriteExternalFile).toHaveBeenCalledOnce();
    expect(mockWriteExternalFile).toHaveBeenCalledWith(
      "root-1",
      "chapter/target.md",
      "",
    );
    expect(hasPendingWriteBack("scene-target")).toBe(false);
    expect(hasPendingWriteBack("scene-outside")).toBe(true);
  });
});
