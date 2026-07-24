// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import { useChatStore } from "@/features/chat/chatStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { ConnectedMobileWorkspaceSurface } from "./MobileWorkspaceSurfaces";
import { useCompactNavigationStore } from "./compactNavigationStore";

const loadSessions = vi.fn();
const selectSession = vi.fn();
const createNewSession = vi.fn();

function chatSession(id: string, nodeId: string) {
  return {
    id,
    projectId: "project-1",
    nodeId,
    codexAnchorId: null,
    snippetAnchorId: null,
    title: id,
    titleManual: 0,
    model: "claude-test",
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
  };
}

describe("ConnectedMobileWorkspaceSurface AI readiness", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    loadSessions.mockReset().mockResolvedValue(true);
    selectSession.mockReset().mockResolvedValue(undefined);
    createNewSession.mockReset().mockResolvedValue(undefined);
    useCompactNavigationStore.setState({
      activeSurface: "ai",
      backStack: [],
      sheet: null,
    });
    useProjectStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          aiPolicy: null,
        },
      ] as never,
    });
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "anthropic",
        model: "claude-test",
      },
      hasApiKey: false,
    });
    useTreeStore.setState({ activeSceneId: "scene-1" } as never);
    useChatStore.setState({
      messages: [],
      sessions: [],
      activeSessionId: null,
      activeSceneId: "scene-1",
      isLoadingSessions: false,
      isLoadingMessages: false,
      isStreaming: false,
      chatScope: "scene",
      scopeAnchorId: null,
      loadSessions,
      selectSession,
      createNewSession,
    } as never);
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("ja");
  });

  it("keeps the draft editable but blocks submit until the provider is ready", () => {
    const onOpenSettings = vi.fn();
    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={onOpenSettings}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    const send = screen.getByRole("button", { name: "Send" });

    expect(input).toBeEnabled();
    expect(send).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "AI is not configured",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open AI settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    act(() => {
      useAiSettingsStore.setState({ hasApiKey: true });
    });

    expect(input).toHaveValue("Keep this draft");
    expect(send).toBeEnabled();
  });

  it("loads and wires the current-scope chat history on the phone AI surface", async () => {
    useAiSettingsStore.setState({ hasApiKey: true });
    useChatStore.setState({
      sessions: [
        { ...chatSession("chat-1", "scene-1"), title: "Opening ideas" },
        { ...chatSession("chat-2", "scene-1"), title: "Climax review" },
      ],
      activeSessionId: "chat-1",
    });

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledWith(
        "scene-1",
        undefined,
        undefined,
      );
    });
    expect(selectSession).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Past chats" }), {
      target: { value: "chat-2" },
    });
    expect(selectSession).toHaveBeenCalledWith("chat-2");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(createNewSession).toHaveBeenCalledWith(
      "project-1",
      "New chat",
      "scene-1",
      undefined,
      undefined,
    );
  });

  it("mirrors tree scene changes while inactive and waits to load until AI opens", async () => {
    useCompactNavigationStore.getState().reset();
    useChatStore.setState({
      activeSceneId: "scene-old",
      activeSessionId: "chat-old",
      sessions: [chatSession("chat-old", "scene-old")],
      messages: [
        { id: "message-old", role: "assistant", content: "old reply" },
      ],
    } as never);
    useTreeStore.setState({ activeSceneId: "scene-2" } as never);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(useChatStore.getState().activeSceneId).toBe("scene-2");
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().messages).toEqual([]);
    });
    expect(loadSessions).not.toHaveBeenCalled();

    act(() => {
      useCompactNavigationStore.getState().openSurface("ai");
    });

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledWith(
        "scene-2",
        undefined,
        undefined,
      );
    });
  });

  it("selects only the latest scene result when an older load resolves late", async () => {
    let resolveScene1!: () => void;
    let resolveScene2!: () => void;
    const scene1Ready = new Promise<void>((resolve) => {
      resolveScene1 = resolve;
    });
    const scene2Ready = new Promise<void>((resolve) => {
      resolveScene2 = resolve;
    });
    let requestGeneration = 0;
    loadSessions.mockImplementation(async (nodeId?: string | null) => {
      const generation = ++requestGeneration;
      await (nodeId === "scene-1" ? scene1Ready : scene2Ready);
      if (generation !== requestGeneration) return false;
      useChatStore.setState({
        sessions: [chatSession(`chat-${nodeId}`, nodeId!)],
        isLoadingSessions: false,
      });
      return true;
    });

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );
    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));

    act(() => {
      useTreeStore.setState({ activeSceneId: "scene-2" } as never);
    });
    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveScene2();
      await scene2Ready;
    });
    await waitFor(() =>
      expect(selectSession).toHaveBeenCalledWith("chat-scene-2"),
    );

    await act(async () => {
      resolveScene1();
      await scene1Ready;
    });
    expect(selectSession).toHaveBeenCalledTimes(1);
  });

  it("clears a missing scene and never exposes an older load as all history", async () => {
    let resolveLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const staleSession = chatSession("chat-stale", "scene-1");
    loadSessions.mockImplementation(async () => {
      await loadReady;
      if (!useTreeStore.getState().activeSceneId) return false;
      useChatStore.setState({
        sessions: [staleSession],
        isLoadingSessions: false,
      });
      return true;
    });
    useChatStore.setState({
      activeSessionId: staleSession.id,
      sessions: [staleSession],
      messages: [
        { id: "message-stale", role: "assistant", content: "stale reply" },
      ],
    } as never);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );
    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));

    act(() => {
      useTreeStore.setState({ activeSceneId: null } as never);
    });

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().messages).toEqual([]);
      expect(screen.queryByRole("option", { name: "chat-stale" })).toBeNull();
    });
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessions).not.toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
    );

    await act(async () => {
      resolveLoad();
      await loadReady;
    });
    await waitFor(() => {
      expect(useChatStore.getState().sessions).toEqual([]);
      expect(screen.queryByRole("option", { name: "chat-stale" })).toBeNull();
    });
  });

  it("selects null when the active scope has no sessions", async () => {
    useChatStore.setState({
      activeSessionId: "chat-old",
      sessions: [chatSession("chat-old", "scene-1")],
    });
    loadSessions.mockImplementation(async () => {
      useChatStore.setState({ sessions: [], isLoadingSessions: false });
      return true;
    });

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(selectSession).toHaveBeenCalledWith(null);
    });
  });

  it("does not auto-select stale history when loading the requested scope fails", async () => {
    const staleSession = chatSession("chat-stale", "scene-1");
    useChatStore.setState({
      activeSessionId: staleSession.id,
      sessions: [staleSession],
      messages: [
        { id: "message-stale", role: "assistant", content: "stale reply" },
      ],
    } as never);
    loadSessions.mockImplementation(async () => {
      useChatStore.setState({ sessions: [], isLoadingSessions: false });
      return false;
    });

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledOnce();
      expect(useChatStore.getState().sessions).toEqual([]);
    });
    expect(selectSession).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeSessionId).toBe(staleSession.id);
    expect(useChatStore.getState().messages).toEqual([
      { id: "message-stale", role: "assistant", content: "stale reply" },
    ]);
    expect(
      screen.queryByRole("option", { name: staleSession.title }),
    ).toBeNull();
  });

  it("rejects loaded sessions outside the requested node and anchor scope", async () => {
    const wrongScopeSession = {
      ...chatSession("chat-wrong-scope", "scene-1"),
      codexAnchorId: "codex-stale",
    };
    loadSessions.mockImplementation(async () => {
      useChatStore.setState({
        sessions: [wrongScopeSession],
        isLoadingSessions: false,
      });
      return true;
    });
    selectSession.mockImplementation(async (sessionId: string | null) => {
      if (sessionId === null) {
        useChatStore.setState({ activeSessionId: null, messages: [] });
      }
    });

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(selectSession).toHaveBeenCalledWith(null);
      expect(useChatStore.getState().activeSessionId).toBeNull();
    });
    expect(selectSession).not.toHaveBeenCalledWith(wrongScopeSession.id);
    expect(
      screen.queryByRole("option", { name: wrongScopeSession.title }),
    ).toBeNull();
  });

  it("creates one chat for a rapid double tap and locks the AI surface until it finishes", async () => {
    useAiSettingsStore.setState({ hasApiKey: true });
    let resolveCreation!: () => void;
    const creationReady = new Promise<void>((resolve) => {
      resolveCreation = resolve;
    });
    createNewSession.mockReturnValue(creationReady);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    });

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "keep this draft" } });
    const create = screen.getByRole("button", { name: "New chat" });
    act(() => {
      create.click();
      create.click();
    });

    expect(createNewSession).toHaveBeenCalledOnce();
    expect(create).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Past chats" })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(input).toHaveValue("keep this draft");

    await act(async () => {
      resolveCreation();
      await creationReady;
    });

    await waitFor(() => expect(create).toBeEnabled());
    expect(input).toBeEnabled();
    expect(input).toHaveValue("keep this draft");
  });
});
