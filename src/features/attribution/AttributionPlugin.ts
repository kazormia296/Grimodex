import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAttributionStore } from "./attributionStore";
import type { FilterSource } from "./attributionStore";

export const attributionKey = new PluginKey("attribution");

function buildDecorations(
  doc: ProseMirrorNode,
  filterSource: FilterSource,
): DecorationSet {
  const decos: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find((m) => m.type.name === "authorship");
    const source = (mark?.attrs.source as string) ?? "human";
    const len = node.nodeSize;

    if (filterSource !== null) {
      const matches =
        source === filterSource || (filterSource === "human" && !mark);
      if (!matches) {
        decos.push(
          Decoration.inline(pos, pos + len, { class: "attribution-dimmed" }),
        );
        return;
      }
      if (source !== "human") {
        const classMap: Record<string, string> = {
          ai: "attribution-ai",
          unknown: "attribution-unknown",
        };
        decos.push(
          Decoration.inline(pos, pos + len, {
            class: classMap[source] ?? "attribution-unknown",
          }),
        );
      }
      return;
    }

    if (source === "human") return;
    const classMap: Record<string, string> = {
      ai: "attribution-ai",
      unknown: "attribution-unknown",
    };
    const isManualOverride = mark?.attrs.manualOverride === true;
    const classes = [
      classMap[source] ?? "attribution-unknown",
      isManualOverride ? "attribution-manual-override" : "",
    ]
      .filter(Boolean)
      .join(" ");
    decos.push(
      Decoration.inline(pos, pos + len, {
        class: classes,
        "data-attribution-source": source,
        "data-attribution-model": mark?.attrs.model ?? "",
        "data-attribution-timestamp": mark?.attrs.timestamp ?? "",
        "data-attribution-message-id": mark?.attrs.chatMessageId ?? "",
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
        const { showAttribution, filterSource } =
          useAttributionStore.getState();
        return showAttribution
          ? buildDecorations(doc, filterSource)
          : DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        const { showAttribution, filterSource } =
          useAttributionStore.getState();
        if (!showAttribution) return DecorationSet.empty;

        if (tr.docChanged || tr.getMeta("attributionUpdate") === true) {
          return buildDecorations(newState.doc, filterSource);
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
