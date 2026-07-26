import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
}));

let currentProjectId: string | null = "project-1";
let currentSettings: { model: string; provider: string } | null = {
  model: "claude-sonnet-4-6",
  provider: "openrouter",
};

vi.mock("@/db/client", () => ({ db: { insert: insertMock } }));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: currentProjectId }) },
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: { getState: () => ({ settings: currentSettings }) },
}));

import { recordAiUsage } from "./recordAiUsage";

describe("recordAiUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({ values: valuesMock });
    valuesMock.mockResolvedValue(undefined);
    currentProjectId = "project-1";
    currentSettings = { model: "claude-sonnet-4-6", provider: "openrouter" };
  });

  it("inserts a usage row with explicit fields", async () => {
    await recordAiUsage({
      surface: "map_branch",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      durationMs: 1234,
      traceId: "t-1",
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        surface: "map_branch",
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.01,
        durationMs: 1234,
        traceId: "t-1",
        model: "claude-sonnet-4-6",
        provider: "openrouter",
      }),
    );
  });

  it("defaults model/provider from AI settings when omitted", async () => {
    await recordAiUsage({ surface: "chat", tokensIn: 1, tokensOut: 2 });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        provider: "openrouter",
      }),
    );
  });

  it("keeps explicit turn provider/project and telemetry metadata snapshots", async () => {
    const metadata = {
      inputTokenDrift: {
        provider: "sakana",
        projectId: "turn-project",
        requestCount: 1,
      },
    };
    await recordAiUsage({
      surface: "chat",
      model: "fugu",
      provider: "sakana",
      projectId: "turn-project",
      metadata,
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "turn-project",
        model: "fugu",
        provider: "sakana",
        metadata: JSON.stringify(metadata),
      }),
    );
  });

  it("records prompt-cache read/write tokens", async () => {
    await recordAiUsage({
      surface: "chat",
      tokensIn: 1500,
      tokensOut: 200,
      cacheReadTokens: 1200,
      cacheWriteTokens: 300,
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheReadTokens: 1200,
        cacheWriteTokens: 300,
      }),
    );
  });

  it("defaults cache tokens to null when omitted", async () => {
    await recordAiUsage({ surface: "chat", tokensIn: 1 });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    );
  });

  it("records null tokens so the invocation is still counted", async () => {
    await recordAiUsage({ surface: "inline_ai" });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "inline_ai",
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
      }),
    );
  });

  it("early-returns without a project id (no insert)", async () => {
    currentProjectId = null;
    await recordAiUsage({ surface: "chat", tokensIn: 5 });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("is fail-open: swallows DB errors", async () => {
    valuesMock.mockRejectedValueOnce(new Error("db down"));
    await expect(recordAiUsage({ surface: "chat" })).resolves.toBeUndefined();
  });

  it("serializes metadata to JSON", async () => {
    await recordAiUsage({ surface: "agent", metadata: { foo: "bar" } });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: JSON.stringify({ foo: "bar" }) }),
    );
  });
});
