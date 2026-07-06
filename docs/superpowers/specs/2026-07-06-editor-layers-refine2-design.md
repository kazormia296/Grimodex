# Editorパネル レイヤー/オーバーレイ Refine 2b 設計書

日付: 2026-07-06
先行: `2026-07-06-editor-panel-refine-design.md` (PR#286) のフォローアップ。
ユーザー提案 8 項目（+ 追加 1 項目）を、AskUserQuestion で確定した 4 決定と
ともに実装した。

## 確定した決定（ユーザー回答）

1. **読者コメントの見た目** = 点線下線・菫色（「点線 = コメント族」の視覚言語を維持）
2. **パネル連動 (Auto) モード** = 完全追従（パネル開閉に レイヤー ON/OFF が追従、
   手動トグルは次のパネル変化までの一時上書き — Map パネルの
   `useMapBoardAutoActivate` と同型）
3. **シーン区切りアイコン** = アスタリスク3連 SVG（本文の「* * *」と1対1対応）
4. **統合後の波線色** = severity 共通スケール（error=赤 / warning=橙 /
   suggestion・info=青。校閲と Lint をソースで塗り分けない）

## 変更内容

### 1. 校閲の指摘 + Lint の統合レイヤー
- LayersPopover の校閲行と Lint 行を「校閲の指摘」1行に統合。
  スイッチ表示は `showAnnotations || showLint`、トグルは両フラグを同値に揃えて
  write-through（`display.layerReview` + `display.layerLint` の2キーは維持）。
- 件数 = 校閲アノテーション（非 dismissed・pseudo_comment 除く、scene のみ）+ Lint 診断数。
- CSS: `--deco-lint-*` → `--deco-issue-*` に改名し、`.pe-annotation` にも
  severity クラス（`pe-annotation-severity-*`）で同スケールを適用。
  `--deco-review`（ピンク）は引退。ガターの校閲マークは `--deco-issue-warning` の単色。
- AnnotationPlugin は元から severity クラスを付与していた（CSS 未定義で無効だった）
  — CSS 側の定義追加のみで色分けが有効化される。既定 severity は
  `applyAnnotationsToEditor` の `?? "warning"`。

### 2. 読者コメント (pseudo_comment) の分離
- 新レイヤー「読者コメント」（scene のみ表示、`display.layerReaderComments` 既定 ON、
  `annotationStore.showReaderComments`）。
- AnnotationPlugin のゲートを category で分岐: `pseudo_comment` →
  `showReaderComments`、それ以外 → `showAnnotations`。
- 見た目は背景ハイライト（帰属の「面」と衝突）→ **菫色の点線下線**
  （`--deco-reader-comment`: light `#8b5cf6` / dark `#a78bfa`）。
  severity クラスとの同居があるため `.pe-annotation.pe-annotation-pseudo_comment`
  の2クラスで specificity を上げて上書き。
- PseudoCommentBubble（ホバー吹き出し）も `showReaderComments` に従属。
- 段落ガターに `reader` チャネルを追加（MessagesSquare 相当アイコン、
  comment → reader → foreshadow → review の順）。

### 3. パネル連動 (Auto) モード — `useLayerAutoFollow`
- `display.layerAutoFollow`（既定 OFF、`cursorSettingsStore.layerAutoFollow`）。
  LayersPopover ヘッダ直下の「パネル連動」スイッチでトグル。
- ON 中の対応: kouetsu → 校閲の指摘 + 読者コメント / codex → Codex /
  attribution → 帰属 / foreshadow → 伏線。コメントは対応パネルがないため手動のまま。
- **自動追従は設定を書き換えない**: 各ストアに `persist:false` オプション付きの
  絶対値セッター（`setShowAnnotations` / `setShowLint` / `setShowForeshadowMarks` /
  `setShowAttribution` / `setEnabled` 等）を追加し、`LayerSetOptions` で分岐。
  手動基準値（`display.layer*`）は保存されたまま、**Auto OFF 復帰時に
  `initFromSettings` ×4ストアで復元**。
- フックは Toolbar にマウント（エディタごと）。decoration plugin はストアを
  build 時に読むだけなので、追従時に各 rebuild meta を dispatch する
  （LayersPopover のトグルと同じ規約）。attribution / Codex は
  `useAttribution` / `useCodexHighlight` がストア購読で自前 dispatch するため不要。

### 4-5. 説明文の削除
- `editor.layers.codexNote`（「（見た目は不変）」）と `editor.layers.sampleNote`
  （「行の左見本 ＝ 本文中の描画」）を ja/en とも削除。

### 6. 行見本の Lucide アイコン化
- 左列の見本（波線 SVG・カラードット等）を廃止し、チャネル色の Lucide アイコンへ:
  帰属=Fingerprint（--attribution-ai）/ コメント=MessageSquareText（--deco-comment）/
  読者コメント=MessagesSquare（--deco-reader-comment）/ 伏線=Flag
  （--deco-foreshadow-setup）/ 校閲の指摘=SpellCheck（--deco-issue-warning）/
  Codex=BookOpen（muted）。
- ツールバーの状態ドット（5px）は維持。読者コメントドットを追加し、
  校閲+Lint は統合1ドット（--deco-issue-warning）に。

### 7. Codex ハイライトの種類 + 濃度
- LayersPopover の Codex 行 ON 時に展開 UI: スタイルセグメント
  「デフォルト / 下線」（既存 `display.codexHighlightStyle` に接続）+
  濃度スライダー（新キー `display.codexHighlightOpacity`、5〜25、既定 10）。
  濃度は背景スタイル時のみ表示（表示は ×10 で 50〜250%、100%=標準）。
- 濃度の解決は `codexHighlightBackground(colors, level)`（resolveCodexColors.ts）:
  **10 = パレット設計値 (hl) そのまま**（既定で従来の見た目を完全保存）、
  10 未満 = hl を透明側へ `level×10%`、10 超 = fg を `（level-10)×2%` 混合して濃く。
- 適用箇所: CodexHighlightPlugin（本文）+ useCodexMarkdownComponents（チャット）。
  再構築は `useCodexHighlight` が `display.codexHighlightOpacity` を購読して
  既存の style 変更と同経路で dispatch。
- 設定ダイアログ（DisplayCategory）にも同じ濃度スライダーを追加。

### 8. シーン区切りアイコン
- Toolbar の手描き SVG「— ・・・ —」→ アスタリスク3連（各アスタリスクは
  縦線+対角2線の6アーム、中心 x=4/12/20）。

### 9. タブバーとメタチップ行の上下入替（追加要望）
- 旧: Breadcrumb → SceneMetaChipRow → TabBar。新: Breadcrumb → TabBar →
  SceneMetaChipRow（タブ=どのシーンか、チップ=その中身、の階層に揃える）。
- split view では TabBar がグループごとのため、`SceneMetaChipRow` に
  `groupIndex` prop を追加して各グループのタブバー直下に設置。
  「そのグループのアクティブタブ = アクティブシーン」のときだけ描画し、
  同一シーンが両グループで開いている場合はフォーカス中のグループを優先。
  linear mode は単一 TabBar 直下（ゲートなし）。

## 設定キー（追加/変更なしの整理）

| キー | 既定 | 備考 |
|---|---|---|
| `display.layerReaderComments` | true | 新規 (global) |
| `display.layerAutoFollow` | false | 新規 (global) |
| `display.codexHighlightOpacity` | 10 | 新規 (global)、10=設計値そのまま |
| `display.layerReview` / `display.layerLint` | true | 維持（統合スイッチが両方を書く） |

## テスト
- `LayersPopover.test.tsx`: 行構成（scene=7スイッチ/他=6）、統合トグルの
  両キー write-through、読者コメント行、Codex 展開 UI、パネル連動スイッチ。
- `AnnotationPlugin.test.ts`（新規）: pseudo_comment と校閲の独立ゲート、severity クラス。
- `useLayerAutoFollow.test.ts`（新規）: 完全追従・設定不汚染・OFF 復元。
  layoutStore は zustand 製の小型モックで可視状態を駆動。
- `GutterMarksPlugin.test.ts`: reader チャネル分離とゲート。
- `decorationChannels.browser.test.tsx`: 新契約（severity 3色 / 読者コメント点線・
  背景なし / 校閲と Lint の同 severity 同色）を実 Chromium で gate。
- `resolveCodexColors.test.ts`: `codexHighlightBackground` の2セグメント式。

## フォローアップ (2026-07-07 ユーザーフィードバック5件)

1. **ガター表示領域の予約** — オーバーレイON時にアイコンが幅次第でクリップされる問題。
   ガター生成レイヤー（コメント/読者コメント/伏線/校閲）のON数から
   `gutterReserveInlineSize(n)` = `calc(14n+2(n-1)px + 0.6em)` を算出し、
   EditorContentArea の本文ラッパー（editor-line-numbers と同じ内側 div）に
   `.editor-gutter-reserve` + `--gutter-reserve` で padding-inline-start を予約。
   行番号 (2.5em) 併用時は加算。縦書きは論理プロパティで上余白へ自動追従。
   幾何 gate: decorationChannels.browser.test（予約なし=はみ出し / あり=収まる）。
2. **フォーカスモードで詳細ペイン・チップ行を表示** — focusMode の非表示条件を
   SceneMetaChipRow と EditorPane.isPanelVisible から除去。フォーカスモードの
   効果は本文減光 (FocusModePlugin) のみに。※旧設計 (1h) の
   「`!focusMode`」表示条件はこのフォローアップで廃止。
3. **ホバーポップオーバー全種対応 + カーソル統一** —
   校閲の指摘: `AnnotationHoverPopover`（severity アイコン + 観点ラベル
   (ANNOTATION_CATEGORY_TO_CAT→CAT_LABEL_KEY) + 指摘本文。pseudo_comment は
   PseudoCommentBubble の担当のまま除外）。
   Lint: `LintHoverPopover`（rule + message + Fix ボタン。message は decoration の
   `data-lint-message` 属性から読む — LintDecorationPlugin に属性追加。Fix は
   rule_id+message の一意一致時のみ表示）。
   カーソルは全装飾 `help` に統一（pe-annotation / codex-highlight を pointer→help。
   全種「ホバーで詳細」モデルでクリックハンドラを持つ装飾は無いため）。
4. **パネル連動のタブ連動化** — kouetsu 系レイヤーは `kouetsuStore.activeTab` に連動:
   指摘タブ→校閲の指摘 (校閲+Lint) / コメントタブ→コメント+読者コメント /
   ブロッカータブ・パネル閉→全OFF。コメントレイヤーも Auto 対象に昇格。
5. **「校閲パネルを開く →」フッタ導線を削除** — LayersPopover のフッタバーごと廃止
   （i18n キー editor.layers.openKouetsu 削除）。

## 既知のトレードオフ
- Auto 追従中の手動トグルは write-through で永続化される（明示操作のため意図通り）
  が、次のパネル可視変化で実効表示は再同期される。
- Lint トグル OFF→ON 復帰の stale オフセット許容は従来どおり（次の debounce で自己修復）。
- 統合スイッチは `layerReview` / `layerLint` の2キーを同値に揃えるだけで
  キー統合（migration）はしない — 旧設定との互換を優先。
