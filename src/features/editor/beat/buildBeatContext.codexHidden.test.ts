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
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async () => [],
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
});
