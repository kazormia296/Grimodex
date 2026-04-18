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

  // Build a flat-text-index → ProseMirror-position mapping by walking all
  // text nodes. Text nodes within the same paragraph have contiguous PM
  // positions; paragraph open/close tokens introduce gaps.
  // Ruby atom nodes are also included: every character of the base text maps
  // to the same PM node position (atoms have nodeSize=1).
  const flatPmPos: number[] = [];
  const flatIsRuby: boolean[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "ruby") {
      const base = (node.attrs.base as string) ?? "";
      for (let i = 0; i < base.length; i++) {
        flatPmPos.push(pos);
        flatIsRuby.push(true);
      }
      return false;
    }
    if (!node.isText) return;
    const len = node.text!.length;
    for (let i = 0; i < len; i++) {
      flatPmPos.push(pos + i);
      flatIsRuby.push(false);
    }
  });

  const sorted = [...matches].sort((a, b) => a.from - b.from);
  const decos: Decoration[] = [];

  for (const m of sorted) {
    if (m.from < 0 || m.to > flatPmPos.length || m.from >= m.to) continue;

    const pmFrom = flatPmPos[m.from];
    const pmLastChar = flatPmPos[m.to - 1];
    const pmTo = pmLastChar + 1;

    const colors = typeColorMap[m.entryType] ?? {
      hl: "#88888829",
      tx: "#888888",
      fg: "#888888",
    };
    const inlineStyle =
      highlightStyle === "underline"
        ? `text-decoration: underline; text-decoration-color: ${colors.fg}; text-underline-offset: 3px`
        : `background-color: ${colors.hl}; color: ${colors.tx}; border-radius: 3px; padding: 0 2px`;

    // Check if the match is entirely within a single ruby atom.
    // All flat chars must map to the same PM position (the atom's pos).
    let isRubyMatch = flatIsRuby[m.from];
    if (isRubyMatch) {
      for (let i = m.from + 1; i < m.to; i++) {
        if (flatPmPos[i] !== pmFrom) {
          isRubyMatch = false;
          break;
        }
      }
    }

    if (isRubyMatch) {
      // Use Decoration.node so the highlight is applied to the ruby atom's
      // outer DOM element (span.ruby-atom). ProseMirror's patchOuterDeco
      // applies class/style/data-* attributes to the NodeView's dom.
      decos.push(
        Decoration.node(pmFrom, pmFrom + 1, {
          class: "codex-highlight",
          style: inlineStyle,
          "data-codex-entry-id": String(m.entryId),
          "data-codex-entry-type": m.entryType,
          "data-codex-entry-name": m.entryName,
        }),
      );
      continue;
    }

    // Skip matches whose characters are not contiguous in PM space (i.e. the
    // match spans a paragraph boundary, which has open/close tokens in between).
    if (pmLastChar - pmFrom !== m.to - m.from - 1) continue;

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
          // Adjacent inline decorations (deco[i].to === deco[i+1].from) cause
          // ProseMirror's DOM reconciler to crash when content is inserted at
          // the shared boundary (null nextSibling in renderDescs). Clear all
          // decos in that case; asyncResult will rebuild them in ~150ms.
          const decoList = oldDecos.find();
          for (let i = 0; i + 1 < decoList.length; i++) {
            if (decoList[i].to === decoList[i + 1].from) {
              return DecorationSet.empty;
            }
          }
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
