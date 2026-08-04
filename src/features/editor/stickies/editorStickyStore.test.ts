import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import type { EditorSticky } from "./editorStickyTypes";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  createEditorSticky,
  deleteEditorSticky,
  EditorStickyConflictError,
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
  EditorStickyConflictError: class MockEditorStickyConflictError extends Error {
    readonly stickyId: string;
    readonly expectedVersion: number;

    constructor(stickyId: string, expectedVersion: number) {
      super(`Editor sticky ${stickyId}: version ${expectedVersion} conflict`);
      this.name = "EditorStickyConflictError";
      this.stickyId = stickyId;
      this.expectedVersion = expectedVersion;
    }
  },
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("editor sticky document store", () => {
  beforeEach(() => {
    resetEditorStickyStoreForTests();
    vi.clearAllMocks();
    setCurrentWorkspaceIdentity(null);
  });

  afterEach(() => {
    setCurrentWorkspaceIdentity(null);
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

  it("pins the draft base version instead of silently rebasing onto a newer row", async () => {
    const remote = { ...sticky, body: "remote", version: 1 };
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
        .update(sticky.id, "project-1", key, { body: "draft" }, 0),
    ).rejects.toThrow("editor sticky version conflict");

    expect(updateEditorSticky).toHaveBeenCalledWith(
      "project-1",
      sticky.id,
      { body: "draft" },
      0,
    );
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([remote]);
  });

  it("rejects a stale explicit base before publishing an optimistic row", async () => {
    const current = { ...sticky, body: "remote", version: 1 };
    vi.mocked(listEditorStickies)
      .mockResolvedValueOnce([sticky])
      .mockResolvedValueOnce([current]);
    vi.mocked(updateEditorSticky).mockResolvedValueOnce(current);
    await loadEditorStickies("project-1", key);

    await useEditorStickyStore
      .getState()
      .update(sticky.id, "project-1", key, { body: "remote" }, 0);

    await expect(
      useEditorStickyStore
        .getState()
        .update(sticky.id, "project-1", key, { body: "stale" }, 0),
    ).rejects.toMatchObject<Partial<EditorStickyConflictError>>({
      name: "EditorStickyConflictError",
      stickyId: sticky.id,
      expectedVersion: 0,
    });

    expect(updateEditorSticky).toHaveBeenCalledOnce();
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([current]);
  });

  it("waits for a pending update and deletes the latest persisted version", async () => {
    const updated: EditorSticky = { ...sticky, body: "saved", version: 1 };
    let resolveUpdate!: (value: EditorSticky) => void;
    vi.mocked(updateEditorSticky).mockImplementationOnce(
      () =>
        new Promise<EditorSticky>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    vi.mocked(deleteEditorSticky).mockResolvedValueOnce(undefined);
    await loadEditorStickies("project-1", key);

    const pendingUpdate = useEditorStickyStore
      .getState()
      .update(sticky.id, "project-1", key, { body: "saved" }, 0);
    await vi.waitFor(() => expect(updateEditorSticky).toHaveBeenCalledOnce());

    const pendingDelete = useEditorStickyStore
      .getState()
      .remove(sticky.id, "project-1", key, sticky.version);
    expect(deleteEditorSticky).not.toHaveBeenCalled();

    resolveUpdate(updated);
    await expect(pendingUpdate).resolves.toEqual(updated);
    await expect(pendingDelete).resolves.toEqual(updated);
    expect(deleteEditorSticky).toHaveBeenCalledWith("project-1", sticky.id, 1);
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

  it("keeps a failed initial load retryable after creating a sticky", async () => {
    const existing = [
      { ...sticky, id: "sticky-a", body: "A" },
      { ...sticky, id: "sticky-b", body: "B" },
    ];
    const created = { ...sticky, id: "sticky-c", body: "C" };
    vi.mocked(listEditorStickies)
      .mockRejectedValueOnce(new Error("temporary list failure"))
      .mockResolvedValueOnce([...existing, created]);
    vi.mocked(createEditorSticky).mockResolvedValueOnce(created);

    await expect(loadEditorStickies("project-1", key)).rejects.toThrow(
      "temporary list failure",
    );
    await expect(
      useEditorStickyStore.getState().create("project-1", key, {
        inlineOffset: created.inlineOffset,
        blockOffset: created.blockOffset,
      }),
    ).resolves.toEqual(created);

    await loadEditorStickies("project-1", key);

    expect(listEditorStickies).toHaveBeenCalledTimes(2);
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([...existing, created]);
  });

  it("waits for an in-flight initial load before creating a sticky", async () => {
    const pending = deferred<EditorSticky[]>();
    const existing = [{ ...sticky, id: "sticky-a", body: "A" }];
    const created = { ...sticky, id: "sticky-c", body: "C" };
    vi.mocked(listEditorStickies).mockReturnValueOnce(pending.promise);
    vi.mocked(createEditorSticky).mockResolvedValueOnce(created);

    const load = loadEditorStickies("project-1", key);
    await vi.waitFor(() => expect(listEditorStickies).toHaveBeenCalledOnce());

    const create = useEditorStickyStore.getState().create("project-1", key, {
      inlineOffset: created.inlineOffset,
      blockOffset: created.blockOffset,
    });
    expect(createEditorSticky).not.toHaveBeenCalled();

    pending.resolve(existing);
    await load;
    await expect(create).resolves.toEqual(created);

    expect(createEditorSticky).toHaveBeenCalledOnce();
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([...existing, created]);
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

  it("does not reuse a loaded bucket across Workspace generations", async () => {
    const workspaceBSticky = {
      ...sticky,
      body: "workspace-b",
      version: 2,
    };
    vi.mocked(listEditorStickies)
      .mockResolvedValueOnce([sticky])
      .mockResolvedValueOnce([workspaceBSticky]);

    setCurrentWorkspaceIdentity({ path: "/workspace-a", openRevision: 1 });
    await loadEditorStickies("project-1", key);
    setCurrentWorkspaceIdentity({ path: "/workspace-b", openRevision: 2 });
    await loadEditorStickies("project-1", key);

    expect(listEditorStickies).toHaveBeenCalledTimes(2);
    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([workspaceBSticky]);
  });

  it("does not publish a deferred load after Workspace authority changes", async () => {
    const pending = deferred<Array<typeof sticky>>();
    vi.mocked(listEditorStickies).mockReturnValueOnce(pending.promise);

    setCurrentWorkspaceIdentity({ path: "/workspace-a", openRevision: 1 });
    const load = loadEditorStickies("project-1", key);
    await vi.waitFor(() => expect(listEditorStickies).toHaveBeenCalledOnce());

    setCurrentWorkspaceIdentity({ path: "/workspace-b", openRevision: 2 });
    pending.resolve([sticky]);
    await load;

    expect(
      useEditorStickyStore.getState().getForDocument("project-1", key),
    ).toEqual([]);
  });
});
