import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCreateResultMetadata } from "@/lib/createResultMetadata";
import type { TrashItemData, TrashItemInput } from "./types";
import { UNDO_ABSORB_WINDOW_MS } from "./types";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const currentProject = { value: "p1" };
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => currentProject.value,
}));
vi.mock("./api", () => ({
  createTrashItem: vi.fn(),
  listTrashItems: vi.fn(async () => []),
  deleteTrashItem: vi.fn(async () => {}),
  clearAllTrashItems: vi.fn(async () => {}),
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ getBoolean: () => true }),
  },
}));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn() },
  errorDetail: vi.fn((error: unknown) => String(error)),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("i18next", () => ({
  default: { t: (_key: string, fallback?: string) => fallback ?? "" },
}));

import * as trashApi from "./api";
import {
  _resetTrashBinLifecycleForTests,
  flushPendingTrashItemsStrict,
  useTrashBinStore,
} from "./trashBinStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const input: TrashItemInput = {
  projectId: "p1",
  kind: "text-fragment",
  subKind: "text-fragment",
  originSceneId: "scene-1",
  originCodexId: null,
  previewText: "削除済み",
  previewMeta: null,
  payload: { text: "削除済み", spans: [] },
};

function deletedReplay(): TrashItemData {
  return attachCreateResultMetadata(
    {
      id: "trash-request-1",
      ...input,
      charCount: 4,
      isInteresting: false,
      deletedAt: "2026-07-10T00:00:00.000Z",
    },
    {
      __idempotency: { replayed: true, entityPresent: false },
    },
  );
}

function createdItem(id = "trash-request-1", projectId = "p1"): TrashItemData {
  return {
    id,
    ...input,
    projectId,
    charCount: 4,
    isInteresting: false,
    deletedAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("trashBinStore Project authority and delayed persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTrashBinLifecycleForTests();
    _resetQuiescenceLeasesForTests();
    vi.clearAllMocks();
    currentProject.value = "p1";
    useTrashBinStore.setState({
      activeProjectId: "p1",
      items: new Map(),
      selectedItemId: null,
      isCapturing: true,
      isLoading: false,
      pendingQueue: [],
    });
  });

  afterEach(() => {
    _resetTrashBinLifecycleForTests();
    _resetQuiescenceLeasesForTests();
    vi.useRealTimers();
  });

  it("prune 後の遅延 replay を items に幽霊復活させない", async () => {
    vi.mocked(trashApi.createTrashItem).mockResolvedValue(deletedReplay());

    useTrashBinStore
      .getState()
      .enqueuePending(input, { tempId: "trash-request-1" });
    await vi.advanceTimersByTimeAsync(UNDO_ABSORB_WINDOW_MS);

    expect(trashApi.createTrashItem).toHaveBeenCalledWith(input, {
      charCount: 4,
      isInteresting: false,
      id: "trash-request-1",
    });
    expect(useTrashBinStore.getState().pendingQueue).toHaveLength(0);
    expect(useTrashBinStore.getState().items).toEqual(new Map());
  });

  it("strict quiescence flushes a delayed capture before its timer expires", async () => {
    const create = deferred<TrashItemData>();
    vi.mocked(trashApi.createTrashItem).mockReturnValueOnce(create.promise);
    useTrashBinStore
      .getState()
      .enqueuePending(input, { tempId: "trash-request-1" });

    const flush = flushPendingTrashItemsStrict();
    expect(trashApi.createTrashItem).toHaveBeenCalledTimes(1);
    expect(useTrashBinStore.getState().pendingQueue).toHaveLength(1);

    create.resolve(createdItem());
    await flush;
    expect(useTrashBinStore.getState().pendingQueue).toHaveLength(0);
    expect(useTrashBinStore.getState().items.has("trash-request-1")).toBe(true);
  });

  it("does not admit a new delayed capture after lifecycle quiescence starts", () => {
    const lease = acquireQuiescenceLease("project-load");
    try {
      useTrashBinStore
        .getState()
        .enqueuePending(input, { tempId: "trash-request-1" });
    } finally {
      lease.release();
    }

    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
    expect(trashApi.createTrashItem).not.toHaveBeenCalled();
  });

  it("retains a failed capture and retries it on the next strict boundary", async () => {
    vi.mocked(trashApi.createTrashItem).mockRejectedValueOnce(
      new Error("create failed"),
    );
    useTrashBinStore
      .getState()
      .enqueuePending(input, { tempId: "trash-request-1" });

    await expect(flushPendingTrashItemsStrict()).rejects.toThrow(
      "pending Trash Bin captures failed",
    );
    expect(useTrashBinStore.getState().pendingQueue).toHaveLength(1);

    vi.mocked(trashApi.createTrashItem).mockResolvedValueOnce(createdItem());
    await expect(flushPendingTrashItemsStrict()).resolves.toBeUndefined();
    expect(trashApi.createTrashItem).toHaveBeenCalledTimes(2);
    expect(useTrashBinStore.getState().pendingQueue).toHaveLength(0);
  });

  it("clears old rows synchronously before target Project hydration settles", async () => {
    const targetItems = deferred<TrashItemData[]>();
    useTrashBinStore.setState({
      items: new Map([["old", createdItem("old")]]),
      selectedItemId: "old",
    });
    currentProject.value = "p2";
    useTrashBinStore.getState().resetForProject("p2");
    vi.mocked(trashApi.listTrashItems).mockReturnValueOnce(targetItems.promise);

    const load = useTrashBinStore.getState().loadItems("p2");
    expect(useTrashBinStore.getState()).toMatchObject({
      activeProjectId: "p2",
      selectedItemId: null,
      isLoading: true,
      pendingQueue: [],
    });
    expect(useTrashBinStore.getState().items).toEqual(new Map());

    targetItems.resolve([createdItem("new", "p2")]);
    await load;
    expect([...useTrashBinStore.getState().items.keys()]).toEqual(["new"]);
  });

  it("rejects current hydration failures so lifecycle can report degradation", async () => {
    currentProject.value = "p2";
    useTrashBinStore.getState().resetForProject("p2");
    vi.mocked(trashApi.listTrashItems).mockRejectedValueOnce(
      new Error("load failed"),
    );

    await expect(useTrashBinStore.getState().loadItems("p2")).rejects.toThrow(
      "load failed",
    );
    expect(useTrashBinStore.getState().isLoading).toBe(false);
    expect(useTrashBinStore.getState().items).toEqual(new Map());
  });

  it("cancels old timers and rejects stale id-only callbacks at Project commit", async () => {
    useTrashBinStore.setState({
      items: new Map([["old", createdItem("old")]]),
    });
    const removeFromOldRender = useTrashBinStore.getState().removeItem;
    useTrashBinStore
      .getState()
      .enqueuePending(input, { tempId: "trash-request-1" });

    currentProject.value = "p2";
    useTrashBinStore.getState().resetForProject("p2");
    await removeFromOldRender("old");
    await vi.advanceTimersByTimeAsync(UNDO_ABSORB_WINDOW_MS);

    expect(trashApi.deleteTrashItem).not.toHaveBeenCalled();
    expect(trashApi.createTrashItem).not.toHaveBeenCalled();
    expect(useTrashBinStore.getState().items).toEqual(new Map());
    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
  });

  it("does not issue a second renderer delete after Native structural restore", async () => {
    const structure = {
      ...createdItem("structure-1"),
      kind: "structure-item" as const,
      subKind: "grid-chapter" as const,
      payload: {
        originalId: "old-folder",
        title: "Chapter",
        parentId: null,
        sortOrder: "a0",
        metadata: {},
      },
    };
    useTrashBinStore.setState({
      items: new Map([[structure.id, structure]]),
    });

    await expect(
      useTrashBinStore.getState().pickup(structure.id, async () => ({
        ok: true,
        newId: "restored-grid-chapter:structure-1",
        brokenLinks: [],
      })),
    ).resolves.toMatchObject({ ok: true });

    expect(trashApi.deleteTrashItem).not.toHaveBeenCalled();
    expect(useTrashBinStore.getState().items.has(structure.id)).toBe(false);
  });

  it("keeps an editor-local text fragment when its separate Trash delete fails", async () => {
    const fragment = createdItem("fragment-delete-failure");
    useTrashBinStore.setState({
      items: new Map([[fragment.id, fragment]]),
    });
    vi.mocked(trashApi.deleteTrashItem).mockRejectedValueOnce(
      new Error("delete failed"),
    );

    const result = await useTrashBinStore
      .getState()
      .pickup(fragment.id, async () => ({
        ok: true,
        newId: fragment.id,
        brokenLinks: [],
      }));

    expect(result).toMatchObject({ ok: false, reason: "internal-error" });
    expect(useTrashBinStore.getState().items.has(fragment.id)).toBe(true);
  });
});
