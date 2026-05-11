// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SceneMetaPanel } from "./SceneMetaPanel";
import type { Editor } from "@tiptap/core";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ nodes: [{ id: "scene-1", nodeType: "scene", title: "Scene 1" }] }),
  ),
}));

vi.mock("@/features/editor/SynopsisHeader", () => ({
  SynopsisHeader: ({ sceneId }: { sceneId: string }) => (
    <div data-testid="synopsis-header" data-scene-id={sceneId} />
  ),
}));

vi.mock("@/features/editor/BeatsHeader", () => ({
  BeatsHeader: ({ sceneId }: { sceneId: string }) => (
    <div data-testid="beats-header" data-scene-id={sceneId} />
  ),
}));

vi.mock("@/features/post-effect/PostEffectAnnotationPanel", () => ({
  PostEffectAnnotationPanel: ({ sceneId }: { sceneId: string }) => (
    <div data-testid="annotation-panel" data-scene-id={sceneId} />
  ),
}));

const mockEditor = null as unknown as Editor;

describe("SceneMetaPanel (B-10)", () => {
  it("renders the panel container", () => {
    render(
      <SceneMetaPanel
        sceneId="scene-1"
        editor={mockEditor}
        setMentionPopup={() => {}}
      />,
    );
    expect(screen.getByTestId("scene-meta-panel")).toBeTruthy();
  });

  it("renders SynopsisHeader with correct sceneId", () => {
    render(
      <SceneMetaPanel
        sceneId="scene-1"
        editor={mockEditor}
        setMentionPopup={() => {}}
      />,
    );
    const header = screen.getByTestId("synopsis-header");
    expect(header.getAttribute("data-scene-id")).toBe("scene-1");
  });

  it("renders BeatsHeader with correct sceneId", () => {
    render(
      <SceneMetaPanel
        sceneId="scene-1"
        editor={mockEditor}
        setMentionPopup={() => {}}
      />,
    );
    const header = screen.getByTestId("beats-header");
    expect(header.getAttribute("data-scene-id")).toBe("scene-1");
  });
});
