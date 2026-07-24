// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhoneSceneMetaSheet } from "./PhoneSceneMetaSheet";

describe("PhoneSceneMetaSheet", () => {
  it("keeps its header and content inside the visual viewport safe area", () => {
    const onClose = vi.fn();
    render(
      <PhoneSceneMetaSheet
        phoneWorkspace
        open
        title="Scene details"
        closeLabel="Close"
        onClose={onClose}
      >
        <div>Scene metadata</div>
      </PhoneSceneMetaSheet>,
    );

    const sheet = screen.getByTestId("phone-scene-meta-sheet");
    expect(sheet.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(sheet.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(sheet.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(sheet.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(sheet.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(screen.getByText("Scene metadata")).toBeInTheDocument();

    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("min-h-11");
    expect(close.className).toContain("min-w-11");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not mount the phone sheet in the desktop projection", () => {
    render(
      <PhoneSceneMetaSheet
        phoneWorkspace={false}
        open
        title="Scene details"
        closeLabel="Close"
        onClose={vi.fn()}
      >
        <div>Scene metadata</div>
      </PhoneSceneMetaSheet>,
    );

    expect(screen.queryByTestId("phone-scene-meta-sheet")).toBeNull();
  });
});
