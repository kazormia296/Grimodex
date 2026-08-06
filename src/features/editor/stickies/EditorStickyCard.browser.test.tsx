import { render } from "@testing-library/react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { EditorSticky } from "./editorStickyTypes";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/animation", () => ({
  DURATIONS: { slow: 0.3 },
  EASINGS: { easeOut: [0.16, 1, 0.3, 1] },
  useReducedMotion: () => false,
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      onAnimationComplete: _onAnimationComplete,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      children?: ReactNode;
      initial?: unknown;
      animate?: unknown;
      onAnimationComplete?: () => void;
    }) => <div {...props}>{children}</div>,
  },
}));

vi.mock("@/application/lifecycle/useQuiescentDraftParticipant", () => ({
  useQuiescentDraftParticipant: () => undefined,
}));

vi.mock("./editorStickyCommands", () => ({
  setEditorStickyColor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/sticky/StickyBodyEditor", () => ({
  StickyBodyEditor: ({ style }: { style?: CSSProperties }) => (
    <textarea aria-label="付箋本文" style={style} />
  ),
}));

vi.mock("@/features/sticky/StickyRichTextBody", () => ({
  StickyRichTextBody: ({ fontSize }: { fontSize?: CSSProperties["fontSize"] }) => (
    <div data-testid="sticky-body-view" style={{ fontSize }}>
      <p>
        <span>付箋の文字</span>
      </p>
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
  id: "sticky-browser-double-click",
  projectId: "project-1",
  documentKey,
  body: '{"type":"doc","content":[]}',
  paletteId: "post-it-playful",
  colorSlot: 0,
  inlineOffset: 12,
  blockOffset: 24,
  zIndex: 0,
  version: 0,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

it("enters edit mode when Chromium double-clicks rendered sticky text", async () => {
  const onEdit = vi.fn();
  render(
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
      selected={false}
      editing={false}
      onSelect={vi.fn()}
      onEdit={onEdit}
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

  const text = page.getByText("付箋の文字");
  await expect.element(text).toBeVisible();
  await text.dblClick();

  expect(onEdit).toHaveBeenCalledExactlyOnceWith(sticky.id);
});
