import { describe, it, expect, beforeEach, vi } from "vitest";
import { useForeshadowStore } from "./foreshadowStore";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";

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

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("./api", () => ({
  listForeshadows: vi.fn(),
  createForeshadow: vi.fn(),
  deleteForeshadow: vi.fn(),
  listSetups: vi.fn(),
  deleteSetup: vi.fn(),
  reanchorOrphanSetup: vi.fn(),
  reinsertOrphanSetup: vi.fn(),
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: { getState: vi.fn() },
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: { getState: vi.fn() },
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("i18next", () => ({
  default: { t: (_k: string, fallback: string) => fallback },
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn() },
  errorDetail: vi.fn(),
  rootCause: vi.fn((e: unknown) => String(e)),
}));

import {
  listForeshadows,
  createForeshadow,
  deleteForeshadow,
  listSetups,
  deleteSetup,
  reanchorOrphanSetup,
  reinsertOrphanSetup,
} from "./api";
import { db } from "@/db/client";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";

const mockListForeshadows = vi.mocked(listForeshadows);
const mockCreateForeshadow = vi.mocked(createForeshadow);
const mockDeleteForeshadow = vi.mocked(deleteForeshadow);
const mockListSetups = vi.mocked(listSetups);
const mockDeleteSetup = vi.mocked(deleteSetup);
const mockReanchorOrphanSetup = vi.mocked(reanchorOrphanSetup);
const mockReinsertOrphanSetup = vi.mocked(reinsertOrphanSetup);
const mockUseEditorStore = vi.mocked(useEditorStore);
const mockUseSceneStore = vi.mocked(useSceneStore);
const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
};

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

// Helper to set up db.select().from().where() chain return value
function mockDbSetups(setups: ForeshadowSetupRow[]) {
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockResolvedValue(setups);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("foreshadowStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useForeshadowStore.setState({ items: [], isLoading: false });
  });

  // ── load / buildWithLabels ────────────────────────────────────────

  describe("load (buildWithLabels)", () => {
    it("empty rows → items stays empty, no DB setup query", async () => {
      mockListForeshadows.mockResolvedValue([]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items).toEqual([]);
      expect(useForeshadowStore.getState().isLoading).toBe(false);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("row with no setups gets label=planned and setupCount=0", async () => {
      const row = makeRow();
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([]);

      await useForeshadowStore.getState().load("proj-1");

      const [item] = useForeshadowStore.getState().items;
      expect(item.label).toBe("planned");
      expect(item.setupCount).toBe(0);
    });

    it("non-orphan setup increments setupCount → label=seeded", async () => {
      const row = makeRow();
      const setup = makeSetup({ isOrphan: false });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      const [item] = useForeshadowStore.getState().items;
      expect(item.setupCount).toBe(1);
      expect(item.label).toBe("seeded");
    });

    it("orphan setup is NOT counted", async () => {
      const row = makeRow();
      const setup = makeSetup({ isOrphan: true });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      const [item] = useForeshadowStore.getState().items;
      expect(item.setupCount).toBe(0);
      expect(item.label).toBe("planned");
    });

    it("strength=subtle → label=needs_strengthening", async () => {
      const row = makeRow();
      const setup = makeSetup({ isOrphan: false, strength: "subtle" });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items[0].label).toBe(
        "needs_strengthening",
      );
    });

    it("aiStrength=subtle → label=needs_strengthening", async () => {
      const row = makeRow();
      const setup = makeSetup({ isOrphan: false, aiStrength: "subtle" });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items[0].label).toBe(
        "needs_strengthening",
      );
    });

    it("payoffConfirmed + setupCount>0 → label=paid", async () => {
      const row = makeRow({ payoffConfirmed: true });
      const setup = makeSetup({ isOrphan: false });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items[0].label).toBe("paid");
    });

    it("payoffConfirmed + setupCount=0 → label=orphan_payoff", async () => {
      const row = makeRow({ payoffConfirmed: true });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items[0].label).toBe(
        "orphan_payoff",
      );
    });

    it("abandoned=true → label=abandoned regardless of setups", async () => {
      const row = makeRow({ abandoned: true });
      const setup = makeSetup({ isOrphan: false });
      mockListForeshadows.mockResolvedValue([row]);
      mockDbSetups([setup]);

      await useForeshadowStore.getState().load("proj-1");

      expect(useForeshadowStore.getState().items[0].label).toBe("abandoned");
    });

    it("multiple rows get independent labels", async () => {
      const row1 = makeRow({ id: "f-1" });
      const row2 = makeRow({ id: "f-2", payoffConfirmed: true });
      const setup1 = makeSetup({
        id: "s-1",
        foreshadowId: "f-1",
        isOrphan: false,
      });
      mockListForeshadows.mockResolvedValue([row1, row2]);
      mockDbSetups([setup1]);

      await useForeshadowStore.getState().load("proj-1");

      const items = useForeshadowStore.getState().items;
      expect(items.find((i) => i.id === "f-1")?.label).toBe("seeded");
      expect(items.find((i) => i.id === "f-2")?.label).toBe("orphan_payoff");
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
});
