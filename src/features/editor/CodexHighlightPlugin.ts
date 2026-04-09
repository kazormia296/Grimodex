import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CodexMatch } from "@/features/codex/codexMatcher";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

export const codexHighlightKey = new PluginKey("codexHighlight");

/**
 * Convert flat text offsets from codexMatcher to ProseMirror positions.
 * ProseMirror positions include structural node boundaries, so we need
 * to walk the doc to map flat offsets to actual positions.
 */
export function mapMatchesToDecorations(
  doc: ProseMirrorNode,
  matches: CodexMatch[],
  typeColorMap: Record<string, ResolvedCodexColor> = {},
  highlightStyle: string = "color-text",
): Decoration[] {
  if (matches.length === 0) return [];

  const decos: Decoration[] = [];
  let flatPos = 0;
  let matchIdx = 0;

  // Sort matches by from position
  const sorted = [...matches].sort((a, b) => a.from - b.from);

  doc.descendants((node, pos) => {
    if (matchIdx >= sorted.length) return false;
    if (!node.isText) return;

    const text = node.text!;
    const nodeStart = flatPos;
    const nodeEnd = flatPos + text.length;

    while (matchIdx < sorted.length && sorted[matchIdx].from < nodeEnd) {
      const m = sorted[matchIdx];
      if (m.from >= nodeStart && m.to <= nodeEnd) {
        const pmFrom = pos + (m.from - nodeStart);
        const pmTo = pos + (m.to - nodeStart);
        const colors = typeColorMap[m.entryType] ?? {
          hl: "#88888829",
          tx: "#888888",
          fg: "#888888",
        };
        const inlineStyle =
          highlightStyle === "underline"
            ? `text-decoration: underline; text-decoration-color: ${colors.fg}; text-underline-offset: 3px`
            : `background-color: ${colors.hl}; color: ${colors.tx}; border-radius: 3px; padding: 0 2px`;
        decos.push(
          Decoration.inline(pmFrom, pmTo, {
            class: "codex-highlight",
            style: inlineStyle,
            "data-codex-entry-id": String(m.entryId),
            "data-codex-entry-type": m.entryType,
            "data-codex-entry-name": m.entryName,
          }),
        );
      }
      matchIdx++;
    }
    flatPos = nodeEnd;
  });

  return decos;
}

export function createCodexHighlightPlugin(): Plugin {
  return new Plugin({
    key: codexHighlightKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        const { typeColorMap } = useCodexHighlightStore.getState();

        // Async result delivered via transaction meta
        const asyncResult = tr.getMeta("codexHighlightResult") as
          | CodexMatch[]
          | undefined;
        if (asyncResult !== undefined) {
          const highlightStyle = useSettingsStore
            .getState()
            .get("display.codexHighlightStyle", "color-text");
          return DecorationSet.create(
            newState.doc,
            mapMatchesToDecorations(
              newState.doc,
              asyncResult,
              typeColorMap,
              highlightStyle,
            ),
          );
        }

        // Doc changed or forced update → remap existing decoration positions
        if (tr.docChanged || tr.getMeta("codexHighlightUpdate") === true) {
          return oldDecos.map(tr.mapping, tr.doc);
        }

        return oldDecos;
      },
    },
    props: {
      decorations(state) {
        return codexHighlightKey.getState(state);
      },
    },
  });
}
