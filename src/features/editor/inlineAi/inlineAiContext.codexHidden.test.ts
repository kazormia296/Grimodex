import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import type { Editor } from "@tiptap/core";

// インライン AI が AI へ送る Codex の要約は、作者が hidden（AI に秘匿）と印したものを含まない。

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    summary: string | null;
    contextMode: string;
  }>,
  phases: [] as Array<Record<string, unknown>>,
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
        Promise.resolve(table === codexEntries ? h.rows : []).then(
          resolve,
          reject,
        ),
    };
    return chain;
  };
  return { db: { select: query } };
});

import { buildInlineAiContextForSend } from "./inlineAiContext";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";

function editorLike(text: string): Editor {
  const state = EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
  });
  const withSel = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1, 1)),
  );
  return {
    state: withSel,
    getText: () => withSel.doc.textBetween(0, withSel.doc.content.size, "\n"),
  } as unknown as Editor;
}

const ENTRIES = [
  { id: "a", name: "Alice", summary: "勇敢な騎士", contextMode: "mentioned" },
  {
    id: "b",
    name: "Bob",
    summary: "作者が秘匿した要約",
    contextMode: "hidden",
  },
  {
    id: "c",
    name: "Carol",
    summary: "suppress の要約",
    contextMode: "suppress",
  },
];

describe("buildInlineAiContextForSend", () => {
  beforeEach(() => {
    h.rows = ENTRIES.map(({ id, summary, contextMode }) => ({
      id,
      summary,
      contextMode,
    }));
  });

  it("検出済みの hidden は要約を渡さない（それ以外は今のまま）", async () => {
    const ctx = await buildInlineAiContextForSend({
      editor: editorLike("x"),
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: ["a", "b", "c"],
      codexEntries: ENTRIES,
      projectId: "p1",
      sceneId: "scene-1",
    });
    expect(ctx.codexSummaries).toBe(
      "- Alice: 勇敢な騎士\n- Carol: suppress の要約",
    );
    expect(ctx.codexSummaries).not.toContain("作者が秘匿した要約");
  });

  it("場面でない（sceneId なし）編集でも hidden を渡さない", async () => {
    const ctx = await buildInlineAiContextForSend({
      editor: editorLike("x"),
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: ["b"],
      codexEntries: ENTRIES,
    });
    expect(ctx.codexSummaries).toBe("");
  });
});

describe("Phase が hidden を解除した Codex", () => {
  it("base の hidden の要約でなく Phase 解決後の要約を渡す", async () => {
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
    h.rows = [
      { id: "b", summary: "作者が秘匿した要約", contextMode: "hidden" },
    ];
    h.phases = [
      {
        id: "ph",
        entryId: "b",
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
    const send = (sceneId: string) =>
      buildInlineAiContextForSend({
        editor: editorLike("x"),
        projectTitle: "P",
        sceneTitle: "S",
        matchedCodexIds: ["b"],
        codexEntries: ENTRIES,
        projectId: "p1",
        sceneId,
      });
    expect((await send("scene-2")).codexSummaries).toBe(
      "- Bob: 公開された要約",
    );
    expect((await send("scene-1")).codexSummaries).toBe("");
    h.phases = [];
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
    h.rows = ENTRIES.map(({ id, summary, contextMode }) => ({
      id,
      summary,
      contextMode,
    }));
    h.phases = ["a", "c"].map((entryId) => ({
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
    const ctx = await buildInlineAiContextForSend({
      editor: editorLike("x"),
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: ["a", "c"],
      codexEntries: ENTRIES,
      projectId: "p1",
      sceneId: "scene-2",
    });
    expect(ctx.codexSummaries).toBe(
      "- Alice: 勇敢な騎士\n- Carol: suppress の要約",
    );
    h.phases = [];
  });
});

describe("インライン AI の送信経路は hidden 判定を通る", () => {
  const root = resolve(__dirname, "../..");
  for (const file of ["editor/EditorPane.tsx", "editor/useLinearInlineAi.ts"]) {
    it(`${file} は buildInlineAiContext を直接呼ばず、buildInlineAiContextForSend を使う`, () => {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/\bbuildInlineAiContext\(/);
      expect(source).toMatch(/\bbuildInlineAiContextForSend\(/);
      // 非同期の context は、送る前の鮮度の検査と reject の処理（sendWhenFresh）を通す。
      expect(source).not.toMatch(
        /buildInlineAiContextForSend\([\s\S]*?\}\)\.then\(/,
      );
      expect(source).toMatch(/\bsendWhenFresh\(/);
    });
  }
});
