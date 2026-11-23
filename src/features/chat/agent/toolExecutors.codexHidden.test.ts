import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex の hidden（AI に秘匿）は、agent tool のどの読み出しでも model に渡らない。
// where を解釈しない fake db が、project の全 Codex を返す。hidden の除外は
// executor 側の責務なので、除外されなければ hidden の行が結果に残る。

interface FakeEntry {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  type: string;
  aliases: string | null;
  summary: string | null;
  content: string;
  tagsCache: string | null;
  contextMode: string;
}

const h = vi.hoisted(() => ({
  entries: [] as FakeEntry[],
  invoke: vi.fn(),
  activeSceneId: "scene-1" as string | null,
  phases: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<Record<string, unknown>>,
  defs: [] as Array<Record<string, unknown>>,
  vals: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "proj-A", activeSceneId: h.activeSceneId }),
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-A",
}));
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async (ids: string[]) =>
    h.phases.filter((p) => ids.includes(String(p["entryId"]))),
  listDetailOverridesByPhaseIds: async (ids: string[]) =>
    h.overrides.filter((o) => ids.includes(String(o["phaseId"]))),
}));
vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: (s: string) => s,
}));
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));
vi.mock("@/features/tree/api", () => ({ loadSceneContent: vi.fn() }));
vi.mock("@/features/agent-writes/codex", () => ({
  agentCreateCodexEntry: vi.fn(),
  agentUpdateCodexEntry: vi.fn(),
}));
vi.mock("@/features/agent-writes/snippet", () => ({
  agentCreateSnippet: vi.fn(),
}));
vi.mock("@/features/agent-writes/foreshadow", () => ({
  agentCreateForeshadow: vi.fn(),
  agentUpdateForeshadow: vi.fn(),
}));
vi.mock("@/features/agent-writes/event", () => ({
  agentCreateEvent: vi.fn(),
  agentUpdateEvent: vi.fn(),
  agentDeleteEvent: vi.fn(),
  agentSetEventParticipants: vi.fn(),
  agentLinkSceneEvent: vi.fn(),
  agentUnlinkSceneEvent: vi.fn(),
  agentAddEventRelation: vi.fn(),
  agentRemoveEventRelation: vi.fn(),
}));
vi.mock("@/features/foreshadow/api", () => ({
  listOpenForeshadowsForContext: vi.fn(),
}));

vi.mock("@/db/client", async () => {
  const { codexEntries, codexDetailDefinitions, codexDetailValues } =
    await import("@/db/schema");
  const project = (cols: Record<string, unknown> | undefined) =>
    h.entries.map((entry) => {
      if (!cols) return { ...entry };
      const row: Record<string, unknown> = {};
      for (const key of Object.keys(cols)) {
        row[key] = (entry as unknown as Record<string, unknown>)[key];
      }
      return row;
    });
  const query = (cols: Record<string, unknown> | undefined) => {
    let table: unknown;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (
        resolve: (v: unknown[]) => unknown,
        reject: (r: unknown) => unknown,
      ) =>
        Promise.resolve(
          table === codexEntries
            ? project(cols)
            : table === codexDetailDefinitions
              ? h.defs
              : table === codexDetailValues
                ? h.vals
                : [],
        ).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: query, selectDistinct: query } };
});

import { executeTool, executeReadOnlyTool } from "./toolExecutors";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const entry = (over: Partial<FakeEntry> & { id: string }): FakeEntry => ({
  projectId: "proj-A",
  parentId: null,
  name: over.id,
  type: "character",
  aliases: null,
  summary: `${over.id} の要約`,
  content: `${over.id} の本文`,
  tagsCache: JSON.stringify([{ name: "t" }]),
  contextMode: "mentioned",
  ...over,
});

const VISIBLE = entry({ id: "e-visible", name: "公開の人物" });
const HIDDEN = entry({
  id: "e-hidden",
  name: "秘匿の人物",
  summary: "作者が秘匿した要約",
  contextMode: "hidden",
});
const SUPPRESS = entry({ id: "e-suppress", contextMode: "suppress" });

function ids(content: unknown): string[] {
  return (content as Array<{ id: string }>).map((r) => r.id);
}

beforeEach(() => {
  h.entries = [VISIBLE, HIDDEN, SUPPRESS];
  h.phases = [];
  h.overrides = [];
  h.defs = [];
  h.vals = [];
  h.activeSceneId = "scene-1";
  h.invoke.mockReset();
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "fts_search") {
      return Promise.resolve([
        { sourceType: "codex", id: "e-visible" },
        { sourceType: "codex", id: "e-hidden" },
      ]);
    }
    return Promise.resolve([]);
  });
  usePhaseStore.setState({
    sceneTimeIndex: buildSceneTimeIndex([]),
    resolutionMode: "reading",
  });
  setCurrentWorkspaceIdentity({
    path: "/workspace/codex-hidden-test",
    openRevision: 1,
  });
});

describe("agent tool は hidden の Codex を model に渡さない", () => {
  it("search_codex: FTS 経路", async () => {
    const res = await executeTool("search_codex", "c", {
      query: "ドラクタール",
    });
    expect(res.error).toBeUndefined();
    expect(ids(res.content)).toContain("e-visible");
    expect(ids(res.content)).not.toContain("e-hidden");
    expect(JSON.stringify(res)).not.toContain("作者が秘匿した要約");
  });

  it("search_codex: LIKE 経路（短い語）", async () => {
    const res = await executeTool("search_codex", "c", { query: "龍" });
    expect(ids(res.content)).not.toContain("e-hidden");
  });

  it("search_codex: dense だけが hidden を返しても落とす", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "codex_semantic_search") {
        return Promise.resolve([
          {
            entryId: "e-hidden",
            entryName: "秘匿の人物",
            entryType: "character",
            summary: "作者が秘匿した要約",
            score: 0.99,
          },
        ]);
      }
      if (cmd === "fts_search") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const res = await executeTool("search_codex", "c", { query: "龍" });
    expect(ids(res.content)).not.toContain("e-hidden");
    expect(JSON.stringify(res)).not.toContain("作者が秘匿した要約");
  });

  it("list_codex_by_type", async () => {
    const res = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    expect(ids(res.content)).toContain("e-visible");
    expect(ids(res.content)).not.toContain("e-hidden");
  });

  it("search_codex_by_tags", async () => {
    const res = await executeTool("search_codex_by_tags", "c", {
      tags: ["t"],
    });
    expect(ids(res.content)).toContain("e-visible");
    expect(ids(res.content)).not.toContain("e-hidden");
  });

  it("find_related_entries: 結果から hidden を落とす", async () => {
    h.entries = [VISIBLE, HIDDEN];
    const res = await executeTool("find_related_entries", "c", {
      id: "e-visible",
    });
    expect(ids(res.content)).not.toContain("e-hidden");
  });

  it("find_related_entries: 起点が hidden なら存在しない id と同じ応答", async () => {
    const missing = await executeTool("find_related_entries", "c", {
      id: "e-none",
    });
    h.entries = [HIDDEN, VISIBLE];
    const res = await executeTool("find_related_entries", "c", {
      id: "e-hidden",
    });
    // fake db は where を解釈しないので、missing は空の project で作る。
    h.entries = [];
    const absent = await executeTool("find_related_entries", "c", {
      id: "e-hidden",
    });
    expect(missing.summary).toBe(absent.summary);
    expect(res.summary).toBe(absent.summary);
    expect(res.content).toEqual(absent.content);
  });

  it("get_codex_entry: hidden は存在しない id と同じ応答（本体を返さない）", async () => {
    h.entries = [];
    const absent = await executeTool("get_codex_entry", "c", {
      id: "e-hidden",
    });
    h.entries = [HIDDEN];
    const res = await executeTool("get_codex_entry", "c", { id: "e-hidden" });
    expect(res.content).toEqual(absent.content);
    expect(res.summary).toBe(absent.summary);
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("作者が秘匿した要約");
    expect(JSON.stringify(res)).not.toContain("e-hidden の本文");
  });

  it("get_codex_entry: children の hidden も落とす", async () => {
    const parent = entry({ id: "e-parent", name: "親" });
    const child = entry({ id: "e-child", parentId: "e-parent" });
    const hiddenChild = entry({
      id: "e-hidden-child",
      parentId: "e-parent",
      contextMode: "hidden",
      summary: "秘匿の子の要約",
    });
    h.entries = [parent, child, hiddenChild];
    const res = await executeTool("get_codex_entry", "c", { id: "e-parent" });
    const childIds = ids((res.content as { children: unknown }).children);
    expect(childIds).toContain("e-child");
    expect(childIds).not.toContain("e-hidden-child");
    expect(JSON.stringify(res)).not.toContain("秘匿の子の要約");
  });

  it("sub-agent（executeReadOnlyTool）も同じ", async () => {
    const res = await executeReadOnlyTool("list_codex_by_type", "c", {
      type: "character",
    });
    expect(ids(res.content)).not.toContain("e-hidden");
  });

  it("hidden 以外（suppress・mentioned）は今のまま渡す", async () => {
    const res = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    expect(ids(res.content)).toEqual(["e-visible", "e-suppress"]);
  });

  it("現在の場面の Phase が hidden にした Codex も落とす", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "proj-A",
      parentId: null,
      nodeType: "scene" as const,
      title: id,
      synopsis: null,
      intent: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([
        node("scene-1", "a0"),
        node("scene-2", "a1"),
      ]),
      resolutionMode: "reading",
    });
    h.entries = [VISIBLE];
    h.phases = [
      {
        id: "ph-1",
        entryId: "e-visible",
        anchorNodeId: "scene-2",
        label: "後半",
        summaryOverride: null,
        contentOverride: null,
        contextModeOverride: "hidden",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    h.activeSceneId = "scene-1";
    const before = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    expect(ids(before.content)).toEqual(["e-visible"]);
    h.activeSceneId = "scene-2";
    const after = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    expect(ids(after.content)).toEqual([]);
  });

  it("既知の穴（DR-MP4-46 が閉じる。直す前の挙動）：起点の場面を失った（NULL・読む順に無い）hidden の Phase は効かず、場面が解決できても公開のまま渡る", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "proj-A",
      parentId: null,
      nodeType: "scene" as const,
      title: id,
      synopsis: null,
      intent: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([node("scene-1", "a0")]),
      resolutionMode: "reading",
    });
    const orphan = (
      id: string,
      entryId: string,
      anchorNodeId: string | null,
    ) => ({
      id,
      entryId,
      anchorNodeId,
      label: id,
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride: "hidden",
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    h.entries = [
      entry({ id: "e-null" }),
      entry({ id: "e-gone" }),
      entry({ id: "e-valid" }),
    ];
    h.phases = [
      orphan("ph-null", "e-null", null),
      orphan("ph-gone", "e-gone", "deleted-scene"),
      orphan("ph-valid", "e-valid", "scene-1"),
    ];
    h.activeSceneId = "scene-1";
    const res = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    // e-valid の Phase は scene-1 で効いて hidden。起点を失った 2 つは skip され公開のまま。
    expect(ids(res.content)).toEqual(["e-null", "e-gone"]);
  });

  it("Phase が hidden を解除した Codex は base の hidden の文でなく Phase 解決後の文を返す", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "proj-A",
      parentId: null,
      nodeType: "scene" as const,
      title: id,
      synopsis: null,
      intent: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([
        node("scene-1", "a0"),
        node("scene-2", "a1"),
      ]),
      resolutionMode: "reading",
    });
    h.entries = [
      entry({
        id: "e-reveal",
        summary: "base の秘匿の要約",
        content: "base の秘匿の本文",
        contextMode: "hidden",
      }),
    ];
    h.phases = [
      {
        id: "ph-reveal",
        entryId: "e-reveal",
        anchorNodeId: "scene-2",
        label: "公開",
        summaryOverride: "公開された要約",
        contentOverride: "公開された本文",
        contextModeOverride: "mentioned",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    h.activeSceneId = "scene-2";
    const got = await executeTool("get_codex_entry", "c", { id: "e-reveal" });
    const list = await executeTool("list_codex_by_type", "c", {
      type: "character",
    });
    for (const res of [got, list]) {
      const text = JSON.stringify(res);
      expect(text).toContain("公開された要約");
      expect(text).not.toContain("base の秘匿の要約");
      expect(text).not.toContain("base の秘匿の本文");
    }
    expect(JSON.stringify(got)).toContain("公開された本文");
    // 解除の前の場面では hidden のまま。
    h.activeSceneId = "scene-1";
    const before = await executeTool("get_codex_entry", "c", {
      id: "e-reveal",
    });
    expect(before.content).toBeNull();
  });
  describe("Phase 解決後の文・詳細", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "proj-A",
      parentId: null,
      nodeType: "scene" as const,
      title: id,
      synopsis: null,
      intent: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const phase = (entryId: string, over: Record<string, unknown>) => ({
      id: `ph-${entryId}`,
      entryId,
      anchorNodeId: "scene-2",
      label: "後半",
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
    beforeEach(() => {
      usePhaseStore.setState({
        sceneTimeIndex: buildSceneTimeIndex([
          node("scene-1", "a0"),
          node("scene-2", "a1"),
        ]),
        resolutionMode: "reading",
      });
      h.activeSceneId = "scene-2";
      h.defs = [
        {
          id: "d-secret",
          name: "正体",
          typeSlug: "character",
          includeInContext: true,
        },
        {
          id: "d-age",
          name: "年齢",
          typeSlug: "character",
          includeInContext: true,
        },
      ];
    });

    it("get_codex_entry: Phase で解除された hidden の詳細は base でなく解決後（null は消去）", async () => {
      h.entries = [
        entry({ id: "e-reveal", contextMode: "hidden", summary: "base" }),
      ];
      h.vals = [
        {
          entryId: "e-reveal",
          definitionId: "d-secret",
          value: "base の秘匿の正体",
        },
        {
          entryId: "e-reveal",
          definitionId: "d-age",
          value: "base の秘匿の年齢",
        },
      ];
      h.phases = [phase("e-reveal", { contextModeOverride: "mentioned" })];
      h.overrides = [
        {
          id: "o1",
          phaseId: "ph-e-reveal",
          definitionId: "d-secret",
          value: "公開された正体",
        },
        {
          id: "o2",
          phaseId: "ph-e-reveal",
          definitionId: "d-age",
          value: null,
        },
      ];
      const res = await executeTool("get_codex_entry", "c", { id: "e-reveal" });
      const details = (
        res.content as { details: Array<{ field: string; value: unknown }> }
      ).details;
      expect(details).toEqual([
        { field: "正体", value: "公開された正体" },
        { field: "年齢", value: null },
      ]);
      expect(JSON.stringify(res)).not.toContain("base の秘匿");
    });

    it("hidden でない項目の詳細は Phase の override があっても base のまま（範囲を足さない）", async () => {
      h.entries = [entry({ id: "e-ok", contextMode: "mentioned" })];
      h.vals = [
        { entryId: "e-ok", definitionId: "d-secret", value: "base の正体" },
      ];
      h.phases = [phase("e-ok", {})];
      h.overrides = [
        {
          id: "o1",
          phaseId: "ph-e-ok",
          definitionId: "d-secret",
          value: "Phase の正体",
        },
      ];
      const res = await executeTool("get_codex_entry", "c", { id: "e-ok" });
      const details = (
        res.content as { details: Array<{ field: string; value: unknown }> }
      ).details;
      expect(details).toContainEqual({ field: "正体", value: "base の正体" });
    });

    it("hidden でない項目の文は Phase の override があっても base のまま（8 経路の代表）", async () => {
      for (const mode of ["always", "mentioned", "suppress"]) {
        const id = `e-${mode}`;
        h.entries = [
          entry({
            id,
            contextMode: mode,
            summary: "base の要約",
            content: "base の本文",
          }),
        ];
        h.phases = [
          phase(id, {
            summaryOverride: "Phase の要約",
            contentOverride: "Phase の本文",
          }),
        ];
        const got = await executeTool("get_codex_entry", "c", { id });
        const content = got.content as { summary: string; body: string };
        expect(content.summary).toBe("base の要約");
        expect(content.body).toBe("base の本文");
        for (const tool of ["list_codex_by_type", "search_codex_by_tags"]) {
          const res = await executeTool(tool, "c", {
            type: "character",
            tags: ["t"],
          });
          expect(JSON.stringify(res.content)).toContain("base の要約");
          expect(JSON.stringify(res.content)).not.toContain("Phase の要約");
        }
        const search = await executeTool("search_codex", "c", { query: "龍" });
        expect(JSON.stringify(search.content)).toContain("base の要約");
        expect(JSON.stringify(search.content)).not.toContain("Phase の要約");
      }
    });

    it("search_codex: summary は null にならず空文字（Phase 解除で summary が null でも）", async () => {
      h.entries = [
        entry({ id: "e-r", contextMode: "hidden", summary: "base" }),
      ];
      h.phases = [
        phase("e-r", {
          contextModeOverride: "mentioned",
          summaryOverride: null,
        }),
      ];
      const res = await executeTool("search_codex", "c", { query: "龍" });
      for (const row of res.content as Array<{ summary: unknown }>) {
        expect(typeof row.summary).toBe("string");
      }
    });
  });
});
