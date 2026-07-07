# エディタ入力補助3種 設計書 (2026-07-07)

## 概要

本文エディタ (TipTap) に「入力を助ける」3機能を追加する。いずれも設定トグルで
制御し、既存の設定パイプライン (`types.ts` → `EditorCategory` → `useEditorSettings`)
と拡張登録パターン (`getEditorExtensions`) に素直に載せる。

| # | 機能 | 既定 | 設定キー (scope=global) | 実装機構 |
|---|------|------|------------------------|----------|
| 1 | 青空文庫記法の入力時自動変換 | **ON** | `editor.aozoraInput` | 設定ゲート付き InputRule |
| 2 | 空白・改行の表示（不可視文字） | **OFF** | `editor.showInvisibles` | ラッパクラスCSS(¶) + 実行時Decorationプラグイン(空白/↵) |
| 3 | 約物ペアの自動補完 | **ON** | `editor.autoPairBrackets` | 設定ゲート付き InputRule + Backspace キーマップ |

3つとも「拡張配列を差し替えず、handler 内で `useSettingsStore.getState().getBoolean`
を実行時参照」する `gateBySetting` 流儀に従う（配列差し替え＝エディタ再生成＝本文消失の温床、
`EditorPane.tsx:556` の警告）。

## 前提（recon で確定した既存資産）

- `RubyNode` (inline atom node `ruby` `{base, annotation}`) と `EmphasisDotsMark`
  (mark `emphasisDots`) は**既にスキーマに存在**。青空変換は新ノードを増やさず既存を挿す。
- `src/features/import/kakuyomuMarkup.ts` に `KANJI_RE = /[一-鿿々〆〤]/` と
  `｜base《reading》` / `漢字《reading》` / `《《text》》` のパーサが既にあり、
  同じスキーマ形状を生成する（ロジックを流用）。
- InputRule の IME 安全性: PM は IME 変換中 keydown を抑止するが
  (`prosemirror-view` keyCode 229 / `view.composing`)、`prosemirror-inputrules` は
  `handleTextInput` に加え `compositionend` フックも張るため **InputRule は IME 確定後に再発火**する。
  → 約物・記法の変換は InputRule に置くのが唯一の IME 安全経路。物理キー(Backspace)は keymap で可。
- 拡張登録は2系統: `getEditorExtensions()` (project DBシーン) と
  `buildFileBackedExtensions()` (外部Markdownシーン)。後者は **ruby/emphasisDots スキーマを持たず**、
  貼付時に ruby 記法を strip する。→ **青空変換は前者のみ**（file-backed に ruby ノードを挿すと schema エラー）。
- 実行時プラグインは `useCharacterFade` / `useTateChuYoko` 流儀で
  `EditorPane.tsx` と `LinearSceneBlock.tsx` の**両方**に hook を配線する。

## 機能1: 青空文庫記法の入力時自動変換 (`editor.aozoraInput`, 既定ON)

新規 `src/features/editor/AozoraInputRules.ts` = `Extension.create({ addInputRules })`。
`getEditorExtensions` の `RubyNode` 近傍に登録（file-backed には**登録しない**）。

InputRule（配列順が重要。単一 `《` を使う自動ルビより、`｜`付き・`《《`付きを先に）:

1. **ピペルビ** `find: /｜([^｜《》\n]+)《([^《》\n]+)》$/`
   → `state.tr.replaceRangeWith(range.from, range.to, schema.nodes.ruby.create({base:m[1], annotation:m[2]}))`
2. **傍点** `markInputRule({ find: /《《([^《》\n]+)》》$/, type: schema.marks.emphasisDots })`
3. **自動ルビ** `find: /([一-鿿々〆〤ヶ]+)《([^《》\n]+)》$/`（ユーザ選択=自動ルビON）
   → 同じく ruby ノード挿入。`match[1]` が連続漢字＝base。

各ルールは default **true** のゲートで包む（既存 `gateBySetting` は既定 false なので、
本ファイルに `gateOn(rule, key)` = `getBoolean(key, true)` を実装）。

罠: ruby は atom (size=1) なので `insertText` ではなく `replaceRangeWith` でノード挿入。
順序で `《《…》》` を単一 `《…》` より先に判定（傍点をルビに食われない）。

## 機能2: 空白・改行の表示 (`editor.showInvisibles`, 既定OFF)

- **段落末 ¶**: ラッパクラス `editor-show-invisibles` を付けて純CSS
  `.editor-show-invisibles .tiptap > p::after { content:"¶" }`（行番号CSSと同型・縦書きは論理プロパティで追従）。
  クラス付与は `EditorContentArea.tsx`(内側div) と `LinearSceneBlock.tsx`(629) の `cn()` に
  `editorSettings.showInvisibles && "editor-show-invisibles"` を追加。
- **空白 / 全角空白 / タブ / hardBreak↵**: `src/features/editor/ShowInvisiblesPlugin.ts`
  Decoration プラグイン。text ノードを走査し空白文字ごとに
  `Decoration.inline(pos,pos+1,{class})`（`pm-ws-space` `pm-ws-ideographic` `pm-ws-tab`）、
  hardBreak に `Decoration.widget(pos,()=>span("↵"),{side:-1})`。
  CSS は span を `position:relative` + `::before` オーバレイでグリフを重ねる
  （実文字は残す＝コピー/文字数に影響なし。inline-block 不使用で幻の空行を回避）。
  docChanged で再構築・全置換で clear・それ以外は map（`AttributionPlugin`/`LintDecorationPlugin` 型）。
- 実行時登録 `src/features/editor/useShowInvisibles.ts`（`useTateChuYoko` 型: setting ON の時だけ
  `registerPlugin`、OFF で `unregisterPlugin`）。`EditorPane`(1274近傍) と `LinearSceneBlock`(473近傍) に配線。
- グリフ: 半角空白=`·` / 全角空白=`□` / タブ=`→` / 段落末=`¶` / hardBreak=`↵`。muted色・低opacity・pointer-events none。

## 機能3: 約物ペア自動補完 (`editor.autoPairBrackets`, 既定ON)

新規 `src/features/editor/AutoPairBracketsExtension.ts`。`getEditorExtensions` と
`buildFileBackedExtensions` の**両方**に登録（テキスト操作のみでスキーマ非依存）。

対象ペア（`《》`はルビと衝突するため**除外**、ASCII引用符は smartQuotes 所管なので**除外**）:
```
「」 『』 （） 【】 〔〕 ［］ 〈〉 ｛｝ 〝〟
```

挙動（すべて `editor.autoPairBrackets` 実行時ゲート）:

1. **ペア挿入** `addInputRules()` 開き約物 `find: /([「『（【〔［〈｛〝])$/`
   → 直後文字が「内容文字」(かな/漢字/英数字等)なら閉じを挿さず null（`「」既存文` の鬱陶しさ回避）、
   それ以外(行末/空白/約物)なら閉じ約物を `range.to` に挿入しキャレットを間に置く。
2. **オーバータイプ** `addInputRules()` 閉じ約物 `find: /([」』）】〕］〉｝〟])$/`
   → 直後が同じ閉じ約物なら、今打った1文字を削除しキャレットを既存の閉じの後ろへ（二重化防止）。
3. **スマート Backspace** `addKeyboardShortcuts()` `Backspace`
   → 空選択で直前が開き・直後が対応する閉じ（空ペア `「|」`）なら両方削除。それ以外は false（既定動作）。

**選択範囲ラップ（選択して開き約物→囲む）は非対応**（IME 確定は選択を約物で置換済みのため
InputRule/compositionend では原理的に不可。物理入力だけ効く＝挙動が不一致になるので今回は見送り）。

罠: overtype/insert は開き・閉じで文字集合が排他なので相互衝突なし。Typography の `"`/`'`
（smartQuotes）とも文字が重ならない。青空の `《`/`》`/`｜` とも重ならない。

## 設定配線（3キー共通レシピ）

- `src/features/settings/types.ts`: `KEY_SCOPE` に3キー `"global"`、`DEFAULT_SETTINGS` に
  `"true"/"false"/"true"`（機能1/2/3）。3値の既定を UI `defaultValue`・`useEditorSettings` と一致させる。
- `src/features/settings/hooks/useEditorSettings.ts`: `EditorSettings` に3 boolean 追加
  （`showInvisibles` は EditorContentArea/LinearSceneBlock のラッパクラス駆動に必要。
  aozoraInput/autoPairBrackets は InputRule が store を直接読むので必須ではないが、対称性のため追加）。
- `src/features/settings/categories/EditorCategory.tsx`: experience セクションに 3 `SettingToggle`。
- `src/locales/ja.json` / `en.json`: `settings.editor` に label + Desc キーを両方追加。

## テスト方針

- 機能1/3: `TypographySettingsExtension.test.ts` と同じ happy-dom + `view.someProp("handleTextInput")`
  1文字送りハーネスで、変換結果 doc を assert（ゲートON/OFF・順序・overtype・Backspace）。
- 機能2: happy-dom で `ShowInvisiblesPlugin` の DecorationSet を直接検証（空白種別・hardBreak・OFF時空）。
- IME 実挙動（二重挿入/オーバータイプの実機）は happy-dom で再現不能 → 手動QAに送る。
- `pnpm test` / `npx tsc --noEmit` / `pnpm lint:fix`。レイアウト幾何は絡まないため browser test は不要
  （¶ は純CSS、空白グリフは overlay で寸法不変）。
```
