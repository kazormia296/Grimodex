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
import { _resetWriteBackTimers, scheduleWriteBack } from "./writeBack";

describe("writeBack mute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
});
