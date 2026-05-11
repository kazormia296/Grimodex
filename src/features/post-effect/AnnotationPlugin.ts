import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAnnotationStore } from "./annotationStore";

export const annotationKey = new PluginKey("peAnnotation");

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const { showAnnotations } = useAnnotationStore.getState();
  if (!showAnnotations) return DecorationSet.empty;

  const decos: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "peAnnotation");
    if (!mark) return;

    const category = (mark.attrs.category as string) ?? "";
    const severity = (mark.attrs.severity as string) ?? "warning";
    const status = (mark.attrs.status as string) ?? "open";

    if (status === "dismissed") return;

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
        if (tr.docChanged || tr.getMeta("annotationUpdate") === true) {
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
