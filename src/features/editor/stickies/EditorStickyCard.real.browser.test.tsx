import { fireEvent, render } from "@testing-library/react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import type { EditorSticky } from "./editorStickyTypes";
import "./editorStickyCard.css";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/application/lifecycle/useQuiescentDraftParticipant", () => ({
  useQuiescentDraftParticipant: () => undefined,
}));

vi.mock("./editorStickyCommands", () => ({
  setEditorStickyColor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/editor/useTrashBinCapture", () => ({
  useTrashBinCapture: () => undefined,
}));

vi.mock("@/features/license/useLicenseEditableSync", () => ({
  useLicenseEditableSync: () => undefined,
}));

import { EditorStickyCard } from "./EditorStickyCard";

const documentKey = {
  kind: "tree",
  id: "scene-1",
  storage: "database",
} as const;

const sticky: EditorSticky = {
  id: "sticky-real-browser-double-click",
  projectId: "project-1",
  documentKey,
  body: JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "付箋の文字" }],
      },
    ],
  }),
  paletteId: "post-it-playful",
  colorSlot: 0,
  inlineOffset: 12,
  blockOffset: 24,
  zIndex: 0,
  version: 0,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

interface StatefulCardProps {
  onEdit: () => void;
  onStopEditing: () => void;
  onDelete?: (sticky: EditorSticky) => Promise<void>;
}

function StatefulCard({
  onEdit,
  onStopEditing,
  onDelete = async () => undefined,
}: StatefulCardProps) {
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
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
      selected={selected}
      editing={editing}
      onSelect={(stickyId) => setSelected(stickyId === sticky.id)}
      onEdit={() => {
        onEdit();
        setSelected(true);
        setEditing(true);
      }}
      onStopEditing={() => {
        onStopEditing();
        setEditing(false);
      }}
      onBodySave={vi.fn(async (row, body) => ({
        ...row,
        body,
        version: row.version + 1,
      }))}
      onDelete={onDelete}
      onColorChange={vi.fn().mockResolvedValue(undefined)}
      onBringToFront={vi.fn().mockResolvedValue(undefined)}
      onSendToBack={vi.fn().mockResolvedValue(undefined)}
      onDragStart={vi.fn()}
      onDragMove={vi.fn()}
      onDragEnd={vi.fn()}
      onMeasure={vi.fn()}
    />
  );
}

it("keeps the real TipTap sticky editor open after selecting text by double-click", async () => {
  const onEdit = vi.fn();
  const onStopEditing = vi.fn();
  render(<StatefulCard onEdit={onEdit} onStopEditing={onStopEditing} />);

  const text = page.getByText("付箋の文字");
  await expect.element(text).toBeVisible();
  await text.dblClick();

  expect(onEdit).toHaveBeenCalledExactlyOnceWith();
  await expect.element(page.getByRole("textbox")).toBeVisible();
  expect(onStopEditing).not.toHaveBeenCalled();
});

it("uses the paper outline instead of Chromium's native wrapper ring", async () => {
  render(
    <StatefulCard
      onEdit={vi.fn()}
      onStopEditing={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );

  const card = document.querySelector<HTMLElement>(
    '[data-editor-sticky-card="true"]',
  );
  const motion = document.querySelector<HTMLElement>(
    '[data-testid="editor-sticky-motion"]',
  );
  if (!card || !motion) throw new Error("Editor sticky card was not rendered");

  card.focus();
  fireEvent.click(card);

  await vi.waitFor(() => expect(card).toHaveAttribute("aria-selected", "true"));
  expect(document.activeElement).toBe(card);
  expect(getComputedStyle(card).outlineStyle).toBe("none");
  expect(getComputedStyle(motion).outlineStyle).toBe("solid");
  expect(getComputedStyle(motion).outlineWidth).toBe("2px");

  fireEvent.keyDown(card, { key: "Delete" });

  await vi.waitFor(() => expect(card).toHaveAttribute("aria-disabled", "true"));
  expect(getComputedStyle(card).outlineStyle).toBe("none");
});
