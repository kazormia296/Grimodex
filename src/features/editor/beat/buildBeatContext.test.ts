// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));

import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import type { CodexEntry } from "@/features/codex/api";
import {
  buildBeatCodexSummaries,
  buildBeatContextForGeneration,
} from "./buildBeatContext";

function makeEntry(
  id: string,
  name: string,
  summary: string | null,
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
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as CodexEntry;
}

function createEditorWithBeat(
  content: Record<string, unknown>[] = [
    { type: "text", text: "雨の夜、廃社の前で立ち止まる朱音" },
  ],
) {
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

describe("buildBeatContextForGeneration — codexSummaries", () => {
  beforeEach(() => {
    useTreeStore.setState({
      nodes: [
        {
          id: "scene-1",
          projectId: "p1",
          parentId: null,
          nodeType: "scene",
          title: "第1話",
          synopsis: null,
          intent: null,
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",
          charCount: 0,
          updatedAt: "2026-01-01",
        },
      ],
    });
    useWorkspaceStore.setState({ activeWorkspaceName: "テスト作品" });
    useCodexStore.setState({
      entries: [
        makeEntry("char-akane", "朱音", "主人公。雨を嫌う。"),
        makeEntry("char-rin", "凛", "朱音の幼馴染。"),
        makeEntry("char-empty", "名無し", null),
      ],
    });
    useCodexHighlightStore.setState({ matchedEntryIds: [] });
  });

  it("シーンで検出済みの codex (matchedEntryIds) の name: summary を含める", async () => {
    const editor = createEditorWithBeat();
    useCodexHighlightStore.setState({ matchedEntryIds: ["char-akane"] });

    const result = await buildBeatContextForGeneration(editor, "b1", "scene-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toContain("- 朱音: 主人公。雨を嫌う。");
      expect(result.ctx.codexSummaries).not.toContain("凛");
    }
    editor.destroy();
  });

  it("beat 内の @mention codex は matchedEntryIds に無くても含める", async () => {
    const editor = createEditorWithBeat([
      {
        type: "mention",
        attrs: { id: "char-rin", label: "凛", role: "actor" },
      },
      { type: "text", text: " が裏切る" },
    ]);

    const result = await buildBeatContextForGeneration(editor, "b1", "scene-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toContain("- 凛: 朱音の幼馴染。");
      expect(result.ctx.instructions).toBe("@凛 が裏切る");
    }
    editor.destroy();
  });

  it("検出 codex が無ければ codexSummaries は空文字", async () => {
    const editor = createEditorWithBeat();
    const result = await buildBeatContextForGeneration(editor, "b1", "scene-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.codexSummaries).toBe("");
    }
    editor.destroy();
  });

  it("mention のみの beat は instructions 非空として生成へ進む", async () => {
    const editor = createEditorWithBeat([
      {
        type: "mention",
        attrs: { id: "char-akane", label: "朱音", role: "actor" },
      },
    ]);
    const result = await buildBeatContextForGeneration(editor, "b1", "scene-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.instructions).toBe("@朱音");
    }
    editor.destroy();
  });
});

describe("buildBeatCodexSummaries", () => {
  it("matchedIds が空なら空文字", () => {
    expect(buildBeatCodexSummaries([], [makeEntry("a", "A", "s")])).toBe("");
  });

  it("summary が空のエントリは除外する", () => {
    const out = buildBeatCodexSummaries(
      ["a", "b"],
      [makeEntry("a", "A", "  "), makeEntry("b", "B", "概要B")],
    );
    expect(out).toBe("- B: 概要B");
  });

  it("合計 3000 字を超える行は打ち切る (inline AI と同水準の cap)", () => {
    const long = "あ".repeat(2950);
    const out = buildBeatCodexSummaries(
      ["a", "b"],
      [makeEntry("a", "A", long), makeEntry("b", "B", "い".repeat(100))],
    );
    expect(out).toContain("- A: ");
    expect(out).not.toContain("- B: ");
  });
});
