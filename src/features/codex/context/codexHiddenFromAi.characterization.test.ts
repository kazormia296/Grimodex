// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-8a：`resolveCodexForAi`（と、それを呼ぶ `dropCodexHiddenFromAi`・`visibleCodexForAi`）の、
 * 既存の試験が覆わない挙動の特性試験。**判定の本体を共有の純関数へ載せ替える前に、未変更の legacy で通し、
 * 載せ替えた後も無変更で通る**ことが「結果を 1 byte も変えない」の証拠になる。
 *
 * 実 sql.js（browser-mock）の `@/db/client` に、PR-0 の seed（`legacyReadSeed.ts`。触らない）と、この
 * file の中で足す Phase の行を入れ、公開関数だけを呼ぶ。新しい module は import しない。
 *
 * 固定するもの：
 * - 送った SQL（sql・params。`withContent` の有無、falsy な projectId で project 条件が消えること、
 *   `withDetails` の追加の 2 文、ids が 0 件なら 0 文、entries が 0 件なら 1 文で phases を読まない）。
 * - `usePhaseStore` を読む位置（`listPhasesByEntryIds` の await の最中に書き換えた値が使われる）。
 * - Phase の解決：reading・story・auto（Phase が読む順の後ろ・物語時間の前にある例）、base 公開で Phase が
 *   hidden にする、場面が null・空・空白だけのとき base と同じ結果、読む順に無い id のとき（DR-MP4-41 で fail-closed に変更）
 *   Phase が hidden にする項目は hidden、前後に空白のある
 *   sceneId は trim される、不明な mode は hidden。
 * - `hidden`・`texts` の挿入順（DB に無い id が先、次に DB の返した entry の順）。
 * - `dropCodexHiddenFromAi` の summary の置換（released で、`summary` キーを持つ行だけ）、
 *   `visibleCodexForAi` の summaries・suppressed。
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
import {
  buildSceneTimeIndex,
  type PhaseResolutionMode,
} from "./sceneTimeIndex";
import {
  dropCodexHiddenFromAi,
  resolveCodexForAi,
  visibleCodexForAi,
} from "./codexHiddenFromAi";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const T1 = "2026-01-01T00:00:00.000Z";

/** この file が seed の上に足す Phase。entry は PR-0 の seed の `p-main` の行。 */
const PHASES: ReadonlyArray<{
  id: string;
  entry: string;
  anchor: string;
  mode: string | null;
  summary?: string | null;
  content?: string | null;
  at: string;
}> = [
  // base 公開（c-aria）を、n-s2 から hidden にする。
  {
    id: "ph-aria-hide-s2",
    entry: "c-aria",
    anchor: "n-s2",
    mode: "hidden",
    at: "2026-01-01T00:00:01.000Z",
  },
  // base 公開（c-mage）を、n-s3 から hidden にする。n-s3 は読む順で n-s2 の後ろ、物語時間では n-s2 の前。
  {
    id: "ph-mage-hide-s3",
    entry: "c-mage",
    anchor: "n-s3",
    mode: "hidden",
    at: "2026-01-01T00:00:02.000Z",
  },
  // c-tower を n-s2 から suppress にする（hidden ではない。Phase 解決後の mode が texts に出る）。
  {
    id: "ph-tower-suppress-s2",
    entry: "c-tower",
    anchor: "n-s2",
    mode: "suppress",
    at: "2026-01-01T00:00:03.000Z",
  },
  // c-item を n-s1 から always にする（Phase 解決後の mode が texts に出る）。
  {
    id: "ph-item-always-s1",
    entry: "c-item",
    anchor: "n-s1",
    mode: "always",
    at: "2026-01-01T00:00:04.000Z",
  },
];

const runSql = (sql: string, params: unknown[]) =>
  invoke("db_execute", { sql, params, method: "run" });

beforeAll(async () => {
  setLegacyReadWorkspaceIdentity();
  await seedLegacyReadFixture();
  for (const p of PHASES) {
    await runSql(
      "INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        p.id,
        p.entry,
        p.anchor,
        p.id,
        p.summary ?? null,
        p.content ?? null,
        p.mode,
        p.at,
        p.at,
      ],
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

/** 読む順は s1 < s2 < s3 < s4。物語時間は s3（a2）が s2（a3）より前。 */
const FULL_STORY = [
  sceneNode("n-s1", "a0", "a1"),
  sceneNode("n-s2", "a1", "a3"),
  sceneNode("n-s3", "a2", "a2"),
  sceneNode("n-s4", "a3", "a4"),
];
/** s4 に明示の物語時間が無い（auto は揃っていないので reading に退く。story は s3 の値を引き継ぐ）。 */
const PARTIAL_STORY = [
  sceneNode("n-s1", "a0", "a1"),
  sceneNode("n-s2", "a1", "a3"),
  sceneNode("n-s3", "a2", "a2"),
  sceneNode("n-s4", "a3", null),
];

function setPhaseStore(
  nodes: TreeNodeData[],
  resolutionMode: PhaseResolutionMode,
): void {
  usePhaseStore.setState({
    sceneTimeIndex: buildSceneTimeIndex(nodes),
    resolutionMode,
  });
}

const statements = () =>
  legacyReadInvokeBridge.calls("db_execute").map((call) => ({
    sql: String(call.args?.["sql"]),
    params: call.args?.["params"] as unknown[],
  }));

beforeEach(() => {
  legacyReadInvokeBridge.reset();
  setPhaseStore(FULL_STORY, "reading");
});

const sorted = (values: Iterable<string>) => [...values].sort();

describe("resolveCodexForAi が送る SQL", () => {
  it("projectId ありは project と id の両方を条件にし、列は id・summary・contextMode だけ。続けて phases を 1 文で読む", async () => {
    await resolveCodexForAi({
      entryIds: ["c-aria", "c-secret"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    const sent = statements();
    expect(sent).toEqual([
      {
        sql: 'select "id", "summary", "context_mode" from "codex_entries" where ("codex_entries"."project_id" = ? and "codex_entries"."id" in (?, ?))',
        params: ["p-main", "c-aria", "c-secret"],
      },
      {
        sql: 'select "id", "entry_id", "anchor_node_id", "label", "summary_override", "content_override", "context_mode_override", "created_at", "updated_at", "version" from "codex_entry_phases" where "codex_entry_phases"."entry_id" in (?, ?) order by "codex_entry_phases"."created_at"',
        params: ["c-aria", "c-secret"],
      },
    ]);
  });

  it("projectId が空・未指定・null なら project の条件は消える（id だけで引く）", async () => {
    for (const projectId of ["", undefined, null]) {
      legacyReadInvokeBridge.reset();
      const { hidden } = await resolveCodexForAi({
        entryIds: ["c-aria", "x-c-aria"],
        ...(projectId === undefined ? {} : { projectId }),
        sceneId: "n-s1",
      });
      expect(statements()[0], String(projectId)).toEqual({
        sql: 'select "id", "summary", "context_mode" from "codex_entries" where "codex_entries"."id" in (?, ?)',
        params: ["c-aria", "x-c-aria"],
      });
      // 他 project の x-c-aria も DB にあるので、project 条件が無ければ hidden に数えられない。
      expect(sorted(hidden), String(projectId)).toEqual([]);
    }
  });

  it("projectId ありなら、他 project の id は DB に無い扱いで hidden", async () => {
    const { hidden } = await resolveCodexForAi({
      entryIds: ["c-aria", "x-c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect(sorted(hidden)).toEqual(["x-c-aria"]);
  });

  it("withContent は content の列を足し、本文を texts に載せる。無ければ本文は空文字", async () => {
    const without = await resolveCodexForAi({
      entryIds: ["c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect(without.texts.get("c-aria")?.content).toBe("");
    legacyReadInvokeBridge.reset();
    const withContent = await resolveCodexForAi({
      entryIds: ["c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
      withContent: true,
    });
    expect(statements()[0]).toEqual({
      sql: 'select "id", "summary", "context_mode", "content" from "codex_entries" where ("codex_entries"."project_id" = ? and "codex_entries"."id" in (?))',
      params: ["p-main", "c-aria"],
    });
    expect(withContent.texts.get("c-aria")?.content).toContain("アリア");
  });

  it("ids が 0 件なら 1 文も送らない。重複は取り除き、全部 DB に無ければ phases は読まない", async () => {
    const none = await resolveCodexForAi({
      entryIds: [],
      projectId: "p-main",
    });
    expect(none.hidden.size).toBe(0);
    expect(none.texts.size).toBe(0);
    expect(statements()).toEqual([]);

    const gone = await resolveCodexForAi({
      entryIds: ["gone-1", "gone-1", "gone-2"],
      projectId: "p-main",
    });
    expect([...gone.hidden]).toEqual(["gone-1", "gone-2"]);
    expect(gone.texts.size).toBe(0);
    expect(statements()).toEqual([
      {
        sql: 'select "id", "summary", "context_mode" from "codex_entries" where ("codex_entries"."project_id" = ? and "codex_entries"."id" in (?, ?))',
        params: ["p-main", "gone-1", "gone-2"],
      },
    ]);
  });

  it("phases は DB で見つかった entry の id だけで引く（DB に無い id・他 project の id は含めない）", async () => {
    await resolveCodexForAi({
      entryIds: ["c-aria", "gone", "x-c-aria", "c-mage"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    const phases = statements()[1]!;
    expect(phases.sql).toContain('from "codex_entry_phases"');
    expect(sorted(phases.params as string[])).toEqual(["c-aria", "c-mage"]);
  });

  it("withDetails は released があるときだけ、Phase の detail override と raw の detail 値を 1 文ずつ足す", async () => {
    // released なし（c-aria は base 公開）：追加の文は無い。
    await resolveCodexForAi({
      entryIds: ["c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
      withDetails: true,
    });
    expect(statements().map((s) => s.sql.match(/from "(\w+)"/u)?.[1])).toEqual([
      "codex_entries",
      "codex_entry_phases",
    ]);

    legacyReadInvokeBridge.reset();
    const released = await resolveCodexForAi({
      entryIds: ["c-released"],
      projectId: "p-main",
      sceneId: "n-s3",
      withDetails: true,
    });
    expect(statements().map((s) => s.sql.match(/from "(\w+)"/u)?.[1])).toEqual([
      "codex_entries",
      "codex_entry_phases",
      "codex_phase_detail_overrides",
      "codex_detail_values",
    ]);
    const text = released.texts.get("c-released");
    expect(text?.released).toBe(true);
    expect(text?.detailValues).toBeInstanceOf(Map);
    expect(text?.detailValues?.size).toBe(0);

    // withDetails でなければ detailValues は付かない。
    const plain = await resolveCodexForAi({
      entryIds: ["c-released"],
      projectId: "p-main",
      sceneId: "n-s3",
    });
    expect(plain.texts.get("c-released")?.detailValues).toBeUndefined();
  });
});

describe("resolveCodexForAi が usePhaseStore を読む位置", () => {
  it("phases の読みの await の最中に書き換えた値が使われる（entries の読みより後で、phases の後）", async () => {
    // 読み始めの store は「Phase が効かない reading・s1」。phases の読みが始まった瞬間に story へ書き換える。
    // c-mage の Phase は n-s3（読む順では n-s2 の後ろ、物語時間では前）。現在の場面は n-s2。
    // store を reading のまま読めば visible、書き換え後の story を読めば hidden。
    let fired = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !fired &&
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_entry_phases"')
      ) {
        fired = true;
        setPhaseStore(FULL_STORY, "story");
      }
    });
    const { hidden } = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect(fired).toBe(true);
    expect([...hidden]).toEqual(["c-mage"]);
  });

  it("entries の読みの await の最中に書き換えた値も、phases の後に読むので使われる", async () => {
    let fired = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !fired &&
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_entries"')
      ) {
        fired = true;
        setPhaseStore(FULL_STORY, "story");
      }
    });
    const { hidden } = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect(fired).toBe(true);
    expect([...hidden]).toEqual(["c-mage"]);
  });

  it("全 id が DB に無いときは、冒頭に projectEpoch を控える 1 回だけで、index・mode は読まない（DR-MP4-41 (b)）", async () => {
    // 変わった期待：以前は 0 回と 1 回。(b) の epoch の控え（関数の冒頭）で、どちらも 1 回増える。
    // 値（index・mode）を読む回は変わらない：全 id が DB に無ければ、その読みは無い。
    const spy = vi.spyOn(usePhaseStore, "getState");
    try {
      await resolveCodexForAi({ entryIds: ["gone"], projectId: "p-main" });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await resolveCodexForAi({ entryIds: ["c-aria"], projectId: "p-main" });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

/** c-aria（base 公開・Phase が hidden）・c-released（base hidden・Phase が公開）・c-mage（base 公開・Phase が hidden）を判定して、sorted な hidden と texts の released を返す。 */
async function observeIds(sceneId: string | null | undefined) {
  const r = await resolveCodexForAi({
    entryIds: ["c-aria", "c-released", "c-mage"],
    projectId: "p-main",
    ...(sceneId === undefined ? {} : { sceneId }),
  });
  return {
    hidden: [...r.hidden].sort(),
    texts: [...r.texts.entries()]
      .map(([id, t]) => [id, t.released])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
}

describe("resolveCodexForAi の Phase の解決", () => {
  it("reading：base 公開の c-aria は、Phase が hidden にする n-s2 から hidden（n-s1 では公開）", async () => {
    const atS1 = await resolveCodexForAi({
      entryIds: ["c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect([...atS1.hidden]).toEqual([]);
    expect(atS1.texts.get("c-aria")).toMatchObject({
      released: false,
      mode: "mentioned",
      summary: "老魔術師を訪ねる旅の少女",
    });
    for (const sceneId of ["n-s2", "n-s3", "n-s4"]) {
      const after = await resolveCodexForAi({
        entryIds: ["c-aria"],
        projectId: "p-main",
        sceneId,
      });
      expect([...after.hidden], sceneId).toEqual(["c-aria"]);
      expect(after.texts.size, sceneId).toBe(0);
    }
  });

  it("base の hidden を Phase が解除する c-released は、n-s3 から公開で、文は Phase 解決後（released）", async () => {
    const before = await resolveCodexForAi({
      entryIds: ["c-released"],
      projectId: "p-main",
      sceneId: "n-s2",
      withContent: true,
    });
    expect([...before.hidden]).toEqual(["c-released"]);
    const after = await resolveCodexForAi({
      entryIds: ["c-released"],
      projectId: "p-main",
      sceneId: "n-s3",
      withContent: true,
    });
    expect([...after.hidden]).toEqual([]);
    const text = after.texts.get("c-released");
    expect(text).toMatchObject({
      released: true,
      mode: "mentioned",
      summary: "n-s3 で正体が明らかになる騎士。",
    });
    expect(text?.content).toContain("Phase 解決後の本文。");
  });

  it("withContent なしで released なら、本文は Phase の override（base の本文は読まないので空）", async () => {
    const after = await resolveCodexForAi({
      entryIds: ["c-released"],
      projectId: "p-main",
      sceneId: "n-s3",
    });
    expect(after.texts.get("c-released")?.content).toContain(
      "Phase 解決後の本文。",
    );
  });

  it("場面なし（null・未指定・空・空白だけ）は、base で解決する（Phase は効かない）", async () => {
    // DR-MP4-41：「場面なし」は今までどおり base 扱い（変えない）。
    const expected = {
      hidden: ["c-released"],
      texts: [
        ["c-aria", false],
        ["c-mage", false],
      ],
    };
    for (const sceneId of [undefined, null, "", "   "]) {
      expect(await observeIds(sceneId), String(sceneId)).toEqual(expected);
    }
  });

  it("場面が与えられているのに読む順に無い（archived・trash・削除済み・別 project の id）とき、Phase が hidden にする項目は hidden に倒す（DR-MP4-41 (a)）", async () => {
    // 変わった期待：以前は base と同じ結果（c-aria・c-mage は公開、fail-open）だった。
    // いまは Phase が hidden にする c-aria・c-mage も hidden。base hidden の c-released は今までどおり hidden。
    for (const sceneId of [
      "n-archived",
      "no-such-scene",
      "n-note",
      "  no-such-scene  ",
    ]) {
      expect(await observeIds(sceneId), String(sceneId)).toEqual({
        hidden: ["c-aria", "c-mage", "c-released"],
        texts: [],
      });
    }
  });

  it("場面が読む順に無くても、Phase が hidden にしない項目（suppress・always の Phase を持つもの）は、今までどおり（DR-MP4-41 (a) は広げない）", async () => {
    const r = await resolveCodexForAi({
      entryIds: ["c-tower", "c-item"],
      projectId: "p-main",
      sceneId: "no-such-scene",
    });
    expect([...r.hidden]).toEqual([]);
    expect(r.texts.get("c-tower")).toMatchObject({ released: false });
    expect(r.texts.get("c-item")).toMatchObject({ released: false });
  });

  it("sceneId は前後の空白を取り除いて使う", async () => {
    const trimmed = await resolveCodexForAi({
      entryIds: ["c-aria"],
      projectId: "p-main",
      sceneId: "  n-s2  ",
    });
    expect([...trimmed.hidden]).toEqual(["c-aria"]);
  });

  it("story：Phase が物語時間で現在の場面より前なら、読む順で後ろでも効く。reading では効かない", async () => {
    setPhaseStore(FULL_STORY, "reading");
    const reading = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...reading.hidden]).toEqual([]);

    setPhaseStore(FULL_STORY, "story");
    const story = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...story.hidden]).toEqual(["c-mage"]);
  });

  it("auto：全場面に物語時間が揃っていれば story、揃っていなければ reading に退く", async () => {
    setPhaseStore(FULL_STORY, "auto");
    const full = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...full.hidden]).toEqual(["c-mage"]);

    setPhaseStore(PARTIAL_STORY, "auto");
    const partial = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...partial.hidden]).toEqual([]);

    // story は s4 が s3 の値を引き継ぐので、揃っていなくても story で解決する。
    setPhaseStore(PARTIAL_STORY, "story");
    const story = await resolveCodexForAi({
      entryIds: ["c-mage"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...story.hidden]).toEqual(["c-mage"]);
  });

  it("suppress・always は hidden でなく、Phase 解決後の mode が texts に出る（base の文のまま、released は false）", async () => {
    const atS1 = await resolveCodexForAi({
      entryIds: ["c-item", "c-tower"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    // c-item の always は n-s1 から。c-tower の suppress は n-s2 から。
    expect([...atS1.hidden]).toEqual([]);
    expect(atS1.texts.get("c-item")).toMatchObject({
      mode: "always",
      released: false,
    });
    expect(atS1.texts.get("c-tower")?.mode).toBe("mentioned");
    const atS2 = await resolveCodexForAi({
      entryIds: ["c-item", "c-tower"],
      projectId: "p-main",
      sceneId: "n-s2",
    });
    expect([...atS2.hidden]).toEqual([]);
    expect(atS2.texts.get("c-tower")).toMatchObject({
      mode: "suppress",
      released: false,
    });
  });
});

describe("resolveCodexForAi の hidden・texts の挿入順", () => {
  it("hidden は DB に無い id が先（渡した順）、次に entry。texts は DB が返した entry のうち公開のもの", async () => {
    const r = await resolveCodexForAi({
      entryIds: ["c-aria", "gone-1", "c-secret", "c-mage", "gone-2", "c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect([...r.hidden]).toEqual(["gone-1", "gone-2", "c-secret"]);
    expect([...r.texts.keys()].sort()).toEqual(["c-aria", "c-mage"]);
    // DB が返した順（この sql.js では、2 つの結果が同じ順になること自体を固定する）。
    expect([...r.texts.keys()]).toEqual(
      (
        (await invoke("db_execute", {
          sql: 'select "id" from "codex_entries" where ("codex_entries"."project_id" = ? and "codex_entries"."id" in (?, ?))',
          params: ["p-main", "c-aria", "c-mage"],
          method: "all",
        })) as { rows: Array<{ id: string }> }
      ).rows.map((row) => row.id),
    );
  });
});

describe("dropCodexHiddenFromAi・visibleCodexForAi", () => {
  it("hidden の行を除いて順序を保ち、Phase で解除された行（released）で summary を持つ行だけ summary を置き換える", async () => {
    const rows = [
      { id: "c-secret", summary: "x" },
      { id: "c-released", summary: "base の summary（hidden）" },
      { id: "c-aria", summary: "老魔術師を訪ねる旅の少女" },
      { id: "gone", summary: "y" },
    ];
    const dropped = await dropCodexHiddenFromAi(rows, {
      projectId: "p-main",
      sceneId: "n-s3",
    });
    // n-s3：c-aria は Phase（n-s2 から hidden）で hidden。c-released は解除され、summary は Phase 解決後。
    expect(dropped).toEqual([
      { id: "c-released", summary: "n-s3 で正体が明らかになる騎士。" },
    ]);
    const before = await dropCodexHiddenFromAi(rows, {
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect(before).toEqual([
      { id: "c-aria", summary: "老魔術師を訪ねる旅の少女" },
    ]);
  });

  it("summary キーを持たない行は、released でも置き換えない。入力の配列は変えない", async () => {
    const rows = [{ id: "c-released", name: "幻の騎士" }];
    const dropped = await dropCodexHiddenFromAi(rows, {
      projectId: "p-main",
      sceneId: "n-s3",
    });
    expect(dropped).toEqual([{ id: "c-released", name: "幻の騎士" }]);
    expect(dropped[0]).toBe(rows[0]);
  });

  it("空の入力は DB を引かず空", async () => {
    expect(await dropCodexHiddenFromAi([], { projectId: "p-main" })).toEqual(
      [],
    );
    expect(statements()).toEqual([]);
  });

  it("visibleCodexForAi：ids は順序を保って hidden を除き、summaries は released だけ、suppressed は解決後が suppress の id", async () => {
    const visible = await visibleCodexForAi(
      ["c-tower", "c-released", "c-aria", "c-secret", "gone"],
      { projectId: "p-main", sceneId: "n-s3" },
    );
    expect(visible.ids).toEqual(["c-tower", "c-released"]);
    expect([...visible.summaries.entries()]).toEqual([
      ["c-released", "n-s3 で正体が明らかになる騎士。"],
    ]);
    expect([...visible.suppressed]).toEqual(["c-tower"]);
  });

  it("visibleCodexForAi：空の ids は DB を引かず、何も渡さない", async () => {
    const empty = await visibleCodexForAi([], { projectId: "p-main" });
    expect(empty.ids).toEqual([]);
    expect(empty.summaries.size).toBe(0);
    expect(empty.suppressed.size).toBe(0);
    expect(statements()).toEqual([]);
  });
});
