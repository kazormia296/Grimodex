import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";

vi.mock("@/features/tree/SceneEditor", () => ({
  SceneEditor: () => <div data-scene-editor />,
}));

vi.mock("./PanelChromeMenu", () => ({
  PanelChromeMenu: ({ children }: { children: React.ReactNode }) => children,
}));

import { EditorArea } from "./EditorArea";

describe("EditorArea startup motion", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      initialized: true,
    });
  });

  it("shows the startup editor at its final opacity without an enter animation", () => {
    useLayoutStore.setState({ initialized: false });
    const { container } = render(<EditorArea />);
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");

    expect(editor).not.toBeNull();
    expect(getComputedStyle(editor!).opacity).toBe("1");
  });

  it("keeps the enter animation for mounts after initialization", async () => {
    const { container } = render(<EditorArea />);
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");

    expect(editor).not.toBeNull();
    expect(parseFloat(getComputedStyle(editor!).opacity)).toBeLessThan(1);
    await waitFor(() => {
      expect(getComputedStyle(editor!).opacity).toBe("1");
    });
  });
});
