// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorToggleIcon } from "./EditorToggleIcon";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("EditorToggleIcon", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
    });
  });

  it("is pressed while the editor is open", () => {
    render(<EditorToggleIcon />);
    const button = screen.getByRole("button", { pressed: true });
    expect(button).toBeDefined();
    expect(button.querySelector("span[aria-hidden]")).toBeNull();
  });

  it("closes the editor when clicked while open", async () => {
    render(<EditorToggleIcon />);
    await userEvent.setup().click(screen.getByRole("button"));
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(false);
  });

  it("reopens the editor with the same control", async () => {
    useLayoutStore.getState().setEditorOpen(false);
    render(<EditorToggleIcon />);
    const button = screen.getByRole("button", { pressed: false });
    expect(button.className).toContain("text-muted-foreground");
    expect(button.className).not.toMatch(/text-muted-foreground\/\d+/);

    await userEvent.setup().click(button);
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
  });

  it("marks the icon as a fixed non-draggable control", () => {
    render(<EditorToggleIcon />);
    const button = screen.getByRole("button");
    expect(button.dataset.stripeIconKind).toBe("fixed");
    expect(button.className).toContain("ring-inset");
    expect(button.className).toContain("cursor-default");
  });
});
