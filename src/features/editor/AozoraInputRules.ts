import { Extension, InputRule, markInputRule } from "@tiptap/core";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * 青空文庫/カクヨム系記法の入力時自動変換 (`editor.aozoraInput`, 既定 ON)。
 *
 * - `｜親文字《ふりがな》`          → ruby ノード (明示ピペ)
 * - `漢字《ふりがな》`              → ruby ノード (自動ルビ: 直前の連続漢字が base)
 * - `《《傍点》》`                   → emphasisDots マーク
 * - `［＃縦中横］text［＃縦中横終わり］` → tcy マーク (範囲指定型)
 *
 * ruby ノード / emphasisDots / tcy マークは既にスキーマに存在するため
 * (`RubyNode.ts` / `EmphasisDotsMark.ts` / `TcyMark.ts`)、新スキーマは追加しない。
 * ロジックは import 経路の `kakuyomuMarkup.ts` と同じ形状を生成する。
 *
 * IME 経由の `》` は keydown では捕まらないが、prosemirror-inputrules が
 * compositionend でも再発火するため InputRule が唯一の IME 安全な変換経路。
 * 設定トグルは handler 内で実行時参照する (拡張の付け外しはエディタ再生成＝
 * 本文消失の温床のため避ける — TypographySettingsExtension と同方針)。
 *
 * file-backed(外部Markdown) エディタは ruby/emphasisDots スキーマを持たない
 * ため、この拡張は `getEditorExtensions` (project DB シーン) にのみ登録する。
 */

/** kakuyomuMarkup.ts の KANJI_RE と同一 (連続漢字 + 反復記号)。 */
const KANJI_CLASS = "一-鿿々〆〤ヶ";

/** `｜base《reading》` — 明示ピペルビ。base は ｜《》改行以外なら何でも可。 */
const PIPE_RUBY = new RegExp(`｜([^｜《》\\n]+)《([^《》\\n]+)》$`);
/** `漢字《reading》` — 自動ルビ。直前の連続漢字を base とする。 */
const AUTO_RUBY = new RegExp(`([${KANJI_CLASS}]+)《([^《》\\n]+)》$`);
/** `《《text》》` — 傍点(圏点)。 */
const EMPHASIS_DOTS = /《《([^《》\n]+)》》$/;
/** `［＃縦中横］text［＃縦中横終わり］` — 範囲指定型の縦中横。 */
const TCY_RANGE = /［＃縦中横］([^［］\n]+)［＃縦中横終わり］$/;

/**
 * `TypographySettingsExtension` の gateBySetting と同型だが、既定を **true**
 * にした版 (青空記法は既定 ON)。handler が null を返すとそのルールだけ
 * 不発になり、後続ルールの試行は妨げない (@tiptap/core run() の契約)。
 */
function gateOn(rule: InputRule, settingKey: string): InputRule {
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      useSettingsStore.getState().getBoolean(settingKey, true)
        ? rule.handler(props)
        : null,
    undoable: rule.undoable,
  });
}

/**
 * `［＃縦中横］text［＃縦中横終わり］` を tcy マーク付きテキストへ置換する。
 * markInputRule は capture がデリミタ内に現れると indexOf が誤爆するため
 * (text が "縦中横" 等)、自前 handler で範囲を明示置換する。
 */
function tcyRule(): InputRule {
  return new InputRule({
    find: TCY_RANGE,
    handler: ({ state, range, match }) => {
      const tcyType = state.schema.marks.tcy;
      const text = match[1];
      if (!tcyType || !text) return null;
      state.tr.insertText(text, range.from, range.to);
      state.tr.addMark(range.from, range.from + text.length, tcyType.create());
      state.tr.removeStoredMark(tcyType);
    },
  });
}

/** `｜base《reading》` / `漢字《reading》` を ruby ノードへ置換する InputRule。 */
function rubyRule(find: RegExp): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const rubyType = state.schema.nodes.ruby;
      if (!rubyType) return null;
      const base = match[1];
      const annotation = match[2];
      if (!base || !annotation) return null;
      state.tr.replaceRangeWith(
        range.from,
        range.to,
        rubyType.create({ base, annotation }),
      );
    },
  });
}

export const AozoraInputRules = Extension.create({
  name: "aozoraInputRules",

  addInputRules() {
    const emphasisType = this.editor.schema.marks.emphasisDots;
    const rules: InputRule[] = [
      // ｜付きを最優先 (自動ルビが ｜ を無視して先食いするのを防ぐ)
      gateOn(rubyRule(PIPE_RUBY), "editor.aozoraInput"),
    ];
    // 《《…》》 を単一 《…》(自動ルビ) より先に判定する
    if (emphasisType) {
      rules.push(
        gateOn(
          markInputRule({ find: EMPHASIS_DOTS, type: emphasisType }),
          "editor.aozoraInput",
        ),
      );
    }
    rules.push(gateOn(rubyRule(AUTO_RUBY), "editor.aozoraInput"));
    // 縦中横 (［＃縦中横］…［＃縦中横終わり］)。tcy マークが在るときだけ。
    if (this.editor.schema.marks.tcy) {
      rules.push(gateOn(tcyRule(), "editor.aozoraInput"));
    }
    return rules;
  },
});
