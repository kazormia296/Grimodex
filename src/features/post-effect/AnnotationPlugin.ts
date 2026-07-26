import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAnnotationStore } from "./annotationStore";

export const annotationKey = new PluginKey("peAnnotation");

/**
 * Meta key to force decoration rebuild. Dispatched when:
 * - applyAnnotationsToEditor 経由で mark を貼り替えたとき
 * - showAnnotations トグルが切り替わったとき (call site から dispatch)
 *
 * Comment 系の COMMENT_REBUILD_META と同じ規約。
 */
export const ANNOTATION_REBUILD_META = "annotationUpdate";

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const { showAnnotations, showReaderComments } = useAnnotationStore.getState();
  if (!showAnnotations && !showReaderComments) return DecorationSet.empty;

  const decos: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "peAnnotation");
    if (!mark) return;

    const category = (mark.attrs.category as string) ?? "";
    const severity = (mark.attrs.severity as string) ?? "warning";
    const status = (mark.attrs.status as string) ?? "open";

    if (status === "dismissed") return;
    // pseudo_comment (読者コメント) は「校閲の指摘」とは別レイヤーでゲートする
    if (category === "pseudo_comment" ? !showReaderComments : !showAnnotations)
      return;

    const classes = [
      "pe-annotation",
      `pe-annotation-${category}`,
      `pe-annotation-severity-${severity}`,
    ]
      .filter(Boolean)
      .join(" ");

    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classes,
        "data-pe-ann-id": mark.attrs.annotationId as string,
        "data-pe-category": category,
        "data-pe-severity": severity,
      }),
    );
  });

  return DecorationSet.create(doc, decos);
}

export function createAnnotationPlugin(): Plugin {
  return new Plugin({
    key: annotationKey,
    state: {
      init(_, { doc }) {
        return buildDecorations(doc);
      },
      apply(tr, oldDecos, _oldState, newState) {
        if (tr.docChanged || tr.getMeta(ANNOTATION_REBUILD_META) === true) {
          return buildDecorations(newState.doc);
        }
        return oldDecos.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return annotationKey.getState(state);
      },
    },
  });
}
