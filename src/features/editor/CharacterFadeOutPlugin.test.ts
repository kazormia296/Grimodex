// @vitest-environment happy-dom
//
// CharacterFadeOutPlugin の削除ゴースト描画テスト。gate しているのは
//   - 横書き: coordsAtPos の座標に ghost span を貼ること（従来挙動）
//   - 縦書き: resolveCoordsVertical（スムースキャレットと同じリゾルバ）の
//     座標を使い、ghost に writing-mode: vertical-rl を当てること
//   - 縦書きでリゾルバが null のときは coordsAtPos へフォールバックすること
// 縦書きで実効 OFF にしていた旧ゲート（useCharacterFade 側）の撤去は
// useCharacterFade.test.ts で gate する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { createCharacterFadeOutPlugin } from "./CharacterFadeOutPlugin";
import { resolveCoordsVertical } from "./cursorCoords";

vi.mock("./cursorCoords", () => ({
  resolveCoordsVertical: vi.fn(),
}));

const mockResolveVertical = vi.mocked(resolveCoordsVertical);

describe("CharacterFadeOutPlugin – ghost placement", () => {
  let wrapper: HTMLDivElement;
  let view: EditorView;
  let vertical: boolean;

  function createView() {
    wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [
        createCharacterFadeOutPlugin(
          () => true,
          () => vertical,
        ),
      ],
    });
    view = new EditorView(wrapper, { state });
    view.coordsAtPos = vi.fn().mockReturnValue({
      left: 50,
      right: 52,
      top: 20,
      bottom: 40,
    });
  }

  beforeEach(() => {
    vertical = false;
    mockResolveVertical.mockReset();
    createView();
  });

  afterEach(() => {
    view.destroy();
    wrapper.remove();
    for (const el of document.querySelectorAll(".editor-fade-out-ghost")) {
      el.remove();
    }
  });

  function deleteOneChar() {
    const tr = view.state.tr.delete(2, 3);
    view.dispatch(tr);
  }

  function getGhost(): HTMLSpanElement {
    const ghosts = document.querySelectorAll<HTMLSpanElement>(
      ".editor-fade-out-ghost",
    );
    expect(ghosts.length).toBe(1);
    return ghosts[0];
  }

  it("横書き: coordsAtPos の座標に ghost を貼る（writing-mode なし）", () => {
    deleteOneChar();
    const ghost = getGhost();
    expect(ghost.textContent).toBe("e");
    expect(ghost.style.left).toBe("50px");
    expect(ghost.style.top).toBe("20px");
    expect(ghost.style.writingMode).toBe("");
    expect(mockResolveVertical).not.toHaveBeenCalled();
  });

  it("縦書き: resolveCoordsVertical の座標 + writing-mode: vertical-rl", () => {
    vertical = true;
    mockResolveVertical.mockReturnValue({
      left: 100,
      right: 118,
      top: 200,
      bottom: 200,
    });
    deleteOneChar();
    const ghost = getGhost();
    expect(ghost.textContent).toBe("e");
    expect(ghost.style.left).toBe("100px");
    expect(ghost.style.top).toBe("200px");
    expect(ghost.style.writingMode).toBe("vertical-rl");
    expect(view.coordsAtPos).not.toHaveBeenCalled();
  });

  it("縦書き: リゾルバ null は coordsAtPos へフォールバック（縦向きは維持）", () => {
    vertical = true;
    mockResolveVertical.mockReturnValue(null);
    deleteOneChar();
    const ghost = getGhost();
    expect(ghost.style.left).toBe("50px");
    expect(ghost.style.top).toBe("20px");
    expect(ghost.style.writingMode).toBe("vertical-rl");
  });
});
