// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `usePhaseStore.resetForProject()` の直後（`sceneTimeIndex` は空、`resolutionMode` は前の project の
 * 値のまま）と、現在の場面が `sceneTimeIndex` に無いときの `resolveCodexForAi` の判定。
 * 8a では fail-open の疑いとして特性を固定していた。**DR-MP4-41 の決定（fail-closed）で期待を変えた**。
 *
 * 固定する値：
 * - 効くのは `resolutionMode` の残りではなく、`sceneTimeIndex` が空であること。現在の場面が
 *   読む順に無いと、Phase は 1 つも効かない（`resolveApplicablePhases` の `current-scene-missing`）ので、
 *   mode が reading でも story でも同じ結果になる。
 * - DR-MP4-41 (a)：場面が与えられているのに読む順に無いとき、Phase が hidden にする項目
 *   （base 公開・Phase hidden）は hidden に倒す。以前は公開と判定されていた（fail-open）。
 * - DR-MP4-41 の Q1：場面なし（null・空・空白だけ・未指定）も場面を解決できないので、同じ規則で
 *   hidden に倒す（以前は base 扱いで公開と判定されていた）。
 * - base が hidden の項目は、Phase が公開にするものも含めて hidden のまま（今までと同じ）。
 * - `setResolutionMode(B の値)` を足しても、index が空のうちは同じ。`recomputeSceneOrder` で
 *   index が入ると、従来どおり正しい判定に戻る。
 * - DR-MP4-41 (b)：判定の途中（DB の await の最中）に project が切り替わったら、全 id が hidden。
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

describe("resetForProject の直後・場面が index に無いときの hidden の判定（DR-MP4-41 の決定）", () => {
  it("reset の前（A の mode＝story・index あり）は、3 種とも正しい（hidden／hidden／公開）", async () => {
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: true,
      baseHiddenPhasePublic: false,
    });
  });

  it("reset の直後（index は空、mode は A の story のまま）：Phase だけが hidden にする項目も hidden に倒す（fail-closed）", async () => {
    usePhaseStore.getState().resetForProject();
    const state = usePhaseStore.getState();
    expect(state.resolutionMode).toBe("story");
    expect(state.sceneTimeIndex.readingOrder.size).toBe(0);
    // DR-MP4-41 (a)：base 公開で Phase が hidden の c-aria は hidden（以前は公開と判定された）。
    // base hidden の c-secret・c-released は、今までどおり hidden のまま。
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: true,
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
      basePublicPhaseHidden: true,
      baseHiddenPhasePublic: true,
    };
    expect(reading).toEqual(expected);
    expect(auto).toEqual(expected);
  });

  it("B の正しい mode を setResolutionMode しても、index が空のうちは fail-closed のまま", async () => {
    usePhaseStore.getState().resetForProject();
    usePhaseStore.getState().setResolutionMode("story");
    expect(await observe()).toEqual({
      baseHidden: true,
      basePublicPhaseHidden: true,
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

  it("現在の場面が index に無いとき（reset と無関係に）も、Phase が hidden にする項目は hidden（DR-MP4-41 (a)）", async () => {
    const { hidden } = await resolveCodexForAi({
      entryIds: [KINDS.basePublicPhaseHidden],
      projectId: "p-main",
      sceneId: "n-not-in-index",
    });
    expect(hidden.has(KINDS.basePublicPhaseHidden)).toBe(true);
  });

  it("場面なし（sceneId が null・空・空白だけ・未指定）も、場面を解決できないので、Phase が hidden にする項目は hidden に倒す（DR-MP4-41 の Q1）", async () => {
    // 変わった期待：以前は base 扱い（c-aria は公開、base hidden の 2 つだけ hidden）だった。
    // いまは c-aria（base 公開・Phase が hidden）も hidden。base hidden の 2 つは今までどおり hidden。
    usePhaseStore.getState().resetForProject();
    for (const sceneId of [null, "", "   ", undefined]) {
      const { hidden } = await resolveCodexForAi({
        entryIds: Object.values(KINDS),
        projectId: "p-main",
        ...(sceneId === undefined ? {} : { sceneId }),
      });
      expect([...hidden].sort(), String(sceneId)).toEqual(
        [
          KINDS.baseHidden,
          KINDS.basePublicPhaseHidden,
          KINDS.baseHiddenPhasePublic,
        ].sort(),
      );
    }
  });
});

describe("判定の途中で project が切り替わったら、全 id が hidden（DR-MP4-41 (b)）", () => {
  const ALL = [
    KINDS.baseHidden,
    KINDS.basePublicPhaseHidden,
    KINDS.baseHiddenPhasePublic,
    "c-mage",
    "gone-id",
  ];

  const resolveAll = () =>
    resolveCodexForAi({
      entryIds: ALL,
      projectId: "p-main",
      sceneId: "n-s1",
      withContent: true,
    });

  it("切り替えが無ければ、公開の項目は公開のまま（制御）", async () => {
    const { hidden, texts } = await resolveAll();
    expect(texts.has("c-mage")).toBe(true);
    expect(hidden.has("c-mage")).toBe(false);
  });

  it("phases の読みの await の最中に resetForProject すると、全 id が hidden で texts は空", async () => {
    let fired = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !fired &&
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_entry_phases"')
      ) {
        fired = true;
        usePhaseStore.getState().resetForProject();
      }
    });
    const { hidden, texts } = await resolveAll();
    expect(fired).toBe(true);
    expect([...hidden].sort()).toEqual([...ALL].sort());
    expect(texts.size).toBe(0);
  });

  it("entries の読みの await の最中に resetForProject しても、全 id が hidden", async () => {
    let fired = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !fired &&
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_entries"')
      ) {
        fired = true;
        usePhaseStore.getState().resetForProject();
      }
    });
    const { hidden, texts } = await resolveAll();
    expect(fired).toBe(true);
    expect([...hidden].sort()).toEqual([...ALL].sort());
    expect(texts.size).toBe(0);
  });

  it("呼ぶ前に済んだ切り替えは、その呼びの epoch で数える（その後の判定は (a) に従う）", async () => {
    usePhaseStore.getState().resetForProject();
    const { hidden } = await resolveCodexForAi({
      entryIds: [KINDS.basePublicPhaseHidden],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    // index は空で n-s1 は読む順に無い：(a) で hidden。
    expect(hidden.has(KINDS.basePublicPhaseHidden)).toBe(true);
  });
});
