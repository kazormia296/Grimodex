// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  AdaptiveWorkspaceShell,
  type MobileWorkspaceSurfaceId,
} from "./AdaptiveWorkspaceShell";
import { useCompactNavigationStore } from "./compactNavigationStore";
import { PhoneChatSurface } from "./mobile/PhoneChatSurface";
import { PhoneCodexNavigator } from "./mobile/PhoneCodexNavigator";
import { PhoneSceneNavigator } from "./mobile/PhoneSceneNavigator";

afterEach(() => {
  cleanup();
  useCompactNavigationStore.getState().reset();
  useEditorSessionStore.getState().resetForProject();
  useInlineAiStore.getState().reset();
});

describe("AdaptiveWorkspaceShell", () => {
  it("keeps the editor DOM node mounted across profile changes", () => {
    const { container, rerender } = render(
      <AdaptiveWorkspaceShell
        profile="wide"
        editor={<textarea data-testid="editor" />}
        panel={<div data-testid="panel">Panel</div>}
        panelOpen
      />,
    );
    const editor = container.querySelector("[data-testid=editor]");

    rerender(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        panel={<div data-testid="panel">Panel</div>}
        panelOpen
      />,
    );

    expect(container.querySelector("[data-testid=editor]")).toBe(editor);
    expect(
      container.querySelector("[data-adaptive-chrome=phone]"),
    ).not.toBeNull();
    expect(container.querySelector("[data-editor-surface]")).not.toBeNull();
  });

  it("does not expose hidden surfaces to pointer or accessibility navigation", () => {
    const { container } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<div data-testid="editor" />}
        panel={<div data-testid="panel" />}
        panelOpen
      />,
    );
    const editorSurface = container.querySelector("[data-editor-surface]");

    expect(editorSurface).toHaveAttribute("aria-hidden", "true");
    expect(editorSurface).toHaveAttribute("inert");
  });

  it("keeps phone navigation content behind the typed mobile surface boundary", () => {
    const { container } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<div data-testid="editor" />}
        mobileSurfaces={{ scenes: <div data-testid="scenes">Scenes</div> }}
      />,
    );
    const scenesButton = container.querySelectorAll("nav button")[1];
    if (scenesButton) fireEvent.click(scenesButton);
    expect(container.querySelector("[data-mobile-surface]")).not.toBeNull();
  });

  it("hands Write focus to the group that already owns the phone document", () => {
    useCompactNavigationStore.getState().openSurface("scenes");
    useTreeStore.setState({ activeSceneId: "scene-b" });
    useTabStore.setState({
      tabs: [{ nodeId: "scene-a", contentType: "scene", isPreview: false }],
      activeTabId: "scene-a",
      secondaryTabs: [
        { nodeId: "scene-b", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-b",
      secondaryGroupOpen: true,
      activeGroupIndex: 0,
    } as never);
    const { container } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        mobileSurfaces={{ scenes: <div>Scenes</div> }}
      />,
    );

    fireEvent.click(container.querySelectorAll("nav button")[0]!);

    expect(useEditorSessionStore.getState().focusRequests).toEqual({
      0: false,
      1: true,
    });
  });

  it("hands Write focus to the inline-AI owner when both groups hold the document", () => {
    useCompactNavigationStore.getState().openSurface("scenes");
    useTreeStore.setState({ activeSceneId: "scene-a" });
    useTabStore.setState({
      tabs: [{ nodeId: "scene-a", contentType: "scene", isPreview: false }],
      activeTabId: "scene-a",
      secondaryTabs: [
        { nodeId: "scene-a", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-a",
      secondaryGroupOpen: true,
      activeGroupIndex: 1,
    } as never);
    useInlineAiStore.setState({
      status: "diffShown",
      activeEditorGroup: 0,
    });
    const { container } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        mobileSurfaces={{ scenes: <div>Scenes</div> }}
      />,
    );

    fireEvent.click(container.querySelectorAll("nav button")[0]!);

    expect(useEditorSessionStore.getState().focusRequests).toEqual({
      0: true,
      1: false,
    });
  });

  it("does not connect mobile data surfaces outside the phone profile", () => {
    const renderMobileSurface = vi.fn((surface: MobileWorkspaceSurfaceId) => (
      <div>{surface}</div>
    ));
    useCompactNavigationStore.getState().openSurface("scenes");
    const { rerender } = render(
      <AdaptiveWorkspaceShell
        profile="wide"
        editor={<div>Editor</div>}
        renderMobileSurface={renderMobileSurface}
      />,
    );
    expect(renderMobileSurface).not.toHaveBeenCalled();

    rerender(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<div>Editor</div>}
        renderMobileSurface={renderMobileSurface}
      />,
    );
    expect(renderMobileSurface).toHaveBeenCalledTimes(5);
    expect(renderMobileSurface.mock.calls.map(([surface]) => surface)).toEqual([
      "scenes",
      "codex",
      "ai",
      "more",
      "search",
    ]);
  });

  it("keeps phone surface state mounted while bottom navigation hides inactive surfaces", () => {
    useCompactNavigationStore.getState().openSurface("scenes");
    const { container } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        mobileSurfaces={{
          scenes: (
            <PhoneSceneNavigator
              scenes={[
                { id: "opening", title: "Opening" },
                { id: "climax", title: "Climax" },
              ]}
              onOpenScene={vi.fn()}
            />
          ),
          codex: (
            <PhoneCodexNavigator
              entries={[{ id: "aoi", name: "葵", type: "character" }]}
            />
          ),
          ai: <PhoneChatSurface messages={[]} onSend={vi.fn()} />,
          more: <div>More</div>,
          search: <div>Search</div>,
        }}
      />,
    );
    const navigationButtons = container.querySelectorAll("nav button");
    const scenesSurface = container.querySelector<HTMLElement>(
      '[data-mobile-surface-id="scenes"]',
    );
    const codexSurface = container.querySelector<HTMLElement>(
      '[data-mobile-surface-id="codex"]',
    );
    const aiSurface = container.querySelector<HTMLElement>(
      '[data-mobile-surface-id="ai"]',
    );
    const sceneQuery = scenesSurface?.querySelector<HTMLInputElement>("input");

    expect(scenesSurface).not.toBeNull();
    expect(codexSurface).not.toBeNull();
    expect(aiSurface).not.toBeNull();
    expect(scenesSurface).not.toHaveAttribute("aria-hidden");
    expect(codexSurface).toHaveAttribute("aria-hidden", "true");
    expect(codexSurface).toHaveAttribute("inert");

    if (sceneQuery) {
      fireEvent.change(sceneQuery, { target: { value: "climax" } });
    }
    fireEvent.click(navigationButtons[2]!);
    expect(container.querySelector('[data-mobile-surface-id="scenes"]')).toBe(
      scenesSurface,
    );
    expect(scenesSurface).toHaveAttribute("aria-hidden", "true");
    expect(scenesSurface).toHaveAttribute("inert");
    expect(codexSurface).not.toHaveAttribute("aria-hidden");

    const codexEntry = codexSurface?.querySelector("button");
    if (codexEntry) fireEvent.click(codexEntry);
    expect(codexSurface?.querySelector("article")).not.toBeNull();

    fireEvent.click(navigationButtons[3]!);
    const chatDraft = aiSurface?.querySelector<HTMLTextAreaElement>("textarea");
    if (chatDraft) {
      fireEvent.change(chatDraft, { target: { value: "Unsent draft" } });
    }
    fireEvent.click(navigationButtons[0]!);
    expect(aiSurface).toHaveAttribute("aria-hidden", "true");
    expect(aiSurface).toHaveAttribute("inert");

    fireEvent.click(navigationButtons[1]!);
    expect(scenesSurface?.querySelector<HTMLInputElement>("input")?.value).toBe(
      "climax",
    );
    fireEvent.click(navigationButtons[2]!);
    expect(codexSurface?.querySelector("article")).not.toBeNull();
    fireEvent.click(navigationButtons[3]!);
    expect(
      aiSurface?.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("Unsent draft");
    expect(aiSurface).not.toHaveAttribute("aria-hidden");
    expect(aiSurface).not.toHaveAttribute("inert");
  });

  it("projects the mounted editor over phone chrome without changing mobile navigation state", () => {
    useCompactNavigationStore.getState().openSurface("scenes");
    const { container, rerender } = render(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        zenMode
        renderMobileSurface={() => <div data-testid="scenes">Scenes</div>}
      />,
    );
    const editor = container.querySelector("[data-testid=editor]");
    const editorSurface = container.querySelector<HTMLElement>(
      "[data-editor-surface]",
    );
    const mobileSurface = container.querySelector<HTMLElement>(
      '[data-mobile-surface-id="scenes"]',
    );

    expect(
      container.querySelector('[data-adaptive-chrome="phone"]'),
    ).toHaveAttribute("data-active", "false");
    expect(editorSurface).toHaveStyle({ visibility: "visible" });
    expect(editorSurface).not.toHaveAttribute("aria-hidden");
    expect(mobileSurface).toHaveStyle({ visibility: "hidden" });
    expect(mobileSurface).toHaveAttribute("inert");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("scenes");

    rerender(
      <AdaptiveWorkspaceShell
        profile="phone"
        editor={<textarea data-testid="editor" />}
        renderMobileSurface={() => <div data-testid="scenes">Scenes</div>}
      />,
    );

    expect(container.querySelector("[data-testid=editor]")).toBe(editor);
    expect(editorSurface).toHaveAttribute("aria-hidden", "true");
    expect(mobileSurface).toHaveStyle({ visibility: "visible" });
    expect(useCompactNavigationStore.getState().activeSurface).toBe("scenes");
  });
});
