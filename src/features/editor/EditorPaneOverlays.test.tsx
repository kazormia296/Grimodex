// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/chat/components/MentionPopup", () => ({
  MentionPopup: () => null,
}));
vi.mock("@/features/editor/inlineAi/InlineAIToolbar", () => ({
  InlineAIToolbar: () => null,
}));
vi.mock("@/features/editor/inlineAi/SlashCommandPopup", () => ({
  SlashCommandPopup: () => null,
}));
vi.mock("@/features/editor/reorder/ReorderOverlay", () => ({
  ReorderOverlay: () => null,
}));
vi.mock("@/features/editor/inlineAi/InlineAIPalette", () => ({
  InlineAIPalette: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="inline-ai-palette" onClick={onClose} />
  ),
}));
vi.mock("@/features/ab-test/AbInlineDialog", () => ({
  AbInlineDialog: ({
    onOpenChange,
  }: {
    onOpenChange: (open: boolean) => void;
  }) => (
    <button
      data-testid="ab-inline-dialog"
      onClick={() => onOpenChange(false)}
    />
  ),
}));

import { EditorPaneOverlays, type AbInlineState } from "./EditorPaneOverlays";

function buildProps() {
  return {
    editor: {} as Editor,
    paletteOpen: false,
    palettePreselect: null,
    onClosePalette: vi.fn(),
    onSubmitPalette: vi.fn(),
    onSubmitPaletteAb: vi.fn(),
    abInline: null as AbInlineState | null,
    onCloseAb: vi.fn(),
    onAdoptAb: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onRetry: vi.fn(),
    anchorRef: { current: null },
    isInlineAiOwner: false,
    mentionPopup: null,
    mentionIndex: 0,
    onMentionSelect: vi.fn(),
    onMentionIndexChange: vi.fn(),
    onMentionSelectWithRole: vi.fn(),
    paragraphReorder: {
      open: false,
      units: [],
      order: [],
      onOrderChange: vi.fn(),
      granularity: "sentence" as const,
      onGranularityChange: vi.fn(),
      loading: false,
      errorMessage: null,
      canConfirm: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    },
    bunsetsuAvailable: false,
    phraseAvailable: false,
    wordAvailable: false,
  };
}

describe("EditorPaneOverlays lazy dialogs", () => {
  it("mounts and closes the palette after its first open", async () => {
    const props = buildProps();
    const { rerender } = render(<EditorPaneOverlays {...props} />);

    expect(screen.queryByTestId("inline-ai-palette")).toBeNull();
    rerender(<EditorPaneOverlays {...props} paletteOpen />);

    fireEvent.click(await screen.findByTestId("inline-ai-palette"));
    expect(props.onClosePalette).toHaveBeenCalledOnce();

    rerender(<EditorPaneOverlays {...props} paletteOpen={false} />);
    await waitFor(() =>
      expect(screen.queryByTestId("inline-ai-palette")).toBeNull(),
    );
  });

  it("mounts and closes the A/B dialog after its first result", async () => {
    const props = buildProps();
    const abInline: AbInlineState = {
      messages: [],
      mode: "insert",
      originalRange: null,
      insertPos: 0,
      projectId: "project-a",
      projectionKey: "projection-a",
      documentSnapshot: {} as AbInlineState["documentSnapshot"],
    };
    const { rerender } = render(<EditorPaneOverlays {...props} />);

    expect(screen.queryByTestId("ab-inline-dialog")).toBeNull();
    rerender(<EditorPaneOverlays {...props} abInline={abInline} />);

    fireEvent.click(await screen.findByTestId("ab-inline-dialog"));
    expect(props.onCloseAb).toHaveBeenCalledOnce();

    rerender(<EditorPaneOverlays {...props} abInline={null} />);
    await waitFor(() =>
      expect(screen.queryByTestId("ab-inline-dialog")).toBeNull(),
    );
  });
});
