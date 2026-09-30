// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Toolbar } from "./Toolbar";
import { useCursorSettingsStore } from "./cursorSettingsStore";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    requested: vi.fn(),
    resolved: vi.fn(),
    ready,
    release: () => release(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./LayersPopover", async (original) => {
  loading.requested();
  await loading.ready;
  const module = await original<typeof import("./LayersPopover")>();
  loading.resolved();
  return module;
});

describe("Toolbar Layers cold loading", () => {
  it("defers loading until open, honors dismissal during loading, and reopens the loaded popover", async () => {
    useCursorSettingsStore.setState({ zenMode: false, layerAutoFollow: false });
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>本文</p>",
    });
    const view = render(
      <Toolbar editor={editor as never} onFindReplace={() => {}} />,
    );
    try {
      const trigger = screen.getByRole("button", {
        name: "editor.toolbar.layers",
      });
      expect(loading.requested).not.toHaveBeenCalled();
      fireEvent.click(trigger);
      await waitFor(() => expect(loading.requested).toHaveBeenCalledOnce());
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.mouseDown(document.body);
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      await act(async () => loading.release());
      await waitFor(() => expect(loading.resolved).toHaveBeenCalledOnce());
      expect(screen.queryByTestId("layers-popover")).toBeNull();
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(trigger);
      const popover = await screen.findByTestId("layers-popover");
      fireEvent.mouseDown(popover);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("layers-popover")).toBeNull();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(loading.requested).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      editor.destroy();
    }
  });
});
