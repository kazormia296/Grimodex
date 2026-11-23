// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// beat が AI へ送る Codex の要約は、作者が hidden（AI に秘匿）と印したものを含まない。
// DB は where を解釈しない fake で、project の全 Codex を返す。

interface FakeRow {
  id: string;
  summary: string | null;
  contextMode: string;
}

const h = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  failDb: false,
  phases: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async (ids: string[]) =>
    h.phases.filter((p) => ids.includes(String(p["entryId"]))),
}));
vi.mock("@/db/client", async () => {
  const { codexEntries } = await import("@/db/schema");
  const query = () => {
    let table: unknown;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      then: (
        resolve: (v: unknown[]) => unknown,
        reject: (r: unknown) => unknown,
      ) =>
        (h.failDb
          ? Promise.reject(new Error("db down"))
          : Promise.resolve(table === codexEntries ? h.rows : [])
        ).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: query } };
});

import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import type { CodexEntry } from "@/features/codex/api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { buildBeatContextForGeneration } from "./buildBeatContext";

function makeEntry(
  id: string,
  name: string,
  summary: string,
  contextMode: string,
): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type: "character",
    name,
    summary,
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    tagsCache: null,
    contextMode,
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as CodexEntry;
}

function createEditorWithBeat(content: Record<string, unknown>[]) {
  const editor = new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: "<p>シーン冒頭の文。</p>",
  });
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content,
    })
    .run();
  return editor;
}

describe("buildBeatContextForGeneration — hidden の Codex", () => {
  beforeEach(() => {
    h.failDb = false;
    h.phases = [];
    const entries = [
      makeEntry("char-akane", "朱音", "主人公。雨を嫌う。", "mentioned"),
      makeEntry("char-rin", "凛", "作者が秘匿した要約", "hidden"),
      makeEntry("char-sup", "雫", "suppress の要約", "suppress"),
    ];
    h.rows = entries.map((e) => ({
      id: e.id,
      summary: e.summary,
      contextMode: e.contextMode,
    }));
    useCodexStore.setState({ entries });
    useWorkspaceStore.setState({ activeWorkspaceName: "テスト作品" });
    useTreeStore.setState({ nodes: [] });
    useCodexHighlightStore.setState({ matchedEntryIds: [] });
  });

  it("検出済みの hidden は要約を渡さない（それ以外は今のまま）", async () => {
    const editor = createEditorWithBeat([{ type: "text", text: "雨の夜" }]);
    useCodexHighlightStore.setState({
      matchedEntryIds: ["char-akane", "char-rin", "char-sup"],
    });
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-1",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toContain("- 朱音: 主人公。雨を嫌う。");
      expect(result.ctx.codexSummaries).toContain("- 雫: suppress の要約");
      expect(result.ctx.codexSummaries).not.toContain("凛");
      expect(result.ctx.codexSummaries).not.toContain("作者が秘匿した要約");
    }
    editor.destroy();
  });

  it("beat の @mention 経由の hidden も要約を渡さない", async () => {
    const editor = createEditorWithBeat([
      {
        type: "mention",
        attrs: { id: "char-rin", label: "凛", role: "actor" },
      },
      { type: "text", text: " が裏切る" },
    ]);
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-1",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toBe("");
    }
    editor.destroy();
  });

  it("hidden の判定に失敗したら fail-closed で要約を渡さず、生成の文脈は作る", async () => {
    h.failDb = true;
    const editor = createEditorWithBeat([{ type: "text", text: "雨の夜" }]);
    useCodexHighlightStore.setState({ matchedEntryIds: ["char-akane"] });
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-1",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.codexSummaries).toBe("");
    editor.destroy();
  });
  it("hidden でない項目の要約は Phase の summaryOverride があっても base のまま", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "p1",
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
    h.phases = ["char-akane", "char-sup"].map((entryId) => ({
      id: `ph-${entryId}`,
      entryId,
      anchorNodeId: "scene-2",
      label: "後半",
      summaryOverride: "Phase の要約",
      contentOverride: null,
      contextModeOverride: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    }));
    const editor = createEditorWithBeat([{ type: "text", text: "雨の夜" }]);
    useCodexHighlightStore.setState({
      matchedEntryIds: ["char-akane", "char-sup"],
    });
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-2",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toContain("- 朱音: 主人公。雨を嫌う。");
      expect(result.ctx.codexSummaries).toContain("- 雫: suppress の要約");
      expect(result.ctx.codexSummaries).not.toContain("Phase の要約");
    }
    editor.destroy();
  });

  it("Phase で hidden が解除された項目は解決後の要約を渡す", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "p1",
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
    h.phases = [
      {
        id: "ph-rin",
        entryId: "char-rin",
        anchorNodeId: "scene-2",
        label: "公開",
        summaryOverride: "公開された要約",
        contentOverride: null,
        contextModeOverride: "mentioned",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const editor = createEditorWithBeat([{ type: "text", text: "雨の夜" }]);
    useCodexHighlightStore.setState({ matchedEntryIds: ["char-rin"] });
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-2",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toBe("- 凛: 公開された要約");
    }
    editor.destroy();
  });

  it("既知の穴（DR-MP4-46 が閉じる。直す前の挙動）：起点の場面を失った（NULL）hidden の Phase は効かず、場面が読む順に有れば要約を渡す", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([
        {
          id: "scene-1",
          projectId: "p1",
          parentId: null,
          nodeType: "scene" as const,
          title: "scene-1",
          synopsis: null,
          intent: null,
          sortOrder: "a0",
          status: null,
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          charCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      ]),
      resolutionMode: "reading",
    });
    h.phases = [
      {
        id: "ph-akane",
        entryId: "char-akane",
        anchorNodeId: null,
        label: "起点なし",
        summaryOverride: null,
        contentOverride: null,
        contextModeOverride: "hidden",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const editor = createEditorWithBeat([{ type: "text", text: "雨の夜" }]);
    useCodexHighlightStore.setState({ matchedEntryIds: ["char-akane"] });
    const result = await buildBeatContextForGeneration(
      editor,
      "b1",
      "scene-1",
      "p1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toBe("- 朱音: 主人公。雨を嫌う。");
    }
    editor.destroy();
  });
});
