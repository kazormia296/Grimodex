import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAttributionStore } from "./attributionStore";

export const attributionKey = new PluginKey("attribution");

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decos: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (!mark) return;

    const source = mark.attrs.source as string;
    if (source === "human") return;

    const classMap: Record<string, string> = {
      ai: "attribution-ai",
      unknown: "attribution-unknown",
    };
    const isManualOverride = mark.attrs.manualOverride === true;
    const classes = [
      classMap[source] ?? "attribution-unknown",
      isManualOverride ? "attribution-manual-override" : "",
    ]
      .filter(Boolean)
      .join(" ");

    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classes,
        "data-attribution-source": source,
        "data-attribution-model": mark.attrs.model ?? "",
        "data-attribution-timestamp": mark.attrs.timestamp ?? "",
        "data-attribution-message-id": mark.attrs.chatMessageId ?? "",
        "data-manual-override": isManualOverride ? "true" : "",
      }),
    );
  });

  return DecorationSet.create(doc, decos);
}

export function createAttributionPlugin(): Plugin {
  return new Plugin({
    key: attributionKey,
    state: {
      init(_, { doc }) {
        const show = useAttributionStore.getState().showAttribution;
        return show ? buildDecorations(doc) : DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        const show = useAttributionStore.getState().showAttribution;
        if (!show) return DecorationSet.empty;

        if (tr.docChanged || tr.getMeta("attributionUpdate") === true) {
          return buildDecorations(newState.doc);
        }

        return oldDecos.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return attributionKey.getState(state);
      },
    },
  });
}
