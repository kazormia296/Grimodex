// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, CSSProperties } from "react";
import type { EditorSticky } from "./editorStickyTypes";

const { mockSetEditorStickyColor, mockToastError } = vi.hoisted(() => ({
  mockSetEditorStickyColor: vi.fn().mockResolvedValue(undefined),
  mockToastError: vi.fn(),
}));

vi.mock("./editorStickyCommands", () => ({
  setEditorStickyColor: mockSetEditorStickyColor,
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "map.menu.changeColor": "色を変更",
        "map.menu.bringToFront": "前面へ",
        "map.menu.sendToBack": "背面へ",
        "common.delete": "削除",
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock("@/application/lifecycle/useQuiescentDraftParticipant", () => ({
  useQuiescentDraftParticipant: () => undefined,
}));

vi.mock("@/features/sticky/StickyBodyEditor", () => ({
  StickyBodyEditor: ({
    body,
    onContentChange,
    style,
  }: {
    body: string;
    onContentChange: (body: string) => void;
    style?: CSSProperties;
  }) => (
    <textarea
      aria-label="付箋本文"
      defaultValue={body}
      style={style}
      onChange={(event) => onContentChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/features/sticky/StickyRichTextBody", () => ({
  StickyRichTextBody: ({
    body,
    fontSize,
  }: {
    body: string;
    fontSize?: CSSProperties["fontSize"];
  }) => (
    <div data-testid="sticky-body-view" style={{ fontSize }}>
      {body}
    </div>
  ),
}));

import { EditorStickyCard } from "./EditorStickyCard";

const documentKey = {
  kind: "tree",
  id: "scene-1",
  storage: "database",
} as const;

const sticky: EditorSticky = {
  id: "sticky-1",
  projectId: "project-1",
  documentKey,
  body: "body-v0",
  paletteId: "post-it-playful",
  colorSlot: 0,
  inlineOffset: 12,
  blockOffset: 24,
  zIndex: 0,
  version: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

function renderCard(
  overrides: Partial<ComponentProps<typeof EditorStickyCard>> = {},
) {
  const onSelect = vi.fn();
  const onBringToFront = vi.fn().mockResolvedValue(undefined);
  const onSendToBack = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <EditorStickyCard
      sticky={sticky}
      left={0}
      top={0}
      width={240}
      minHeight={120}
      maxHeight={360}
      height={120}
      fontSize={16}
      coverage={[]}
      selected
      editing={false}
      onSelect={onSelect}
      onEdit={vi.fn()}
      onStopEditing={vi.fn()}
      onBodySave={vi.fn(async (row, body) => ({
        ...row,
        body,
        version: row.version + 1,
      }))}
      onDelete={onDelete}
      onColorChange={vi.fn().mockResolvedValue(undefined)}
      onBringToFront={onBringToFront}
      onSendToBack={onSendToBack}
      onDragStart={vi.fn()}
      onDragMove={vi.fn()}
      onDragEnd={vi.fn()}
      onMeasure={vi.fn()}
      {...overrides}
    />,
  );
  return {
    ...result,
    onSelect,
    onBringToFront,
    onSendToBack,
    onDelete,
  };
}

describe("EditorStickyCard context menu and selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetEditorStickyColor.mockResolvedValue(undefined);
  });

  it("executes commands from the Map-style context menu", async () => {
    const { onBringToFront } = renderCard();

    fireEvent.contextMenu(screen.getByLabelText("Editor付箋"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "前面へ" }),
    );

    await waitFor(() =>
      expect(onBringToFront).toHaveBeenCalledExactlyOnceWith(sticky),
    );
  });

  it("opens the color submenu and applies the selected palette slot", async () => {
    renderCard();

    fireEvent.contextMenu(screen.getByLabelText("Editor付箋"));
    const colorTrigger = await screen.findByRole("menuitem", {
      name: "色を変更",
    });
    colorTrigger.focus();
    fireEvent.keyDown(colorTrigger, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Vital Orange" }),
    );

    await waitFor(() =>
      expect(mockSetEditorStickyColor).toHaveBeenCalledExactlyOnceWith(
        sticky,
        "post-it-playful",
        1,
      ),
    );
  });

  it("clears selection when the user points outside the selected card", () => {
    const { onSelect } = renderCard();
    onSelect.mockClear();

    fireEvent.pointerDown(document.body);

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("clears selection with Escape outside edit mode", () => {
    const { onSelect } = renderCard();
    onSelect.mockClear();

    fireEvent.keyDown(screen.getByLabelText("Editor付箋"), { key: "Escape" });

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  });
});
