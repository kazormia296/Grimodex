// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-8b：Codex の hidden を通る read tool 4 本（search_codex・list_codex_by_type・
 * search_codex_by_tags・find_related_entries）の、PR-0 の golden が覆わない legacy の挙動の特性試験。
 * **共有 core へ移す前に未変更の legacy で通し、移した後も無変更で通る**ことが「結果を 1 byte も
 * 変えない」の証拠になる（DR-MP4-40）。基準は DR-MP4-41 の後の挙動（場面を解決できないときは、
 * Phase が hidden にする項目を hidden に倒す）。
 *
 * 実 sql.js（browser-mock）の `@/db/client` に、PR-0 の seed（`legacyReadSeed.ts`。触らない）と、この
 * file の中で足す行（entry・tag・Phase）を入れ、`executeTool` で 4 本を呼ぶ。
 *
 * 固定するもの：
 * - （送った呼出しの列の固定は、seed だけの world で流す必要があるので `toolExecutors.codexCalls.test.ts`。）
 * - store の読取り位置：search_codex_by_tags・find_related_entries（起点の判定と結果落としの 2 回）で、
 *   DB の最中に場面を切り替える。起点が無いとき場面は読まない。
 * - Phase の解決：reading・story・auto、base 公開を Phase が hidden にする、場面が null・空・空白だけ・
 *   読む順に無い id・前後に空白（DR-MP4-41）。
 * - scope あり（projectId は store、場面は scope）・なし（store の activeSceneId）。
 * - 判定の途中で project が切り替わると、全部 hidden（DR-MP4-41 (b)）。tool 自身の DB の最中の切替は
 *   (b) の前に済むので、(a) に従う。
 * - dense の hit が DB に無い id（hidden）、cut の位置に hidden が居て 20 件に満たない、dense の summary が
 *   released でない項目でそのまま出る、LIKE の arm の limit 20、fts が 0 件なら entries を読まない。
 * - find_related_entries：aliases の壊れた JSON・非配列・非文字列、terms が空、type の trim、limit 20。
 *
 * 固定しないもの：scope があるときの `getState` の呼出し回数（移す前後で値が変わる）。
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
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { executeReadOnlyTool, executeTool } from "./toolExecutors";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadWorld,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const T0 = "2026-01-01T00:00:00.000Z";
const EMPTY_DOC = '{"type":"doc","content":[]}';
const runSql = (sql: string, params: unknown[]) =>
  invoke("db_execute", { sql, params, method: "run" });

/** この file が seed（p-main）の上に足す entry。他の file の seed・golden には触れない。 */
interface ExtraEntry {
  readonly id: string;
  readonly type?: string;
  readonly name: string;
  readonly aliases?: string | null;
  readonly summary?: string | null;
  readonly tags?: string | null;
  readonly mode?: string;
  readonly tag?: string;
}

const EXTRA_ENTRIES: readonly ExtraEntry[] = [
  // base 公開。Phase が n-s2 から hidden にする（reading では s2 で隠れ、s1 では出る）。魔法タグ。
  {
    id: "cx-late",
    name: "遅れの客",
    summary: "老魔術師の客",
    tags: '[{"name":"魔法","color":null}]',
    tag: "t-magic",
  },
  // base 公開。Phase が n-s3 から hidden にする（読む順で s2 の後ろ、物語時間では s2 の前）。
  { id: "cx-story", name: "物語の客", summary: "物語時間の例" },
  // find_related の起点。Phase が n-s2 から hidden にする。
  { id: "cx-src", name: "起点甲", summary: "起点の要約" },
  { id: "cx-rel-a", name: "友人", summary: "起点甲の友" },
  // 関連の 1 件。Phase が n-s2 から hidden にする。
  { id: "cx-rel-hid", name: "影", summary: "起点甲の影" },
  // aliases の癖。
  {
    id: "cx-alias-broken",
    name: "壊れた別名",
    aliases: "not json{",
  },
  { id: "cx-alias-obj", name: "別名が非配列", aliases: '{"a":1}' },
  {
    id: "cx-alias-mixed",
    name: "別名に混在",
    aliases: '["別名甲", 5, null, "", "  ", "別名乙"]',
  },
  { id: "cx-noname", name: "   ", aliases: null },
];

/** limit 20 を超える LIKE の arm 用。type は lore（seed では 0 件の type）。 */
const STELE_COUNT = 22;
const steleId = (n: number) => `cx-stele-${String(n).padStart(2, "0")}`;

const EXTRA_PHASES: ReadonlyArray<{
  id: string;
  entry: string;
  anchor: string;
  mode: string;
  at: string;
}> = [
  {
    id: "ph-late-hide-s2",
    entry: "cx-late",
    anchor: "n-s2",
    mode: "hidden",
    at: "2026-01-01T00:00:01.000Z",
  },
  {
    id: "ph-story-hide-s3",
    entry: "cx-story",
    anchor: "n-s3",
    mode: "hidden",
    at: "2026-01-01T00:00:02.000Z",
  },
  {
    id: "ph-src-hide-s2",
    entry: "cx-src",
    anchor: "n-s2",
    mode: "hidden",
    at: "2026-01-01T00:00:03.000Z",
  },
  {
    id: "ph-relhid-hide-s2",
    entry: "cx-rel-hid",
    anchor: "n-s2",
    mode: "hidden",
    at: "2026-01-01T00:00:04.000Z",
  },
];

async function insertEntry(entry: ExtraEntry): Promise<void> {
  await runSql(
    "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, tags_cache, context_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      entry.id,
      "p-main",
      entry.type ?? "character",
      entry.name,
      entry.aliases ?? null,
      entry.summary ?? null,
      EMPTY_DOC,
      entry.tags ?? null,
      entry.mode ?? "mentioned",
      T0,
      T0,
    ],
  );
  if (entry.tag) {
    await runSql(
      "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES (?, ?)",
      [entry.id, entry.tag],
    );
  }
}

beforeAll(async () => {
  setLegacyReadWorkspaceIdentity();
  await seedLegacyReadFixture();
  for (const entry of EXTRA_ENTRIES) await insertEntry(entry);
  for (let n = 1; n <= STELE_COUNT; n++) {
    await insertEntry({
      id: steleId(n),
      type: "lore",
      name: `石碑${String(n).padStart(2, "0")}`,
      summary: `石碑の要約 ${n}`,
    });
  }
  // find_related の LIKE の arm（limit 20）の起点。name に「石碑」だけを持つ。
  await insertEntry({ id: "cx-stele-src", type: "lore", name: "石碑" });
  for (const p of EXTRA_PHASES) {
    await runSql(
      "INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [p.id, p.entry, p.anchor, p.id, null, null, p.mode, p.at, p.at],
    );
  }
});

beforeEach(() => {
  setLegacyReadWorkspaceIdentity();
  legacyReadInvokeBridge.reset();
});

/** world を揃える。`listNodes` の読みは記録に残さない（呼出しの列は tool が送ったものだけ）。 */
async function setWorld(world: LegacyReadWorld): Promise<void> {
  await setLegacyReadWorld(world);
  legacyReadInvokeBridge.reset();
}

const MAIN_S1: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s1" };
const MAIN_S2: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s2" };
const MAIN_S3: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s3" };

type Result = Awaited<ReturnType<typeof executeTool>>;
const run = (
  tool: string,
  params: Record<string, unknown>,
  context?: Parameters<typeof executeTool>[4],
): Promise<Result> => executeTool(tool, "call-1", params, undefined, context);
const idsOf = (result: Result): string[] =>
  (result.content as Array<{ id: string }>).map((row) => row.id);

/** 最初に sql が pattern に当たる db_execute が呼ばれた瞬間に、store を書き換える hook。 */
function onFirstSql(
  pattern: RegExp,
  action: () => void,
  nth = 1,
): { readonly fired: () => number } {
  let seen = 0;
  let fired = 0;
  legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
    if (cmd !== "db_execute" || !pattern.test(String(args?.["sql"]))) return;
    seen += 1;
    if (seen === nth) {
      fired += 1;
      action();
    }
  });
  return { fired: () => fired };
}

const switchScene = (sceneId: string | null) => () =>
  useTreeStore.setState({ activeSceneId: sceneId as string });

// ---------------------------------------------------------------------------
// 2. store の読取り位置
// ---------------------------------------------------------------------------

describe("store の読取り位置（場面は DB と dense の await の後で読む）", () => {
  it("search_codex_by_tags：場面はタグの join の DB の読みの後で読む（最中に n-s2 へ切り替えると、n-s2 から hidden の cx-late が落ちる）", async () => {
    await setWorld(MAIN_S1);
    const control = await run("search_codex_by_tags", { tags: ["魔法"] });
    expect(idsOf(control)).toContain("cx-late");
    await setWorld(MAIN_S1);
    const hook = onFirstSql(/codex_entry_tags/iu, switchScene("n-s2"));
    const switched = await run("search_codex_by_tags", { tags: ["魔法"] });
    expect(hook.fired()).toBe(1);
    expect(idsOf(switched)).not.toContain("cx-late");
    expect(idsOf(switched)).toContain("c-aria");
  });

  it("list_codex_by_type：場面は DB の読みの後で読む（最中に n-s2 へ切り替えると cx-late が落ちる）", async () => {
    await setWorld(MAIN_S1);
    expect(
      idsOf(await run("list_codex_by_type", { type: "character" })),
    ).toContain("cx-late");
    await setWorld(MAIN_S1);
    const hook = onFirstSql(/from "codex_entries"/iu, switchScene("n-s2"));
    const switched = await run("list_codex_by_type", { type: "character" });
    expect(hook.fired()).toBe(1);
    expect(idsOf(switched)).not.toContain("cx-late");
  });

  it("find_related_entries：起点の判定の場面は起点の select の後で読む（最中に n-s2 へ切り替えると、n-s2 から hidden の起点は Entry not found）", async () => {
    await setWorld(MAIN_S1);
    const control = await run("find_related_entries", { id: "cx-src" });
    expect(idsOf(control)).toEqual(["cx-rel-a", "cx-rel-hid"]);
    await setWorld(MAIN_S1);
    const hook = onFirstSql(
      /"codex_entries"\."id" = \?/iu,
      switchScene("n-s2"),
    );
    const switched = await run("find_related_entries", { id: "cx-src" });
    expect(hook.fired()).toBe(1);
    expect(switched.summary).toBe("Entry not found");
    expect(switched.content).toEqual([]);
  });

  it("find_related_entries：結果を落とす場面は、関連の select の後に読み直す（起点の判定は n-s1 のまま。最中に n-s2 へ切り替えると cx-rel-hid だけが落ちる）", async () => {
    await setWorld(MAIN_S1);
    // 起点は c-mage（Phase なし）。cx-rel-hid は c-mage に関連しないので、起点 cx-src の関連で見る：
    // 起点 cx-src は n-s2 から hidden だが、起点の判定は n-s1 で済んでいる。
    const hook = onFirstSql(/like/iu, switchScene("n-s2"));
    const switched = await run("find_related_entries", { id: "cx-src" });
    expect(hook.fired()).toBe(1);
    expect(idsOf(switched)).toEqual(["cx-rel-a"]);
    expect(switched.summary).toBe("1 related to 起点甲");
  });

  it("search_codex：場面は dense の await の後で読む（dense の最中に n-s2 へ切り替えると cx-late が落ちる）", async () => {
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    expect(idsOf(await run("search_codex", { query: "遅れの客" }))).toContain(
      "cx-late",
    );
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    let fired = 0;
    legacyReadInvokeBridge.setOnCall(({ cmd }) => {
      if (cmd === "codex_semantic_search" && fired === 0) {
        fired += 1;
        useTreeStore.setState({ activeSceneId: "n-s2" });
      }
    });
    const switched = await run("search_codex", { query: "遅れの客" });
    expect(fired).toBe(1);
    expect(idsOf(switched)).not.toContain("cx-late");
  });

  it("find_related_entries：起点が存在しない id のときは、場面を読まず、判定の SQL も打たない（store は project の 1 回だけ。SQL は起点の select 1 本）", async () => {
    await setWorld(MAIN_S1);
    const spy = vi.spyOn(useTreeStore, "getState");
    legacyReadInvokeBridge.reset();
    const result = await run("find_related_entries", { id: "nope" });
    const getStateCalls = spy.mock.calls.length;
    spy.mockRestore();
    expect(result.summary).toBe("Entry not found");
    expect(getStateCalls).toBe(1);
    const sql = legacyReadInvokeBridge
      .calls("db_execute")
      .map((call) => String(call.args?.["sql"]));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^select \* ?|^select "id"/iu);
  });

  it("4 本とも、project の 1 回と場面の読みだけで store を読む（既定の経路：search_codex・list・tags は 2 回、find_related は 3 回。起点が hidden でも 2 回）", async () => {
    const counts: Record<string, number> = {};
    const cases: Array<[string, Record<string, unknown>]> = [
      ["search_codex", { query: "老魔術師" }],
      ["list_codex_by_type", { type: "location" }],
      ["search_codex_by_tags", { tags: ["魔法"] }],
      ["find_related_entries", { id: "c-mage" }],
      ["find_related_entries (hidden 起点)", { id: "c-secret" }],
    ];
    for (const [label, params] of cases) {
      await setWorld(MAIN_S1);
      const spy = vi.spyOn(useTreeStore, "getState");
      await run(label.split(" ")[0]!, params);
      counts[label] = spy.mock.calls.length;
      spy.mockRestore();
    }
    expect(counts).toEqual({
      search_codex: 2,
      list_codex_by_type: 2,
      search_codex_by_tags: 2,
      find_related_entries: 3,
      "find_related_entries (hidden 起点)": 2,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Phase の解決
// ---------------------------------------------------------------------------

describe("Phase の解決（reading・story・auto、場面が解決できないとき）", () => {
  const listCharacters = async (world: LegacyReadWorld) => {
    await setWorld(world);
    return idsOf(await run("list_codex_by_type", { type: "character" }));
  };

  it("reading：base 公開で Phase が n-s2 から hidden にする cx-late は、n-s1 で出て n-s2・n-s3 で落ちる。base hidden の c-released は n-s3 で出る", async () => {
    const s1 = await listCharacters(MAIN_S1);
    const s2 = await listCharacters(MAIN_S2);
    const s3 = await listCharacters(MAIN_S3);
    expect(s1).toContain("cx-late");
    expect(s2).not.toContain("cx-late");
    expect(s3).not.toContain("cx-late");
    expect(s1).not.toContain("c-released");
    expect(s2).not.toContain("c-released");
    expect(s3).toContain("c-released");
    expect(s1).toContain("c-aria");
  });

  it("n-s3 の Phase が hidden にする cx-story：reading では n-s2 で出る（n-s3 は n-s2 の後ろ）、story では n-s2 で落ちる（物語時間で n-s3 が先）。auto は seed の全場面に物語時間が無いので reading に退く", async () => {
    const reading = await listCharacters({
      ...MAIN_S2,
      resolutionMode: "reading",
    });
    const story = await listCharacters({ ...MAIN_S2, resolutionMode: "story" });
    const auto = await listCharacters({ ...MAIN_S2, resolutionMode: "auto" });
    expect(reading).toContain("cx-story");
    expect(story).not.toContain("cx-story");
    expect(auto).toContain("cx-story");
  });

  it("場面が null・空・空白だけ・読む順に無い id のとき、Phase が hidden にする項目は hidden に倒す。Phase を持たない項目と、base hidden が Phase で解除される c-released は、結果が変わる（DR-MP4-41）", async () => {
    for (const sceneId of [null, "", "   ", "n-not-in-index"]) {
      await setWorld(MAIN_S1);
      useTreeStore.setState({ activeSceneId: sceneId as string });
      const ids = idsOf(await run("list_codex_by_type", { type: "character" }));
      expect(ids, String(sceneId)).toContain("c-aria");
      expect(ids, String(sceneId)).not.toContain("cx-late");
      expect(ids, String(sceneId)).not.toContain("cx-story");
      expect(ids, String(sceneId)).not.toContain("c-released");
      expect(ids, String(sceneId)).not.toContain("c-secret");
    }
  });

  it("前後に空白のある activeSceneId は trim されて n-s2 になる", async () => {
    await setWorld(MAIN_S1);
    useTreeStore.setState({ activeSceneId: "  n-s2  " });
    const ids = idsOf(await run("list_codex_by_type", { type: "character" }));
    expect(ids).not.toContain("cx-late");
    expect(ids).toContain("c-aria");
  });

  it("4 本とも同じ判定を通る：n-s2 では cx-late が search_codex・tags・find_related（起点 c-mage）のどれにも出ない", async () => {
    await setWorld(MAIN_S2);
    expect(idsOf(await run("search_codex", { query: "遅れの客" }))).toEqual([]);
    expect(
      idsOf(await run("search_codex_by_tags", { tags: ["魔法"] })),
    ).not.toContain("cx-late");
    expect(
      idsOf(await run("find_related_entries", { id: "c-mage" })),
    ).not.toContain("cx-late");
    await setWorld(MAIN_S1);
    expect(
      idsOf(await run("find_related_entries", { id: "c-mage" })),
    ).toContain("cx-late");
  });

  it("find_related_entries の起点：Phase が n-s2 から hidden にする起点は、n-s1 では使え、n-s2 と場面なしでは Entry not found（存在しない id と同じ応答）", async () => {
    await setWorld(MAIN_S1);
    expect((await run("find_related_entries", { id: "cx-src" })).summary).toBe(
      "2 related to 起点甲",
    );
    for (const world of [MAIN_S2, { projectId: "p-main" }]) {
      await setWorld(world);
      const result = await run("find_related_entries", { id: "cx-src" });
      expect(result.summary).toBe("Entry not found");
      expect(result.content).toEqual([]);
      expect(result.tokensUsed).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. scope
// ---------------------------------------------------------------------------

describe("scope あり（projectId は store、場面は scope）／なし（store の activeSceneId）", () => {
  const SCOPE_S3 = { scope: { projectId: "p-other", currentSceneId: "n-s3" } };
  const SCOPE_NULL = { scope: { projectId: "p-other", currentSceneId: null } };

  it("scope の場面が使われ、store の場面は無視される。projectId は scope でなく store（p-main の行が出る）", async () => {
    await setWorld(MAIN_S1);
    for (const [tool, params] of [
      ["list_codex_by_type", { type: "character" }],
      ["search_codex_by_tags", { tags: ["魔法"] }],
      ["find_related_entries", { id: "c-mage" }],
    ] as const) {
      const plain = idsOf(await run(tool, params));
      const scoped = idsOf(await run(tool, params, SCOPE_S3));
      // n-s1 では cx-late が出る。scope の n-s3 では落ちる（n-s2 から hidden）。
      expect(plain, tool).toContain("cx-late");
      expect(scoped, tool).not.toContain("cx-late");
      expect(scoped, tool).toContain(
        tool === "find_related_entries" ? "c-aria" : "c-aria",
      );
    }
    // c-released は n-s3 の Phase で解除される（store は n-s1 なので scope なしでは出ない）。
    expect(
      idsOf(await run("list_codex_by_type", { type: "character" })),
    ).not.toContain("c-released");
    expect(
      idsOf(await run("list_codex_by_type", { type: "character" }, SCOPE_S3)),
    ).toContain("c-released");
  });

  it("scope の場面が null なら base（場面なし）で、Phase が hidden にする項目は hidden。store の場面は読まない", async () => {
    await setWorld(MAIN_S1);
    const ids = idsOf(
      await run("list_codex_by_type", { type: "character" }, SCOPE_NULL),
    );
    expect(ids).toContain("c-aria");
    expect(ids).not.toContain("cx-late");
  });

  it("search_codex も scope の場面を dense の後に使い、projectId は store。呼出しの途中で store の場面を変えても見ない", async () => {
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    let fired = 0;
    legacyReadInvokeBridge.setOnCall(({ cmd }) => {
      if (cmd === "codex_semantic_search" && fired === 0) {
        fired += 1;
        useTreeStore.setState({ activeSceneId: "n-s3" });
      }
    });
    const result = await run(
      "search_codex",
      { query: "遅れの客" },
      {
        scope: { projectId: "p-other", currentSceneId: "n-s1" },
      },
    );
    expect(fired).toBe(1);
    // scope の n-s1 のまま（store を n-s3 に動かしても cx-late は出る）。
    expect(idsOf(result)).toContain("cx-late");
  });

  it("scope は read-only 経路（executeReadOnlyTool）でも同じ", async () => {
    await setWorld(MAIN_S1);
    const result = await executeReadOnlyTool(
      "list_codex_by_type",
      "c",
      { type: "character" },
      SCOPE_S3.scope ? { scope: SCOPE_S3.scope } : undefined,
    );
    const ids = (result.content as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("c-released");
    expect(ids).not.toContain("cx-late");
  });

  it("scope があっても project が store に無ければ No active project（scope の projectId は使わない）", async () => {
    await setWorld({ projectId: "" });
    for (const [tool, params] of [
      ["search_codex", { query: "魔法" }],
      ["list_codex_by_type", { type: "character" }],
      ["search_codex_by_tags", { tags: ["魔法"] }],
      ["find_related_entries", { id: "c-mage" }],
    ] as const) {
      const result = await run(tool, params, SCOPE_S3);
      expect(result.summary, tool).toBe("No active project");
      expect(result.content, tool).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 判定の途中の project の切替（DR-MP4-41 (b)）
// ---------------------------------------------------------------------------

describe("判定の途中で project が切り替わったら、全部 hidden（DR-MP4-41 (b)）", () => {
  const TOOLS: Array<[string, Record<string, unknown>]> = [
    ["search_codex", { query: "老魔術師" }],
    ["list_codex_by_type", { type: "character" }],
    ["search_codex_by_tags", { tags: ["魔法"] }],
    ["find_related_entries", { id: "c-mage" }],
  ];
  const reset = () => usePhaseStore.getState().resetForProject();

  it("制御：切り替えが無ければ、どの tool も結果がある", async () => {
    for (const [tool, params] of TOOLS) {
      await setWorld(MAIN_S1);
      expect(idsOf(await run(tool, params)).length, tool).toBeGreaterThan(0);
    }
  });

  it("判定の entries の読みの最中に切り替えると、全部 hidden（結果は空。find_related は起点が hidden で Entry not found）", async () => {
    for (const [tool, params] of TOOLS) {
      await setWorld(MAIN_S1);
      const hook = onFirstSql(
        /select "id", "summary", "context_mode"/iu,
        reset,
      );
      const result = await run(tool, params);
      expect(hook.fired(), tool).toBe(1);
      expect(result.content, tool).toEqual([]);
      if (tool === "find_related_entries") {
        expect(result.summary).toBe("Entry not found");
      }
    }
  });

  it("判定の phases の読みの最中に切り替えても、全部 hidden", async () => {
    for (const [tool, params] of TOOLS) {
      await setWorld(MAIN_S1);
      const hook = onFirstSql(/from "codex_entry_phases"/iu, reset);
      const result = await run(tool, params);
      expect(hook.fired(), tool).toBe(1);
      expect(result.content, tool).toEqual([]);
    }
  });

  it("find_related_entries：結果の判定（2 回目）の phases の最中に切り替えると、起点は通って、関連が全部落ちる（0 related）", async () => {
    await setWorld(MAIN_S1);
    const hook = onFirstSql(/from "codex_entry_phases"/iu, reset, 2);
    const result = await run("find_related_entries", { id: "c-mage" });
    expect(hook.fired()).toBe(1);
    expect(result.content).toEqual([]);
    expect(result.summary).toBe("0 related to 老魔術師");
  });

  it("tool 自身の DB の読みの最中の切替は、判定の前に済むので (b) の対象でなく、その後の判定は (a) に従う（index が空で場面が読む順に無い：Phase が hidden にする項目は hidden、Phase を持たない公開の項目は残る）", async () => {
    await setWorld(MAIN_S1);
    const hook = onFirstSql(/from "codex_entries"/iu, reset);
    const result = await run("list_codex_by_type", { type: "character" });
    expect(hook.fired()).toBe(1);
    const ids = idsOf(result);
    expect(ids).toContain("c-aria");
    expect(ids).not.toContain("cx-late");
    expect(ids).not.toContain("c-secret");
  });
});

// ---------------------------------------------------------------------------
// 6. search_codex の hit の扱い
// ---------------------------------------------------------------------------

describe("search_codex：fts・dense の hit の扱い", () => {
  /** fts の hit の列を差し替える。 */
  const ftsReturns = (ids: readonly string[]) =>
    legacyReadInvokeBridge.override("fts_search", () =>
      ids.map((id) => ({ sourceType: "codex", id, title: id, excerpt: "" })),
    );

  it("fts の hit は他の sourceType を落とし、id の順で DB の行を並べ直す", async () => {
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("fts_search", () => [
      { sourceType: "scene", id: "n-s1", title: "", excerpt: "" },
      { sourceType: "codex", id: "c-tower", title: "", excerpt: "" },
      { sourceType: "snippet", id: "sn-1", title: "", excerpt: "" },
      { sourceType: "codex", id: "c-aria", title: "", excerpt: "" },
    ]);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    const result = await run("search_codex", { query: "アリア" });
    expect(idsOf(result)).toEqual(["c-tower", "c-aria"]);
    expect(result.summary).toBe("2 entries found");
  });

  it("fts が 0 件なら entries を読まず、判定も読まない（SQL は 1 本も打たない）。dense は 1 回呼ぶ", async () => {
    await setWorld(MAIN_S1);
    ftsReturns([]);
    const result = await run("search_codex", { query: "アリア" });
    expect(result.content).toEqual([]);
    expect(legacyReadInvokeBridge.calls("db_execute")).toEqual([]);
    expect(legacyReadInvokeBridge.calls("codex_semantic_search")).toHaveLength(
      1,
    );
  });

  it("cut の位置に hidden が居ると 20 件に満たない：fts の 20 件のうち hidden 3 件は融合・cut の後に落ち、17 件になる（hidden を先に落として補わない）", async () => {
    await setWorld(MAIN_S1);
    // 20 件：c-secret（base hidden）、c-released（n-s1 では hidden）、cx-late の後に、公開の石碑 17 件。
    const ids = [
      "c-secret",
      "c-released",
      "cx-src-nonexistent",
      ...Array.from({ length: 17 }, (_, i) => steleId(i + 1)),
    ];
    expect(ids).toHaveLength(20);
    ftsReturns(ids);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    const result = await run("search_codex", { query: "石碑の要約" });
    expect(idsOf(result)).toEqual(
      Array.from({ length: 17 }, (_, i) => steleId(i + 1)),
    );
    expect(result.summary).toBe("17 entries found");
    // fts への引数は limit 20（hidden を見込んで増やさない）。
    expect(legacyReadInvokeBridge.calls("fts_search")[0]?.args).toMatchObject({
      scope: "codex",
      limit: 20,
    });
  });

  it("dense の hit が DB に無い id は hidden に数えて落とす。dense の summary は released でない項目でそのまま出る（DB の summary と違っても）。released の項目は Phase 解決後の summary", async () => {
    await setWorld(MAIN_S3);
    ftsReturns(["c-tower"]);
    legacyReadInvokeBridge.override("codex_semantic_search", () => [
      {
        entryId: "ghost-id",
        entryName: "幽霊",
        entryType: "character",
        summary: "DB に無い",
        score: 0.99,
      },
      {
        entryId: "c-mage",
        entryName: "老魔術師",
        entryType: "character",
        summary: "dense 側の要約（DB と違う）",
        score: 0.9,
      },
      {
        entryId: "c-released",
        entryName: "幻の騎士",
        entryType: "character",
        summary: "base の summary（hidden）",
        score: 0.8,
      },
    ]);
    const result = await run("search_codex", { query: "魔法の塔" });
    const rows = result.content as Array<{ id: string; summary: string }>;
    expect(rows.map((r) => r.id)).toEqual(["c-tower", "c-mage", "c-released"]);
    expect(rows.find((r) => r.id === "c-mage")?.summary).toBe(
      "dense 側の要約（DB と違う）",
    );
    expect(rows.find((r) => r.id === "c-released")?.summary).toBe(
      "n-s3 で正体が明らかになる騎士。",
    );
  });

  it("短い語が 1 つでも混じると fts を呼ばず、全 token の LIKE-OR（name・summary・tagsCache・aliases・content）に倒れる。limit 20", async () => {
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    await run("search_codex", { query: "魔法 老魔術師" });
    expect(legacyReadInvokeBridge.calls("fts_search")).toEqual([]);
    const select = legacyReadInvokeBridge.calls("db_execute").map((c) => ({
      sql: String(c.args?.["sql"]),
      params: c.args?.["params"],
    }))[0]!;
    expect(select.sql).toMatch(/like/iu);
    expect(select.sql).toMatch(/limit \?$/iu);
    expect(select.params).toEqual([
      "p-main",
      "%魔法%",
      "%魔法%",
      "%魔法%",
      "%魔法%",
      "%魔法%",
      "%老魔術師%",
      "%老魔術師%",
      "%老魔術師%",
      "%老魔術師%",
      "%老魔術師%",
      20,
    ]);
  });

  it("LIKE の arm は limit 20 で切る（石碑は 22 件：2 字の語は LIKE）。公開の 20 件が出る", async () => {
    await setWorld(MAIN_S1);
    legacyReadInvokeBridge.override("codex_semantic_search", () => []);
    const result = await run("search_codex", { query: "石碑" });
    // 石碑の entry は 23 件（cx-stele-src を含む）。20 件で切れる。
    expect(idsOf(result)).toHaveLength(20);
  });

  it("list_codex_by_type は limit も ORDER BY も無い（lore は 23 件全部）", async () => {
    await setWorld(MAIN_S1);
    const result = await run("list_codex_by_type", { type: "lore" });
    expect(idsOf(result)).toHaveLength(STELE_COUNT + 1);
    expect(result.summary).toBe(`${STELE_COUNT + 1} entries of type 'lore'`);
  });
});

// ---------------------------------------------------------------------------
// 7. search_codex_by_tags・find_related_entries の癖
// ---------------------------------------------------------------------------

describe("search_codex_by_tags の癖", () => {
  it("要素は String 化するだけで trim も重複除去もしない：' 魔法'（前に空白）は当たらず、重複したタグは entry を重複させない（DISTINCT）。タグ名は project をまたいで同名でも、entry 側の project だけで絞る", async () => {
    await setWorld(MAIN_S1);
    expect(
      idsOf(await run("search_codex_by_tags", { tags: [" 魔法"] })),
    ).toEqual([]);
    const dup = idsOf(
      await run("search_codex_by_tags", { tags: ["魔法", "魔法", "主人公"] }),
    );
    expect(new Set(dup).size).toBe(dup.length);
    expect(dup).toContain("c-aria");
  });
});

describe("find_related_entries の癖", () => {
  const relatedSelect = () =>
    legacyReadInvokeBridge
      .calls("db_execute")
      .map((c) => ({
        sql: String(c.args?.["sql"]),
        params: c.args?.["params"],
      }))
      .find((s) => /like/iu.test(s.sql));

  it("aliases が壊れた JSON・非配列なら name だけが検索語になる。配列の非文字列・空・空白だけは落ちる（空白だけの要素は trim して空なので落ちる。' 別名乙' のような前後空白つきは、そのまま使う）", async () => {
    await setWorld(MAIN_S1);
    await run("find_related_entries", { id: "cx-alias-broken" });
    expect(relatedSelect()?.params).toEqual([
      "p-main",
      "cx-alias-broken",
      "%壊れた別名%",
      "%壊れた別名%",
      "%壊れた別名%",
      "%壊れた別名%",
      20,
    ]);
    legacyReadInvokeBridge.reset();
    await run("find_related_entries", { id: "cx-alias-obj" });
    expect(relatedSelect()?.params).toEqual([
      "p-main",
      "cx-alias-obj",
      "%別名が非配列%",
      "%別名が非配列%",
      "%別名が非配列%",
      "%別名が非配列%",
      20,
    ]);
    legacyReadInvokeBridge.reset();
    await run("find_related_entries", { id: "cx-alias-mixed" });
    // terms は name・別名甲・''（落ちる）・'  '（落ちる）・別名乙 の 3 つ。型の絞りが無いので params は 3 語×4 列。
    expect(relatedSelect()?.params).toEqual([
      "p-main",
      "cx-alias-mixed",
      ..."別名に混在 別名甲 別名乙"
        .split(" ")
        .flatMap((term) => Array.from({ length: 4 }, () => `%${term}%`)),
      20,
    ]);
  });

  it("name が空白だけで別名も無いと、検索語が空：Source entry has no searchable name（関連の select は打たない）", async () => {
    await setWorld(MAIN_S1);
    const result = await run("find_related_entries", { id: "cx-noname" });
    expect(result.summary).toBe("Source entry has no searchable name");
    expect(result.content).toEqual([]);
    expect(relatedSelect()).toBeUndefined();
  });

  it("type は trim して絞る。空文字・空白だけ・欠落は絞らない（空白だけは trim して '' で、type の条件は付く。欠落と空文字は付かない）", async () => {
    await setWorld(MAIN_S1);
    await run("find_related_entries", { id: "c-mage", type: " location " });
    expect(relatedSelect()?.sql).toMatch(/"type" = \?/iu);
    expect(relatedSelect()?.params).toContain("location");
    expect(
      (await run("find_related_entries", { id: "c-mage", type: " location " }))
        .summary,
    ).toBe("1 related to 老魔術師 (type=location)");
    for (const type of ["", undefined]) {
      legacyReadInvokeBridge.reset();
      await run("find_related_entries", {
        id: "c-mage",
        ...(type === undefined ? {} : { type }),
      });
      expect(relatedSelect()?.sql, String(type)).not.toMatch(/"type" = \?/iu);
    }
  });

  it("関連の select は limit 20（石碑の起点には 22 件が当たる）。起点自身は除く。id の前後の空白は trim する", async () => {
    await setWorld(MAIN_S1);
    const result = await run("find_related_entries", { id: "  cx-stele-src " });
    expect(idsOf(result)).toHaveLength(20);
    expect(idsOf(result)).not.toContain("cx-stele-src");
    expect(result.summary).toBe("20 related to 石碑");
  });

  it("他 project の id は起点にできない（Entry not found）", async () => {
    await setWorld(MAIN_S1);
    expect(
      (await run("find_related_entries", { id: "x-c-aria" })).summary,
    ).toBe("Entry not found");
  });
});
