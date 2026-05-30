import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    insert: insertMock,
  },
}));

import { insertGenerationLog } from "./generationLogApi";
import { useTreeStore } from "@/features/tree/treeStore";

describe("insertGenerationLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({ values: valuesMock });
    valuesMock.mockResolvedValue(undefined);
    useTreeStore.setState({ projectId: "project-1" });
  });

  it("inserts a generation log using the active project id", async () => {
    await insertGenerationLog({
      kind: "inline-ai",
      commandId: "continue",
      instruction: "続きを書く",
      sceneNodeId: "scene-1",
      model: "claude-sonnet-4-6",
      traceId: "trace-1",
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        kind: "inline-ai",
        commandId: "continue",
        instruction: "続きを書く",
        promptFull: null,
        sceneNodeId: "scene-1",
        model: "claude-sonnet-4-6",
        traceId: "trace-1",
      }),
    );
  });

  it("swallows duplicate trace_id errors", async () => {
    valuesMock.mockRejectedValueOnce(
      new Error("UNIQUE constraint failed: generation_logs.trace_id"),
    );

    await expect(
      insertGenerationLog({
        kind: "beat",
        commandId: "free",
        instruction: "雨の夜",
        sceneNodeId: "scene-1",
        model: "claude-sonnet-4-6",
        traceId: "trace-dup",
      }),
    ).resolves.toBeUndefined();
  });
});
