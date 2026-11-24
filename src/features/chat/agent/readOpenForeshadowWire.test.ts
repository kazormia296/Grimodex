// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-5b：`readOpenForeshadowWire`（renderer の `foreshadowOpen` の port。未回収伏線の wire を
 * 返すだけで、組み立ては共有 core）の固定。
 *
 * - Native 分岐（`window.grimodex` あり）：`foreshadow_list_open_for_context` を `{ projectId }` だけで 1 回
 *   invoke し、戻りをそのまま返す（DB は読まない）。secret は条件に使わない。
 * - Drizzle 分岐（browser-mock・試験）：従来の文と順のまま。foreshadows は未回収・未放棄・
 *   project で絞る。secret=1 の伏線も含む。0 件なら setups の
 *   select を打たず空の 2 list を返す。
 * - `listOpenForeshadowsForContext`（chat の context 構築が使う）は同じ wire を通り、結果の形は不変。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});

import {
  listOpenForeshadowsForContext,
  readOpenForeshadowWire,
} from "@/features/foreshadow/api";
import { foreshadowsForListFromWire } from "../../../../electron/shared/readDomain/features/foreshadow/readRows.js";
import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { LEGACY_READ_SEED } from "./__fixtures__/legacyReadSeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Wire = {
  foreshadows: Array<Record<string, unknown>>;
  setups: Array<Record<string, unknown>>;
};

const dbStatements = () => legacyReadInvokeBridge.calls("db_execute");

function settledListSeedWire(): Wire {
  const rows = (table: string) =>
    LEGACY_READ_SEED.find((entry) => entry.table === table)!.rows as Array<
      Record<string, unknown>
    >;
  const foreshadows = rows("foreshadows").filter(
    (row) => row.project_id === "p-main" && row.abandoned === 0,
  );
  const ids = new Set(foreshadows.map((row) => row.id));
  return {
    foreshadows,
    setups: rows("foreshadow_setups").filter((row) =>
      ids.has(row.foreshadow_id),
    ),
  };
}

describe("readOpenForeshadowWire", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  describe("Drizzle 分岐（browser-mock）", () => {
    it("seed の前提：fs-2 は secret=1 でも未回収・未放棄なので list に出る", () => {
      const rows = LEGACY_READ_SEED.find((t) => t.table === "foreshadows")!
        .rows as Array<Record<string, unknown>>;
      const fs2 = rows.find((r) => r.id === "fs-2")!;
      expect(fs2).toMatchObject({
        project_id: "p-main",
        secret: 1,
        payoff_confirmed: 0,
        abandoned: 0,
      });
    });

    it("secret の値にかかわらず未回収・未放棄・同 project の行を返し、closed と他 project は返さない", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      legacyReadInvokeBridge.reset();
      const wire = (await readOpenForeshadowWire("p-main")) as Wire;
      expect(wire.foreshadows.map((f) => f.id)).toEqual([
        "fs-1",
        "fs-2",
        "fs-5",
      ]);
      expect(wire.foreshadows.map((f) => f.id)).toContain("fs-2");
      expect(wire.foreshadows[0]).toMatchObject({
        id: "fs-1",
        loadBearing: "critical",
        payoffConfirmed: false,
        abandoned: false,
      });
      expect(wire.foreshadows[0]!.updatedAt).toBeInstanceOf(Date);
      // fs-1 has four setups and secret fs-2 has fsu-4. Archived setups remain in this wire.
      expect(wire.setups.map((s) => s.foreshadowId).sort()).toEqual([
        "fs-1",
        "fs-1",
        "fs-1",
        "fs-1",
        "fs-2",
      ]);
      expect(wire.setups[0]).toHaveProperty("sceneId");
    });

    it("includeSettled は同 project の未放棄全件を foreshadow_list_with_labels 形式で返す", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      legacyReadInvokeBridge.reset();
      const wire = (await readOpenForeshadowWire("p-main", true)) as Wire;
      expect(wire.foreshadows.map((row) => row.id)).toEqual([
        "fs-1",
        "fs-2",
        "fs-3",
        "fs-5",
        "fs-7",
      ]);
      expect(wire.foreshadows.find((row) => row.id === "fs-7")).toMatchObject({
        payoffConfirmed: true,
        payoffSceneId: "n-arch",
      });
      expect(wire.setups.some((row) => row.sceneId)).toBe(true);
      const select = String(dbStatements()[0]!.args?.sql);
      expect(select).toMatch(/from "foreshadows"/iu);
      expect(select).toContain('"foreshadows"."abandoned" = ?');
      expect(select).not.toContain('"foreshadows"."payoff_confirmed"');
      expect(select).not.toContain('"foreshadows"."secret"');
    });

    it("the Native and Drizzle settled wires produce the same list from the existing seed", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      const drizzle = await readOpenForeshadowWire("p-main", true);
      const drizzleRows = foreshadowsForListFromWire(drizzle);
      expect(drizzleRows.map((row) => row.id)).toEqual([
        "fs-1",
        "fs-2",
        "fs-5",
        "fs-3",
        "fs-7",
      ]);
      expect(drizzleRows.slice(-2).every((row) => row.settled === true)).toBe(
        true,
      );

      const holder = window as unknown as { grimodex?: unknown };
      holder.grimodex = {};
      try {
        const native = settledListSeedWire();
        legacyReadInvokeBridge.reset();
        legacyReadInvokeBridge.override(
          "foreshadow_list_with_labels",
          () => native,
        );
        const wire = await readOpenForeshadowWire("p-main", true);
        expect(wire).toBe(native);
        expect(
          legacyReadInvokeBridge.calls("foreshadow_list_with_labels"),
        ).toEqual([
          {
            cmd: "foreshadow_list_with_labels",
            args: { projectId: "p-main" },
          },
        ]);
        expect(dbStatements()).toEqual([]);
        expect(foreshadowsForListFromWire(wire)).toEqual(drizzleRows);
      } finally {
        delete holder.grimodex;
      }
    });

    it("foreshadows の文は project・未回収・未放棄で絞り、setups は IN の 1 文（計 2 文）。Native は呼ばない", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      legacyReadInvokeBridge.reset();
      await readOpenForeshadowWire("p-main");
      const statements = dbStatements();
      expect(statements).toHaveLength(2);
      const first = String(statements[0]!.args?.sql);
      expect(first).toMatch(/from "foreshadows"/iu);
      for (const column of ["project_id", "payoff_confirmed", "abandoned"]) {
        expect(first, column).toMatch(
          new RegExp(`"foreshadows"\\."${column}" = \\?`, "u"),
        );
      }
      expect(first).not.toContain('"secret"');
      expect(statements[0]!.args?.params).toEqual(["p-main", 0, 0]);
      expect(String(statements[1]!.args?.sql)).toMatch(
        /from "foreshadow_setups"[\s\S]*"foreshadow_id" in \(/iu,
      );
      expect(
        legacyReadInvokeBridge.calls("foreshadow_list_open_for_context"),
      ).toEqual([]);
    });

    it("伏線が 0 件なら setups の select を打たず、空の 2 list を返す", async () => {
      await setLegacyReadWorld({ projectId: "p-empty" });
      legacyReadInvokeBridge.reset();
      await expect(readOpenForeshadowWire("p-empty")).resolves.toEqual({
        foreshadows: [],
        setups: [],
      });
      expect(dbStatements()).toHaveLength(1);
    });

    it("listOpenForeshadowsForContext は同じ wire から組み、結果の形（derivedLabel・version を含む）は不変", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      const rows = await listOpenForeshadowsForContext("p-main");
      expect(rows.map((r) => [r.id, r.setupCount, r.derivedLabel])).toEqual([
        ["fs-1", 2, "critical_weak"],
        ["fs-2", 1, "needs_strengthening"],
        ["fs-5", 0, "planned"],
      ]);
      expect(rows[0]).toMatchObject({ version: 0, loadBearing: "critical" });
    });
  });

  describe("Native 分岐（window.grimodex あり）", () => {
    it("command は 1 回・引数は { projectId } だけ・DB は読まず、戻りを加工せずそのまま返す", async () => {
      const native = {
        foreshadows: [{ id: "f", title: "t", payoff_confirmed: 0 }],
        setups: [{ foreshadow_id: "f", is_orphan: 0 }],
      };
      const holder = window as unknown as { grimodex?: unknown };
      holder.grimodex = {};
      try {
        legacyReadInvokeBridge.reset();
        legacyReadInvokeBridge.override(
          "foreshadow_list_open_for_context",
          () => native,
        );
        const wire = await readOpenForeshadowWire("p-main");
        expect(wire).toBe(native);
        expect(
          legacyReadInvokeBridge.calls("foreshadow_list_open_for_context"),
        ).toEqual([
          {
            cmd: "foreshadow_list_open_for_context",
            args: { projectId: "p-main" },
          },
        ]);
        expect(legacyReadInvokeBridge.calls()).toHaveLength(1);
        expect(dbStatements()).toEqual([]);
      } finally {
        delete holder.grimodex;
      }
    });

    it("listOpenForeshadowsForContext は壊れた wire を空の成功にせず throw する（setups が無い・行が object でない）", async () => {
      const holder = window as unknown as { grimodex?: unknown };
      holder.grimodex = {};
      try {
        for (const wire of [
          undefined,
          { foreshadows: [] },
          { foreshadows: [null], setups: [] },
        ]) {
          legacyReadInvokeBridge.reset();
          legacyReadInvokeBridge.override(
            "foreshadow_list_open_for_context",
            () => wire,
          );
          await expect(listOpenForeshadowsForContext("p-main")).rejects.toThrow(
            /foreshadow_list_open_for_context/,
          );
        }
      } finally {
        delete holder.grimodex;
      }
    });
  });
});
