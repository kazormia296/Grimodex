import { Extension, InputRule } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import Typography, { emDash } from "@tiptap/extension-typography";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * editor.smartQuotes / editor.smartDashes 設定で実行時ゲートされる
 * Typography 構成。
 *
 * 入力ルールはエディタ生成時に一度だけ登録されるため、拡張の有無で
 * 切り替えると設定変更にエディタ再生成が必要になる（本文サーフェスの
 * 再生成は content-loss 系バグの温床）。代わりにルールの handler 内で
 * settingsStore を毎回参照する: handler が null を返すとそのルールだけ
 * 不発になり、後続ルールの試行は妨げない (@tiptap/core run() の契約)。
 *
 * quotes/dashes 以外の変換 (ellipsis 等) は設定が存在しないため、
 * 従来どおり Typography 本体側で常時 ON を維持する。
 */

function gateBySetting(rule: InputRule, settingKey: string): InputRule {
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      useSettingsStore.getState().getBoolean(settingKey, false)
        ? rule.handler(props)
        : null,
    undoable: rule.undoable,
  });
}

const OPEN_DOUBLE = "“"; // “
const CLOSE_DOUBLE = "”"; // ”
const OPEN_SINGLE = "‘"; // ‘
const CLOSE_SINGLE = "’"; // ’

/**
 * 直前文字がこのクラスなら「開き」文脈（行頭も開き扱い）。
 * 上流 Typography の openDoubleQuote と同じ区切りクラス
 * （空白・開き括弧・先行クォート）に加えて CJK（和文約物・かな・漢字・
 * 全角形）を含める。上流の規則は英語専用の区切りクラスしか見ないため、
 * 日本語文字の直後に " を打つと open ルールが外れて常に閉じグリフに
 * なっていた。
 */
const OPENING_CONTEXT =
  /[\s{[(<'"\u2018\u201C\u3000-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]$/;

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * 開き/閉じを文脈で決める smart quote ルール。
 *
 * 上流 Typography のような「直前文字クラスだけ」の判定は日本語で破綻する:
 * 開きも閉じも直前は CJK 文字になるため、クラスに CJK を足すと今度は
 * 閉じが打てなくなる。そこで段落内の開閉パリティを優先する —
 * 未クローズの開きクォートが手前にあれば閉じ、無ければ直前文字で
 * 開き/閉じ（apostrophe）を決める。英語の挙動（行頭・空白後は開き、
 * 語中の ' は apostrophe）は上流と一致する。
 *
 * single quote は apostrophe（don’t 等の語中 ’）が閉じグリフと同一文字の
 * ため、素朴に数えるとパリティが汚染される（例: `'don't ` の後の ' が
 * 開き扱いになる）。語中（英数字に両側を挟まれた）の close グリフは
 * クォートの閉じとして数えない（skipWordInternalCloses）。
 */
function smartQuoteRule(
  find: RegExp,
  open: string,
  close: string,
  opts?: { skipWordInternalCloses?: boolean },
): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      const $pos = state.doc.resolve(range.from);
      const before = $pos.parent.textBetween(
        0,
        $pos.parentOffset,
        undefined,
        "￼",
      );
      let unclosed = 0;
      for (let i = 0; i < before.length; i++) {
        const ch = before[i];
        if (ch === open) {
          unclosed += 1;
        } else if (ch === close && unclosed > 0) {
          const isWordInternal =
            i > 0 &&
            i + 1 < before.length &&
            WORD_CHAR.test(before[i - 1]) &&
            WORD_CHAR.test(before[i + 1]);
          if (opts?.skipWordInternalCloses && isWordInternal) continue;
          unclosed -= 1;
        }
      }
      const prev = before.slice(-1);
      const opening =
        unclosed === 0 && (prev === "" || OPENING_CONTEXT.test(prev));
      state.tr.insertText(opening ? open : close, range.from, range.to);
    },
  });
}

const SettingGatedTypographyRules = Extension.create({
  name: "typographySettings",

  addInputRules() {
    return [
      gateBySetting(
        smartQuoteRule(/"$/, OPEN_DOUBLE, CLOSE_DOUBLE),
        "editor.smartQuotes",
      ),
      gateBySetting(
        smartQuoteRule(/'$/, OPEN_SINGLE, CLOSE_SINGLE, {
          skipWordInternalCloses: true,
        }),
        "editor.smartQuotes",
      ),
      gateBySetting(emDash(), "editor.smartDashes"),
    ];
  },
});

export function getTypographyExtensions(): Extensions {
  return [
    Typography.configure({
      openDoubleQuote: false,
      closeDoubleQuote: false,
      openSingleQuote: false,
      closeSingleQuote: false,
      emDash: false,
    }),
    SettingGatedTypographyRules,
  ];
}
