// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import {
  createGutterMarksPlugin,
  gutterMarksKey,
  buildGutterWidgetDom,
  GUTTER_REBUILD_META,
  type GutterChannel,
} from "./GutterMarksPlugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    blockquote: { group: "block", content: "block+" },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "block+" },
    sceneBeat: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    comment: { attrs: { text: { default: "" } } },
    foreshadowSetup: {
      attrs: { foreshadowId: { default: "" } },
    },
    foreshadowPayoff: {
      attrs: { foreshadowId: { default: "" } },
    },
    peAnnotation: {
      attrs: {
        annotationId: { default: "" },
        status: { default: "open" },
        category: { default: "review" },
      },
    },
  },
});

interface ParaSpec {
  text: string;
  marks?: Array<[string, Record<string, unknown>?]>;
}

function makeState(paras: ParaSpec[]): EditorState {
  const nodes: ProseMirrorNode[] = paras.map((p) =>
    schema.nodes.paragraph.create(
      {},
      p.text
        ? [
            schema.text(
              p.text,
              (p.marks ?? []).map(([name, attrs]) =>
                schema.marks[name].create(attrs),
              ),
            ),
          ]
        : [],
    ),
  );
  return EditorState.create({
    doc: schema.nodes.doc.create({}, nodes),
    plugins: [createGutterMarksPlugin()],
  });
}

/** Widget keys encode their channels: `gutter-<pos>-<c1.c2>`. */
function widgetKeys(state: EditorState): string[] {
  const set = gutterMarksKey.getState(state);
  if (!set) return [];
  return set
    .find()
    .map((d) => (d.spec as { key?: string }).key ?? "")
    .sort();
}

beforeEach(() => {
  useCursorSettingsStore.setState({
    showComments: true,
    showForeshadowMarks: true,
  });
  useAnnotationStore.setState({
    showAnnotations: true,
    showReaderComments: true,
  });
});

describe("GutterMarksPlugin", () => {
  it("puts no widget on plain paragraphs", () => {
    const state = makeState([{ text: "無印の段落" }]);
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("aggregates channels into a single widget per block", () => {
    const state = makeState([
      {
        text: "コメントと校閲が同居する段落",
        marks: [["comment", { text: "めも" }], ["peAnnotation"]],
      },
      { text: "伏線だけの段落", marks: [["foreshadowSetup"]] },
    ]);
    const keys = widgetKeys(state);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe("gutter-0-comment.review");
    expect(keys[1]).toContain("foreshadow");
  });

  it("treats payoff marks as the foreshadow channel", () => {
    const state = makeState([
      { text: "回収側", marks: [["foreshadowPayoff"]] },
    ]);
    expect(widgetKeys(state)[0]).toContain("foreshadow");
  });

  it("skips dismissed annotations", () => {
    const state = makeState([
      {
        text: "却下済みの指摘",
        marks: [["peAnnotation", { status: "dismissed" }]],
      },
    ]);
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("hides a channel while its layer toggle is off", () => {
    useCursorSettingsStore.setState({ showComments: false });
    const state = makeState([
      {
        text: "コメントと伏線",
        marks: [["comment"], ["foreshadowSetup"]],
      },
    ]);
    expect(widgetKeys(state)[0]).toBe("gutter-0-foreshadow");
  });

  it("rebuilds when GUTTER_REBUILD_META is dispatched after a toggle", () => {
    let state = makeState([{ text: "コメント段落", marks: [["comment"]] }]);
    expect(widgetKeys(state)).toHaveLength(1);

    useCursorSettingsStore.setState({ showComments: false });
    state = state.apply(state.tr.setMeta(GUTTER_REBUILD_META, true));
    expect(widgetKeys(state)).toHaveLength(0);

    useCursorSettingsStore.setState({ showComments: true });
    state = state.apply(state.tr.setMeta(GUTTER_REBUILD_META, true));
    expect(widgetKeys(state)).toHaveLength(1);
  });

  it("rebuilds when the review layer toggles via its own rebuild meta", () => {
    let state = makeState([{ text: "校閲段落", marks: [["peAnnotation"]] }]);
    expect(widgetKeys(state)).toHaveLength(1);

    useAnnotationStore.setState({ showAnnotations: false });
    state = state.apply(state.tr.setMeta("annotationUpdate", true));
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("pseudo_comment は review でなく reader チャネルになる", () => {
    const state = makeState([
      {
        text: "読者コメント付き段落",
        marks: [["peAnnotation", { category: "pseudo_comment" }]],
      },
    ]);
    expect(widgetKeys(state)).toEqual(["gutter-0-reader"]);
  });

  it("reader チャネルは showReaderComments でゲートされ、review レイヤーに従わない", () => {
    useAnnotationStore.setState({
      showAnnotations: false,
      showReaderComments: true,
    });
    const state = makeState([
      {
        text: "読者コメントと校閲",
        marks: [["peAnnotation", { category: "pseudo_comment" }]],
      },
    ]);
    expect(widgetKeys(state)).toEqual(["gutter-0-reader"]);

    useAnnotationStore.setState({ showReaderComments: false });
    const hidden = makeState([
      {
        text: "読者コメント",
        marks: [["peAnnotation", { category: "pseudo_comment" }]],
      },
    ]);
    expect(widgetKeys(hidden)).toHaveLength(0);
  });

  it("nests: コンテナと内側段落で二重描画しない (blockquote)", () => {
    const para = schema.nodes.paragraph.create({}, [
      schema.text("引用内コメント", [schema.marks.comment.create()]),
    ]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.blockquote.create({}, [para]),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [createGutterMarksPlugin()],
    });
    const keys = widgetKeys(state);
    // 最内の paragraph (pos 1) にのみ 1 widget
    expect(keys).toEqual(["gutter-1-comment"]);
  });

  it("nests: bulletList>listItem>paragraph でも 1 widget", () => {
    const para = schema.nodes.paragraph.create({}, [
      schema.text("リスト項目", [schema.marks.comment.create()]),
    ]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.bulletList.create({}, [
        schema.nodes.listItem.create({}, [para]),
      ]),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [createGutterMarksPlugin()],
    });
    expect(widgetKeys(state)).toHaveLength(1);
  });

  it("sceneBeat 内の mark にはガターを出さない", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.sceneBeat.create({}, [
        schema.text("ビート内コメント", [schema.marks.comment.create()]),
      ]),
      schema.nodes.paragraph.create({}, [schema.text("本文")]),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [createGutterMarksPlugin()],
    });
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("rebuilds on doc changes", () => {
    let state = makeState([{ text: "頭" }]);
    expect(widgetKeys(state)).toHaveLength(0);

    const comment = schema.marks.comment.create({ text: "後付け" });
    const tr = state.tr.addMark(1, 2, comment);
    state = state.apply(tr);
    expect(widgetKeys(state)).toHaveLength(1);
  });
});

describe("buildGutterWidgetDom", () => {
  it("renders one icon per channel with channel classes", () => {
    const channels: GutterChannel[] = [
      "comment",
      "reader",
      "foreshadow",
      "review",
    ];
    const el = buildGutterWidgetDom(channels);
    expect(el.className).toBe("gutter-marks");
    const icons = el.querySelectorAll(".gutter-mark");
    expect(icons).toHaveLength(4);
    expect(icons[0].className).toContain("gutter-mark--comment");
    expect(icons[1].className).toContain("gutter-mark--reader");
    expect(icons[2].className).toContain("gutter-mark--foreshadow");
    expect(icons[3].className).toContain("gutter-mark--review");
    // 各アイコンは svg を1つ持つ
    expect(el.querySelectorAll("svg")).toHaveLength(4);
  });
});
