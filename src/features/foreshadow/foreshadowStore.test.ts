import { describe, it, expect, beforeEach, vi } from "vitest";
import { useForeshadowStore } from "./foreshadowStore";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";
import { attachCreateResultMetadata } from "@/lib/createResultMetadata";
import { IpcInvokeError } from "@/lib/tauri";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

// ── Fixtures ────────────────────────────────────────────────────────

function makeRow(overrides: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f-1",
    projectId: "proj-1",
    title: "白鯨の前兆",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeSetup(
  overrides: Partial<ForeshadowSetupRow> = {},
): ForeshadowSetupRow {
  return {
    id: "s-1",
    foreshadowId: "f-1",
    sceneId: "scene-1",
    fromPos: 0,
    toPos: 5,
    kind: "designated_existing",
    strength: null,
    aiStrength: null,
    aiReasoning: null,
    attribution: "human",
    aiRationale: null,
    lastEvaluatedAt: null,
    isOrphan: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function unknownCreateError(): IpcInvokeError {
  return new IpcInvokeError("foreshadow_create", {
    code: "IPC_TIMEOUT",
    message: "IPC timeout: foreshadow_create",
    retryable: true,
    outcome: "unknown",
  });
}

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("./api", () => ({
  listForeshadowsWithLabels: vi.fn(),
  createForeshadow: vi.fn(),
  deleteForeshadow: vi.fn(),
  listSetups: vi.fn(),
  deleteSetup: vi.fn(),
  reanchorOrphanSetup: vi.fn(),
  reinsertOrphanSetup: vi.fn(),
  proposePastSetups: vi.fn(),
  auditChapter: vi.fn(),
  detectRelatedCodex: vi.fn(),
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: { getState: vi.fn() },
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: { getState: vi.fn() },
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContents: vi.fn(),
  saveSceneContent: vi.fn(),
}));

vi.mock("@/features/editor/editorSaveRegistry", () => ({
  saveScene: vi.fn(),
}));

vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: vi.fn((s: string) => s),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("i18next", () => ({
  default: { t: (_k: string, fallback: string) => fallback },
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn() },
  errorDetail: vi.fn(),
  rootCause: vi.fn((e: unknown) => String(e)),
}));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));

import {
  listForeshadowsWithLabels,
  createForeshadow,
  deleteForeshadow,
  listSetups,
  deleteSetup,
  reanchorOrphanSetup,
  reinsertOrphanSetup,
  proposePastSetups,
  auditChapter,
  detectRelatedCodex,
} from "./api";
import { loadSceneContents } from "@/features/tree/api";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";
import { recordChangeEvent } from "@/features/timelapse/recorder";

const mockListForeshadowsWithLabels = vi.mocked(listForeshadowsWithLabels);
const mockCreateForeshadow = vi.mocked(createForeshadow);
const mockDeleteForeshadow = vi.mocked(deleteForeshadow);
const mockListSetups = vi.mocked(listSetups);
const mockDeleteSetup = vi.mocked(deleteSetup);
const mockReanchorOrphanSetup = vi.mocked(reanchorOrphanSetup);
const mockReinsertOrphanSetup = vi.mocked(reinsertOrphanSetup);
const mockProposePastSetups = vi.mocked(proposePastSetups);
const mockAuditChapter = vi.mocked(auditChapter);
const mockDetectRelatedCodex = vi.mocked(detectRelatedCodex);
const mockLoadSceneContents = vi.mocked(loadSceneContents);
const mockSaveScene = vi.mocked(saveScene);
const mockUseEditorStore = vi.mocked(useEditorStore);
const mockUseSceneStore = vi.mocked(useSceneStore);

function makeEditorChainMock() {
  const run = vi.fn();
  const setMark = vi.fn(() => ({ run }));
  const setTextSelection = vi.fn(() => ({ setMark }));
  return {
    chain: vi.fn(() => ({ setTextSelection })),
    state: { selection: { from: 10, to: 20 } },
    _run: run,
    _setMark: setMark,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("foreshadowStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateForeshadow.mockReset();
    useGlobalHistoryStore.getState().clear();
    useForeshadowStore.getState().resetForProject();
  });

  // ── load ──────────────────────────────────────────────────────────

  describe("load", () => {
    it("sets items from listForeshadowsWithLabels", async () => {
      const items = [
        { ...makeRow(), label: "planned" as const, setupCount: 0 },
      ];
      mockListForeshadowsWithLabels.mockResolvedValue({
        items,
        sceneInfoBySceneId: {},
        setupScenesByForeshadowId: {},
      });

      await useForeshadowStore.getState().load("proj-1");

      expect(mockListForeshadowsWithLabels).toHaveBeenCalledWith("proj-1");
      expect(useForeshadowStore.getState().items).toEqual(items);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
    });

    it("clears loading state on failure", async () => {
      mockListForeshadowsWithLabels.mockRejectedValue(new Error("IPC timeout"));

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items).toEqual([]);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
    });

    it("lets lifecycle strict callers observe a shared load failure", async () => {
      const failure = new Error("foreshadow optional hydrate failed");
      mockListForeshadowsWithLabels.mockRejectedValueOnce(failure);

      const compatibleUiLoad = useForeshadowStore.getState().load("proj-1");
      const strictLifecycleLoad = useForeshadowStore
        .getState()
        .load("proj-1", { propagateError: true });
      const compatibleExpectation =
        expect(compatibleUiLoad).resolves.toBe(undefined);
      const strictExpectation =
        expect(strictLifecycleLoad).rejects.toBe(failure);

      await Promise.all([compatibleExpectation, strictExpectation]);
      expect(mockListForeshadowsWithLabels).toHaveBeenCalledTimes(1);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
    });

    it("keeps a strict-first load authoritative when an ordinary caller joins", async () => {
      const failure = new Error("foreshadow strict-first hydrate failed");
      mockListForeshadowsWithLabels.mockRejectedValueOnce(failure);

      const strictLifecycleLoad = useForeshadowStore
        .getState()
        .load("proj-1", { propagateError: true });
      const compatibleUiLoad = useForeshadowStore.getState().load("proj-1");
      const strictExpectation =
        expect(strictLifecycleLoad).rejects.toBe(failure);
      const compatibleExpectation =
        expect(compatibleUiLoad).resolves.toBe(undefined);

      await Promise.all([strictExpectation, compatibleExpectation]);
      expect(mockListForeshadowsWithLabels).toHaveBeenCalledTimes(1);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
    });

    it("does not publish a load invalidated by a Project reset", async () => {
      let resolveOldLoad!: (
        value: Awaited<ReturnType<typeof listForeshadowsWithLabels>>,
      ) => void;
      const currentItem = {
        ...makeRow({ id: "current-foreshadow" }),
        label: "planned" as const,
        setupCount: 0,
      };
      mockListForeshadowsWithLabels
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveOldLoad = resolve;
          }),
        )
        .mockResolvedValueOnce({
          items: [currentItem],
          sceneInfoBySceneId: {},
          setupScenesByForeshadowId: {},
        });

      const oldLoad = useForeshadowStore.getState().load("proj-old");
      useForeshadowStore.getState().resetForProject();
      await useForeshadowStore.getState().load("proj-current");
      resolveOldLoad({
        items: [
          {
            ...makeRow({ id: "old-foreshadow" }),
            label: "planned",
            setupCount: 0,
          },
        ],
        sceneInfoBySceneId: {},
        setupScenesByForeshadowId: {},
      });
      await oldLoad;

      expect(useForeshadowStore.getState().items).toEqual([currentItem]);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
    });
  });

  // ── create ────────────────────────────────────────────────────────

  describe("create", () => {
    it("returns ForeshadowWithLabel and prepends to items", async () => {
      const row = makeRow();
      mockCreateForeshadow.mockResolvedValue(row);
      useForeshadowStore.setState({
        items: [
          { ...makeRow({ id: "f-existing" }), label: "planned", setupCount: 0 },
        ],
      });

      const result = await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "白鯨の前兆",
        intent: null,
        loadBearing: null,
      });

      expect(result.id).toBe("f-1");
      expect(result.label).toBe("planned");
      expect(result.setupCount).toBe(0);

      const items = useForeshadowStore.getState().items;
      expect(items[0].id).toBe("f-1");
      expect(items[1].id).toBe("f-existing");
    });

    it("throws and does not modify items on API failure", async () => {
      mockCreateForeshadow.mockRejectedValue(new Error("DB error"));

      await expect(
        useForeshadowStore.getState().create({
          projectId: "proj-1",
          title: "失敗",
          intent: null,
          loadBearing: null,
        }),
      ).rejects.toThrow("DB error");

      expect(useForeshadowStore.getState().items).toEqual([]);
    });

    it("削除済み request replay を items/history に幽霊復活させない", async () => {
      const existing = {
        ...makeRow({ id: "f-existing" }),
        label: "planned" as const,
        setupCount: 0,
      };
      useForeshadowStore.setState({ items: [existing] });
      mockCreateForeshadow.mockResolvedValue(
        attachCreateResultMetadata(makeRow(), {
          __idempotency: { replayed: true, entityPresent: false },
        }),
      );

      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "遅延リトライ",
        intent: null,
        loadBearing: null,
      });

      expect(useForeshadowStore.getState().items).toEqual([existing]);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    });

    it("現存する exact replay は既存 item/history を重複させない", async () => {
      const existing = {
        ...makeRow(),
        label: "planned" as const,
        setupCount: 0,
      };
      useForeshadowStore.setState({ items: [existing] });
      mockCreateForeshadow.mockResolvedValue(
        attachCreateResultMetadata(makeRow(), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      );

      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "同一リトライ",
        intent: null,
        loadBearing: null,
      });

      expect(useForeshadowStore.getState().items).toEqual([existing]);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    });

    it("lost response の現存 replay は未掲載 item だけ公開し history は増やさない", async () => {
      mockCreateForeshadow.mockResolvedValue(
        attachCreateResultMetadata(makeRow(), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      );

      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "応答喪失リトライ",
        intent: null,
        loadBearing: null,
      });

      expect(useForeshadowStore.getState().items.map(({ id }) => id)).toEqual([
        "f-1",
      ]);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
      expect(recordChangeEvent).toHaveBeenCalledTimes(1);
    });

    it("unknown 後の明示リトライは同じ request ID を再利用し、成功後は解放する", async () => {
      mockCreateForeshadow
        .mockRejectedValueOnce(unknownCreateError())
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            makeRow({ id: data.id, title: data.title }),
            {
              __idempotency: { replayed: true, entityPresent: true },
            },
          ),
        )
        .mockImplementationOnce(async (data) =>
          makeRow({ id: data.id, title: data.title }),
        );
      const input = {
        projectId: "proj-1",
        title: "応答喪失",
        intent: null,
        loadBearing: null,
      };

      await expect(
        useForeshadowStore.getState().create(input),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      await useForeshadowStore.getState().create(input);

      const [firstPayload] = mockCreateForeshadow.mock.calls[0];
      const [retryPayload] = mockCreateForeshadow.mock.calls[1];
      expect(retryPayload).toEqual(firstPayload);
      expect(firstPayload.id).toBeTruthy();
      expect(
        useForeshadowStore
          .getState()
          .items.filter(({ id }) => id === firstPayload.id),
      ).toHaveLength(1);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
      expect(recordChangeEvent).toHaveBeenCalledTimes(1);

      await useForeshadowStore.getState().create(input);
      const [afterSuccessPayload] = mockCreateForeshadow.mock.calls[2];
      expect(afterSuccessPayload.id).not.toBe(firstPayload.id);
    });

    it("unknown 後に payload を変更すると保留 request ID を解放する", async () => {
      mockCreateForeshadow
        .mockRejectedValueOnce(unknownCreateError())
        .mockImplementationOnce(async (data) =>
          makeRow({ id: data.id, title: data.title }),
        );

      await expect(
        useForeshadowStore.getState().create({
          projectId: "proj-1",
          title: "変更前",
          intent: null,
          loadBearing: null,
        }),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "変更後",
        intent: null,
        loadBearing: null,
      });

      const [firstPayload] = mockCreateForeshadow.mock.calls[0];
      const [changedPayload] = mockCreateForeshadow.mock.calls[1];
      expect(changedPayload.title).toBe("変更後");
      expect(changedPayload.id).not.toBe(firstPayload.id);
    });

    it("異なる unknown create を並べても各 Foreshadow の retry ID を保持する", async () => {
      mockCreateForeshadow
        .mockRejectedValueOnce(unknownCreateError())
        .mockRejectedValueOnce(unknownCreateError())
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            makeRow({ id: data.id, title: data.title }),
            {
              __idempotency: { replayed: true, entityPresent: true },
            },
          ),
        );
      const first = {
        projectId: "proj-1",
        title: "first",
        intent: null,
        loadBearing: null,
      };
      const second = { ...first, title: "second" };

      await expect(
        useForeshadowStore.getState().create(first),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      await expect(
        useForeshadowStore.getState().create(second),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      await useForeshadowStore.getState().create(first);

      const [firstPayload] = mockCreateForeshadow.mock.calls[0];
      const [secondPayload] = mockCreateForeshadow.mock.calls[1];
      const [firstRetryPayload] = mockCreateForeshadow.mock.calls[2];
      expect(firstRetryPayload).toEqual(firstPayload);
      expect(secondPayload.id).not.toBe(firstPayload.id);
    });

    it("create history は deliberate redo cycle ごとに fresh request ID を使う", async () => {
      mockCreateForeshadow.mockImplementation(async (data) =>
        makeRow({ id: data.id, title: data.title }),
      );
      mockDeleteForeshadow.mockResolvedValue(undefined);

      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "redo cycle",
        intent: null,
        loadBearing: null,
      });
      const history = useGlobalHistoryStore.getState();
      await history.undo();
      await history.redo();
      await history.undo();
      await history.redo();

      const firstRedoOptions = mockCreateForeshadow.mock.calls[1][1];
      const secondRedoOptions = mockCreateForeshadow.mock.calls[2][1];
      expect(firstRedoOptions?.requestId).toBeTruthy();
      expect(secondRedoOptions?.requestId).toBeTruthy();
      expect(secondRedoOptions?.requestId).not.toBe(
        firstRedoOptions?.requestId,
      );
      expect(useForeshadowStore.getState().items).toHaveLength(1);
    });

    it("create history redo は削除済み replay を UI に復元しない", async () => {
      mockCreateForeshadow
        .mockImplementationOnce(async (data) =>
          makeRow({ id: data.id, title: data.title }),
        )
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            makeRow({ id: data.id, title: data.title }),
            {
              __idempotency: { replayed: true, entityPresent: false },
            },
          ),
        );
      mockDeleteForeshadow.mockResolvedValue(undefined);

      await useForeshadowStore.getState().create({
        projectId: "proj-1",
        title: "deleted replay",
        intent: null,
        loadBearing: null,
      });
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().redo();

      expect(useForeshadowStore.getState().items).toEqual([]);
    });
  });

  // ── remove ────────────────────────────────────────────────────────

  describe("remove", () => {
    it("removes item from list on success", async () => {
      mockDeleteForeshadow.mockResolvedValue(undefined);
      useForeshadowStore.setState({
        items: [
          { ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 },
          { ...makeRow({ id: "f-2" }), label: "seeded", setupCount: 1 },
        ],
      });

      await useForeshadowStore.getState().remove("f-1");

      const items = useForeshadowStore.getState().items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("f-2");
    });

    it("keeps items unchanged on API failure", async () => {
      mockDeleteForeshadow.mockRejectedValue(new Error("DB error"));
      useForeshadowStore.setState({
        items: [{ ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 }],
      });

      await useForeshadowStore.getState().remove("f-1");

      expect(useForeshadowStore.getState().items).toHaveLength(1);
    });

    it("delete history は deliberate undo cycle ごとに fresh request ID を使う", async () => {
      const codexLinkDirtyAt = new Date("2024-01-02T03:04:05.000Z");
      const existing = {
        ...makeRow({
          intent: "restore me",
          secret: false,
          codexLinkDirtyAt,
        }),
        label: "planned" as const,
        setupCount: 0,
      };
      useForeshadowStore.setState({ items: [existing] });
      mockDeleteForeshadow.mockResolvedValue(undefined);
      mockCreateForeshadow.mockImplementation(async (data) =>
        makeRow({ id: data.id, title: data.title, intent: data.intent }),
      );

      await useForeshadowStore.getState().remove(existing.id);
      const history = useGlobalHistoryStore.getState();
      await history.undo();
      await history.redo();
      await history.undo();

      const firstUndoOptions = mockCreateForeshadow.mock.calls[0][1];
      const secondUndoOptions = mockCreateForeshadow.mock.calls[1][1];
      const firstUndoPayload = mockCreateForeshadow.mock.calls[0][0];
      expect(firstUndoOptions?.requestId).toBeTruthy();
      expect(secondUndoOptions?.requestId).toBeTruthy();
      expect(secondUndoOptions?.requestId).not.toBe(
        firstUndoOptions?.requestId,
      );
      expect(firstUndoPayload).toMatchObject({
        secret: false,
        codexLinkDirtyAt,
      });
      expect(useForeshadowStore.getState().items).toHaveLength(1);
    });

    it("delete history undo は削除済み replay を UI に復元しない", async () => {
      const existing = {
        ...makeRow({ intent: "restore me" }),
        label: "planned" as const,
        setupCount: 0,
      };
      useForeshadowStore.setState({ items: [existing] });
      mockDeleteForeshadow.mockResolvedValue(undefined);
      mockCreateForeshadow.mockResolvedValue(
        attachCreateResultMetadata(makeRow(), {
          __idempotency: { replayed: true, entityPresent: false },
        }),
      );

      await useForeshadowStore.getState().remove(existing.id);
      await useGlobalHistoryStore.getState().undo();

      expect(useForeshadowStore.getState().items).toEqual([]);
    });
  });

  // ── loadSetups ────────────────────────────────────────────────────

  describe("loadSetups", () => {
    it("populates setupsByForeshadowId for the given id", async () => {
      const setup = makeSetup({ id: "s-1", foreshadowId: "f-1" });
      mockListSetups.mockResolvedValue([setup]);

      await useForeshadowStore.getState().loadSetups("f-1");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-1"]).toEqual(
        [setup],
      );
    });

    it("stores empty array when no setups exist", async () => {
      mockListSetups.mockResolvedValue([]);

      await useForeshadowStore.getState().loadSetups("f-1");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-1"]).toEqual(
        [],
      );
    });

    it("does not affect other foreshadow entries", async () => {
      const setupA = makeSetup({ id: "s-a", foreshadowId: "f-a" });
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-a": [setupA] },
      });
      mockListSetups.mockResolvedValue([]);

      await useForeshadowStore.getState().loadSetups("f-b");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-a"]).toEqual(
        [setupA],
      );
    });

    it("silently swallows API errors without modifying state", async () => {
      mockListSetups.mockRejectedValue(new Error("DB error"));
      useForeshadowStore.setState({ setupsByForeshadowId: {} });

      await useForeshadowStore.getState().loadSetups("f-1");

      expect(
        useForeshadowStore.getState().setupsByForeshadowId["f-1"],
      ).toBeUndefined();
    });
  });

  // ── removeSetup ───────────────────────────────────────────────────

  describe("removeSetup", () => {
    it("removes the setup row from setupsByForeshadowId", async () => {
      const s1 = makeSetup({ id: "s-1", foreshadowId: "f-1" });
      const s2 = makeSetup({ id: "s-2", foreshadowId: "f-1" });
      mockDeleteSetup.mockResolvedValue(undefined);
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-1": [s1, s2] },
      });

      await useForeshadowStore.getState().removeSetup("s-1", "f-1");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-1"]).toEqual(
        [s2],
      );
    });

    it("keeps other foreshadow entries untouched", async () => {
      const sa = makeSetup({ id: "s-a", foreshadowId: "f-a" });
      const sb = makeSetup({ id: "s-b", foreshadowId: "f-b" });
      mockDeleteSetup.mockResolvedValue(undefined);
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-a": [sa], "f-b": [sb] },
      });

      await useForeshadowStore.getState().removeSetup("s-b", "f-b");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-a"]).toEqual(
        [sa],
      );
    });

    it("keeps state unchanged on API failure", async () => {
      const s1 = makeSetup({ id: "s-1", foreshadowId: "f-1" });
      mockDeleteSetup.mockRejectedValue(new Error("DB error"));
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-1": [s1] },
      });

      await useForeshadowStore.getState().removeSetup("s-1", "f-1");

      expect(useForeshadowStore.getState().setupsByForeshadowId["f-1"]).toEqual(
        [s1],
      );
    });
  });

  // ── reanchorSetup ─────────────────────────────────────────────────

  describe("reanchorSetup", () => {
    it("shows toast and returns if no editor open", async () => {
      const { toast } = await import("sonner");
      mockUseEditorStore.getState.mockReturnValue({ editor: null } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "scene-1",
      } as never);

      await useForeshadowStore.getState().reanchorSetup("s-1", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(mockReanchorOrphanSetup).not.toHaveBeenCalled();
    });

    it("shows toast and returns if selection is empty (from === to)", async () => {
      const { toast } = await import("sonner");
      const editor = makeEditorChainMock();
      (
        editor as never as {
          state: { selection: { from: number; to: number } };
        }
      ).state = { selection: { from: 5, to: 5 } };
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "scene-1",
      } as never);

      await useForeshadowStore.getState().reanchorSetup("s-1", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(mockReanchorOrphanSetup).not.toHaveBeenCalled();
    });

    it("calls reanchorOrphanSetup with correct anchor and updates state", async () => {
      const orphanSetup = makeSetup({
        id: "s-1",
        foreshadowId: "f-1",
        isOrphan: true,
        sceneId: "old-scene",
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "scene-new",
      } as never);
      mockReanchorOrphanSetup.mockResolvedValue(undefined);
      useForeshadowStore.setState({
        items: [{ ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 }],
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reanchorSetup("s-1", "f-1");

      expect(mockReanchorOrphanSetup).toHaveBeenCalledWith("s-1", {
        sceneId: "scene-new",
        fromPos: 10,
        toPos: 20,
      });
      const setups = useForeshadowStore.getState().setupsByForeshadowId["f-1"];
      const updated = setups?.find((s) => s.id === "s-1");
      expect(updated?.isOrphan).toBe(false);
      expect(updated?.sceneId).toBe("scene-new");
    });

    it("calls editor.chain setMark after successful reanchor", async () => {
      const orphanSetup = makeSetup({
        id: "s-1",
        foreshadowId: "f-1",
        isOrphan: true,
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);
      mockReanchorOrphanSetup.mockResolvedValue(undefined);
      useForeshadowStore.setState({
        items: [{ ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 }],
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reanchorSetup("s-1", "f-1");

      expect(editor.chain).toHaveBeenCalled();
      expect(editor._setMark).toHaveBeenCalledWith("foreshadowSetup", {
        setupId: "s-1",
        foreshadowId: "f-1",
      });
      expect(editor._run).toHaveBeenCalled();
    });

    it("shows toast and keeps state on API failure", async () => {
      const { toast } = await import("sonner");
      const orphanSetup = makeSetup({
        id: "s-1",
        foreshadowId: "f-1",
        isOrphan: true,
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);
      mockReanchorOrphanSetup.mockRejectedValue(new Error("Tauri error"));
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reanchorSetup("s-1", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(
        useForeshadowStore.getState().setupsByForeshadowId["f-1"]?.[0]
          ?.isOrphan,
      ).toBe(true);
    });
  });

  // ── reinsertSetup ─────────────────────────────────────────────────

  describe("reinsertSetup", () => {
    it("shows toast and returns if no editor open", async () => {
      const { toast } = await import("sonner");
      mockUseEditorStore.getState.mockReturnValue({ editor: null } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);

      await useForeshadowStore.getState().reinsertSetup("s-1", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(mockReinsertOrphanSetup).not.toHaveBeenCalled();
    });

    it("shows toast and returns if selection is empty", async () => {
      const { toast } = await import("sonner");
      const editor = makeEditorChainMock();
      (
        editor as never as {
          state: { selection: { from: number; to: number } };
        }
      ).state = { selection: { from: 3, to: 3 } };
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);

      await useForeshadowStore.getState().reinsertSetup("s-1", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(mockReinsertOrphanSetup).not.toHaveBeenCalled();
    });

    it("calls reinsertOrphanSetup and replaces orphan with new setup in state", async () => {
      const orphanSetup = makeSetup({
        id: "s-old",
        foreshadowId: "f-1",
        isOrphan: true,
      });
      const newSetup = makeSetup({
        id: "s-new",
        foreshadowId: "f-1",
        isOrphan: false,
        sceneId: "sc-1",
        fromPos: 10,
        toPos: 20,
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);
      mockReinsertOrphanSetup.mockResolvedValue(newSetup);
      useForeshadowStore.setState({
        items: [{ ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 }],
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reinsertSetup("s-old", "f-1");

      const setups = useForeshadowStore.getState().setupsByForeshadowId["f-1"];
      expect(setups?.some((s) => s.id === "s-old")).toBe(false);
      expect(setups?.some((s) => s.id === "s-new")).toBe(true);
    });

    it("calls editor.chain setMark with new id after successful reinsert", async () => {
      const orphanSetup = makeSetup({
        id: "s-old",
        foreshadowId: "f-1",
        isOrphan: true,
      });
      const newSetup = makeSetup({
        id: "s-new",
        foreshadowId: "f-1",
        isOrphan: false,
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);
      mockReinsertOrphanSetup.mockResolvedValue(newSetup);
      useForeshadowStore.setState({
        items: [{ ...makeRow({ id: "f-1" }), label: "planned", setupCount: 0 }],
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reinsertSetup("s-old", "f-1");

      expect(editor._setMark).toHaveBeenCalledWith("foreshadowSetup", {
        setupId: "s-new",
        foreshadowId: "f-1",
      });
      expect(editor._run).toHaveBeenCalled();
    });

    it("shows toast and keeps state on API failure", async () => {
      const { toast } = await import("sonner");
      const orphanSetup = makeSetup({
        id: "s-old",
        foreshadowId: "f-1",
        isOrphan: true,
      });
      const editor = makeEditorChainMock();
      mockUseEditorStore.getState.mockReturnValue({ editor } as never);
      mockUseSceneStore.getState.mockReturnValue({
        activeSceneId: "sc-1",
      } as never);
      mockReinsertOrphanSetup.mockRejectedValue(new Error("Tauri error"));
      useForeshadowStore.setState({
        setupsByForeshadowId: { "f-1": [orphanSetup] },
      });

      await useForeshadowStore.getState().reinsertSetup("s-old", "f-1");

      expect(toast.error).toHaveBeenCalled();
      expect(
        useForeshadowStore.getState().setupsByForeshadowId["f-1"]?.[0]?.id,
      ).toBe("s-old");
    });
  });

  // ── proposeSetups ─────────────────────────────────────────────────

  describe("proposeSetups", () => {
    function makeSceneNode(
      id: string,
      sortOrder: string,
      parentId: string | null = null,
    ) {
      return {
        id,
        nodeType: "scene",
        title: `title-${id}`,
        sortOrder,
        parentId,
      };
    }

    beforeEach(() => {
      useForeshadowStore.setState({
        items: [
          {
            ...makeRow({ id: "f-1", payoffSceneId: "scene-payoff" }),
            label: "planned",
            setupCount: 0,
          },
        ],
        proposeResults: {},
      });
      mockLoadSceneContents.mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, `body-${id}`]))),
      );
      mockDetectRelatedCodex.mockResolvedValue([]);
      mockProposePastSetups.mockResolvedValue([]);
      mockSaveScene.mockResolvedValue(undefined);
    });

    it("pastScenes を sortOrder 順に整列し、orderIndex に実際の物語順を渡す", async () => {
      // nodes 配列の並び（topological 順相当）は sortOrder 昇順ではない
      mockUseSceneStore.getState.mockReturnValue({
        nodes: [
          makeSceneNode("scene-c", "a2"),
          makeSceneNode("scene-a", "a0"),
          makeSceneNode("scene-payoff", "a3"),
          makeSceneNode("scene-b", "a1"),
        ],
        activeSceneId: null,
      } as never);

      await useForeshadowStore.getState().proposeSetups("f-1");

      const req = mockProposePastSetups.mock.calls[0][0];
      expect(
        req.pastScenes.map((s) => ({
          sceneId: s.sceneId,
          orderIndex: s.orderIndex,
        })),
      ).toEqual([
        { sceneId: "scene-a", orderIndex: 1 },
        { sceneId: "scene-b", orderIndex: 2 },
        { sceneId: "scene-c", orderIndex: 3 },
      ]);
      expect(mockLoadSceneContents).toHaveBeenCalledOnce();
      expect(mockLoadSceneContents).toHaveBeenCalledWith([
        "scene-a",
        "scene-b",
        "scene-c",
        "scene-payoff",
      ]);
    });

    it("検出した relatedCodex を空配列でなく実エントリで渡す", async () => {
      mockUseSceneStore.getState.mockReturnValue({
        nodes: [
          makeSceneNode("scene-a", "a0"),
          makeSceneNode("scene-payoff", "a3"),
        ],
        activeSceneId: null,
      } as never);
      mockDetectRelatedCodex.mockResolvedValue([
        { id: "c-1", name: "朱音", summary: "主人公" },
      ]);

      await useForeshadowStore.getState().proposeSetups("f-1");

      expect(mockDetectRelatedCodex).toHaveBeenCalledWith(
        expect.stringContaining("body-scene-payoff"),
      );
      expect(mockDetectRelatedCodex).toHaveBeenCalledWith(
        expect.stringContaining("body-scene-a"),
      );
      const req = mockProposePastSetups.mock.calls[0][0];
      expect(req.relatedCodex).toEqual([
        { id: "c-1", name: "朱音", summary: "主人公" },
      ]);
    });

    it("実行前に active scene の保存を flush する (DB 読みより先)", async () => {
      mockUseSceneStore.getState.mockReturnValue({
        nodes: [
          makeSceneNode("scene-a", "a0"),
          makeSceneNode("scene-payoff", "a3"),
        ],
        activeSceneId: "scene-a",
      } as never);

      await useForeshadowStore.getState().proposeSetups("f-1");

      expect(mockSaveScene).toHaveBeenCalledWith("scene-a");
      expect(mockSaveScene.mock.invocationCallOrder[0]).toBeLessThan(
        mockLoadSceneContents.mock.invocationCallOrder[0],
      );
    });

    it("activeSceneId が無ければ flush しない", async () => {
      mockUseSceneStore.getState.mockReturnValue({
        nodes: [makeSceneNode("scene-payoff", "a3")],
        activeSceneId: null,
      } as never);

      await useForeshadowStore.getState().proposeSetups("f-1");

      expect(mockSaveScene).not.toHaveBeenCalled();
    });
  });

  // ── auditChapter ──────────────────────────────────────────────────

  describe("auditChapter", () => {
    function makeChapterScene(id: string, sortOrder: string) {
      return {
        id,
        nodeType: "scene",
        title: `title-${id}`,
        sortOrder,
        parentId: "ch-1",
      };
    }

    beforeEach(() => {
      useForeshadowStore.setState({ items: [], auditResults: {} });
      mockLoadSceneContents.mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, `body-${id}`]))),
      );
      mockDetectRelatedCodex.mockResolvedValue([]);
      mockAuditChapter.mockResolvedValue([]);
      mockSaveScene.mockResolvedValue(undefined);
    });

    it("実行前に active scene の保存を flush し、検出 relatedCodex を渡す", async () => {
      mockUseSceneStore.getState.mockReturnValue({
        nodes: [makeChapterScene("s-2", "a1"), makeChapterScene("s-1", "a0")],
        activeSceneId: "s-1",
      } as never);
      mockDetectRelatedCodex.mockResolvedValue([
        { id: "c-1", name: "王家の印章", summary: "失われた紋章" },
      ]);

      await useForeshadowStore.getState().auditChapter("ch-1");

      expect(mockSaveScene).toHaveBeenCalledWith("s-1");
      expect(mockSaveScene.mock.invocationCallOrder[0]).toBeLessThan(
        mockLoadSceneContents.mock.invocationCallOrder[0],
      );
      expect(mockDetectRelatedCodex).toHaveBeenCalledWith(
        expect.stringContaining("body-s-1"),
      );
      const req = mockAuditChapter.mock.calls[0][0];
      expect(req.relatedCodex).toEqual([
        { id: "c-1", name: "王家の印章", summary: "失われた紋章" },
      ]);
      expect(req.scenes.map((s) => s.sceneId)).toEqual(["s-1", "s-2"]);
      expect(mockLoadSceneContents).toHaveBeenCalledOnce();
      expect(mockLoadSceneContents).toHaveBeenCalledWith(["s-1", "s-2"]);
    });
  });
});
