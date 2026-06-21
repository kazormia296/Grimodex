import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { flattenDocForCodex } from "./codexDocFlatten";
import {
  runLengthAllowed,
  TATE_CHU_YOKO_DIGIT_RUN,
  type TateChuYokoPolicy,
} from "./tateChuYokoPolicy";

/**
 * 縦中横（tate-chu-yoko）— 縦書きモードで半角数字の連続を `text-combine-upright`
 * で正立・横並びに結合する inline decoration プラグイン。
 *
 * 対象 run の length ポリシー（off/2/all）は tateChuYokoPolicy.ts に集約し、
 * エクスポート記法（exportEngine）と共有する。縦/横の出し分けは CSS
 * （`.editor-vertical .tiptap .tcy`）が担う。本プラグインは doc から純粋に
 * decoration を作るだけで、縦書き時のみ登録される（useTateChuYoko）。
 */
// 既存の import 互換のため型を再公開する。
export type { TateChuYokoPolicy };

export const tateChuYokoKey = new PluginKey<DecorationSet>("tateChuYoko");

const DIGIT_RUN = TATE_CHU_YOKO_DIGIT_RUN;

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
