// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-5b：`readOpenForeshadowWire`（renderer の `foreshadowOpen` の port。未回収伏線の wire を
 * 返すだけで、組み立ては共有 core）の固定。
 *
 * - Native 分岐（`window.grimodex` あり）：`foreshadow_list_open_for_context` を `{ projectId }` だけで 1 回
 *   invoke し、戻りをそのまま返す（DB は読まない）。
 * - Drizzle 分岐（browser-mock・試験）：従来の文と順のまま。foreshadows は `secret = false`・未回収・
 *   未放棄・project で絞る（**secret の伏線を list に出さない条件はここにも在る**）。0 件なら setups の
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

describe("readOpenForeshadowWire", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  describe("Drizzle 分岐（browser-mock）", () => {
    it("seed の前提：fs-2 は secret=1 で未回収・未放棄（secret の絞りが効かなければ list に出る伏線）", () => {
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

    it("secret・回収済み・放棄済み・他 project の行を返さず、setups は残った伏線の分だけ。行は camelCase・boolean・Date のまま", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      legacyReadInvokeBridge.reset();
      const wire = (await readOpenForeshadowWire("p-main")) as Wire;
      expect(wire.foreshadows.map((f) => f.id)).toEqual(["fs-1", "fs-5"]);
      expect(wire.foreshadows.map((f) => f.id)).not.toContain("fs-2");
      expect(wire.foreshadows[0]).toMatchObject({
        id: "fs-1",
        loadBearing: "critical",
        payoffConfirmed: false,
        abandoned: false,
      });
      expect(wire.foreshadows[0]!.updatedAt).toBeInstanceOf(Date);
      // fs-2 の setup（fsu-4）は残った伏線の setup ではない。
      expect(wire.setups.map((s) => s.foreshadowId)).toEqual([
        "fs-1",
        "fs-1",
        "fs-1",
      ]);
      expect(wire.setups[0]).toHaveProperty("sceneId");
    });

    it("foreshadows の文は project・未回収・未放棄・secret=false で絞り、setups は IN の 1 文（計 2 文）。Native は呼ばない", async () => {
      await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
      legacyReadInvokeBridge.reset();
      await readOpenForeshadowWire("p-main");
      const statements = dbStatements();
      expect(statements).toHaveLength(2);
      const first = String(statements[0]!.args?.sql);
      expect(first).toMatch(/from "foreshadows"/iu);
      for (const column of [
        "project_id",
        "payoff_confirmed",
        "abandoned",
        "secret",
      ]) {
        expect(first, column).toMatch(
          new RegExp(`"foreshadows"\\."${column}" = \\?`, "u"),
        );
      }
      expect(statements[0]!.args?.params).toEqual(["p-main", 0, 0, 0]);
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
