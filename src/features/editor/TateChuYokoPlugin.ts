import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { flattenDocForCodex } from "./codexDocFlatten";

/**
 * 縦中横（tate-chu-yoko）— 縦書きモードで半角数字の連続を `text-combine-upright`
 * で正立・横並びに結合する inline decoration プラグイン。
 *
 * - `off`  : 縦中横なし。
 * - `2`    : 2桁の数字 run のみ結合（出版物の慣習に最も近い既定）。
 * - `all`  : 2桁以上の数字 run をすべて結合（3〜4桁は流儀に幅があるため任意）。
 *
 * 縦/横の出し分けは CSS（`.editor-vertical .tiptap .tcy`）が担う。本プラグインは
 * doc から純粋に decoration を作るだけで、縦書き時のみ登録される（useTateChuYoko）。
 */
export type TateChuYokoPolicy = "off" | "2" | "all";

export const tateChuYokoKey = new PluginKey<DecorationSet>("tateChuYoko");

const DIGIT_RUN = /[0-9]+/g;

/** 1桁は縦中横の対象外（2文字以上）。policy により上限を変える。 */
function runLengthAllowed(len: number, policy: TateChuYokoPolicy): boolean {
  if (len < 2) return false;
  if (policy === "2") return len === 2;
  return true; // "all"
}

export function buildTateChuYokoDecorations(
  doc: ProseMirrorNode,
  policy: TateChuYokoPolicy,
): DecorationSet {
  if (policy === "off") return DecorationSet.empty;

  // Codex と同じ平坦化を single source of truth として使う。mark 境界で割れた
  // text node を連結するため、`20<b>26</b>` のような run も取りこぼさない
  // （per-text-node の matchAll だと割れてしまう罠）。ruby atom / block 境界も
  // この contract が吸収する（see codexDocFlatten.ts）。
  const { text, flatPmPos } = flattenDocForCodex(doc);
  const decos: Decoration[] = [];

  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0];
    if (!runLengthAllowed(run.length, policy)) continue;
    const start = m.index ?? 0;
    const end = start + run.length;
    // 防御チェック（CodexHighlightPlugin と同型）。contract 上は
    // text.length === flatPmPos.length なので冗長だが、flattenDocForCodex の
    // 将来変更で範囲外アクセスが静かに混入するのを防ぐ。
    if (start < 0 || end > flatPmPos.length) continue;
    const pmFrom = flatPmPos[start];
    const pmLastChar = flatPmPos[end - 1];
    const pmTo = pmLastChar + 1;
    // run が PM 空間で連続している時だけ装飾する。次はこの判定で弾かれる:
    //  - ruby atom: 全 base char が同一 PM 位置に潰れる
    //  - mention atom: flat text に寄与せず PM 位置に穴を空ける
    //    （codexDocFlatten.ts の「mention atoms contribute NOTHING」contract）
    //  - 万一 block 境界（\n スロット）を含む run
    if (pmLastChar - pmFrom !== run.length - 1) continue;
    decos.push(Decoration.inline(pmFrom, pmTo, { class: "tcy" }));
  }

  return DecorationSet.create(doc, decos);
}

export function createTateChuYokoPlugin(policy: TateChuYokoPolicy): Plugin {
  return new Plugin<DecorationSet>({
    key: tateChuYokoKey,
    state: {
      init: (_config, state) => buildTateChuYokoDecorations(state.doc, policy),
      apply(tr, old) {
        // 数字の挿入/削除で run の境界自体が変わるため、docChanged 時は map では
        // なく必ず再構築する（map だと "1"+"2"→"12" の新規 run を取りこぼす）。
        if (tr.docChanged) return buildTateChuYokoDecorations(tr.doc, policy);
        return old;
      },
    },
    props: {
      decorations(state) {
        return tateChuYokoKey.getState(state);
      },
    },
  });
}
