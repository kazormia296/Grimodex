// @vitest-environment happy-dom
//
// CharacterFadePlugin (挿入フェード) の装飾付与テスト。gate しているのは
//   - 手入力相当の insert で挿入範囲に .editor-fade-in 装飾が付くこと
//   - programmaticInsert メタ付き tr では付かないこと
//   - 実効 OFF (getFadeIn=false) では付かないこと
// CSS アニメ自体 (opacity 0→1, 120ms) はブラウザ側の関心なので非 gate。
import { describe, it, expect } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import {
  createCharacterFadePlugin,
  characterFadeKey,
} from "./CharacterFadePlugin";

function setup(fadeIn: boolean) {
  const wrapper = document.createElement("div");
  document.body.appendChild(wrapper);
  const state = EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text("hello")]),
    ]),
    plugins: [createCharacterFadePlugin(() => fadeIn)],
  });
  const view = new EditorView(wrapper, { state });
  return { view, wrapper };
}

describe("CharacterFadePlugin – 挿入フェード装飾", () => {
  it("手入力の挿入で .editor-fade-in 装飾が付き、DOM にも反映される", () => {
    const { view, wrapper } = setup(true);
    const tr = view.state.tr.insertText("あ", 3, 3);
    view.dispatch(tr);

    const decos = characterFadeKey.getState(view.state)!.find();
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(3);
    expect(decos[0].to).toBe(4);
    expect(wrapper.querySelectorAll(".editor-fade-in").length).toBe(1);
    expect(wrapper.querySelector(".editor-fade-in")!.textContent).toBe("あ");
    view.destroy();
    wrapper.remove();
  });

  it("段落末尾への入力でも打った文字に装飾が付く（旧off-by-oneの再発防止）", () => {
    // 旧実装は自 step の mapping を含めて写像し範囲が 1 文字ぶん後ろへ
    // ずれていた。段落末尾 (最頻の打鍵位置) では範囲が本文の外に出て
    // 何も光らない = 「フェードインが効かない」の正体。
    const { view, wrapper } = setup(true);
    const end = 6; // "hello" の直後
    const tr = view.state.tr.insertText("あ", end, end);
    view.dispatch(tr);

    const decos = characterFadeKey.getState(view.state)!.find();
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(end);
    expect(decos[0].to).toBe(end + 1);
    expect(wrapper.querySelector(".editor-fade-in")!.textContent).toBe("あ");
    view.destroy();
    wrapper.remove();
  });

  it("programmaticInsert メタ付き tr では装飾を付けない", () => {
    const { view, wrapper } = setup(true);
    const tr = view.state.tr.insertText("あ", 3, 3);
    tr.setMeta("programmaticInsert", true);
    view.dispatch(tr);
    expect(characterFadeKey.getState(view.state)!.find().length).toBe(0);
    view.destroy();
    wrapper.remove();
  });

  it("実効 OFF (getFadeIn=false) では装飾を付けない", () => {
    const { view, wrapper } = setup(false);
    const tr = view.state.tr.insertText("あ", 3, 3);
    view.dispatch(tr);
    expect(characterFadeKey.getState(view.state)!.find().length).toBe(0);
    view.destroy();
    wrapper.remove();
  });
});
