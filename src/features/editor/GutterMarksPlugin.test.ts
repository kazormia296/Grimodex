// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import {
  createGutterMarksPlugin,
  gutterMarksKey,
  buildGutterWidgetDom,
  gutterReserveInlineSize,
  GUTTER_REBUILD_META,
  type GutterChannel,
} from "./GutterMarksPlugin";
import {
  createLintDecorationPlugin,
  setLintDiagnostics,
  LINT_REBUILD_META,
} from "./LintDecorationPlugin";
import type { Diagnostic } from "@/features/lint/types";

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
    showLint: true,
  });
  useAnnotationStore.setState({
    showAnnotations: true,
    showReaderComments: true,
  });
});

/**
 * Lint 指摘は mark ではなく decoration。gutter の collectChannels ロジックが
 * lint decoration を review チャネルに拾えるかを検証する。ここでは lint field が
 * gutter より先に適用される「正しい」プラグイン順 [lint, gutter] を手で組む。
 *
 * 注意: これはロジックの単体検証であって、production の実プラグイン順は保証
 * しない。TipTap は登録順を反転するため、実際の適用順は GutterMarksExtension の
 * priority に依存する。その順序契約は getEditorExtensions() 実体で組む統合テスト
 * (gutterLintOrder.browser.test.tsx) で別途 gate する。
 */
function makeStateWithLint(
  text: string,
  diagnostics: Diagnostic[],
): EditorState {
  let state = EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, text ? [schema.text(text)] : []),
    ]),
    plugins: [createLintDecorationPlugin(), createGutterMarksPlugin()],
  });
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      state = state.apply(tr);
    },
  };
  setLintDiagnostics(view, diagnostics);
  return state;
}

const LINT_DIAG: Diagnostic = {
  rule_id: "ja/sentence-length",
  severity: "warning",
  message: "一文が長すぎます",
  range: { start: 0, end: 5 },
};

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

  it("maps stable widgets across ordinary text input instead of recreating them", () => {
    let state = makeState([
      { text: "先頭" },
      { text: "コメント段落", marks: [["comment"]] },
    ]);
    const before = gutterMarksKey.getState(state)?.find()[0];
    expect(before).toBeDefined();

    state = state.apply(state.tr.insertText("追記", 2));

    const after = gutterMarksKey.getState(state)?.find()[0];
    expect(after?.spec.key).toBe(before?.spec.key);
    expect(after?.from).toBe((before?.from ?? 0) + 2);
  });

  it("rebuilds when a marked range is removed by a replace step", () => {
    let state = makeState([
      { text: "コメント", marks: [["comment"]] },
      { text: "本文" },
    ]);
    expect(widgetKeys(state)).toHaveLength(1);

    state = state.apply(state.tr.delete(1, 6));

    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("rebuilds for structural edits that split a marked textblock", () => {
    let state = makeState([{ text: "コメント", marks: [["comment"]] }]);

    state = state.apply(state.tr.split(4));

    expect(widgetKeys(state)).toHaveLength(2);
  });

  // ── 校閲+Lint 統合: Lint 指摘のみの段落にも review ガター記号を出す ──
  // (bug2: scene2 の 2 段落で文字数=一文長 Lint はあるがガターアイコンが無い)

  it("Lint 指摘のみの段落にも review ガター記号を出す", () => {
    const state = makeStateWithLint("これはとても長い一文です。", [LINT_DIAG]);
    expect(widgetKeys(state)).toEqual(["gutter-0-review"]);
  });

  it("showLint OFF では Lint 由来の review ガターを出さない", () => {
    useCursorSettingsStore.setState({ showLint: false });
    const state = makeStateWithLint("これはとても長い一文です。", [LINT_DIAG]);
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("showLint トグル (LINT_REBUILD_META) で Lint review ガターが追従する", () => {
    let state = makeStateWithLint("これはとても長い一文です。", [LINT_DIAG]);
    expect(widgetKeys(state)).toEqual(["gutter-0-review"]);

    useCursorSettingsStore.setState({ showLint: false });
    state = state.apply(state.tr.setMeta(LINT_REBUILD_META, true));
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("Lint 診断が消えたら review ガターも消える", () => {
    let state = makeStateWithLint("これはとても長い一文です。", [LINT_DIAG]);
    expect(widgetKeys(state)).toEqual(["gutter-0-review"]);

    const view = {
      state,
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    };
    setLintDiagnostics(view, []);
    expect(widgetKeys(state)).toHaveLength(0);
  });

  it("校閲アノテーションと Lint が同居しても review は 1 記号に集約する", () => {
    // peAnnotation(校閲) + Lint 両方が同じ段落にある state を組む。
    let state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [
          schema.text("校閲もLintもあるMOJIRETSU", [
            schema.marks.peAnnotation.create(),
          ]),
        ]),
      ]),
      plugins: [createLintDecorationPlugin(), createGutterMarksPlugin()],
    });
    const view = {
      state,
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    };
    setLintDiagnostics(view, [LINT_DIAG]);
    // review が 2 回 push されず 1 記号
    expect(widgetKeys(state)).toEqual(["gutter-0-review"]);
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

describe("gutterReserveInlineSize", () => {
  it("チャネル数に応じた予約幅 (14px×n + 2px×(n-1) + 0.6em) を返す", () => {
    expect(gutterReserveInlineSize(0)).toBeNull();
    expect(gutterReserveInlineSize(1)).toBe("calc(14px + 0.6em)");
    expect(gutterReserveInlineSize(2)).toBe("calc(30px + 0.6em)");
    expect(gutterReserveInlineSize(4)).toBe("calc(62px + 0.6em)");
  });
});
