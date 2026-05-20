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
    expect(screen.getByRole("button", { pressed: true })).toBeDefined();
  });

  it("closes the editor when clicked while open", async () => {
    render(<EditorToggleIcon />);
    await userEvent.setup().click(screen.getByRole("button"));
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(false);
  });

  it("reopens the editor with the same control", async () => {
    useLayoutStore.getState().setEditorOpen(false);
    render(<EditorToggleIcon />);
    expect(screen.getByRole("button", { pressed: false })).toBeDefined();

    await userEvent.setup().click(screen.getByRole("button"));
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
  });
});
