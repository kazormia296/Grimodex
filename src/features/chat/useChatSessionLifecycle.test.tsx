// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSession } from "./chatTypes";
import {
  type ChatSessionLifecycleOptions,
  useChatSessionLifecycle,
} from "./useChatSessionLifecycle";

const mocks = vi.hoisted(() => ({
  state: {
    sessions: [] as ChatSession[],
    activeSessionId: null as string | null,
  },
}));

vi.mock("./chatStore", () => ({
  useChatStore: {
    getState: () => mocks.state,
  },
}));

vi.mock("@/lib/perfLog", () => ({
  markStart: vi.fn(),
  markEnd: vi.fn(),
}));

const session1 = { id: "session-1" } as ChatSession;
const session2 = { id: "session-2" } as ChatSession;

function lifecycleOptions(
  overrides: Partial<ChatSessionLifecycleOptions> = {},
): ChatSessionLifecycleOptions {
  return {
    isActive: true,
    treeActiveSceneId: "scene-1",
    chatScope: "scene",
    scopeAnchorId: null,
    activeSessionId: mocks.state.activeSessionId,
    includeBodies: true,
    includeMapBoard: false,
    mapBoardId: null,
    agentMode: false,
    provider: null,
    currentModel: "test-model",
    allCodexEntries: [],
    loadAiSettings: vi.fn(),
    setActiveSceneId: vi.fn(),
    loadSessions: vi.fn(async () => true),
    selectSession: vi.fn(async () => {}),
    refreshContextLayers: vi.fn(async () => null),
    ...overrides,
  };
}

async function flushLifecycleLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useChatSessionLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {
      sessions: [],
      activeSessionId: null,
    };
  });

  it("preserves an existing active session after refreshing the list", async () => {
    mocks.state = {
      sessions: [session2],
      activeSessionId: session2.id,
    };
    const selectSession = vi.fn(async () => {});
    const loadSessions = vi.fn(async () => {
      mocks.state = {
        sessions: [session1, session2],
        activeSessionId: session2.id,
      };
      return true;
    });

    renderHook(() =>
      useChatSessionLifecycle(
        lifecycleOptions({
          activeSessionId: session2.id,
          loadSessions,
          selectSession,
        }),
      ),
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledOnce());
    await flushLifecycleLoad();

    expect(selectSession).not.toHaveBeenCalled();
  });

  it("selects the first session when the refreshed list has no active session", async () => {
    const selectSession = vi.fn(async () => {});
    const loadSessions = vi.fn(async () => {
      mocks.state = {
        sessions: [session1, session2],
        activeSessionId: null,
      };
      return true;
    });

    renderHook(() =>
      useChatSessionLifecycle(
        lifecycleOptions({ loadSessions, selectSession }),
      ),
    );

    await waitFor(() =>
      expect(selectSession).toHaveBeenCalledWith(session1.id),
    );
  });

  it("does not redundantly select null when the refreshed list is empty", async () => {
    const selectSession = vi.fn(async () => {});
    const loadSessions = vi.fn(async () => {
      mocks.state = {
        sessions: [],
        activeSessionId: null,
      };
      return true;
    });

    renderHook(() =>
      useChatSessionLifecycle(
        lifecycleOptions({ loadSessions, selectSession }),
      ),
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledOnce());
    await flushLifecycleLoad();

    expect(selectSession).not.toHaveBeenCalled();
  });
});
