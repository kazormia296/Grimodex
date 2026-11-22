// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-8 の疑いの確認：`usePhaseStore.resetForProject()` の直後（`sceneTimeIndex` は空、
 * `resolutionMode` は前の project の値のまま）に `resolveCodexForAi` を呼ぶと、hidden の Codex が
 * AI に見える向き（fail-open）に働くか。**現状の挙動を特性として固定する**（直しではない）。
 *
 * 観察（この file が固定する値）：
 * - 効くのは `resolutionMode` の残りではなく、`sceneTimeIndex` が空であること。現在の場面が
 *   読む順に無いと、Phase は 1 つも効かない（`resolveApplicablePhases` の `current-scene-missing`）ので、
 *   mode が reading でも story でも同じ結果になる。
 * - base が公開で Phase が hidden にする項目は、公開と判定される（fail-open）。
 * - base が hidden の項目は、Phase が公開にするものも含めて hidden のまま（fail-closed 側は守られる）。
 *   つまり漏れるのは「Phase だけが hidden にしている」項目に限られる。
 * - `setResolutionMode(B の値)` を足しても、index が空のうちは変わらない。`recomputeSceneOrder` で
 *   index が入ると正しい判定に戻る。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("@/features/chat/agent/legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});

import { invoke } from "@/lib/tauri";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { legacyReadInvokeBridge } from "@/features/chat/agent/legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
} from "@/features/chat/agent/legacyReadHarness.testSupport";
import type { TreeNodeData } from "@/features/tree/types";
import { buildSceneTimeIndex } from "./sceneTimeIndex";
import { resolveCodexForAi } from "./codexHiddenFromAi";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const T1 = "2026-01-01T00:00:00.000Z";

// characterization.test.ts と同じ Phase のうち、この試験が使う 2 つ。
//  c-aria     : base 公開。n-s2 から Phase が hidden にする。
//  c-released : base hidden。n-s3 から Phase が公開にする（seed の側の Phase）。
//  c-secret   : base hidden。Phase なし。
const PHASES = [
  { id: "ph-aria-hide-s2", entry: "c-aria", anchor: "n-s2", mode: "hidden" },
];

const runSql = (sql: string, params: unknown[]) =>
  invoke("db_execute", { sql, params, method: "run" });

beforeAll(async () => {
  setLegacyReadWorkspaceIdentity();
  await seedLegacyReadFixture();
  for (const p of PHASES) {
    await runSql(
      "INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [p.id, p.entry, p.anchor, p.id, null, null, p.mode, T1, T1],
    );
  }
});

const sceneNode = (
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null,
): TreeNodeData =>
  ({
    id,
    projectId: "p-main",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    archivedAt: null,
    createdAt: T1,
    updatedAt: T1,
  }) as unknown as TreeNodeData;

const FULL_STORY = [
  sceneNode("n-s1", "a0", "a1"),
  sceneNode("n-s2", "a1", "a3"),
  sceneNode("n-s3", "a2", "a2"),
  sceneNode("n-s4", "a3", "a4"),
];

const KINDS = {
  baseHidden: "c-secret",
  basePublicPhaseHidden: "c-aria",
  baseHiddenPhasePublic: "c-released",
} as const;

/** 3 種を、現在の場面 n-s4（どの Phase も効く後ろの場面）で判定し、hidden かどうかを返す。 */
async function observe(): Promise<Record<keyof typeof KINDS, boolean>> {
  const { hidden } = await resolveCodexForAi({
    entryIds: Object.values(KINDS),
    projectId: "p-main",
    sceneId: "n-s4",
  });
  return {
    baseHidden: hidden.has(KINDS.baseHidden),
    basePublicPhaseHidden: hidden.has(KINDS.basePublicPhaseHidden),
    baseHiddenPhasePublic: hidden.has(KINDS.baseHiddenPhasePublic),
  };
}

beforeEach(() => {
  legacyReadInvokeBridge.reset();
  // project A：mode は story。index は読み込み済み。
  usePhaseStore.setState({
    sceneTimeIndex: buildSceneTimeIndex(FULL_STORY),
    resolutionMode: "story",
  });
});

describe("resetForProject の直後の hidden の判定（既知の疑い）", () => {
  it("reset の前（A の mode＝story・index あり）は、3 種とも正しい（hidden／hidden／公開）", async () => {
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: true,
      baseHiddenPhasePublic: false,
    });
  });

  it("reset の直後（index は空、mode は A の story のまま）：Phase だけが hidden にする項目が公開と判定される（fail-open）", async () => {
    usePhaseStore.getState().resetForProject();
    const state = usePhaseStore.getState();
    expect(state.resolutionMode).toBe("story");
    expect(state.sceneTimeIndex.readingOrder.size).toBe(0);
    // 既知の疑い：base 公開で Phase が hidden の c-aria が、AI に渡る向き（hidden でない）になる。
    // base hidden の c-secret は hidden のまま。base hidden で Phase が公開にする c-released は
    // Phase が効かないので hidden のまま（fail-closed）。
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: false,
      baseHiddenPhasePublic: true,
    });
  });

  it("reset の直後は mode が reading でも同じ（原因は mode の残りではなく index が空なこと）", async () => {
    usePhaseStore.getState().resetForProject();
    usePhaseStore.getState().setResolutionMode("reading");
    const reading = await observe();
    usePhaseStore.getState().setResolutionMode("auto");
    const auto = await observe();
    const expected = {
      baseHidden: true,
      basePublicPhaseHidden: false,
      baseHiddenPhasePublic: true,
    };
    expect(reading).toEqual(expected);
    expect(auto).toEqual(expected);
  });

  it("B の正しい mode を setResolutionMode しても、index が空のうちは fail-open のまま", async () => {
    usePhaseStore.getState().resetForProject();
    usePhaseStore.getState().setResolutionMode("story");
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: false,
      baseHiddenPhasePublic: true,
    });
  });

  it("index を入れ直す（recomputeSceneOrder）と、3 種とも正しい判定に戻る", async () => {
    usePhaseStore.getState().resetForProject();
    usePhaseStore.getState().recomputeSceneOrder([...FULL_STORY]);
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: true,
      baseHiddenPhasePublic: false,
    });
  });

  it("現在の場面が index に無いとき（reset と無関係に）も、Phase が効かず同じ fail-open になる", async () => {
    const { hidden } = await resolveCodexForAi({
      entryIds: [KINDS.basePublicPhaseHidden],
      projectId: "p-main",
      sceneId: "n-not-in-index",
    });
    expect(hidden.has(KINDS.basePublicPhaseHidden)).toBe(false);
  });
});
