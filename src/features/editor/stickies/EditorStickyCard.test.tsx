// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  }: {
    body: string;
    onContentChange: (body: string) => void;
  }) => (
    <textarea
      aria-label="付箋本文"
      defaultValue={body}
      onChange={(event) => onContentChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/features/sticky/StickyRichTextBody", () => ({
  StickyRichTextBody: ({ body }: { body: string }) => <div>{body}</div>,
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
  const onStopEditing = vi.fn();
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
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onStopEditing={onStopEditing}
      onBodySave={onBodySave}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onColorChange={vi.fn().mockResolvedValue(undefined)}
      onBringToFront={vi.fn().mockResolvedValue(undefined)}
      onSendToBack={vi.fn().mockResolvedValue(undefined)}
      onDragStart={vi.fn()}
      onDragMove={vi.fn()}
      onDragEnd={vi.fn()}
      onMeasure={vi.fn()}
      {...props}
    />,
  );
  return { ...result, onBodySave, onStopEditing };
}

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
