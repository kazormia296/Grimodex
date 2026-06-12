import { Extension, InputRule } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import Typography, {
  closeDoubleQuote,
  closeSingleQuote,
  emDash,
  openDoubleQuote,
  openSingleQuote,
} from "@tiptap/extension-typography";
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

const SettingGatedTypographyRules = Extension.create({
  name: "typographySettings",

  addInputRules() {
    return [
      ...[
        openDoubleQuote(),
        closeDoubleQuote(),
        openSingleQuote(),
        closeSingleQuote(),
      ].map((rule) => gateBySetting(rule, "editor.smartQuotes")),
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
