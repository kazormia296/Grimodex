// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsiveDialog } from "./ResponsiveDialog";

describe("ResponsiveDialog", () => {
  afterEach(() => cleanup());

  it("uses a full-screen phone surface with safe-area hooks", () => {
    const { getByRole } = render(
      <ResponsiveDialog open onClose={vi.fn()} profile="phone" title="Picker">
        <p>content</p>
      </ResponsiveDialog>,
    );

    const dialog = getByRole("dialog");
    expect(dialog).toHaveAttribute("data-dialog-profile", "phone");
    expect(dialog.className).toContain("rounded-none");
    expect(dialog.className).toContain("h-[100dvh]");
  });

  it("supports a compact sheet without changing the desktop modal contract", () => {
    const { getByRole } = render(
      <ResponsiveDialog
        open
        onClose={vi.fn()}
        profile="compact"
        presentation="sheet"
        title="Picker"
      >
        <p>content</p>
      </ResponsiveDialog>,
    );

    const dialog = getByRole("dialog");
    expect(dialog).toHaveAttribute("data-dialog-profile", "compact");
    expect(dialog.className).toContain("rounded-t-xl");
  });

  it("does not consume Escape during IME composition but closes on normal Escape", () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <ResponsiveDialog open onClose={onClose} profile="wide" title="Picker">
        <input aria-label="text" />
      </ResponsiveDialog>,
    );

    fireEvent.keyDown(getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
      keyCode: 229,
      isComposing: true,
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
