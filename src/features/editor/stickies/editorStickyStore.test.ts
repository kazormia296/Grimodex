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
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([sticky]);
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
      .update(sticky.id, "project-1", key, { blockOffset: 40 });

    expect(updateEditorSticky).toHaveBeenCalledWith(
      "project-1",
      sticky.id,
      { blockOffset: 40 },
      0,
    );
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key)[0]
        ?.version,
    ).toBe(1);
  });

  it("reloads the bucket after an OCC failure instead of keeping the optimistic row", async () => {
    const remote = { ...sticky, blockOffset: 88, version: 1 };
    vi.mocked(listEditorStickies)
      .mockResolvedValueOnce([sticky])
      .mockResolvedValueOnce([remote]);
    vi.mocked(updateEditorSticky).mockRejectedValueOnce(
      new Error("editor sticky version conflict"),
    );
    await loadEditorStickies("project-1", key);

    await expect(
      useEditorStickyStore
        .getState()
        .update(sticky.id, "project-1", key, { blockOffset: 40 }),
    ).rejects.toThrow("editor sticky version conflict");

    expect(listEditorStickies).toHaveBeenCalledTimes(2);
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([remote]);
  });

  it("rolls back the optimistic row when the failure refresh also fails", async () => {
    vi.mocked(listEditorStickies)
      .mockResolvedValueOnce([sticky])
      .mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(updateEditorSticky).mockRejectedValueOnce(
      new Error("write failed"),
    );
    await loadEditorStickies("project-1", key);

    await expect(
      useEditorStickyStore
        .getState()
        .update(sticky.id, "project-1", key, { blockOffset: 40 }),
    ).rejects.toThrow("write failed");

    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([sticky]);
  });

  it("inserts and removes a sticky from the same document bucket", async () => {
    vi.mocked(createEditorSticky).mockResolvedValue(sticky);
    vi.mocked(deleteEditorSticky).mockResolvedValue(undefined);

    await useEditorStickyStore.getState().create("project-1", key, {
      inlineOffset: 12,
      blockOffset: 24,
    });
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toHaveLength(1);

    await useEditorStickyStore
      .getState()
      .remove(sticky.id, "project-1", key, sticky.version);
    expect(deleteEditorSticky).toHaveBeenCalledWith(
      "project-1",
      sticky.id,
      sticky.version,
    );
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([]);
  });

  it("passes an explicit id through for Global History restoration", async () => {
    vi.mocked(createEditorSticky).mockResolvedValue(sticky);

    await useEditorStickyStore.getState().create("project-1", key, {
      id: sticky.id,
      inlineOffset: sticky.inlineOffset,
      blockOffset: sticky.blockOffset,
    });

    expect(createEditorSticky).toHaveBeenCalledWith({
      id: sticky.id,
      projectId: "project-1",
      documentKey: key,
      inlineOffset: sticky.inlineOffset,
      blockOffset: sticky.blockOffset,
    });
  });

  it("does not reuse a loaded document bucket across projects", async () => {
    vi.mocked(listEditorStickies).mockResolvedValue([sticky]);

    await loadEditorStickies("project-1", key);
    await loadEditorStickies("project-2", key);

    expect(listEditorStickies).toHaveBeenCalledTimes(2);
    expect(
      useEditorStickyStore.getState().getForDocument("project-2", key),
    ).toEqual([sticky]);
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([sticky]);
  });
});
