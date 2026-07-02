import { describe, it, expect, beforeEach } from "vitest";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { DecorationSet } from "@tiptap/pm/view";
import { history, undo } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";

import {
  inlineAiDiffKey,
  createInlineAIDiffPlugin,
} from "./InlineAIDiffPlugin";
import { useInlineAiStore } from "./inlineAiStore";

function makeState(text: string, owner?: Editor): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
    plugins: [createInlineAIDiffPlugin(owner)],
  });
}

// owner ゲートは identity 比較のみなので、テストではセンチネルで十分。
const OWNER_A = { __id: "A" } as unknown as Editor;
const OWNER_B = { __id: "B" } as unknown as Editor;

function decoSet(state: EditorState): DecorationSet {
  return inlineAiDiffKey.getState(state) as DecorationSet;
}

function forceUpdate(state: EditorState): EditorState {
  const tr = state.tr.setMeta("inlineAiDiffUpdate", true);
  return state.apply(tr);
}

describe("InlineAIDiffPlugin", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  it("emits no decorations when idle", () => {
    const state = makeState("hello world");
    expect(decoSet(state)).toBe(DecorationSet.empty);
  });

  it("renders .diff-add on generated range in insert mode", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 6,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });

    const next = forceUpdate(state);
    const decos = decoSet(next).find();
    expect(decos).toHaveLength(1);
    const spec = decos[0] as unknown as { type: { attrs: { class: string } } };
    expect(spec.type.attrs.class).toBe("diff-add");
  });

  it("renders both .diff-remove and .diff-add in replace mode", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    // Original selection covers "hello" at PM [1,6). Generated text is
    // appended directly after at PM [6,11) (simulating "brave").
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: { from: 1, to: 6 },
      originalText: "hello",
      insertPos: null,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });

    const next = forceUpdate(state);
    const decos = decoSet(next).find();
    expect(decos).toHaveLength(2);

    const classes = decos
      .map(
        (d) =>
          (d as unknown as { type: { attrs: { class: string } } }).type.attrs
            .class,
      )
      .sort();
    expect(classes).toEqual(["diff-add", "diff-remove"]);
  });

  it("drops decorations on reset", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 1,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 1, to: 6 });

    const afterShow = forceUpdate(state);
    expect(decoSet(afterShow).find()).toHaveLength(1);

    useInlineAiStore.getState().reset();
    const afterReset = forceUpdate(afterShow);
    expect(decoSet(afterReset)).toBe(DecorationSet.empty);
  });
});

// グローバル単一 store を複数エディタが共有する linear / split view 向けの
// owner ゲート。生成中でないエディタが他人のセッションの装飾を描いたり、
// ストリーミング中に隣のエディタの入力をサイレントに握りつぶしたりしない。
describe("InlineAIDiffPlugin: owner ゲート (複数エディタ共有)", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  function startInsertSession(activeEditor: Editor) {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 6,
      abortController: new AbortController(),
      activeEditor,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });
  }

  it("別エディタが所有するセッションでは装飾しない", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_B);
    const next = forceUpdate(state);
    expect(decoSet(next)).toBe(DecorationSet.empty);
  });

  it("自分が所有するセッションでは従来通り装飾する", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_A);
    const next = forceUpdate(state);
    expect(decoSet(next).find()).toHaveLength(1);
  });

  it("別エディタのセッション中は生の入力を握りつぶさない", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_B);
    // status === generating だが foreign。meta 無しの docChanged tr が通る。
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toContain("X");
  });

  it("自分のセッション中は生の入力を握りつぶす (従来のストリーミング保護)", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_A);
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toBe("hello world");
  });
});

// B1: diffShown (Accept 待ち) の間も本文編集をロックする。手動編集が autosave
// 抑止下で未保存のまま溜まり、離脱で喪失するのを原理的に防ぐ。accept/reject は
// 先に reset()→idle してから tr を投げるので素通りする (本文編集ロックの対象外)。
describe("InlineAIDiffPlugin: diffShown 編集ロック (B1)", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  function startSession(activeEditor: Editor) {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 6,
      abortController: new AbortController(),
      activeEditor,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });
  }

  it("diffShown 中の owner エディタへの手動入力を握りつぶす", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().finishGeneration("m");
    expect(useInlineAiStore.getState().status).toBe("diffShown");
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toBe("hello world");
  });

  it("error 中の owner エディタへの手動入力も握りつぶす", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().setError("boom");
    expect(useInlineAiStore.getState().status).toBe("error");
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toBe("hello world");
  });

  it("diffShown 中、addToHistory:false の真にプログラマティックな tr (Beat chunk 等) は通す", () => {
    // insertBeatStream は addToHistory:false で chunk を挿入する。ユーザー入力
    // ではないので diffShown 中でも握りつぶしてはいけない (回帰防止)。
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().finishGeneration("m");
    const tr = state.tr.insertText("Z", 6).setMeta("addToHistory", false);
    const next = state.apply(tr);
    expect(next.doc.textContent).toContain("Z");
  });

  it("diffShown 中、addToHistory が立つ通常 tr (手動ペースト/Fix の insertContentAt 相当) は握りつぶす", () => {
    // ペーストや Fix 系 insertContentAt は addToHistory:false を立てない通常 tr。
    // ユーザー由来の本文変更なのでロック対象。
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().finishGeneration("m");
    const tr = state.tr
      .insertText("X", 1)
      .setMeta("programmaticInsert", true)
      .setMeta("paste", true);
    const next = state.apply(tr);
    expect(next.doc.textContent).toBe("hello world");
  });

  it("diffShown 中でも docChanged=false の tr (選択/強制更新) は通す", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().finishGeneration("m");
    const next = forceUpdate(state);
    expect(decoSet(next).find()).toHaveLength(1);
  });

  it("inlineAiInsert chunk は generating / diffShown どちらでも通す", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    const gen = state.apply(
      state.tr.insertText("Z", 6).setMeta("inlineAiInsert", true),
    );
    expect(gen.doc.textContent).toContain("Z");
    useInlineAiStore.getState().finishGeneration("m");
    const shown = gen.apply(
      gen.tr.insertText("Q", 7).setMeta("inlineAiInsert", true),
    );
    expect(shown.doc.textContent).toContain("Q");
  });

  it("reset()→idle 後の編集 (accept/reject 本体) は通す", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_A);
    useInlineAiStore.getState().finishGeneration("m");
    useInlineAiStore.getState().reset();
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toContain("X");
  });

  it("別エディタは diffShown 中でも編集を通す (foreign 非ブロック維持)", () => {
    const state = makeState("hello world", OWNER_A);
    startSession(OWNER_B);
    useInlineAiStore.getState().finishGeneration("m");
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toContain("X");
  });
});

// pending guard の二重 undo 系統ガード（アーキ監査 #12 の回帰テスト）。
//
// 背景: App.tsx の global undo ハンドラはフォーカスが ProseMirror 内のとき
// early return し（App.tsx:540）、Ctrl+Z を TipTap 内蔵 undo（prosemirror-history）
// に委ねる。この内蔵 undo は globalHistoryStore の replayGuard を経由しないため、
// 「pending 中に内蔵 undo が AI diff 下の doc を巻き戻せてしまうのでは」という
// 疑義があった。実際には prosemirror-history の undo transaction は
// `setMeta(historyKey, …)` を立てるだけで `addToHistory:false` を立てない
// （prosemirror-history 1.5 histTransaction）。そのため diffShown/generating/error
// 中は InlineAIDiffPlugin.filterTransaction が「addToHistory:false でない
// docChanged tr」として握りつぶす。この不変条件を明示的に gate する
// （将来 filterTransaction が history tr を通す方向へ変わると穴が開くため）。
describe("InlineAIDiffPlugin: pending 中の内蔵 undo ガード (#12)", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  function makeHistoryState(text: string, owner?: Editor): EditorState {
    return EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text(text)]),
      ]),
      // 実アプリの TipTap StarterKit History 相当（@tiptap/pm/history）。
      plugins: [history(), createInlineAIDiffPlugin(owner)],
    });
  }

  function enterDiffShown(owner: Editor) {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 12,
      abortController: new AbortController(),
      activeEditor: owner,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 12, to: 13 });
    useInlineAiStore.getState().finishGeneration("m");
  }

  /** undo コマンドを filterTransaction 経由で適用し、結果 state を返す。 */
  function applyUndo(state: EditorState): EditorState {
    let out = state;
    // state.apply は applyTransaction 経由で filterTransaction を通す
    // （既存テストの入力握りつぶしと同じ経路）。
    undo(state, (tr: Transaction) => {
      out = state.apply(tr);
    });
    return out;
  }

  it("diffShown 中の owner エディタの内蔵 undo は握りつぶされ doc を巻き戻さない", () => {
    // ユーザー編集を 1 つ履歴に積む（"hello world" → "hello worldX"）。
    const base = makeHistoryState("hello world", OWNER_A);
    let state = base.apply(base.tr.insertText("X", 12));
    expect(state.doc.textContent).toBe("hello worldX");

    enterDiffShown(OWNER_A);
    expect(useInlineAiStore.getState().status).toBe("diffShown");

    state = applyUndo(state);
    // 握りつぶされていれば doc は不変（AI diff 下の本文が保護される）。
    expect(state.doc.textContent).toBe("hello worldX");
  });

  it("idle 復帰後は同じ内蔵 undo が通る（ガードが status 依存であることの対照）", () => {
    const base = makeHistoryState("hello world", OWNER_A);
    let state = base.apply(base.tr.insertText("X", 12));
    enterDiffShown(OWNER_A);
    useInlineAiStore.getState().reset(); // accept/reject 相当で idle へ

    state = applyUndo(state);
    // ガードが外れているので undo が適用され "X" が消える。
    expect(state.doc.textContent).toBe("hello world");
  });
});
