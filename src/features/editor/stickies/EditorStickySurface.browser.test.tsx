import { render } from "@testing-library/react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import type { EditorSticky } from "./editorStickyTypes";

const { fixture, storeState } = vi.hoisted(() => {
  const documentKey = {
    kind: "tree",
    id: "scene-surface-browser",
    storage: "database",
  } as const;
  const sticky = {
    id: "sticky-surface-browser",
    projectId: "project-1",
    documentKey,
    body: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "表面上の付箋文字" }],
        },
      ],
    }),
    paletteId: "post-it-playful",
    colorSlot: 0,
    inlineOffset: 24,
    blockOffset: 24,
    zIndex: 0,
    version: 0,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
  const state = {
    getForDocument: () => [sticky],
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  return { fixture: { documentKey, sticky }, storeState: state };
});

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

vi.mock("@/runtime/workspaceIdentity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/runtime/workspaceIdentity")>();
  return {
    ...actual,
    getCurrentWorkspaceIdentity: () => ({
      path: "/browser-workspace",
      openRevision: 1,
    }),
    subscribeCurrentWorkspaceIdentity: () => () => undefined,
  };
});

vi.mock("./editorStickyStore", () => {
  const useEditorStickyStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  );
  return {
    loadEditorStickies: vi.fn().mockResolvedValue(undefined),
    useEditorStickyStore,
  };
});

vi.mock("./useEditorTextCoverage", () => ({
  useEditorTextCoverage: () => ({
    coverage: [],
    requestMeasure: vi.fn(),
  }),
}));

vi.mock("./editorStickySurfaceRegistry", () => ({
  registerEditorStickySurface: () => () => undefined,
}));

import { EditorStickySurface } from "./EditorStickySurface";

it("opens the real sticky editor when text is double-clicked through the surface overlay", async () => {
  render(
    <div style={{ width: 800, height: 600 }}>
      <EditorStickySurface
        editor={null}
        documentKey={fixture.documentKey}
        projectId="project-1"
        fontSize={16}
        verticalMode={false}
      >
        <div style={{ minHeight: 600 }}>下層の本文</div>
      </EditorStickySurface>
    </div>,
  );

  const text = page.getByText("表面上の付箋文字");
  await expect.element(text).toBeVisible();
  await text.dblClick();

  await expect.element(page.getByRole("textbox")).toBeVisible();
  expect(
    document.querySelector<HTMLElement>("[data-editor-sticky-card]")?.dataset
      .editorStickyId,
  ).toBe((fixture.sticky as EditorSticky).id);
});
