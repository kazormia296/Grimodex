import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CodexMatch } from "@/features/codex/codexMatcher";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  codexHighlightBackground,
  type ResolvedCodexColor,
} from "@/lib/resolveCodexColors";
import { markStart, markEnd } from "@/lib/perfLog";
import { flattenDocForCodex } from "./codexDocFlatten";

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
  opacityLevel: number = 10,
): Decoration[] {
  if (matches.length === 0) return [];

  // Flat-text-offset → ProseMirror-position mapping (shared contract with the
  // matcher and with rename propagation; see codexDocFlatten.ts).
  const { flatPmPos, flatIsRuby } = flattenDocForCodex(doc);

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
    // padding は論理プロパティで「テキスト進行方向の前後 2px」を指定する。
    // 物理 `padding: 0 2px` だと縦書き (vertical-rl) で左右 = 行の太さ方向に
    // 効いてしまい、ハイライト行だけ横幅が太って見える。
    const inlineStyle =
      highlightStyle === "underline"
        ? `text-decoration: underline; text-decoration-color: ${colors.fg}; text-underline-offset: 3px`
        : `background-color: ${codexHighlightBackground(colors, opacityLevel)}; color: ${colors.tx}; border-radius: 3px; padding-inline: 2px`;

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
        Decoration.node(
          pmFrom,
          pmFrom + 1,
          {
            class: "codex-highlight",
            style: inlineStyle,
            "data-codex-entry-id": String(m.entryId),
            "data-codex-entry-type": m.entryType,
            "data-codex-entry-name": m.entryName,
          },
          // 段落移動 (reorder) 時に装飾を再構築するため kind を spec に残す。
          { codexKind: "node" },
        ),
      );
      continue;
    }

    // Skip matches whose characters are not contiguous in PM space (i.e. the
    // match spans a paragraph boundary, which has open/close tokens in between).
    if (pmLastChar - pmFrom !== m.to - m.from - 1) continue;

    decos.push(
      Decoration.inline(
        pmFrom,
        pmTo,
        {
          class: "codex-highlight",
          style: inlineStyle,
          "data-codex-entry-id": String(m.entryId),
          "data-codex-entry-type": m.entryType,
          "data-codex-entry-name": m.entryName,
        },
        // 段落移動 (reorder) 時に装飾を再構築するため kind を spec に残す。
        { codexKind: "inline" },
      ),
    );
  }

  return decos;
}

interface CodexReorderInfo {
  /** 入れ替えた 2 ブロックの先頭位置 (= 前ブロックの開始)。 */
  start: number;
  /** 前ブロック (doc 順で先) の nodeSize。 */
  firstSize: number;
  /** 後ブロック (doc 順で後) の nodeSize。 */
  secondSize: number;
}

/**
 * 段落移動 (ParagraphMoveExtension の隣接ブロック swap) では tr.replaceWith が置換
 * 範囲内の装飾を DecorationSet.map で落としてしまう。そのため移動の transaction が
 * 運ぶ codexHighlightReorder meta を見て、装飾を **per-block オフセットで手動再構築**し、
 * 消失 (= ハイライトの padding 消えで折り返しズレ + 色消えでちらつき) を防ぐ。
 *
 * codex 装飾は単一 text run / ruby atom 内に収まるので from/to は同一ブロック内。
 */
export function remapCodexDecosForReorder(
  oldDecos: DecorationSet,
  doc: ProseMirrorNode,
  reorder: CodexReorderInfo,
): DecorationSet {
  const { start, firstSize, secondSize } = reorder;
  const mid = start + firstSize;
  const end = mid + secondSize;
  const rebuilt: Decoration[] = [];
  for (const d of oldDecos.find()) {
    let shift = 0;
    if (d.from >= start && d.from < mid)
      shift = secondSize; // 前ブロック → 後ろへ
    else if (d.from >= mid && d.from < end) shift = -firstSize; // 後ブロック → 前へ
    const attrs = (d as unknown as { type: { attrs: Record<string, string> } })
      .type.attrs;
    const spec = d.spec as { codexKind?: string } | undefined;
    if (spec?.codexKind === "node") {
      rebuilt.push(
        Decoration.node(d.from + shift, d.to + shift, attrs, d.spec),
      );
    } else {
      rebuilt.push(
        Decoration.inline(d.from + shift, d.to + shift, attrs, d.spec),
      );
    }
  }
  return DecorationSet.create(doc, rebuilt);
}

export function createCodexHighlightPlugin(): Plugin {
  return new Plugin({
    key: codexHighlightKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        markStart("plugin.codexHighlight.apply");
        try {
          const { typeColorMap } = useCodexHighlightStore.getState();

          // Async result delivered via transaction meta
          const asyncResult = tr.getMeta("codexHighlightResult") as
            | CodexMatch[]
            | undefined;
          if (asyncResult !== undefined) {
            const settings = useSettingsStore.getState();
            const highlightStyle = settings.get(
              "display.codexHighlightStyle",
              "color-text",
            );
            const opacityLevel = Number(
              settings.get("display.codexHighlightOpacity", "10"),
            );
            return DecorationSet.create(
              newState.doc,
              mapMatchesToDecorations(
                newState.doc,
                asyncResult,
                typeColorMap,
                highlightStyle,
                opacityLevel,
              ),
            );
          }

          // 段落移動 (隣接ブロック swap) は replaceWith で装飾を落とすため、移動が
          // 運ぶ reorder meta を見て per-block オフセットで装飾を手動再構築し保持する。
          // これで移動中もハイライトの padding/色が消えず、折り返しズレ・ちらつきが出ない。
          const reorder = tr.getMeta("codexHighlightReorder") as
            | CodexReorderInfo
            | undefined;
          if (reorder) {
            return remapCodexDecosForReorder(oldDecos, newState.doc, reorder);
          }

          // Doc changed or forced update → remap existing decoration positions
          if (tr.docChanged || tr.getMeta("codexHighlightUpdate") === true) {
            // Adjacent inline decorations (deco[i].to === deco[i+1].from) cause
            // ProseMirror's DOM reconciler to crash when content is inserted at
            // the shared boundary (null nextSibling in renderDescs). Clear all
            // decos in that case; asyncResult will rebuild them in ~150ms.
            // Check after mapping: deletions between previously non-adjacent
            // decos can pull them into adjacency.
            const mapped = oldDecos.map(tr.mapping, tr.doc);
            const decoList = mapped.find();
            for (let i = 0; i + 1 < decoList.length; i++) {
              if (decoList[i].to === decoList[i + 1].from) {
                return DecorationSet.empty;
              }
            }
            return mapped;
          }

          return oldDecos;
        } finally {
          markEnd("plugin.codexHighlight.apply");
        }
      },
    },
    props: {
      decorations(state) {
        return codexHighlightKey.getState(state);
      },
    },
  });
}
