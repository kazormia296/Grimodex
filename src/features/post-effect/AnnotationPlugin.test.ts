// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";

import { useAnnotationStore } from "./annotationStore";
import {
  createAnnotationPlugin,
  annotationKey,
  ANNOTATION_REBUILD_META,
} from "./AnnotationPlugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    peAnnotation: {
      attrs: {
        annotationId: { default: "" },
        category: { default: "review" },
        severity: { default: "warning" },
        status: { default: "open" },
        live: { default: false },
      },
    },
  },
});

/** 校閲アノテーション1本 + 読者コメント1本を持つ state を作る。 */
function makeState(): EditorState {
  const doc = schema.nodes.doc.create({}, [
    schema.nodes.paragraph.create({}, [
      schema.text("校閲の指摘", [
        schema.marks.peAnnotation.create({
          annotationId: "rev1",
          category: "review",
          severity: "error",
        }),
      ]),
      schema.text("あいだ"),
      schema.text("読者コメント", [
        schema.marks.peAnnotation.create({
          annotationId: "pc1",
          category: "pseudo_comment",
        }),
      ]),
    ]),
  ]);
  return EditorState.create({ doc, plugins: [createAnnotationPlugin()] });
}

function decoClasses(state: EditorState): string[] {
  const set = annotationKey.getState(state);
  if (!set) return [];
  return set
    .find()
    .map(
      (d: unknown) =>
        (d as { type: { attrs: Record<string, string> } }).type.attrs.class,
    )
    .sort();
}

function rebuild(state: EditorState): EditorState {
  return state.apply(state.tr.setMeta(ANNOTATION_REBUILD_META, true));
}

function makeLiveState(): EditorState {
  const doc = schema.nodes.doc.create({}, [
    schema.nodes.paragraph.create({}, [
      schema.text("ライブ読者コメント", [
        schema.marks.peAnnotation.create({
          annotationId: "live1",
          category: "pseudo_comment",
          live: true,
        }),
      ]),
    ]),
  ]);
  return EditorState.create({ doc, plugins: [createAnnotationPlugin()] });
}

beforeEach(() => {
  useAnnotationStore.setState({
    showAnnotations: true,
    showReaderComments: true,
  });
});

describe("AnnotationPlugin のレイヤーゲート", () => {
  it("両レイヤーONなら校閲と読者コメントの両方を装飾する", () => {
    const classes = decoClasses(makeState());
    expect(classes).toHaveLength(2);
    expect(classes.some((c) => c.includes("pe-annotation-review"))).toBe(true);
    expect(
      classes.some((c) => c.includes("pe-annotation-pseudo_comment")),
    ).toBe(true);
  });

  it("severity クラスが付与される (重要度色分けのフック)", () => {
    const classes = decoClasses(makeState());
    expect(
      classes.some((c) => c.includes("pe-annotation-severity-error")),
    ).toBe(true);
  });

  it("校閲OFF・読者コメントONなら pseudo_comment だけ残る", () => {
    useAnnotationStore.setState({ showAnnotations: false });
    const classes = decoClasses(makeState());
    expect(classes).toHaveLength(1);
    expect(classes[0]).toContain("pe-annotation-pseudo_comment");
  });

  it("校閲ON・読者コメントOFFなら pseudo_comment が消える", () => {
    useAnnotationStore.setState({ showReaderComments: false });
    const classes = decoClasses(makeState());
    expect(classes).toHaveLength(1);
    expect(classes[0]).toContain("pe-annotation-review");
  });

  it("両方OFFなら装飾なし", () => {
    useAnnotationStore.setState({
      showAnnotations: false,
      showReaderComments: false,
    });
    expect(decoClasses(makeState())).toHaveLength(0);
  });

  it("ライブ読者コメントは本文レイヤーをOFFにしても常に装飾する", () => {
    useAnnotationStore.setState({
      showAnnotations: false,
      showReaderComments: false,
    });
    const classes = decoClasses(makeLiveState());
    expect(classes).toHaveLength(1);
    expect(classes[0]).toContain("pe-annotation-pseudo_comment");
  });

  it("ANNOTATION_REBUILD_META でトグル変更が反映される", () => {
    let state = makeState();
    expect(decoClasses(state)).toHaveLength(2);
    useAnnotationStore.setState({ showReaderComments: false });
    state = rebuild(state);
    expect(decoClasses(state)).toHaveLength(1);
  });
});
