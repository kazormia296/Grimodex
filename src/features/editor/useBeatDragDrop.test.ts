// @vitest-environment happy-dom
//
// useBeatDragDrop.onDragEnd の「geometry を使わない」3 分岐を happy-dom で gate する。
// これらは posAtCoords を経由せず doc transaction / store 操作だけなので単体で検証可能。
// （posAtCoords を使う placed-move 分岐だけは別途 *.browser.test.tsx で実 Chromium。）
//
// バグ履歴: 50ccdb57 "Unplaced Beat の D&D 不具合を修正" が
//   - unplaced 並べ替え (reorder 分岐) を新規配線
//   - beat-editor-drop-zone の useDroppable 登録 / collision fallback
// を入れた。reorder 分岐はこの時まで未配線だった = まさに回帰したい所。
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import type { DragEndEvent } from "@dnd-kit/core";
import { useBeatDragDrop } from "./useBeatDragDrop";
import {
  useUnplacedBeatsStore,
  type UnplacedBeat,
} from "./beat/unplacedBeatsStore";

const SCENE = "s1";

function createEditor(content = "") {
  return new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content,
  });
}

function insertBeat(editor: Editor, id: string) {
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: `beat ${id}` }],
    })
    .run();
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
}

function beat(id: string): UnplacedBeat {
  return {
    id,
    beatType: "free",
    pov: null,
    collapsed: false,
    content: [{ type: "text", text: `beat ${id}` }],
  };
}

function beatIdsInDoc(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "sceneBeat") ids.push(n.attrs.id as string);
  });
  return ids;
}

const unplacedIds = () =>
  useUnplacedBeatsStore
    .getState()
    .getBeats(SCENE)
    .map((b) => b.id);

beforeEach(() => {
  useUnplacedBeatsStore.getState().clearScene(SCENE);
});

describe("useBeatDragDrop.onDragEnd (happy-dom: 非 geometry 分岐)", () => {
  it("unplaced 同士の並べ替え: reorder で順序が変わる (50ccdb57 回帰)", () => {
    useUnplacedBeatsStore
      .getState()
      .setBeats(SCENE, [beat("b1"), beat("b2"), beat("b3")], "load");
    const editorRef = { current: createEditor() };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );

    act(() => {
      result.current.onDragEnd({
        active: {
          id: "b1",
          data: { current: { beat: beat("b1"), sceneId: SCENE } },
        },
        over: { id: "b3" },
        delta: { x: 0, y: 0 },
        activatorEvent: {} as Event,
      } as unknown as DragEndEvent);
    });

    expect(unplacedIds()).toEqual(["b2", "b3", "b1"]);
  });

  it("placed → unplaced ドロップ: doc から消え unplaced に戻る", () => {
    const editor = createEditor();
    insertBeat(editor, "pb1");
    const editorRef = { current: editor };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );
    expect(beatIdsInDoc(editor)).toContain("pb1");

    act(() => {
      result.current.onDragEnd({
        active: { id: "drag", data: { current: { placedBeatId: "pb1" } } },
        over: { id: "unplaced-drop-zone" },
        delta: { x: 0, y: 0 },
        activatorEvent: {} as Event,
      } as unknown as DragEndEvent);
    });

    expect(beatIdsInDoc(editor)).not.toContain("pb1");
    expect(unplacedIds()).toContain("pb1");
  });

  it("unplaced → 本文末尾 ドロップ: placeBeatAtEnd で doc に追加され unplaced から消える", () => {
    useUnplacedBeatsStore.getState().setBeats(SCENE, [beat("ub1")], "load");
    const editor = createEditor("<p>本文</p>");
    const editorRef = { current: editor };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );

    act(() => {
      result.current.onDragEnd({
        active: {
          id: "ub1",
          data: { current: { beat: beat("ub1"), sceneId: SCENE } },
        },
        over: { id: "beat-editor-drop-zone" },
        delta: { x: 0, y: 0 },
        activatorEvent: {} as Event,
      } as unknown as DragEndEvent);
    });

    expect(beatIdsInDoc(editor)).toContain("ub1");
    expect(unplacedIds()).not.toContain("ub1");
  });
});
