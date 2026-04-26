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
} from "./api";
import { db } from "@/db/client";

const mockListForeshadows = vi.mocked(listForeshadows);
const mockCreateForeshadow = vi.mocked(createForeshadow);
const mockDeleteForeshadow = vi.mocked(deleteForeshadow);
const mockListSetups = vi.mocked(listSetups);
const mockDeleteSetup = vi.mocked(deleteSetup);
const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
};

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
        useForeshadowStore
          .getState()
          .create({ projectId: "proj-1", title: "失敗", intent: null }),
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
});
