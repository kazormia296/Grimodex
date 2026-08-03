import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const listenMock = vi.hoisted(() => vi.fn(async () => () => undefined));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  listen: listenMock,
}));

import { useWorkspaceStore } from "@/features/workspace/store";
import { useAiSettingsStore } from "@/features/chat/store";
import { DEFAULT_AI_SETTINGS } from "@/features/chat/types";
import { invokeSingleShotChat } from "@/features/chat/singleShotTransport";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";

describe("A/B fresh dispatch workspace authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      activeWorkspacePath: "/workspace/after-switch",
      workspaceSwitchInProgress: false,
    });
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "gpt-5.6",
      },
    });
  });

  it("blocks a fresh chat slot before audit append or provider invoke after a workspace switch", async () => {
    await expect(
      invokeSingleShotChat(
        {
          messages: [{ role: "user", content: "second chat slot" }],
          provider: "openrouter",
          model: "gpt-5.6",
        },
        {
          projectId: "project-1",
          expectedWorkspacePath: "/workspace/before-switch",
          pathId: "ab_chat",
          operationId: "comparison-1",
        },
      ),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("blocks a fresh inline slot before listeners, audit append or provider invoke after a workspace switch", async () => {
    await expect(
      sendInlineAiStream(
        [{ role: "user", content: "second inline slot" }],
        {
          projectId: "project-1",
          expectedWorkspacePath: "/workspace/before-switch",
          pathId: "ab_inline",
          operationId: "comparison-1",
        },
        {
          onTextDelta: vi.fn(),
          onDone: vi.fn(),
          onError: vi.fn(),
        },
        { provider: "openrouter", model: "gpt-5.6" },
      ),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });
});
