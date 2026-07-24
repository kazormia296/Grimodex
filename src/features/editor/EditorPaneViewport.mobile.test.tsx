// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  ResizablePanel: ({ children, id }: { children: ReactNode; id: string }) => (
    <div data-panel-id={id}>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="panel-handle" />,
}));

vi.mock("@/features/editor/EditorContentArea", () => ({
  EditorContentArea: () => <div data-testid="editor-content" />,
}));

vi.mock("@/features/editor/SceneMetaPanel", () => ({
  SceneMetaPanel: () => <div data-testid="scene-meta" />,
}));

import { EditorPaneViewport } from "./EditorPaneViewport";

const beatDragDrop = {
  sensors: [],
  collisionDetection: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  draggingBeat: null,
};

describe("EditorPaneViewport mobile projection", () => {
  it("keeps editor content mounted when the desktop side panel is suppressed", () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <EditorPaneViewport
        isPanelVisible
        sceneMetaPanelWidth={30}
        onPanelLayoutChanged={vi.fn()}
        contentAreaProps={{} as never}
        sceneId="scene-1"
        editor={null}
        setMentionPopup={vi.fn()}
        beatDragDrop={beatDragDrop as never}
      />,
    );
    const editorContent = getByTestId("editor-content");
    expect(getByTestId("scene-meta")).toBeTruthy();

    rerender(
      <EditorPaneViewport
        isPanelVisible={false}
        sceneMetaPanelWidth={30}
        onPanelLayoutChanged={vi.fn()}
        contentAreaProps={{} as never}
        sceneId="scene-1"
        editor={null}
        setMentionPopup={vi.fn()}
        beatDragDrop={beatDragDrop as never}
      />,
    );

    expect(getByTestId("editor-content")).toBe(editorContent);
    expect(queryByTestId("scene-meta")).toBeNull();
  });
});
