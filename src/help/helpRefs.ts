/**
 * ヘルプ文書の参照 `{{<kind>:<key>}}` の解釈。
 *
 *  - `{{command:<id>}}`   コマンド（keybindings.ts の getCommands()）
 *  - `{{panel:<id>}}`     パネル（PanelId）
 *  - `{{settings:<id>}}`  設定カテゴリ（SETTINGS_CATEGORIES）
 *  - `{{preset:<id>}}`    組み込みレイアウトプリセット（例 `builtin:plan`）
 *  - `{{t:<i18n key>}}`   UI の文言（locales の key）。画面の部品の名前を書くのに使う
 */

export type HelpRefKind = "command" | "panel" | "settings" | "preset" | "t";

export interface HelpRef {
  kind: HelpRefKind;
  key: string;
  /** 本文中の `{{...}}` そのもの */
  raw: string;
}

const REF_PATTERN = /\{\{(command|panel|settings|preset|t):([^}\s]+)\}\}/g;
const ANY_BRACES = /\{\{[^}]*\}\}/g;

export function collectRefs(body: string): HelpRef[] {
  return [...body.matchAll(REF_PATTERN)].map((match) => ({
    kind: match[1] as HelpRefKind,
    key: match[2]!,
    raw: match[0],
  }));
}

/** 参照の形になっていない `{{...}}`（綴りの誤り）を返す。 */
export function findMalformedRefs(body: string): string[] {
  const valid = new Set(collectRefs(body).map((ref) => ref.raw));
  return [...body.matchAll(ANY_BRACES)]
    .map((match) => match[0])
    .filter((raw) => !valid.has(raw));
}

/** 参照を resolver の返す文字列へ置き換える。resolver が null を返した参照は原文のまま残す。 */
export function expandRefs(
  body: string,
  resolve: (ref: HelpRef) => string | null,
): string {
  return body.replace(REF_PATTERN, (raw, kind: string, key: string) => {
    return resolve({ kind: kind as HelpRefKind, key, raw }) ?? raw;
  });
}
