import { describe, expect, it, vi } from "vitest";

import type {
  CoreNativeReads,
  CoreReadContext,
  CoreReadDbClient,
  CoreTreeState,
} from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import { createCoreReadDb } from "./readDb.js";
import { createReadExecutors } from "./readExecutors.js";

interface Captured {
  readonly sql: string;
  readonly params: unknown[];
  readonly method: string;
}

const T = 1_767_225_600_000;

/**
 * One row of `foreshadows`, positional in the schema's column order (the tool
 * selects every column).
 */
const foreshadowRow = (over: Record<string, unknown> = {}): unknown[] => {
  const v = {
    id: "f1",
    project_id: "p1",
    title: "老魔術師の杖",
    intent: "杖が後で鍵になる",
    notes: "作者だけのメモ",
    payoff_scene_id: null,
    payoff_from_pos: null,
    payoff_to_pos: null,
    payoff_confirmed: 0,
    abandoned: 0,
    secret: 0,
    load_bearing: "critical",
    mechanism: null,
    version: 0,
    codex_link_dirty_at: null,
    created_at: T,
    updated_at: T,
    ...over,
  };
  return [
    v.id,
    v.project_id,
    v.title,
    v.intent,
    v.notes,
    v.payoff_scene_id,
    v.payoff_from_pos,
    v.payoff_to_pos,
    v.payoff_confirmed,
    v.abandoned,
    v.secret,
    v.load_bearing,
    v.mechanism,
    v.version,
    v.codex_link_dirty_at,
    v.created_at,
    v.updated_at,
  ];
};

function makeCtx(
  opts: {
    answers?: Record<string, unknown[][]>;
    foreshadowOpen?: CoreNativeReads["foreshadowOpen"];
    foreshadowListWithLabels?: CoreNativeReads["foreshadowListWithLabels"];
    projectId?: string | (() => string);
  } = {},
) {
  const captured: Captured[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    captured.push({ sql, params, method });
    const table = /from "([a-z_]+)"/u.exec(sql)?.[1] ?? "";
    return { rows: opts.answers?.[table] ?? [] };
  };
  const foreshadowOpen = vi.fn(
    opts.foreshadowOpen ?? (async () => ({ foreshadows: [], setups: [] })),
  );
  const foreshadowListWithLabels = vi.fn(
    opts.foreshadowListWithLabels ??
      (async () => ({ foreshadows: [], setups: [] })),
  );
  const fts = vi.fn(async () => []);
  const getTreeState = vi.fn(
    () =>
      ({
        projectId:
          typeof opts.projectId === "function"
            ? opts.projectId()
            : (opts.projectId ?? "p1"),
        nodes: [],
        activeSceneId: null,
      }) as CoreTreeState,
  );
  const ctx: CoreReadContext = {
    getDb: () => createCoreReadDb(client),
    getTreeState,
    body: {
      barrier: "none",
      readSceneBody: async () => "",
      readSceneBodies: async () => new Map<string, string>(),
    },
    native: { fts, foreshadowOpen, foreshadowListWithLabels },
    countTokens: (text) => text.length,
  };
  return {
    executors: createReadExecutors(ctx),
    captured,
    foreshadowOpen,
    foreshadowListWithLabels,
    fts,
    getTreeState,
  };
}

const nativeForeshadow = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  title: "老魔術師の杖",
  intent: "杖が後で鍵になる",
  load_bearing: "critical",
  version: 0,
  payoff_confirmed: 0,
  abandoned: 0,
  updated_at: T,
  ...over,
});
const nativeSetup = (over: Record<string, unknown> = {}) => ({
  foreshadow_id: "f1",
  is_orphan: 0,
  strength: null,
  ai_strength: null,
  ai_reasoning: null,
  ...over,
});

describe("list_open_foreshadows", () => {
  it("asks foreshadowOpen for the project only (once), reads no database and does not use fts", async () => {
    const {
      executors,
      foreshadowOpen,
      foreshadowListWithLabels,
      captured,
      fts,
    } = makeCtx();
    const result = await executors.list_open_foreshadows({});
    expect(foreshadowOpen).toHaveBeenCalledTimes(1);
    expect(foreshadowOpen).toHaveBeenCalledWith({ projectId: "p1" });
    expect(foreshadowListWithLabels).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    expect(fts).not.toHaveBeenCalled();
    expect(result).toEqual({
      name: "list_open_foreshadows",
      content: [],
      summary: "0 open foreshadowing items",
      tokensUsed: 2,
    });
  });

  it("builds the result from Native's wire: the key order, intent ?? '' and the setup count without orphans", async () => {
    const { executors } = makeCtx({
      foreshadowOpen: async () => ({
        foreshadows: [
          nativeForeshadow({ id: "f-old", updated_at: T }),
          nativeForeshadow({
            id: "f-light",
            title: "軽い伏線",
            intent: null,
            load_bearing: null,
          }),
          nativeForeshadow({ id: "f-new", updated_at: T + 10 }),
        ],
        setups: [
          nativeSetup({ foreshadow_id: "f-old" }),
          nativeSetup({ foreshadow_id: "f-old", is_orphan: 1 }),
          nativeSetup({ foreshadow_id: "f-new" }),
          nativeSetup({ foreshadow_id: "f-new" }),
        ],
      }),
    });
    const result = await executors.list_open_foreshadows({});
    expect(result.content).toEqual([
      {
        id: "f-new",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 2,
      },
      {
        id: "f-old",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 1,
      },
      {
        id: "f-light",
        title: "軽い伏線",
        intent: "",
        loadBearing: null,
        setupCount: 0,
      },
    ]);
    // The key order is part of the result (the bytes the model reads).
    expect(JSON.stringify((result.content as unknown[])[2])).toBe(
      '{"id":"f-light","title":"軽い伏線","intent":"","loadBearing":null,"setupCount":0}',
    );
    expect(result.summary).toBe("3 open foreshadowing items");
    expect(result.tokensUsed).toBe(JSON.stringify(result.content).length);
  });

  it("shows a secret foreshadow when the read returns it", async () => {
    // The wire has no secret column; the core forwards the read result unchanged.
    const { executors } = makeCtx({
      foreshadowOpen: async () => ({
        foreshadows: [nativeForeshadow({ id: "returned", secret: 1 })],
        setups: [],
      }),
    });
    const result = await executors.list_open_foreshadows({});
    expect((result.content as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "returned",
    ]);
  });

  it("includeSettled projects only active rows, puts settled rows last, and marks them", async () => {
    const { executors, foreshadowOpen, foreshadowListWithLabels, captured } =
      makeCtx({
        foreshadowListWithLabels: async () => ({
          foreshadows: [
            nativeForeshadow({
              id: "open-light",
              load_bearing: "optional",
              updated_at: T + 100,
              notes: "private notes",
              secret: 1,
              payoff_scene_id: "n-open",
            }),
            nativeForeshadow({
              id: "settled-light",
              load_bearing: "optional",
              payoff_confirmed: 1,
              updated_at: T + 200,
              notes: "settled notes",
              secret: 1,
              payoff_scene_id: "n-settled",
            }),
            nativeForeshadow({
              id: "open-critical-old",
              updated_at: T,
            }),
            nativeForeshadow({
              id: "settled-critical",
              payoff_confirmed: 1,
              updated_at: T + 10,
              notes: "must not escape",
              secret: 1,
              payoff_scene_id: "n-secret",
            }),
            nativeForeshadow({
              id: "abandoned",
              payoff_confirmed: 1,
              abandoned: 1,
              notes: "must not escape",
              secret: 1,
              payoff_scene_id: "n-abandoned",
            }),
            nativeForeshadow({
              id: "open-critical-new",
              updated_at: T + 20,
            }),
          ],
          setups: [
            nativeSetup({ foreshadow_id: "settled-critical", scene_id: "n1" }),
            nativeSetup({
              foreshadow_id: "settled-critical",
              scene_id: "n2",
              is_orphan: 1,
            }),
          ],
        }),
      });
    const result = await executors.list_open_foreshadows({
      includeSettled: true,
    });

    expect(foreshadowListWithLabels).toHaveBeenCalledWith({ projectId: "p1" });
    expect(foreshadowListWithLabels).toHaveBeenCalledTimes(1);
    expect(foreshadowOpen).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    expect(result.content).toEqual([
      {
        id: "open-critical-new",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 0,
      },
      {
        id: "open-critical-old",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 0,
      },
      {
        id: "open-light",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "optional",
        setupCount: 0,
      },
      {
        id: "settled-critical",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 1,
        settled: true,
      },
      {
        id: "settled-light",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "optional",
        setupCount: 0,
        settled: true,
      },
    ]);
    expect(
      (result.content as Array<Record<string, unknown>>).map(Object.keys),
    ).toEqual([
      ["id", "title", "intent", "loadBearing", "setupCount"],
      ["id", "title", "intent", "loadBearing", "setupCount"],
      ["id", "title", "intent", "loadBearing", "setupCount"],
      ["id", "title", "intent", "loadBearing", "setupCount", "settled"],
      ["id", "title", "intent", "loadBearing", "setupCount", "settled"],
    ]);
    expect(JSON.stringify(result.content)).not.toMatch(
      /notes|secret|payoff_scene_id|scene_id/u,
    );
    expect(result.summary).toBe("5 foreshadowing items (2 settled)");
    expect(result.tokensUsed).toBe(JSON.stringify(result.content).length);
  });

  it.each([
    ["string", "true"],
    ["number", 1],
    ["null", null],
    ["undefined", undefined],
  ])(
    "rejects includeSettled with a %s value before reading",
    async (_label, includeSettled) => {
      const {
        executors,
        foreshadowOpen,
        foreshadowListWithLabels,
        getTreeState,
      } = makeCtx();
      await expect(
        executors.list_open_foreshadows({ includeSettled }),
      ).rejects.toThrow("includeSettled must be a boolean");
      expect(getTreeState).not.toHaveBeenCalled();
      expect(foreshadowOpen).not.toHaveBeenCalled();
      expect(foreshadowListWithLabels).not.toHaveBeenCalled();
    },
  );

  it("false and unknown input keys preserve the open-only result and port call", async () => {
    const { executors, foreshadowOpen, foreshadowListWithLabels } = makeCtx({
      foreshadowOpen: async () => ({
        foreshadows: [nativeForeshadow()],
        setups: [],
      }),
    });
    const result = await executors.list_open_foreshadows({
      includeSettled: false,
      futureOption: "ignored",
    });
    expect(result.content).toEqual([
      {
        id: "f1",
        title: "老魔術師の杖",
        intent: "杖が後で鍵になる",
        loadBearing: "critical",
        setupCount: 0,
      },
    ]);
    expect(result.summary).toBe("1 open foreshadowing items");
    expect(foreshadowOpen).toHaveBeenCalledWith({ projectId: "p1" });
    expect(foreshadowListWithLabels).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed wire instead of answering '0 open foreshadowing items'", async () => {
    for (const wire of [
      undefined,
      null,
      "x",
      {},
      { foreshadows: [] },
      { setups: [] },
      { foreshadows: [null], setups: [] },
      { foreshadows: [{ id: "f1" }], setups: [] },
      { foreshadows: [nativeForeshadow()], setups: [{}] },
    ]) {
      const { executors } = makeCtx({ foreshadowOpen: async () => wire });
      await expect(
        executors.list_open_foreshadows({}),
        JSON.stringify(wire) ?? String(wire),
      ).rejects.toThrow(/foreshadow_list_open_for_context/);
    }
  });

  it("does not catch a failure of the read (it reaches the caller)", async () => {
    const { executors } = makeCtx({
      foreshadowOpen: async () => {
        throw new Error("native is down");
      },
    });
    await expect(executors.list_open_foreshadows({})).rejects.toThrow(
      "native is down",
    );
  });

  it("takes the project once, when it runs, and passes that value on", async () => {
    let n = 0;
    const { executors, foreshadowOpen, getTreeState } = makeCtx({
      projectId: () => `p-${++n}`,
    });
    await executors.list_open_foreshadows({});
    expect(getTreeState).toHaveBeenCalledTimes(1);
    expect(foreshadowOpen).toHaveBeenCalledWith({ projectId: "p-1" });
  });
});

describe("get_foreshadow_detail", () => {
  const detailAnswers = () => ({
    foreshadows: [
      foreshadowRow({ payoff_scene_id: "n-pay", payoff_confirmed: 0 }),
    ],
    foreshadow_setups: [
      // sceneId, kind, strength, aiStrength, attribution, aiRationale, isOrphan, sceneTitle
      ["n1", "designated_existing", null, "subtle", "ai", null, 0, "出会い"],
      ["n2", "inserted_new", "overt", null, "human", "強調", 1, "旅立ち"],
    ],
    tree_nodes: [["n-pay", "裏切り"]],
  });

  it("answers an empty id before it looks at the project or reads anything", async () => {
    const { executors, captured, getTreeState } = makeCtx();
    const result = await executors.get_foreshadow_detail({ id: "  " });
    expect(result).toEqual({
      name: "get_foreshadow_detail",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    });
    expect(getTreeState).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
  });

  it("scopes the foreshadow to the project in the SQL (XPROJ), trims the id, and reports a missing one", async () => {
    const { executors, captured } = makeCtx();
    const result = await executors.get_foreshadow_detail({ id: " f1 " });
    expect(result).toEqual({
      name: "get_foreshadow_detail",
      content: null,
      summary: "Foreshadow not found",
      tokensUsed: 0,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toMatch(/from "foreshadows" where/u);
    expect(captured[0]!.sql).toMatch(/"foreshadows"\."id" = \?/u);
    expect(captured[0]!.sql).toMatch(/"foreshadows"\."project_id" = \?/u);
    expect(captured[0]!.params).toEqual(["f1", "p1"]);
  });

  it("builds the detail in the executor's key order, with the AI rating when there is no human one", async () => {
    const { executors, captured } = makeCtx({ answers: detailAnswers() });
    const result = await executors.get_foreshadow_detail({ id: "f1" });
    expect(result.content).toEqual({
      id: "f1",
      title: "老魔術師の杖",
      intent: "杖が後で鍵になる",
      notes: "作者だけのメモ",
      loadBearing: "critical",
      payoffConfirmed: false,
      abandoned: false,
      payoffScene: { id: "n-pay", title: "裏切り" },
      setups: [
        {
          sceneId: "n1",
          sceneTitle: "出会い",
          kind: "designated_existing",
          strength: "subtle",
          attribution: "ai",
          aiRationale: "",
          isOrphan: false,
        },
        {
          sceneId: "n2",
          sceneTitle: "旅立ち",
          kind: "inserted_new",
          strength: "overt",
          attribution: "human",
          aiRationale: "強調",
          isOrphan: true,
        },
      ],
    });
    expect(Object.keys(result.content as object)).toEqual([
      "id",
      "title",
      "intent",
      "notes",
      "loadBearing",
      "payoffConfirmed",
      "abandoned",
      "payoffScene",
      "setups",
    ]);
    expect(result.summary).toBe("老魔術師の杖: 2 setup(s), payoff planned");
    expect(result.tokensUsed).toBe(JSON.stringify(result.content).length);
    // Three statements in this order: the foreshadow, its setups joined to the scenes
    // (where the foreshadow id and a scene that is not archived), the payoff scene
    // (by id, and not archived).
    expect(captured.map((c) => /from "([a-z_]+)"/u.exec(c.sql)![1])).toEqual([
      "foreshadows",
      "foreshadow_setups",
      "tree_nodes",
    ]);
    expect(captured[1]!.sql).toMatch(
      /inner join "tree_nodes" on "foreshadow_setups"\."scene_id" = "tree_nodes"\."id"/u,
    );
    expect(captured[1]!.params).toEqual(["f1"]);
    expect(captured[2]!.params).toEqual(["n-pay"]);
    for (const { sql } of captured) {
      expect(checkReadSql(sql, MAIN_READ_TABLE_SET), sql).toMatchObject({
        ok: true,
      });
    }
  });

  it("asks for the setups of live scenes only: a setup on an archived scene is not handed to the model (DR-MP4-36)", async () => {
    // The scripted client does not evaluate SQL. This fixes the statement (the join and the
    // condition on the scene); the rows on a real SQLite are fixed by the golden
    // (`toolExecutors.legacyGolden.test.ts`) and on the real addon (`mastraReadParity.pipeline.spec.ts`).
    const { executors, captured } = makeCtx({ answers: detailAnswers() });
    await executors.get_foreshadow_detail({ id: "f1" });
    const setups = captured[1]!.sql;
    expect(setups).toMatch(/from "foreshadow_setups"/u);
    expect(setups).toMatch(
      /"foreshadow_setups"\."foreshadow_id" = \? and "tree_nodes"\."archived_at" is null/u,
    );
    expect(captured[1]!.params).toEqual(["f1"]);
  });

  it("asks for the payoff scene only when it is live: the statement has the archived condition, by id and nothing else (DR-MP4-36)", async () => {
    // Same as the setups above: the scripted client does not evaluate SQL, so this fixes the
    // statement. The rows are fixed by the golden and on the real addon.
    const { executors, captured } = makeCtx({ answers: detailAnswers() });
    await executors.get_foreshadow_detail({ id: "f1" });
    const payoff = captured[2]!.sql;
    expect(payoff).toMatch(/from "tree_nodes"/u);
    expect(payoff).not.toMatch(/join/u);
    expect(payoff).toMatch(
      /"tree_nodes"\."id" = \? and "tree_nodes"\."archived_at" is null/u,
    );
    expect(captured[2]!.params).toEqual(["n-pay"]);
  });

  it("an archived payoff scene comes back as no row: payoffScene null, the summary says unset, and the id is not in the result (DR-MP4-36)", async () => {
    // The statement above leaves the archived scene out, so the tool gets no row (as for a
    // payoff scene that has no row): the scripted answer for tree_nodes is empty.
    const { executors } = makeCtx({
      answers: {
        ...detailAnswers(),
        tree_nodes: [],
      },
    });
    const result = await executors.get_foreshadow_detail({ id: "f1" });
    expect((result.content as { payoffScene: unknown }).payoffScene).toBeNull();
    expect(JSON.stringify(result.content)).not.toContain("n-pay");
    expect(result.summary).toBe("老魔術師の杖: 2 setup(s), payoff unset");
  });

  it("a confirmed payoff on an archived scene is `payoff confirmed` with payoffScene null (DR-MP4-36)", async () => {
    const { executors } = makeCtx({
      answers: {
        foreshadows: [
          foreshadowRow({ payoff_scene_id: "n-pay", payoff_confirmed: 1 }),
        ],
        tree_nodes: [],
      },
    });
    const result = await executors.get_foreshadow_detail({ id: "f1" });
    expect(result.content).toMatchObject({
      payoffConfirmed: true,
      payoffScene: null,
    });
    expect(result.summary).toBe("老魔術師の杖: 0 setup(s), payoff confirmed");
  });

  it("a live payoff scene stays `payoff planned` with its id and title (DR-MP4-36)", async () => {
    const { executors } = makeCtx({ answers: detailAnswers() });
    const result = await executors.get_foreshadow_detail({ id: "f1" });
    expect((result.content as { payoffScene: unknown }).payoffScene).toEqual({
      id: "n-pay",
      title: "裏切り",
    });
    expect(result.summary).toBe("老魔術師の杖: 2 setup(s), payoff planned");
  });

  it("returns an explicitly requested secret foreshadow and its notes", async () => {
    const { executors } = makeCtx({
      answers: {
        foreshadows: [
          foreshadowRow({
            id: "f-secret",
            title: "黒幕の伏線",
            intent: "黒幕は最初から出ている",
            notes: "犯人の名前",
            secret: 1,
            load_bearing: "supporting",
          }),
        ],
      },
    });
    const result = await executors.get_foreshadow_detail({ id: "f-secret" });
    expect(result.content).toMatchObject({
      id: "f-secret",
      intent: "黒幕は最初から出ている",
      notes: "犯人の名前",
      loadBearing: "supporting",
    });
    expect(result.summary).toBe("黒幕の伏線: 0 setup(s), payoff unset");
  });

  it("says confirmed when the payoff is confirmed, and does not read a payoff scene that is not set", async () => {
    const { executors, captured } = makeCtx({
      answers: { foreshadows: [foreshadowRow({ payoff_confirmed: 1 })] },
    });
    const result = await executors.get_foreshadow_detail({ id: "f1" });
    expect(result.summary).toBe("老魔術師の杖: 0 setup(s), payoff confirmed");
    expect((result.content as { payoffScene: unknown }).payoffScene).toBeNull();
    expect(captured).toHaveLength(2);
  });

  it("takes the project once, and does not call Native", async () => {
    let n = 0;
    const { executors, getTreeState, foreshadowOpen, fts, captured } = makeCtx({
      projectId: () => `p-${++n}`,
      answers: detailAnswers(),
    });
    await executors.get_foreshadow_detail({ id: "f1" });
    expect(getTreeState).toHaveBeenCalledTimes(1);
    expect(captured[0]!.params).toEqual(["f1", "p-1"]);
    expect(foreshadowOpen).not.toHaveBeenCalled();
    expect(fts).not.toHaveBeenCalled();
  });
});
