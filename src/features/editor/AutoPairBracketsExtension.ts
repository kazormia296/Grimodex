import { Extension, InputRule } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { META_SKIP } from "@/features/editor/TrashBinCapturePlugin";

/**
 * 約物ペアの自動補完 (`editor.autoPairBrackets`, 既定 ON)。
 *
 * - **ペア挿入**: 開き約物を打つと対応する閉じを自動挿入し、キャレットを間に置く。
 *   直後が内容文字(かな/漢字/英数字等)のときは閉じない (`「」既存文` の鬱陶しさ回避)。
 * - **オーバータイプ**: 直後が同じ閉じ約物なら、打った1文字を捨てて既存の閉じを通過。
 * - **スマート Backspace**: 空ペア `「|」` の中でのみ両方を一括削除。
 *
 * 開き約物は IME 確定テキストとして compositionend で届き keydown では捕まらないため、
 * ペア挿入・オーバータイプは InputRule に置く (prosemirror-inputrules は
 * compositionend でも再発火する = 唯一の IME 安全経路)。Backspace は物理キーなので keymap。
 *
 * 選択範囲ラップ(選択→開き約物で囲む)は非対応: IME 確定は選択を約物で置換済みのため
 * InputRule/compositionend からは原理的に不可 (物理入力だけ効くと挙動が不一致になる)。
 *
 * `《》` はルビ/傍点 (AozoraInputRules) と衝突するため除外。ASCII 引用符は smartQuotes 所管。
 * priority を上げて Backspace キーマップを StarterKit/inputRules-undo より先に評価させる。
 */

const PAIRS: Record<string, string> = {
  "「": "」",
  "『": "』",
  "（": "）",
  "【": "】",
  "〔": "〕",
  "［": "］",
  "〈": "〉",
  "｛": "｝",
  "〝": "〟",
};

const CLOSERS = new Set(Object.values(PAIRS));
const OPEN_RE = /([「『（【〔［〈｛〝])$/;
const CLOSE_RE = /([」』）】〕］〉｝〟])$/;

/** 内容文字(この直前では閉じ約物を自動挿入しない)。 */
const CONTENT_CHAR = /[0-9A-Za-z぀-ヿ㐀-鿿豈-﫿ｦ-ﾝ々〆〇ーヶ]/;

function enabled(): boolean {
  return useSettingsStore
    .getState()
    .getBoolean("editor.autoPairBrackets", true);
}

/** 同一 textblock 内でキャレット直後の1文字 (無ければ "")。 */
function charAfter(doc: ProseMirrorNode, pos: number): string {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const offset = $pos.parentOffset;
  if (offset >= parent.content.size) return "";
  return parent.textBetween(offset, offset + 1);
}

export const AutoPairBracketsExtension = Extension.create({
  name: "autoPairBrackets",
  priority: 150,

  addInputRules() {
    // InputRule は「打鍵文字がまだ doc に無い」状態で発火する
    // (range は caret 上の 0 幅 / state.tr は打鍵前の doc)。よって打鍵文字を
    // 含めて明示挿入する。selection だけの変更は step が 0 になり dispatch
    // されず default 挿入が走るため、overtype も doc を必ず 1 step 動かす。
    //
    // undoable: false — 直後の Backspace で inputRules-undo が発火すると、
    // net-zero の overtype を巻き戻して閉じ約物を再挿入してしまう
    // (「」→「」」)。undoable=false なら undo レコードを残さず、docChanged で
    // inputRules 状態がクリアされるので Backspace は通常削除になる。
    return [
      // ペア挿入: 開き約物 → 開き+閉じを挿入しキャレットを間に置く
      new InputRule({
        find: OPEN_RE,
        undoable: false,
        handler: ({ state, range, match }) => {
          if (!enabled()) return null;
          const open = match[1]!;
          const close = PAIRS[open];
          if (!close) return null;
          const next = charAfter(state.doc, range.to);
          // 内容文字の直前では閉じない (開きだけ残す = null で default 挿入)
          if (next && CONTENT_CHAR.test(next)) return null;
          state.tr.insertText(open + close, range.from, range.to);
          state.tr.setSelection(
            TextSelection.create(state.tr.doc, range.from + 1),
          );
        },
      }),
      // オーバータイプ: 直後が同じ閉じなら重複させず通過
      new InputRule({
        find: CLOSE_RE,
        undoable: false,
        handler: ({ state, range, match }) => {
          if (!enabled()) return null;
          const close = match[1]!;
          if (charAfter(state.doc, range.to) !== close) return null;
          // 打鍵した閉じを挿入 → 直後の既存の閉じを消す (net で本文不変)。
          // キャレットは閉じの後ろへ。selection のみだと step 0 で不発なので
          // この insert+delete により default 挿入を確実に抑止する。
          state.tr.insertText(close, range.from, range.to);
          state.tr.delete(range.from + 1, range.from + 2);
          state.tr.setSelection(
            TextSelection.create(state.tr.doc, range.from + 1),
          );
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        if (!enabled()) return false;
        return this.editor.commands.command(({ state, tr, dispatch }) => {
          const { selection } = state;
          if (!selection.empty) return false;
          const { $from } = selection;
          const parent = $from.parent;
          const offset = $from.parentOffset;
          if (offset < 1 || offset >= parent.content.size) return false;
          const before = parent.textBetween(offset - 1, offset);
          const after = parent.textBetween(offset, offset + 1);
          // 空ペア (開き|対応する閉じ) のときだけ両方削除
          if (!before || PAIRS[before] !== after) return false;
          if (dispatch) {
            // 自動生成した空ペアの削除はゴミ箱に断片として残さない
            tr.setMeta(META_SKIP, true);
            tr.delete($from.pos - 1, $from.pos + 1);
          }
          return true;
        });
      },
    };
  },
});

/** テスト用: 対応表を公開 (契約の単一情報源)。 */
export const AUTO_PAIR_BRACKETS = PAIRS;
export const AUTO_PAIR_CLOSERS = CLOSERS;
