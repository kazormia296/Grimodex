// @vitest-environment happy-dom
//
// useBeatDragDrop の happy-dom テスト。gate しているのは以下:
//   (A) onDragEnd の「geometry を使わない」3 分岐 (reorder / placed→unplace / unplaced→place)。
//       posAtCoords を経由せず doc transaction / store 操作だけなので単体検証可能。
//       posAtCoords を使う placed-move 分岐は別途 *.browser.test.tsx (実 Chromium)。
//   (B) collisionDetection の fallback seam (pointerWithin→rectIntersection)。合成 args で検証。
//
// バグ履歴 50ccdb57 "Unplaced Beat の D&D 不具合を修正" が入れたのは:
//   1. unplaced 並べ替え (reorder 分岐) の新規配線        → (A) で gate
//   2. collisionDetection の pointerWithin→rectIntersection fallback → (B) で gate
//   3. useDroppable("beat-editor-drop-zone") の登録位置 (EditorDropDiv 抽出)
//      → **非 gate (意図的)**。これは dnd-kit が pointer から over を解決できるかという
//        構造/統合の問題で、合成 over を渡す本テストでは捕まらない。検証には実 DndContext +
//        実ジェスチャ (programmatic には flaky) が要るため対象外とする。
// → 「onDragEnd 全分岐を gate」ではなく「handler 分岐 + collision seam を gate / 登録位置は非対象」。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import type {
  CollisionDetection,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { useBeatDragDrop } from "./useBeatDragDrop";
import {
  useUnplacedBeatsStore,
  type UnplacedBeat,
} from "./beat/unplacedBeatsStore";

const SCENE = "s1";
const editors = new Set<Editor>();

function createEditor(content = "") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content,
  });
  editors.add(editor);
  return editor;
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

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors.clear();
});

describe("useBeatDragDrop.onDragEnd (happy-dom: 非 geometry 分岐)", () => {
  it("projection が drag 中に切り替わった drop は無視する", () => {
    useUnplacedBeatsStore
      .getState()
      .setBeats(SCENE, [beat("b1"), beat("b2")], "load");
    const projectionKeyRef = { current: "projection-a" };
    const { result } = renderHook(() =>
      useBeatDragDrop({
        editorRef: { current: null },
        nodeId: SCENE,
        canMutate: () => true,
        projectionKeyRef,
      }),
    );

    act(() => {
      result.current.onDragStart({
        active: {
          id: "b1",
          data: { current: { beat: beat("b1"), sceneId: SCENE } },
        },
      } as unknown as DragStartEvent);
      projectionKeyRef.current = "projection-b";
      result.current.onDragEnd({
        active: {
          id: "b1",
          data: { current: { beat: beat("b1"), sceneId: SCENE } },
        },
        over: { id: "b2" },
        delta: { x: 0, y: 0 },
        activatorEvent: {} as Event,
      } as unknown as DragEndEvent);
    });

    expect(unplacedIds()).toEqual(["b1", "b2"]);
  });

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

  it("drag 開始後に unplaced 配列が変わった reorder は拒否する", () => {
    useUnplacedBeatsStore
      .getState()
      .setBeats(SCENE, [beat("b1"), beat("b2"), beat("b3")], "load");
    const editorRef = { current: createEditor() };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );

    act(() => {
      result.current.onDragStart({
        active: {
          id: "b1",
          data: { current: { beat: beat("b1"), sceneId: SCENE } },
        },
      } as unknown as DragStartEvent);
      useUnplacedBeatsStore
        .getState()
        .setBeats(SCENE, [beat("b3"), beat("b1"), beat("b2")], "sync");
      result.current.onDragEnd({
        active: {
          id: "b1",
          data: { current: { beat: beat("b1"), sceneId: SCENE } },
        },
        over: { id: "b2" },
        delta: { x: 0, y: 0 },
        activatorEvent: {} as Event,
      } as unknown as DragEndEvent);
    });

    expect(unplacedIds()).toEqual(["b3", "b1", "b2"]);
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

// 50ccdb57 の collision fallback (pointerWithin が空でも rectIntersection で over を
// 解決させる) を合成 args で gate する。grid の gridCollisionDetection と同型の純ロジック。
function collisionArgs(
  pointer: { x: number; y: number } | null,
  collisionRect: DOMRect,
  rects: Record<string, DOMRect>,
): Parameters<CollisionDetection>[0] {
  const droppableRects = new Map(Object.entries(rects));
  const droppableContainers = Object.keys(rects).map((id) => ({ id }));
  return {
    active: { id: "drag", data: { current: {} } },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as unknown as Parameters<CollisionDetection>[0];
}

describe("useBeatDragDrop.collisionDetection (50ccdb57 fallback seam)", () => {
  function getCollisionDetection(): CollisionDetection {
    const editorRef = { current: createEditor() };
    const { result } = renderHook(() =>
      useBeatDragDrop({ editorRef, nodeId: SCENE }),
    );
    return result.current.collisionDetection;
  }

  it("pointer が droppable 内なら pointerWithin の結果を返す", () => {
    const cd = getCollisionDetection();
    const out = cd(
      collisionArgs({ x: 50, y: 50 }, new DOMRect(0, 0, 10, 10), {
        "beat-editor-drop-zone": new DOMRect(0, 0, 100, 100),
      }),
    );
    expect(out.map((c) => c.id)).toEqual(["beat-editor-drop-zone"]);
  });

  it("pointer が全 droppable の外でも rectIntersection で fallback して over を解決する", () => {
    const cd = getCollisionDetection();
    // pointer は rect の外。だが collisionRect(ドラッグ中の矩形) が droppable と重なる。
    const out = cd(
      collisionArgs({ x: 500, y: 500 }, new DOMRect(10, 10, 50, 50), {
        "beat-editor-drop-zone": new DOMRect(0, 0, 100, 100),
      }),
    );
    // fallback が無いと pointerWithin が空のまま over 解決できず [] になる
    expect(out.map((c) => c.id)).toContain("beat-editor-drop-zone");
  });
});
