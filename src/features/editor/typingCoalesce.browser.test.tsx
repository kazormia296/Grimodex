/**
 * 連続キー入力ハングの退化検出 gate（実 rAF / 実 TipTap setContent 統合版）。
 *
 * Phase 2 単体テスト (sceneContentStore.test.ts の subscribeLiveContentRafCoalesced)
 * が mock rAF + mock apply で coalesce ロジック自体を検証しているのに対し、
 * こちらは実ブラウザの requestAnimationFrame + 実 TipTap editor.commands.setContent
 * を回して end-to-end の上限を assert する。
 *
 * 不変条件:
 *   N 個の broadcast を 1 フレーム以内にバーストしても、ミラー側 setContent は 1 回。
 *   broadcast を K フレームにまたがって撒いても、setContent は K + 数回に bounded。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import {
  useSceneContentStore,
  subscribeLiveContentRafCoalesced,
} from "@/features/editor/sceneContentStore";

const SCENE = "scene-coalesce-browser";
const SOURCE_GROUP = 1;
const MIRROR_GROUP = -1; // ミラー側は broadcast しないので任意の非衝突値

function MirrorEditor({ onApply }: { onApply: (doc: object) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
  });
  // ref 化: StrictMode の二重 render で onApply の identity が変わって
  // subscribe が剥がれ・貼り直しされるのを防ぐ。
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  useEffect(() => {
    if (!editor) return;
    return subscribeLiveContentRafCoalesced(SCENE, MIRROR_GROUP, (next) => {
      editor.commands.setContent(
        next as Parameters<typeof editor.commands.setContent>[0],
        { emitUpdate: false },
      );
      onApplyRef.current(next);
    });
  }, [editor]);
  return <EditorContent editor={editor} data-testid="mirror" />;
}

function makeDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("liveContent rAF coalesce — browser integration", () => {
  beforeEach(() => {
    useSceneContentStore.setState({ liveContent: {} });
  });

  it("単一フレーム内 100 回の broadcast → ミラー setContent は 1 回（last-write-wins）", async () => {
    const applies: object[] = [];
    render(<MirrorEditor onApply={(d) => applies.push(d)} />);
    const editable = await waitFor(
      () =>
        document.querySelector(
          "[data-testid='mirror'] [contenteditable='true']",
        ) as HTMLElement | null,
    );
    expect(editable).toBeTruthy();

    const set = useSceneContentStore.getState().setLiveContent;
    for (let i = 0; i < 100; i++) {
      set(SCENE, makeDoc(`k${i}`), SOURCE_GROUP);
    }
    // 同期バースト直後は apply は走っていない（rAF 待ち）
    expect(applies).toHaveLength(0);

    await nextFrame();
    // 念のためもう 1 フレーム遊ばせる（最初のフレーム描画前に scheduling 競合した場合の保険）
    await nextFrame();

    expect(applies).toHaveLength(1);
    expect(JSON.stringify(applies[0])).toContain("k99");
    // 実 DOM にも last-write が反映されている
    expect(editable!.textContent).toBe("k99");
  });

  it("5 フレームにまたがる計 100 broadcast → setContent 数は frame 数に bounded", async () => {
    const applies: object[] = [];
    render(<MirrorEditor onApply={(d) => applies.push(d)} />);
    await waitFor(
      () =>
        document.querySelector(
          "[data-testid='mirror'] [contenteditable='true']",
        ) as HTMLElement | null,
    );

    const set = useSceneContentStore.getState().setLiveContent;
    const FRAMES = 5;
    const PER_FRAME = 20;
    for (let f = 0; f < FRAMES; f++) {
      for (let k = 0; k < PER_FRAME; k++) {
        set(SCENE, makeDoc(`f${f}-k${k}`), SOURCE_GROUP);
      }
      // 次フレームへ譲る → coalesce の flush が起きる
      await nextFrame();
    }
    // 最終バースト分の flush 待ち
    await nextFrame();

    // 上限: 各フレーム 1 apply + 末尾 flush で +1 までを許容
    expect(applies.length).toBeLessThanOrEqual(FRAMES + 1);
    // broadcast 総数 (100) より遥かに少ない
    expect(applies.length).toBeLessThan(20);
    // 最低 1 回は apply されている
    expect(applies.length).toBeGreaterThan(0);
    // last-write が最終 apply
    expect(JSON.stringify(applies[applies.length - 1])).toContain(
      `f${FRAMES - 1}-k${PER_FRAME - 1}`,
    );
  });

  it("ownGroupIndex に一致する broadcast は apply を arm しない", async () => {
    const applies: object[] = [];
    render(<MirrorEditor onApply={(d) => applies.push(d)} />);
    await waitFor(
      () =>
        document.querySelector(
          "[data-testid='mirror'] [contenteditable='true']",
        ) as HTMLElement | null,
    );

    const set = useSceneContentStore.getState().setLiveContent;
    // 全部 MIRROR_GROUP 由来 → スキップされるべき
    for (let i = 0; i < 50; i++) {
      set(SCENE, makeDoc(`own-${i}`), MIRROR_GROUP);
    }
    await nextFrame();
    await nextFrame();

    expect(applies).toHaveLength(0);
  });
});
