import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { ensureEditorOverlayVisible } from "./ensureOverlayVisible";

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      set: vi.fn(),
      getBoolean: (_key: string, def: boolean) => def,
    }),
  },
}));

describe("ensureEditorOverlayVisible", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({
      showComments: false,
      showForeshadowMarks: false,
    });
    useCodexHighlightStore.setState({ enabled: false });
  });

  it("forces comment overlays on when a comment is added", () => {
    ensureEditorOverlayVisible("comment", null);
    expect(useCursorSettingsStore.getState().showComments).toBe(true);
  });

  it("forces foreshadow overlays on when a foreshadow mark is added", () => {
    ensureEditorOverlayVisible("foreshadow", null);
    expect(useCursorSettingsStore.getState().showForeshadowMarks).toBe(true);
  });

  it("forces codex overlays on when a semantic link is added", () => {
    ensureEditorOverlayVisible("codex", null);
    expect(useCodexHighlightStore.getState().enabled).toBe(true);
  });
});
