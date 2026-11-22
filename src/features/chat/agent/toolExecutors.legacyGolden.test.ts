// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-0：legacy（renderer 版）の read tool（M4 の 20 本）の特性試験。
 *
 * 目的：後続の PR が read 部分を共有 core へ移す（legacy の re-point）とき、legacy の結果が
 * 1 byte も変わらないことの oracle にする。golden は **未変更の legacy** から生成した
 * （`__fixtures__/legacyReadGolden/<tool>.golden.txt`。content と、model に渡る JSON の bytes）。
 *
 * 前提と覆えない範囲（PR 本文にも書く）：
 * - 実 sql.js（browser-mock）の `@/db/client` に対して `executeTool` を呼ぶ。`countTokens` は
 *   1 文字（UTF-16 の length）＝1 token に固定する（tokenizer の mode で golden が揺れない）。
 * - browser-mock では、fts は LIKE の arm、semantic 2 本は常に `[]`、foreshadow の
 *   `foreshadow_list_open_for_context` は Drizzle 側の分岐になる。Native 経路（fts／semantic 2 本／
 *   foreshadow／typed read）の **結果の同値は、後続の実 addon の spec（PR-9）の担当**。
 *   ここの golden は main の同値を示さない。Native 経路の呼び方（command・引数・scope）は
 *   `toolExecutors.legacyNativePort.test.ts` で固定する。
 * - dense の「行あり」は、`events_semantic_search`／`codex_semantic_search` にだけ canned の hit を
 *   返して作る（scenario 名に `canned` と付ける）。
 * - ORDER BY の無い SELECT（list_codex_by_type、find_related_entries、LIKE の arm）の並びは、
 *   sql.js の行の返り順に依存する（実 addon では異なりうる）。list_chapters／get_chapter_summaries の
 *   並びは tree の DFS（兄弟ごとの sortOrder、同順位は id）で、行の返り順に依存しない。
 * - archived（外部 Markdown のマウントでファイルの消失・重複により自動で soft delete された行）は、
 *   read tool 5 本と get_chapter_summaries が行単位（`archived_at IS NULL`）で除く。さらに
 *   list_plot_threads の sceneCount・phases、get_thread_scenes の branches（atNodeId）、
 *   get_foreshadow_detail の setups からも除く（DR-MP4-36）。祖先だけが
 *   archived の行は renderer の listNodes と同じく残る（seed の n-part2＞n-s5）。
 *
 * golden の再生成：該当 file を消して `pnpm exec vitest --run <この file>`（CI では書かれず落ちる）。
 * 再生成した差分は人が目で確認する。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { executeTool } from "./toolExecutors";
import {
  LEGACY_READ_CANNED_CODEX_HITS,
  LEGACY_READ_CANNED_EVENT_HITS,
} from "./__fixtures__/legacyReadSeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  runLegacyReadScenarios,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadScenario,
  type LegacyReadWorld,
} from "./legacyReadHarness.testSupport";
import { usePhaseStore } from "@/features/codex/phaseStore";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MAIN_S1: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s1" };
const MAIN_S3: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s3" };
const MAIN_NO_SCENE: LegacyReadWorld = { projectId: "p-main" };
const OTHER: LegacyReadWorld = { projectId: "p-other", activeSceneId: "x-s1" };
const EMPTY: LegacyReadWorld = { projectId: "p-empty" };
const BIG: LegacyReadWorld = { projectId: "p-big" };
const NO_PROJECT: LegacyReadWorld = { projectId: "" };

const sc = (
  name: string,
  world: LegacyReadWorld,
  params: Record<string, unknown> = {},
  extra: Partial<LegacyReadScenario> = {},
): LegacyReadScenario => ({ name, world, params, ...extra });

const goldenPath = (tool: string) =>
  `./__fixtures__/legacyReadGolden/${tool}.golden.txt`;

const cannedEvents = {
  events_semantic_search: () => LEGACY_READ_CANNED_EVENT_HITS,
};
const cannedCodex = {
  codex_semantic_search: () => LEGACY_READ_CANNED_CODEX_HITS,
};
const denseRejects = (cmd: string) => ({
  [cmd]: () => {
    throw new Error("dense unavailable");
  },
});

/** 本文を読む tool の題に入れる注記（main の core は barrier を持てないので同値試験の対象外）。 */
const BARRIER_NOTE: Record<string, string> = {
  get_scene:
    "barrier なし（awaitPendingSceneContentWrite は main で再現しない）",
  get_thread_scenes:
    "barrier なし（awaitPendingSceneContentWrite は main で再現しない）",
};

/** 20 本の scenario 表。tool 名 → scenario の並び（並びも golden の一部）。 */
const SCENARIOS: Record<string, readonly LegacyReadScenario[]> = {
  search_codex: [
    sc(
      "rows: 短い語 2 字（LIKE-OR の arm）。hidden の黒幕と幻の騎士は落ちる",
      MAIN_S1,
      { query: "魔法" },
    ),
    sc("rows: 3 字以上（fts_search の arm → id で Drizzle）", MAIN_S1, {
      query: "老魔術師",
    }),
    sc("rows: 前後の空白は trim される", MAIN_S1, { query: "  アリア  " }),
    sc("hidden: base が hidden の c-secret は結果に出ない", MAIN_S1, {
      query: "黒幕",
    }),
    sc("hidden: Phase 解除前（n-s1）は幻の騎士が出ない", MAIN_S1, {
      query: "騎士",
    }),
    sc(
      "hidden: Phase 解除後（n-s3）は幻の騎士が Phase 解決後の summary で出る",
      MAIN_S3,
      { query: "騎士" },
    ),
    sc(
      "canned dense: sparse と RRF 融合し、融合の後に hidden を落とす（S1）",
      MAIN_S1,
      { query: "魔法" },
      { native: cannedCodex },
    ),
    sc(
      "canned dense: Phase 解除後（S3）は幻の騎士が Phase 解決後の summary で残る",
      MAIN_S3,
      { query: "魔法" },
      { native: cannedCodex },
    ),
    sc(
      "canned dense: dense が reject しても sparse だけに退避する",
      MAIN_S1,
      { query: "魔法" },
      { native: denseRejects("codex_semantic_search") },
    ),
    sc("empty: 一致なし", MAIN_S1, { query: "存在しない語" }),
    sc("empty: 空の project", EMPTY, { query: "魔法" }),
    sc("XPROJ: 他 project では他 project の行だけ", OTHER, { query: "アリア" }),
    sc("XPROJ: main から他 project にしかない語は出ない", MAIN_S1, {
      query: "他作品",
    }),
    sc("no-project: 引数が有効でも No active project", NO_PROJECT, {
      query: "魔法",
    }),
    sc(
      "order: 空の query は no-project より先（0 entries found）",
      NO_PROJECT,
      { query: "" },
    ),
    sc("order: 空白だけの query も先に弾く", NO_PROJECT, { query: "   " }),
    sc("order: query 欠落（undefined）も先に弾く", NO_PROJECT, {}),
  ],
  search_events: [
    sc(
      "canned: S1 では secret の戦争（n-s3 で公開）と恒久秘匿の死が落ちる。DB に無い他 project の id は素通し",
      MAIN_S1,
      { query: "魔術" },
      { native: cannedEvents },
    ),
    sc(
      "canned: S3 では戦争が出る（恒久秘匿の死は出ない）",
      MAIN_S3,
      { query: "魔術" },
      { native: cannedEvents },
    ),
    sc(
      "canned: 場面なしでは secret を全部隠す（fail-closed）",
      MAIN_NO_SCENE,
      { query: "魔術" },
      { native: cannedEvents },
    ),
    sc(
      "canned: limit=2 で slice",
      MAIN_S3,
      { query: "魔術", limit: 2 },
      { native: cannedEvents },
    ),
    sc(
      "canned: limit が数でなければ 10",
      MAIN_S3,
      { query: "魔術", limit: "abc" },
      { native: cannedEvents },
    ),
    sc(
      "canned: dense が reject したら空配列に退避する",
      MAIN_S3,
      { query: "魔術" },
      { native: denseRejects("events_semantic_search") },
    ),
    sc("empty: browser-mock の dense は常に []", MAIN_S3, { query: "魔術" }),
    sc(
      "XPROJ: 他 project で canned の hit が main の event id を含んでも、他 project の年表に無い id は hidden 判定の対象外（素通し）",
      OTHER,
      { query: "出来事" },
      { native: cannedEvents },
    ),
    sc("no-project: 引数が有効でも No active project", NO_PROJECT, {
      query: "魔術",
    }),
    sc("order: 空の query は no-project より先（0 events found）", NO_PROJECT, {
      query: "",
    }),
  ],
  list_codex_by_type: [
    sc(
      "rows: character（S1。hidden の c-secret と c-released は落ちる）",
      MAIN_S1,
      { type: "character" },
    ),
    sc(
      "rows: character（S3。Phase 解除後の c-released が Phase 解決後の summary で出る）",
      MAIN_S3,
      { type: "character" },
    ),
    sc("rows: location", MAIN_S1, { type: "location" }),
    sc("rows: item（summary が null → 空文字、tags なし）", MAIN_S1, {
      type: "item",
    }),
    sc("empty: 行のない type", MAIN_S1, { type: "lore" }),
    sc("empty: type が欠落でも検査せず '' で引く", MAIN_S1, {}),
    sc("empty: 空の project", EMPTY, { type: "character" }),
    sc("XPROJ: 他 project は他 project の行だけ", OTHER, { type: "location" }),
    sc("no-project", NO_PROJECT, { type: "character" }),
    sc("order: type 欠落でも no-project が先に判定される", NO_PROJECT, {}),
  ],
  list_codex_tags: [
    sc(
      "rows: usageCount の降順（hidden の c-secret の分も数える）",
      MAIN_S1,
      {},
    ),
    sc(
      "rows: type=location（typeFilter が null か location を含む）",
      MAIN_S1,
      { type: "location" },
    ),
    sc("rows: type=character（場所タグは出ない）", MAIN_S1, {
      type: "character",
    }),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project は他 project のタグだけ", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
    sc("order: type 付きでも no-project が先", NO_PROJECT, {
      type: "location",
    }),
  ],
  search_codex_by_tags: [
    sc("rows: 1 タグ（hidden の c-secret は落ちる）", MAIN_S1, {
      tags: ["魔法"],
    }),
    sc("rows: 複数タグは和集合（distinct）", MAIN_S1, {
      tags: ["魔法", "場所"],
    }),
    sc("rows: 数値は文字列化される", MAIN_S1, { tags: ["魔法", 1] }),
    sc("empty: 紐づきのないタグ", MAIN_S1, { tags: ["未使用"] }),
    sc("empty: 空の project", EMPTY, { tags: ["魔法"] }),
    sc("XPROJ: 他 project は他 project の行だけ", OTHER, { tags: ["魔法"] }),
    sc("no-project", NO_PROJECT, { tags: ["魔法"] }),
    sc("order: 空配列は no-project より先（No tags provided）", NO_PROJECT, {
      tags: [],
    }),
    sc("order: 配列でない tags も先に弾く", NO_PROJECT, { tags: "魔法" }),
  ],
  find_related_entries: [
    sc(
      "rows: 起点 c-mage の name・aliases で LIKE（起点自身は除く）",
      MAIN_S1,
      { id: "c-mage" },
    ),
    sc("rows: type で絞る", MAIN_S1, { id: "c-mage", type: "location" }),
    sc("hidden: 起点が hidden なら存在しない id と同じ応答", MAIN_S1, {
      id: "c-secret",
    }),
    sc("hidden: Phase 解除後（n-s3）の c-released は起点にできる", MAIN_S3, {
      id: "c-released",
    }),
    sc("empty: 一致なし", MAIN_S1, { id: "c-item" }),
    sc("empty: 空の project", EMPTY, { id: "c-mage" }),
    sc("XPROJ: main から他 project の id を起点にできない", MAIN_S1, {
      id: "x-c-aria",
    }),
    sc("XPROJ: 他 project では他 project の行だけ", OTHER, { id: "x-c-aria" }),
    sc("no-project", NO_PROJECT, { id: "c-mage" }),
    sc("order: 空の id は no-project より先（No id provided）", NO_PROJECT, {
      id: "",
    }),
  ],
  list_chapters: [
    sc(
      "rows: folder と scene を読む順（tree の DFS。兄弟ごとの sortOrder）で出す。note は出ない。archived の場面・folder は出ない。祖先だけが archived の場面は DFS の外として末尾に出る",
      MAIN_S1,
      {},
    ),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project は他 project の folder と場面だけ", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
  ],
  get_scene: [
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: 本文を prosemirrorToText で返す",
      MAIN_S1,
      { id: "n-s1" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: 長い本文は切らない",
      MAIN_S1,
      { id: "n-s3" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）empty: archived（外部ファイルの消失）の場面は Scene not found",
      MAIN_S1,
      { id: "n-arch" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: 祖先の folder だけが archived の場面は読める（行単位の規則）",
      MAIN_S1,
      { id: "n-s5" },
    ),
    sc("empty: note は Scene not found", MAIN_S1, { id: "n-note1" }),
    sc("empty: folder は Scene not found", MAIN_S1, { id: "n-ch1" }),
    sc("empty: 存在しない id", MAIN_S1, { id: "n-none" }),
    sc("empty: 空の project", EMPTY, { id: "n-s1" }),
    sc("XPROJ: main から他 project の場面は読めない", MAIN_S1, { id: "x-s1" }),
    sc("XPROJ: 他 project では他 project の場面を読める", OTHER, {
      id: "x-s1",
    }),
    sc("no-project", NO_PROJECT, { id: "n-s1" }),
    sc("order: 空の id は no-project より先（No id provided）", NO_PROJECT, {
      id: "",
    }),
    sc("order: 空白だけの id も先に弾く", NO_PROJECT, { id: "  " }),
  ],
  search_scenes: [
    sc(
      "rows: 短い語 2 字（LIKE-OR の arm。archived の場面は出ない）",
      MAIN_S1,
      {
        query: "魔法",
      },
    ),
    sc(
      "rows: 3 字以上（fts_search の arm → id で Drizzle。長い本文は 200 字に切る。archived の場面は Drizzle の再取得で落ちる）",
      MAIN_S1,
      { query: "アリア" },
    ),
    sc(
      "empty: 3 字以上の語が archived の場面にだけ当たる（fts_search の hit は Drizzle の再取得で落ちて 0 件）",
      MAIN_S1,
      { query: "外部ファイル" },
    ),
    sc(
      "rows: 短い語 2 字（LIKE-OR の arm）。祖先の folder だけが archived の場面は出る",
      MAIN_S1,
      { query: "親が" },
    ),
    sc(
      "rows: 3 字以上（fts_search の arm）。祖先の folder だけが archived の場面は出る",
      MAIN_S1,
      { query: "親フォルダ" },
    ),
    sc("rows: タイトルの語", MAIN_S1, { query: "旅立ち" }),
    sc("empty: 一致なし", MAIN_S1, { query: "存在しない語" }),
    sc("empty: 空の project", EMPTY, { query: "魔法" }),
    sc("XPROJ: 他 project は他 project の場面だけ", OTHER, { query: "魔法" }),
    sc("XPROJ: main から他 project にしかない語は出ない", MAIN_S1, {
      query: "他作品",
    }),
    sc("no-project", NO_PROJECT, { query: "魔法" }),
    sc("order: 空の query は no-project より先（0 scenes found）", NO_PROJECT, {
      query: "",
    }),
  ],
  search_snippets: [
    sc("rows: 短い語 2 字（LIKE-OR の arm）", MAIN_S1, { query: "魔法" }),
    sc("rows: 3 字以上（fts_search の arm → id で Drizzle）", MAIN_S1, {
      query: "老魔術師",
    }),
    sc("empty: 一致なし", MAIN_S1, { query: "存在しない語" }),
    sc("empty: 空の project", EMPTY, { query: "魔法" }),
    sc("XPROJ: 他 project は他 project の行だけ", OTHER, { query: "魔法" }),
    sc("XPROJ: main から他 project にしかない語は出ない", MAIN_S1, {
      query: "他作品",
    }),
    sc("no-project", NO_PROJECT, { query: "魔法" }),
    sc(
      "order: 空の query は no-project より先（0 snippets found）",
      NO_PROJECT,
      { query: "" },
    ),
  ],
  get_chapter_summaries: [
    sc(
      "rows: 全階層の folder を DFS の読む順に章とし、直下の場面のうち synopsis が空でないものを並べる。synopsis が空の場面・archived の場面は出ない。archived の folder は章にならない",
      MAIN_S1,
      {},
    ),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
  ],
  list_open_foreshadows: [
    sc(
      "rows: secret=0・未回収・未放棄だけ（browser-mock では Drizzle 側の分岐）",
      MAIN_S1,
      {},
    ),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project は他 project の行だけ", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
  ],
  get_foreshadow_detail: [
    sc(
      "rows: 回収予定の場面あり・setup 3 件（orphan と AI 評価のみを含む）。archived の場面の setup は出ない（件数にも入らない）",
      MAIN_S1,
      { id: "fs-1" },
    ),
    sc("rows: secret の伏線も読める（secret の判定なし。DR-MP4-24）", MAIN_S1, {
      id: "fs-2",
    }),
    sc("rows: 回収済み", MAIN_S1, { id: "fs-3" }),
    sc("rows: setup なし・回収先なし（unset）", MAIN_S1, { id: "fs-5" }),
    sc("empty: 存在しない id", MAIN_S1, { id: "fs-none" }),
    sc("empty: 空の project", EMPTY, { id: "fs-1" }),
    sc("XPROJ: main から他 project の伏線は読めない", MAIN_S1, {
      id: "x-fs-1",
    }),
    sc("XPROJ: 他 project では他 project の伏線を読める", OTHER, {
      id: "x-fs-1",
    }),
    sc("no-project", NO_PROJECT, { id: "fs-1" }),
    sc("order: 空の id は no-project より先（No id provided）", NO_PROJECT, {
      id: "",
    }),
  ],
  get_scene_timeline_neighbors: [
    sc(
      "rows: 先頭の場面（previous なし、next は最大 3 件。archived の場面は候補にならない）",
      MAIN_S1,
      { sceneId: "n-s1" },
    ),
    sc("empty: archived の場面を起点にすると Scene not found", MAIN_S1, {
      sceneId: "n-arch",
    }),
    sc("rows: 中間の場面（作中順で前後）", MAIN_S1, { sceneId: "n-s3" }),
    sc("rows: 末尾に近い場面", MAIN_S1, { sceneId: "n-s2" }),
    sc("empty: storyTimeOrder の無い場面", MAIN_S1, { sceneId: "n-s4" }),
    sc("empty: 存在しない場面", MAIN_S1, { sceneId: "n-none" }),
    sc("empty: 空の project", EMPTY, { sceneId: "n-s1" }),
    sc("XPROJ: main から他 project の場面は Scene not found", MAIN_S1, {
      sceneId: "x-s1",
    }),
    sc("XPROJ: 他 project では他 project の場面", OTHER, { sceneId: "x-s1" }),
    sc("no-project", NO_PROJECT, { sceneId: "n-s1" }),
    sc(
      "order: 空の sceneId は no-project より先（No sceneId provided）",
      NO_PROJECT,
      { sceneId: "" },
    ),
  ],
  list_plot_threads: [
    sc(
      "rows: sortOrder 順・distinct な場面数・到達 phase。archived の場面に結ばれた link は数にも phase にも入らない",
      MAIN_S1,
      {},
    ),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project は他 project の筋だけ", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
  ],
  get_thread_scenes: [
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: phase 順・場面の dedup・excerpt・branch。archived の場面に結ばれた link と、archived の場面で合流する branch は出ない",
      MAIN_S1,
      { threadId: "th-main" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: branch の受け側",
      MAIN_S1,
      { threadId: "th-sub" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）empty: 場面に結ばれていない筋",
      MAIN_S1,
      { threadId: "th-empty" },
    ),
    sc(
      "barrier なし（awaitPendingSceneContentWrite は main で再現しない）rows: 9 場面に結ばれた筋は 8 場面で切る（sceneCount は 9）",
      BIG,
      { threadId: "th-big" },
    ),
    sc("empty: 存在しない id", MAIN_S1, { threadId: "th-none" }),
    sc("empty: 空の project", EMPTY, { threadId: "th-main" }),
    sc("XPROJ: main から他 project の筋は Thread not found", MAIN_S1, {
      threadId: "x-th-main",
    }),
    sc("XPROJ: 他 project では他 project の筋", OTHER, {
      threadId: "x-th-main",
    }),
    sc("no-project", NO_PROJECT, { threadId: "th-main" }),
    sc(
      "order: 空の threadId は no-project より先（No threadId provided）",
      NO_PROJECT,
      { threadId: "" },
    ),
  ],
  list_events: [
    sc(
      "rows: S1（secret の戦争と恒久秘匿の死は出ない。日付は暦で整形）",
      MAIN_S1,
      {},
    ),
    sc("rows: S3（戦争が出る）", MAIN_S3, {}),
    sc("rows: 場面なし（secret を全部隠す）", MAIN_NO_SCENE, {}),
    sc("rows: kind=birth", MAIN_S3, { kind: "birth" }),
    sc("rows: 知らない kind は絞らない", MAIN_S3, { kind: "bogus" }),
    sc("rows: UI 言語が en", { ...MAIN_S3, language: "en" }, {}),
    sc("empty: 空の project", EMPTY, {}),
    sc("XPROJ: 他 project は他 project の出来事だけ", OTHER, {}),
    sc("no-project", NO_PROJECT, {}),
    sc("order: kind 付きでも no-project が先（{events: []}）", NO_PROJECT, {
      kind: "birth",
    }),
  ],
  get_event_detail: [
    sc("rows: S1（戦争は hidden なので relation は出ない）", MAIN_S1, {
      eventId: "ev-meet",
    }),
    sc("rows: S3（戦争が見えるので relation も出る）", MAIN_S3, {
      eventId: "ev-meet",
    }),
    sc("rows: 場所・主役・暦整形済みの日付", MAIN_S3, { eventId: "ev-birth" }),
    sc(
      "rows: UI 言語が en",
      { ...MAIN_S3, language: "en" },
      { eventId: "ev-meet" },
    ),
    sc("hidden: S1 の secret（戦争）は存在しない扱い", MAIN_S1, {
      eventId: "ev-war",
    }),
    sc("hidden: S3 では戦争が見える", MAIN_S3, { eventId: "ev-war" }),
    sc("hidden: 恒久秘匿の死はどの場面でも存在しない扱い", MAIN_S3, {
      eventId: "ev-death",
    }),
    sc("empty: 存在しない id", MAIN_S3, { eventId: "ev-none" }),
    sc("empty: 空の project", EMPTY, { eventId: "ev-meet" }),
    sc("XPROJ: main から他 project の出来事は Event not found", MAIN_S3, {
      eventId: "x-ev-1",
    }),
    sc("XPROJ: 他 project では他 project の出来事", OTHER, {
      eventId: "x-ev-1",
    }),
    sc("no-project", NO_PROJECT, { eventId: "ev-meet" }),
    sc(
      "order: 引数の検査は no-project の後（空の eventId × no-project は No active project）",
      NO_PROJECT,
      { eventId: "" },
    ),
    sc("order: project があれば空の eventId は eventId is required", MAIN_S3, {
      eventId: "",
    }),
  ],
  get_character_timeline: [
    sc("rows: 主役 c-aria（誕生を基準に年齢を計算）", MAIN_S3, {
      codexId: "c-aria",
    }),
    sc("rows: 参加者 c-mage（S3。戦争を含む。恒久秘匿の死は出ない）", MAIN_S3, {
      codexId: "c-mage",
    }),
    sc("rows: S1 の c-mage（戦争は hidden）", MAIN_S1, { codexId: "c-mage" }),
    sc(
      "empty: 関与のない codex（名前の解決もなく id を character に）",
      MAIN_S3,
      { codexId: "c-item" },
    ),
    sc("empty: 空の project", EMPTY, { codexId: "c-aria" }),
    sc("XPROJ: main から他 project の codex id", MAIN_S3, {
      codexId: "x-c-aria",
    }),
    sc("XPROJ: 他 project は他 project の出来事だけ", OTHER, {
      codexId: "x-c-aria",
    }),
    sc("no-project", NO_PROJECT, { codexId: "c-aria" }),
    sc(
      "order: 引数の検査は no-project の後（空の codexId × no-project は No active project）",
      NO_PROJECT,
      { codexId: "" },
    ),
    sc("order: project があれば空の codexId は codexId is required", MAIN_S3, {
      codexId: "",
    }),
  ],
  get_chronicle_state: [
    sc(
      "rows: sceneId 指定（S1。hidden の secret は snapshot に入らない）",
      MAIN_S1,
      { sceneId: "n-s1" },
    ),
    sc("rows: sceneId 省略は activeSceneId（S3）", MAIN_S3, {}),
    sc("rows: sceneId 指定は activeSceneId より優先", MAIN_S3, {
      sceneId: "n-s1",
    }),
    sc("rows: UI 言語が en", { ...MAIN_S3, language: "en" }, {}),
    sc("empty: 場面なし・sceneId なし", MAIN_NO_SCENE, {}),
    sc("empty: 年表の出来事が無い project", EMPTY, { sceneId: "n-s1" }),
    sc("XPROJ: main から他 project の sceneId を指定", MAIN_S1, {
      sceneId: "x-s1",
    }),
    sc("XPROJ: 他 project では他 project の年表", OTHER, {}),
    sc("no-project", NO_PROJECT, { sceneId: "n-s1" }),
    sc(
      "order: sceneId 省略と場面なしでも no-project が先（No active project）",
      NO_PROJECT,
      {},
    ),
  ],
};

describe("legacy read tool の特性試験（実 sql.js の golden）", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  it("M4 の 20 本すべてに scenario がある", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      [
        "search_codex",
        "search_events",
        "list_codex_by_type",
        "list_codex_tags",
        "search_codex_by_tags",
        "find_related_entries",
        "list_chapters",
        "get_scene",
        "search_scenes",
        "list_plot_threads",
        "get_thread_scenes",
        "search_snippets",
        "get_chapter_summaries",
        "list_open_foreshadows",
        "get_foreshadow_detail",
        "get_scene_timeline_neighbors",
        "list_events",
        "get_event_detail",
        "get_character_timeline",
        "get_chronicle_state",
      ].sort(),
    );
  });

  for (const [tool, scenarios] of Object.entries(SCENARIOS)) {
    it(`${tool}：${BARRIER_NOTE[tool] ?? ""}golden（${scenarios.length} scenario。content と JSON の bytes）`, async () => {
      const doc = await runLegacyReadScenarios(tool, scenarios);
      // 自己検査：意図しない error（executor が例外を包んだ Error: の summary）が無く、
      // tokensUsed は固定した数え方（1 文字＝1 token）で contentJson の長さと一致する。
      expect(doc).not.toMatch(/"summary": "Error:/);
      expect(doc).not.toMatch(/"error":/);
      const parsed = JSON.parse(doc) as {
        cases: Array<{ result: { tokensUsed: number }; contentJson: string }>;
      };
      for (const c of parsed.cases) {
        if (c.result.tokensUsed === 0) continue;
        expect(c.result.tokensUsed).toBe(c.contentJson.length);
      }
      await expect(doc).toMatchFileSnapshot(goldenPath(tool));
    });
  }
});

describe("legacy の事実の固定（DB の制約・空 project）", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  it("tree_nodes.node_type の CHECK は folder／scene／note だけ（'chapter'／'part' は作れない。list_chapters／get_chapter_summaries は folder を章として読む）", async () => {
    await expect(
      invoke("db_execute", {
        sql: "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES ('n-chapter', 'p-main', 'chapter', '章', 'z0', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        params: [],
        method: "run",
      }),
    ).rejects.toThrow();
    const found = await invoke<{ rows: unknown[] }>("db_execute", {
      sql: "SELECT id FROM tree_nodes WHERE id = 'n-chapter'",
      params: [],
      method: "all",
    });
    expect(found.rows).toHaveLength(0);
  });

  it("seed の p-empty は行を持たない（空の結果は空 project への切替で作る）", async () => {
    for (const table of [
      "tree_nodes",
      "codex_entries",
      "codex_tags",
      "snippets",
      "plot_threads",
      "foreshadows",
      "events",
    ]) {
      const found = await invoke<{ rows: Array<Record<string, unknown>> }>(
        "db_execute",
        {
          sql: `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = 'p-empty'`,
          params: [],
          method: "all",
        },
      );
      expect(Number(Object.values(found.rows[0] ?? {})[0]), table).toBe(0);
    }
  });
});

describe("store の読取り位置の固定（legacy は await の後で読む）", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  /** 最初の特定の command が呼ばれた瞬間に場面を書き換える hook。 */
  function switchSceneOn(cmd: string, sceneId: string): void {
    let done = false;
    legacyReadInvokeBridge.setOnCall(({ cmd: called }) => {
      if (!done && called === cmd) {
        done = true;
        useTreeStore.setState({ activeSceneId: sceneId });
      }
    });
  }

  it("get_thread_scenes：本文の一括読みの失敗は legacy の port が握り、空の excerpt で成功する（core は握らない。DR-MP4-32b）", async () => {
    await setLegacyReadWorld(MAIN_S1);
    const treeApi = await import("@/features/tree/api");
    const spy = vi
      .spyOn(treeApi, "loadSceneContents")
      .mockRejectedValueOnce(new Error("body store down"));
    try {
      const result = await executeTool("get_thread_scenes", "c", {
        threadId: "th-main",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
      const scenes = (result.content as { scenes: Array<{ excerpt: string }> })
        .scenes;
      expect(scenes.length).toBeGreaterThan(0);
      for (const scene of scenes) expect(scene.excerpt).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("search_events：現在の場面は dense の await の後で読む（dense の最中に n-s3 へ切り替えると戦争が見える）", async () => {
    await setLegacyReadWorld(MAIN_S1);
    legacyReadInvokeBridge.override(
      "events_semantic_search",
      () => LEGACY_READ_CANNED_EVENT_HITS,
    );
    switchSceneOn("events_semantic_search", "n-s3");
    const result = await executeTool("search_events", "c", { query: "魔術" });
    const ids = (result.content as Array<{ eventId: string }>).map(
      (e) => e.eventId,
    );
    expect(ids).toContain("ev-war");
  });

  it("search_events：読む順（store の nodes）も dense の await の後で読む（最中に nodes を空にすると secret は全部 hidden）", async () => {
    await setLegacyReadWorld(MAIN_S3);
    legacyReadInvokeBridge.override(
      "events_semantic_search",
      () => LEGACY_READ_CANNED_EVENT_HITS,
    );
    legacyReadInvokeBridge.setOnCall(({ cmd }) => {
      if (cmd === "events_semantic_search") {
        useTreeStore.setState({ nodes: [] });
      }
    });
    const result = await executeTool("search_events", "c", { query: "魔術" });
    const ids = (result.content as Array<{ eventId: string }>).map(
      (e) => e.eventId,
    );
    expect(ids).not.toContain("ev-war");
    expect(ids).toContain("ev-meet");
  });

  it("search_codex：hidden 判定の場面は sparse・dense の await の後で読む（dense の最中に n-s3 へ切り替えると幻の騎士が出る）", async () => {
    await setLegacyReadWorld(MAIN_S1);
    legacyReadInvokeBridge.override(
      "codex_semantic_search",
      () => LEGACY_READ_CANNED_CODEX_HITS,
    );
    switchSceneOn("codex_semantic_search", "n-s3");
    const result = await executeTool("search_codex", "c", { query: "魔法" });
    const ids = (result.content as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain("c-released");
  });

  it("list_codex_by_type：hidden 判定の場面は DB の読みの後で読む", async () => {
    await setLegacyReadWorld(MAIN_S1);
    let switched = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !switched &&
        cmd === "db_execute" &&
        /from "codex_entries"/iu.test(String(args?.sql))
      ) {
        switched = true;
        useTreeStore.setState({ activeSceneId: "n-s3" });
      }
    });
    const result = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    const ids = (result.content as Array<{ id: string }>).map((e) => e.id);
    expect(switched).toBe(true);
    expect(ids).toContain("c-released");
  });

  it("list_events：現在の場面は events の読み（getSharedEvents）の後で読む", async () => {
    await setLegacyReadWorld(MAIN_S1);
    let switched = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !switched &&
        cmd === "db_execute" &&
        /from "events"/iu.test(String(args?.sql))
      ) {
        switched = true;
        useTreeStore.setState({ activeSceneId: "n-s3" });
      }
    });
    const result = await executeTool("list_events", "c", {});
    const ids = (
      result.content as { events: Array<{ id: string }> }
    ).events.map((e) => e.id);
    expect(switched).toBe(true);
    expect(ids).toContain("ev-war");
  });

  it("list_events：現在の場面は scene_events の読みの前に読み終える（その最中の切替は反映されない）", async () => {
    await setLegacyReadWorld(MAIN_S1);
    let switched = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !switched &&
        cmd === "db_execute" &&
        /from "scene_events"/iu.test(String(args?.sql))
      ) {
        switched = true;
        useTreeStore.setState({ activeSceneId: "n-s3" });
      }
    });
    const result = await executeTool("list_events", "c", {});
    const ids = (
      result.content as { events: Array<{ id: string }> }
    ).events.map((e) => e.id);
    expect(switched).toBe(true);
    expect(ids).not.toContain("ev-war");
  });

  it("projectId は呼出しの冒頭で 1 回だけ読む（最初の invoke で store の project を他 project に切り替えても、結果は変わらない）", async () => {
    const calls: Array<[string, Record<string, unknown>, LegacyReadWorld]> = [
      ["search_codex", { query: "魔法" }, MAIN_S1],
      ["search_events", { query: "魔術" }, MAIN_S3],
      ["list_chapters", {}, MAIN_S1],
      ["get_scene", { id: "n-s1" }, MAIN_S1],
      ["list_codex_by_type", { type: "character" }, MAIN_S1],
      ["list_codex_tags", {}, MAIN_S1],
      ["search_codex_by_tags", { tags: ["魔法"] }, MAIN_S1],
      ["find_related_entries", { id: "c-mage" }, MAIN_S1],
      ["search_scenes", { query: "魔法" }, MAIN_S1],
      ["search_snippets", { query: "魔法" }, MAIN_S1],
      ["get_chapter_summaries", {}, MAIN_S1],
      ["get_foreshadow_detail", { id: "fs-1" }, MAIN_S1],
      ["get_scene_timeline_neighbors", { sceneId: "n-s3" }, MAIN_S1],
      ["list_plot_threads", {}, MAIN_S1],
      ["get_thread_scenes", { threadId: "th-main" }, MAIN_S1],
      ["list_events", {}, MAIN_S3],
      ["get_event_detail", { eventId: "ev-meet" }, MAIN_S3],
      ["get_character_timeline", { codexId: "c-aria" }, MAIN_S3],
      ["get_chronicle_state", {}, MAIN_S3],
      ["list_open_foreshadows", {}, MAIN_S1],
    ];
    // dense の最中に切り替えても結果が変わらないことを見るため、dense には canned の hit を返す。
    const armDense = () => {
      legacyReadInvokeBridge.reset();
      legacyReadInvokeBridge.override(
        "codex_semantic_search",
        () => LEGACY_READ_CANNED_CODEX_HITS,
      );
      legacyReadInvokeBridge.override(
        "events_semantic_search",
        () => LEGACY_READ_CANNED_EVENT_HITS,
      );
    };
    for (const [tool, params, world] of calls) {
      await setLegacyReadWorld(world);
      armDense();
      const baseline = await executeTool(tool, "c", params);
      await setLegacyReadWorld(world);
      armDense();
      let switched = false;
      legacyReadInvokeBridge.setOnCall(() => {
        if (!switched) {
          switched = true;
          useTreeStore.setState({ projectId: "p-other" });
        }
      });
      const result = await executeTool(tool, "c", params);
      legacyReadInvokeBridge.reset();
      expect(switched, tool).toBe(true);
      expect(JSON.stringify(result), tool).toBe(JSON.stringify(baseline));
    }
  });
});
