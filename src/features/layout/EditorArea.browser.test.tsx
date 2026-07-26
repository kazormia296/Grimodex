import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "editor.zenBackground.glass.blur": "22",
        "editor.zenBackground.glass.refraction": "13",
        "editor.zenBackground.glass.saturation": "1.4",
        "editor.zenBackground.glass.shine": "0.65",
      },
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

  it("provides adjustable glass styling without filtering the editor DOM", () => {
    const { container } = render(<EditorArea />);
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const glassFilter = container.querySelector<HTMLElement>(
      "[data-editor-fluid-glass-filter]",
    );

    expect(editor).toHaveAttribute("data-editor-fluid-glass", "true");
    expect(editor).toHaveAttribute("data-editor-fluid-glass-refraction", "13");
    expect(glassFilter).not.toBeNull();
    expect(glassFilter).toHaveAttribute("aria-hidden", "true");
    expect(editor?.style.getPropertyValue("--editor-fluid-glass-blur")).toBe(
      "22px",
    );
    expect(
      editor?.style.getPropertyValue("--editor-fluid-glass-saturate"),
    ).toBe("1.4");
    expect(editor?.style.getPropertyValue("--editor-fluid-glass-shine")).toBe(
      "0.65",
    );
    expect(container.querySelector("[data-scene-editor]")).not.toBeNull();
  });
});
