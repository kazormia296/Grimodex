// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CSSProperties } from "react";
import type { EditorSticky } from "./editorStickyTypes";

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError },
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
  props: Partial<React.ComponentProps<typeof EditorStickyCard>> = {},
) {
  const onBodySave = vi.fn(async (row: EditorSticky, body: string) => ({
    ...row,
    body,
    version: row.version + 1,
  }));
  const onSelect = vi.fn();
  const onEdit = vi.fn();
  const onStopEditing = vi.fn();
  const onDragStart = vi.fn();
  const onDragMove = vi.fn();
  const onDragEnd = vi.fn();
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
      editing
      onSelect={onSelect}
      onEdit={onEdit}
      onStopEditing={onStopEditing}
      onBodySave={onBodySave}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onColorChange={vi.fn().mockResolvedValue(undefined)}
      onBringToFront={vi.fn().mockResolvedValue(undefined)}
      onSendToBack={vi.fn().mockResolvedValue(undefined)}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onMeasure={vi.fn()}
      {...props}
    />,
  );
  return {
    ...result,
    onBodySave,
    onSelect,
    onEdit,
    onStopEditing,
    onDragStart,
    onDragMove,
    onDragEnd,
  };
}

describe("EditorStickyCard Map parity", () => {
  it("uses the shared skeuomorphic paper shell without a dedicated header", () => {
    renderCard({ editing: false });

    const visual = screen.getByTestId("editor-sticky-paper-visual");
    expect(visual.classList.contains("sticky-paper")).toBe(true);
    expect(visual).toHaveAttribute("data-glue", "left");
    expect(screen.queryByRole("button", { name: "付箋を移動" })).toBeNull();
  });

  it("applies Map's stable micro-rotation without rotating the mask holes", () => {
    renderCard({
      editing: false,
      coverage: [{ x: 20, y: 30, width: 40, height: 24 }],
    });

    const card = screen.getByLabelText("Editor付箋");
    const match = /^rotate\((-?\d+(?:\.\d+)?)deg\)$/.exec(
      card.style.transform,
    );
    expect(match).not.toBeNull();
    const rotation = Number(match?.[1]);
    expect(Math.abs(rotation)).toBeLessThanOrEqual(2.5);
    expect(rotation).not.toBe(0);
    expect(screen.getByTestId("editor-sticky-mask-holes")).toHaveAttribute(
      "transform",
      `rotate(${-rotation} 120 60)`,
    );
  });

  it("keeps the manuscript font size in display and edit modes", () => {
    const { rerender } = renderCard({ editing: false, fontSize: 18 });

    expect(screen.getByTestId("sticky-body-view")).toHaveStyle({
      fontSize: "18px",
    });

    rerender(
      <EditorStickyCard
        sticky={sticky}
        left={0}
        top={0}
        width={240}
        minHeight={120}
        maxHeight={360}
        height={120}
        fontSize={18}
        coverage={[]}
        selected
        editing
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onStopEditing={vi.fn()}
        onBodySave={vi.fn(async (row, body) => ({
          ...row,
          body,
          version: row.version + 1,
        }))}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onBringToFront={vi.fn().mockResolvedValue(undefined)}
        onSendToBack={vi.fn().mockResolvedValue(undefined)}
        onDragStart={vi.fn()}
        onDragMove={vi.fn()}
        onDragEnd={vi.fn()}
        onMeasure={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "付箋本文" })).toHaveStyle({
      fontSize: "18px",
      lineHeight: "1.5",
    });
  });

  it("enters editing when the body is double-clicked", () => {
    const { onEdit } = renderCard({ editing: false });

    fireEvent.doubleClick(screen.getByTestId("sticky-body-view"));

    expect(onEdit).toHaveBeenCalledExactlyOnceWith(sticky.id);
  });

  it("uses the whole non-editing paper as the drag surface", () => {
    const { onDragStart, onDragMove, onDragEnd } = renderCard({
      editing: false,
    });
    const body = screen.getByTestId("sticky-body-view");
    const card = screen.getByLabelText("Editor付箋");

    fireEvent.pointerDown(body, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 20,
    });
    fireEvent.pointerMove(card, {
      pointerId: 7,
      clientX: 16,
      clientY: 32,
    });
    fireEvent.pointerUp(card, { pointerId: 7 });

    expect(onDragStart).toHaveBeenCalledExactlyOnceWith(sticky.id);
    expect(onDragMove).toHaveBeenCalledExactlyOnceWith(sticky.id, 6, 12);
    expect(onDragEnd).toHaveBeenCalledExactlyOnceWith(sticky.id);
  });
});

describe("EditorStickyCard edit authority", () => {
  it("keeps the edit-entry version when a sibling updates before first input", async () => {
    const { rerender, onBodySave } = renderCard();
    const remote = { ...sticky, body: "body-v1", version: 1 };

    rerender(
      <EditorStickyCard
        sticky={remote}
        left={0}
        top={0}
        width={240}
        minHeight={120}
        maxHeight={360}
        height={120}
        fontSize={16}
        coverage={[]}
        selected
        editing
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onStopEditing={vi.fn()}
        onBodySave={onBodySave}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onBringToFront={vi.fn().mockResolvedValue(undefined)}
        onSendToBack={vi.fn().mockResolvedValue(undefined)}
        onDragStart={vi.fn()}
        onDragMove={vi.fn()}
        onDragEnd={vi.fn()}
        onMeasure={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "付箋本文" }), {
      target: { value: "local-after-remote" },
    });
    fireEvent.keyDown(screen.getByLabelText("Editor付箋"), { key: "Escape" });

    await waitFor(() =>
      expect(onBodySave).toHaveBeenCalledWith(remote, "local-after-remote", 0),
    );
  });
});
