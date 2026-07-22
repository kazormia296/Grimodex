// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveWorkspaceShell } from "./AdaptiveWorkspaceShell";
import { useCompactNavigationStore } from "./compactNavigationStore";

afterEach(() => {
  cleanup();
  useCompactNavigationStore.getState().reset();
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

  it("does not connect mobile data surfaces outside the phone profile", () => {
    const renderMobileSurface = vi.fn(() => <div>Scenes</div>);
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
    expect(renderMobileSurface).toHaveBeenCalledOnce();
    expect(renderMobileSurface).toHaveBeenCalledWith("scenes");
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
      "[data-mobile-surface]",
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
