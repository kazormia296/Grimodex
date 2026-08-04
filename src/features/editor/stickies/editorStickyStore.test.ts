import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import {
  createEditorSticky,
  deleteEditorSticky,
  listEditorStickies,
  updateEditorSticky,
} from "./editorStickyApi";
import {
  loadEditorStickies,
  resetEditorStickyStoreForTests,
  useEditorStickyStore,
} from "./editorStickyStore";

vi.mock("./editorStickyApi", () => ({
  createEditorSticky: vi.fn(),
  deleteEditorSticky: vi.fn(),
  listEditorStickies: vi.fn(),
  updateEditorSticky: vi.fn(),
}));

const key: DocumentKey = { kind: "tree", id: "scene-1", storage: "database" };

const sticky = {
  id: "sticky-1",
  projectId: "project-1",
  documentKey: key,
  body: '{"type":"doc","content":[]}',
  paletteId: "post-it-playful",
  colorSlot: 0,
  inlineOffset: 12,
  blockOffset: 24,
  zIndex: 0,
  version: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("editor sticky document store", () => {
  beforeEach(() => {
    resetEditorStickyStoreForTests();
    vi.clearAllMocks();
  });

  it("loads a document once and exposes the exact document-key bucket", async () => {
    vi.mocked(listEditorStickies).mockResolvedValue([sticky]);

    await loadEditorStickies("project-1", key);
    await loadEditorStickies("project-1", key);

    expect(listEditorStickies).toHaveBeenCalledOnce();
    expect(useEditorStickyStore.getState().byDocument.scene1).toBeUndefined();
    expect(useEditorStickyStore.getState().getForDocument(key)).toEqual([sticky]);
  });

  it("keeps an optimistic edit visible and persists the OCC version", async () => {
    vi.mocked(listEditorStickies).mockResolvedValue([sticky]);
    vi.mocked(updateEditorSticky).mockResolvedValue({
      ...sticky,
      blockOffset: 40,
      version: 1,
    });
    await loadEditorStickies("project-1", key);

    await useEditorStickyStore
      .getState()
      .update(sticky.id, key, { blockOffset: 40 });

    expect(updateEditorSticky).toHaveBeenCalledWith(
      sticky.id,
      { blockOffset: 40 },
      0,
    );
    expect(useEditorStickyStore.getState().getForDocument(key)[0]?.version).toBe(1);
  });

  it("inserts and removes a sticky from the same document bucket", async () => {
    vi.mocked(createEditorSticky).mockResolvedValue(sticky);
    vi.mocked(deleteEditorSticky).mockResolvedValue(undefined);

    await useEditorStickyStore.getState().create("project-1", key, {
      inlineOffset: 12,
      blockOffset: 24,
    });
    expect(useEditorStickyStore.getState().getForDocument(key)).toHaveLength(1);

    await useEditorStickyStore.getState().remove(sticky.id, key, sticky.version);
    expect(deleteEditorSticky).toHaveBeenCalledWith(sticky.id, sticky.version);
    expect(useEditorStickyStore.getState().getForDocument(key)).toEqual([]);
  });
});
