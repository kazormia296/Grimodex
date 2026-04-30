// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SceneMetaPanel } from "./SceneMetaPanel";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ nodes: [{ id: "scene-1", nodeType: "scene", title: "Scene 1" }] }),
  ),
}));

describe("SceneMetaPanel (B-9 shell)", () => {
  it("renders the panel container", () => {
    render(<SceneMetaPanel sceneId="scene-1" />);
    expect(screen.getByTestId("scene-meta-panel")).toBeTruthy();
  });

  it("exposes a data-testid for layout verification", () => {
    const { container } = render(<SceneMetaPanel sceneId="scene-1" />);
    const panel = container.querySelector("[data-testid='scene-meta-panel']");
    expect(panel).not.toBeNull();
  });
});
