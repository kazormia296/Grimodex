// @vitest-environment happy-dom
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/chatStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { PhoneEmptySceneBootstrap } from "./PhoneEmptySceneBootstrap";
import { useTreeStore } from "./treeStore";

describe("PhoneEmptySceneBootstrap", () => {
  beforeEach(() => {
    useCompactNavigationStore.getState().reset();
    useEditorSessionStore.getState().resetForProject();
    useTabStore.setState({
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
      activeTabId: null,
      secondaryActiveTabId: null,
    });
    useWorkspaceStore.setState({
      activeWorkspacePath: "/workspace/empty",
      workspaceOpenRevision: 12,
    });
    useChatStore.setState({
      activeSceneId: "",
      chatScope: "scene",
      agentMode: false,
      isStreaming: false,
      messages: [],
    } as never);
    useTreeStore.setState({
      projectId: "project-empty",
      hydratedProjectId: "project-empty",
      hydratedWorkspaceOpenRevision: 12,
      nodes: [],
      scenes: [],
      activeSceneId: "",
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    useCompactNavigationStore.getState().reset();
    useEditorSessionStore.getState().resetForProject();
  });

  it("creates one scene under StrictMode and immediately selects it", async () => {
    const createNode = vi.fn().mockResolvedValue({
      id: "scene-created",
      nodeType: "scene",
      title: "Scene 1",
    });
    useTreeStore.setState({ createNode });
    useCompactNavigationStore.getState().openSurface("scenes");

    render(
      <StrictMode>
        <PhoneEmptySceneBootstrap />
      </StrictMode>,
    );

    await waitFor(() => expect(createNode).toHaveBeenCalledOnce());
    expect(createNode).toHaveBeenCalledWith({
      nodeType: "scene",
      parentId: null,
      interaction: "implicit",
    });
    await waitFor(() =>
      expect(useTreeStore.getState().activeSceneId).toBe("scene-created"),
    );
    expect(useChatStore.getState().activeSceneId).toBe("scene-created");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useEditorSessionStore.getState().consumeEditorFocusRequest(0)).toBe(
      true,
    );
  });

  it("selects an existing note instead of creating a duplicate scene", async () => {
    const createNode = vi.fn();
    useTreeStore.setState({
      createNode,
      nodes: [
        {
          id: "note-1",
          nodeType: "note",
          title: "Reference",
        },
      ] as never,
    });

    render(<PhoneEmptySceneBootstrap />);

    await waitFor(() =>
      expect(useTreeStore.getState().activeSceneId).toBe("note-1"),
    );
    expect(createNode).not.toHaveBeenCalled();
  });

  it("hands focus back to the preserved secondary owner group", async () => {
    useTabStore.setState({
      secondaryGroupOpen: true,
      activeGroupIndex: 0,
      activeTabId: "scene-primary",
      secondaryActiveTabId: "scene-secondary",
    });
    useTreeStore.setState({
      nodes: [
        {
          id: "scene-secondary",
          nodeType: "scene",
          title: "Secondary",
        },
      ] as never,
    });

    render(<PhoneEmptySceneBootstrap />);

    await waitFor(() =>
      expect(useTreeStore.getState().activeSceneId).toBe("scene-secondary"),
    );
    expect(useEditorSessionStore.getState().consumeEditorFocusRequest(1)).toBe(
      true,
    );
    expect(useEditorSessionStore.getState().consumeEditorFocusRequest(0)).toBe(
      false,
    );
  });

  it("does not move Chat when Tree rejects activation during an Agent turn", async () => {
    useChatStore.setState({
      activeSceneId: "scene-current",
      agentMode: true,
      isStreaming: true,
      messages: [{ id: "streaming-message", content: "draft" }],
    } as never);
    useTreeStore.setState({
      activeSceneId: "scene-current",
      nodes: [
        {
          id: "scene-target",
          nodeType: "scene",
          title: "Target",
        },
      ] as never,
    });
    useCompactNavigationStore.getState().openSurface("scenes");

    render(<PhoneEmptySceneBootstrap />);

    await waitFor(() =>
      expect(document.querySelector('[role="status"] button')).not.toBeNull(),
    );
    expect(useTreeStore.getState().activeSceneId).toBe("scene-current");
    expect(useChatStore.getState().activeSceneId).toBe("scene-current");
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().messages).toEqual([
      { id: "streaming-message", content: "draft" },
    ]);
    expect(useCompactNavigationStore.getState().activeSurface).toBe("scenes");
    expect(useEditorSessionStore.getState().consumeEditorFocusRequest(0)).toBe(
      false,
    );
  });

  it("does not create against stale or failed tree hydration", async () => {
    const createNode = vi.fn();
    useTreeStore.setState({
      createNode,
      hydratedProjectId: null,
    });

    render(<PhoneEmptySceneBootstrap />);
    await Promise.resolve();

    expect(createNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe("");
  });

  it("does not create from a previous workspace hydration with the same project id", async () => {
    const createNode = vi.fn();
    useTreeStore.setState({
      createNode,
      hydratedProjectId: "project-empty",
      hydratedWorkspaceOpenRevision: 11,
    });

    render(<PhoneEmptySceneBootstrap />);
    await Promise.resolve();

    expect(createNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe("");
  });
});
