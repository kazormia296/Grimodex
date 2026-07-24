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

const loadSessions = vi.fn().mockResolvedValue(undefined);
const selectSession = vi.fn().mockResolvedValue(undefined);
const createNewSession = vi.fn().mockResolvedValue(undefined);

describe("ConnectedMobileWorkspaceSurface AI readiness", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
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
      isLoadingSessions: false,
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
        {
          id: "chat-1",
          projectId: "project-1",
          nodeId: "scene-1",
          codexAnchorId: null,
          snippetAnchorId: null,
          title: "Opening ideas",
          titleManual: 0,
          model: "claude-test",
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
        },
        {
          id: "chat-2",
          projectId: "project-1",
          nodeId: "scene-1",
          codexAnchorId: null,
          snippetAnchorId: null,
          title: "Climax review",
          titleManual: 0,
          model: "claude-test",
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
        },
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

    fireEvent.change(
      screen.getByRole("combobox", { name: "Past chats" }),
      { target: { value: "chat-2" } },
    );
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
});
