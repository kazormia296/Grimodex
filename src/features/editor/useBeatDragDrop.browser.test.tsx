/**
 * useBeatDragDrop.onDragEnd の placed-beat-move 分岐 (useBeatDragDrop.ts:110-132) を
 * 実 Chromium で gate する。この分岐だけは
 *   finalX/Y = activator + delta → ed.view.posAtCoords(...) → moveBeatToPosition(...)
 * という coords→pos→move の glue で、posAtCoords は happy-dom では null を返すため
 * （this branch は happy-dom で到達不能 = dead）、実ブラウザでしか検証できない。
 *
 * 注: この分岐に固有のバグ履歴は無い（50ccdb57 が直したのは unplaced/droppable/
 * collision 側で、ここは対象外）。よってこれは「回帰 gate」ではなく
 * 「browser-only な新規カバレッジ」。差分検証では glue を壊す（geometry 由来の
 * pos でなく固定 pos を食わせる）と落ちることを確認しており、moveBeatToPosition を
 * 明示 pos で叩く既存 beatOperations.test とは重複しない。
 */
import { vi } from "vitest";
vi.mock(
  "@tanstack/react-virtual",
  async (importOriginal) => await importOriginal(),
);

import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import type { DragEndEvent } from "@dnd-kit/core";
import { useBeatDragDrop } from "./useBeatDragDrop";
import { useUnplacedBeatsStore } from "./beat/unplacedBeatsStore";

const SCENE = "s1";
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

let editor: Editor | null = null;
let container: HTMLDivElement | null = null;

function insertBeat(ed: Editor, id: string) {
  ed.chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: `beat ${id}` }],
    })
    .run();
  ed.commands.insertContentAt(ed.state.doc.content.size, { type: "paragraph" });
}

function beatIdsInDoc(ed: Editor): string[] {
  const ids: string[] = [];
  ed.state.doc.descendants((n) => {
    if (n.type.name === "sceneBeat") ids.push(n.attrs.id as string);
  });
  return ids;
}

function mountEditor() {
  container = document.createElement("div");
  container.style.width = "600px";
  document.body.appendChild(container);
  editor = new Editor({
    element: container,
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content: "<p>TOP</p>",
  });
  insertBeat(editor, "b1");
  insertBeat(editor, "b2");
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  container?.remove();
  container = null;
  useUnplacedBeatsStore.getState().clearScene(SCENE);
});

describe("useBeatDragDrop placed-beat move (real Chromium)", () => {
  it("本文上部のポインタ位置へ placed beat を move (posAtCoords→moveBeatToPosition)", async () => {
    const ed = mountEditor();
    const editorRef = { current: ed };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );
    await raf();

    expect(beatIdsInDoc(ed)).toEqual(["b1", "b2"]);

    // 先頭 "TOP" 段落の実 rect を測り、その位置をドロップ先座標にする
    const paras = Array.from(container!.querySelectorAll("p"));
    const top = paras.find((p) => p.textContent?.includes("TOP")) ?? paras[0];
    const r = top.getBoundingClientRect();
    expect(r.width).toBeGreaterThan(0); // 実 geometry である確認

    await act(async () => {
      result.current.onDragEnd({
        active: { id: "b2-drag", data: { current: { placedBeatId: "b2" } } },
        over: { id: "beat-editor-drop-zone" },
        activatorEvent: {
          clientX: r.left + 4,
          clientY: r.top + 4,
        } as MouseEvent,
        delta: { x: 0, y: 0 },
      } as unknown as DragEndEvent);
      await raf();
    });

    // posAtCoords が先頭段落の pos を解決 → moveBeatToPosition で b2 が b1 の前へ
    expect(beatIdsInDoc(ed)).toEqual(["b2", "b1"]);
  });
});
