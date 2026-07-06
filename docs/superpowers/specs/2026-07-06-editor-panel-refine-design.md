# Editorパネル Refine — 実装設計書

日付: 2026-07-06
対象デザイン: claude.ai/design「Grimodexの校閲パネルリファイン」プロジェクト内 `Editorパネル Refine.dc.html`
実装対象: 統合プロトタイプ **2a**（= 1a ツールバー + 1c レイヤーメニュー + 1e 本文描画 + 1f 右パネル + 1h チップ行）

## 背景 / 問題意識

- 本文中のオーバーレイ装飾でコメント（`.comment-deco`）・Lint警告（`.lint-deco--warning`）・校閲警告
  （`.pe-annotation-severity-warning`）が**同一のアンバー波線 `#f59e0b`** を共有しており見分け不能。
- 表示トグル（帰属/コメント/伏線/校閲）がツールバー右に4ボタン散在し、Lint と Codex のトグルは別系統
  （Lint はトグル自体が無い）。永続化も不統一（帰属/コメント/伏線/校閲=メモリ内、Codex/Focus/TW=設定）。
- シーンメタデータ（視点/場所/作中日付/あらすじ/狙い/ビート）はネイティブ `<select>` 主体の
  `SceneMetaPanel`（SynopsisHeader + SceneDateEditor + BeatsHeader の縦積み）で、パネルを閉じると
  メタ情報が一切見えない。

## スコープ外（今回やらないこと）

- 1b（スリムバー+バブル昇格）・1d（ステータスバーチップ）・1g（下部ドロワー）は不採用案。
- ステータスバーは現状維持（2a のステータスバーは現行と同等: status/凡例/AI%/文字数/保存状態）。
- EditorBubbleMenu は変更しない。
- Codex ハイライトの見た目は不変（デザイン明記）。`display.codexHighlightStyle` の underline モードも
  現状のまま温存（3チャネル規則の前提は color-text だが、モード自体の廃止はしない）。
- シーン詳細の region パネル化（道B）はしない。既存の in-editor split（道A）を維持。

## フェーズ構成（コミット単位）

### Phase 1 — 本文描画の3チャネル化 + Lintトグル + ガター記号（1e）

**チャネル規則**（すべて `src/index.css`、`:root`/`.dark` 両対応の CSS 変数に新設):

| チャネル | 対象 | 現状 | 新スタイル |
|---|---|---|---|
| 面（背景） | 帰属 AI/不明 | color-mix 背景 | 変更なし（既存 `--attribution-*` × `--attribution-pct`） |
| 波線=直すべき問題 | 校閲（peAnnotation） | severity別波線(warning=#f59e0b) | **全 severity ピンク波線 `#c2417e`**（dark: 明度上げ）。pseudo_comment の indigo 背景は維持 |
| 波線=直すべき問題 | Lint | error #ef4444 / warning #f59e0b / info #3b82f6 | warning を **`#d98d1f`** へ（error/info は維持）。dark 変種追加 |
| 点線=自分のメモ | コメント | アンバー波線 #f59e0b | **点線 dotted `#d99a26`**（dark 変種追加） |
| 破線=自分のメモ | 伏線 setup | 実線 #60a5fa | **破線 dashed `#5B6FD8`** |
| 破線=自分のメモ | 伏線 payoff | 実線 #4ade80 | **破線 dashed**、色は既存の緑系を維持（setupと区別するため。デザインは setup のみ提示） |
| 文字色 | Codex | typeColorMap インライン | 変更なし |

- 新 CSS 変数: `--deco-comment` / `--deco-foreshadow-setup` / `--deco-foreshadow-payoff` /
  `--deco-review` / `--deco-lint-warning`（`:root` と `.dark` で定義。colorThemes.ts は触らない —
  帰属以外はテーマパレット管理外という現状の割り切りを維持）。
- **Lint 表示トグル新設**: `lintStore` に `showLint`（既定 true）を追加し、`LintDecorationPlugin` を
  ゲート。トグル時は既存の diagnostics 再設定 meta（`setLintDiagnostics` 経路）で再構築。
- **ガター記号**: 新規 `GutterMarksPlugin`（`LintDisableGutterPlugin` の widget decoration パターンを
  一般化）。トップレベルブロック単位で「コメント / 伏線 / 校閲」の存在を集約し、ブロック先頭に
  `Decoration.widget(pos+1, side:-1)` で最大3アイコンの行を描画。CSS は論理プロパティ
  （`inset-inline-start`）で縦書き時に段落頭上部へ自然に回る。各レイヤートグルOFF時はそのアイコンを
  出さない。行単位ではなく**段落単位**の当たり付け（デザインの縦書き注記「段落頭の上部余白へ」と整合。
  行単位化は coordsAtPos 依存の別機構になるため見送り）。
- テスト: プラグイン単体（happy-dom）+ `decorationChannels.browser.test.tsx`（実 Chromium で
  text-decoration-style / color の computed style を assert）。

### Phase 2 — 「本文レイヤー」ポップオーバー + ツールバー再編（1c + 1a）

**レイヤーポップオーバー**（新規 `src/features/editor/LayersPopover.tsx`、
`useAnchoredPopover`(portal+fixed) 使用）:

| 行 | 状態源 | 件数 | 備考 |
|---|---|---|---|
| 帰属ハイライト | `attributionStore.showAttribution` | AI% (`aiRatios[nodeId]`) | ON時に濃度スライダー展開（`display.attributionHighlightOpacity` 設定と双方向、設定画面のスライダーと同一セマンティクス） |
| コメント | `cursorSettingsStore.showComments` | doc 走査で comment run 数 | トグル時 `COMMENT_REBUILD_META` dispatch 必須 |
| 伏線マーク | `cursorSettingsStore.showForeshadowMarks` | doc 走査で setup/payoff run 数 | DOM属性ゲート（EditorContentArea） |
| 校閲の指摘 | `annotationStore.showAnnotations` | `annotationsByScene` の非dismissed数 | `sceneId && nodeType==="scene"` 時のみ行を表示。トグル時 `ANNOTATION_REBUILD_META` dispatch |
| Lint | `lintStore.showLint`（Phase 1 新設） | `diagnostics.length` | |
| Codexハイライト | `codexHighlightStore.enabled` | —（「見た目は不変」注記） | トグルを `display.codexHighlight` へ write-through 追加 |

- ヘッダ「すべて隠す」= 6トグル一括OFF。フッタ「校閲パネルを開く →」=
  `useLayoutStore.getState().showPanel("kouetsu")`。各行の左に「本文中の見え方の見本」
  （CSS 変数を参照した小さな帯/線サンプル）。件数はポップオーバー open 時に一度だけ算出。
- **トグルの永続化統一**: settings に global キー新設 —
  `display.layerAttribution`(false) / `display.layerComments`(false) / `display.layerForeshadow`(false) /
  `display.layerReview`(true) / `display.layerLint`(true)。各ストアのトグルで write-through、
  `initFromSettings` を拡張（呼び出しは cursorSettingsStore.initFromSettings と同じ初期化点に追加）。
  Codex は既存キー `display.codexHighlight` を再利用。

**ツールバー再編**（`Toolbar.tsx`）:

- 左4ユニットは構成維持のままアイコン化: U1=Bold/Italic/Underline/Strikethrough(lucide)+﹅(グリフ維持)、
  U2=H1/H2/H3(テキスト維持)、U3=List/ListOrdered/TextQuote/Minus(lucide)、
  U4=ふり仮名(2段グリフ)/Link(lucide)/シーン区切り(デザイン準拠のインラインSVG)。
  ResizeObserver 計測は実幅ベースなので構造不変なら破綻しない。⋮ 内の退避ミラーはそのまま。
- 右グループ: `Aa` | 表示モードセグメント（集中=Focus/TW=Keyboard/縦=「縦」、枠付きセグメント化。
  挙動は既存を維持: TW は `disabled={verticalMode}`）| **レイヤーボタン**（Layers アイコン+ONレイヤーの
  状態ドット、クリックでポップオーバー）| ▶→PanelRight アイコン | ⋮。
  既存の Attr/Cmt/Fs/Rv 4ボタンは撤去（機能はポップオーバーへ移設）。
- Toolbar の `useEditorState` selector 規律を維持（perf テスト gate）。レイヤーストア購読は
  トグル時のみ変化する値に限定。
- テスト: Toolbar.a11y / Toolbar.perf の追従更新 + LayersPopover 単体（トグル/メタdispatch/すべて隠す/
  件数/校閲行の scene 限定）。

### Phase 3 — シーン詳細パネル刷新 + メタチップ行（1f + 1h）

**共有ピッカー部品**（新規 `src/features/editor/sceneMeta/`）:
- `PovPickerPopover` / `LocationPickerPopover`: 検索入力 + `useCodexStore` の type フィルタ候補 +
  「指定なしにする」。保存は必ず `treeStore.updatePovCharacter` / `updateLocation`（undo/OCC 連動）。
- `SceneDatePopover`: 開始/終了 + 確度3ボタン（確定/推定/不明 = `chroniclePrecision`、
  `EVENT_PRECISIONS`）。既存 `EventDateFields`/`ChronicleDatePicker` を流用し `updateChronicleDate`。
- `SynopsisPopover`: あらすじ textarea + 生成ボタン + 狙い表示。`updateSynopsis`。
- すべて `useAnchoredPopover` で body portal（glass/stacking context 罠回避）。

**SceneMetaPanel 刷新**（1f）:
- ヘッダ: 「シーン詳細」+ status バッジ + 閉じるボタン（`editor.sceneMetaPanelOpen` を直接 set）。
- プロパティグリッド: 視点/場所/作中日付 の3行。チップ+上記ピッカー（ネイティブ select 廃止）。
- あらすじカード: textarea + 生成 + 狙い textarea（`updateIntent`、破線枠）。
- ビートセクション: 既存 BeatsHeader の機構（D&D/あらすじから生成/件数）を新レイアウトに再構成。
  配置済みビートに「本文 ¶n」ラベル（doc のトップレベルブロック index から算出する純関数
  `paragraphIndexOfBeat` を新設）。
- SceneMetaPanel は EditorPane / LinearEditorView の両方から共有されているため、中身の刷新は
  一箇所で両ビューに効く。

**メタチップ行**（1h、新規 `SceneMetaChipRow.tsx`）:
- 表示条件: `nodeType==="scene" && !sceneMetaPanelOpen && !focusMode`。
  挿入点は `SceneEditor.tsx` の `<Breadcrumb />` 直下（linear/split の2箇所）。
- チップ: 視点（dot+名前）/ 場所 / 作中日付（+確度バッジ）/ あらすじ（省略表示）/ ビート n。
  視点/場所/日付/あらすじ → その場ポップオーバー編集（共有ピッカー）。ビート → パネルを開く。
- テスト: チップ行の表示条件、ピッカー→treeStore アクション呼び出し、`paragraphIndexOfBeat` 純関数、
  Radix/popover は既存の vi.mock パターン。

## 横断事項

- i18n: 新キーは `editor.layers.*` / `editor.chipRow.*` / `editor.sceneDetail.*` を ja/en 両方に追加。
  `editor.toolbar.comments` の「（未実装）」表記を解消。
- アニメ: ポップオーバー開閉は `src/lib/animation.ts` の VARIANTS/DURATIONS 経由。
- 検証: `pnpm test` / `npx tsc --noEmit` / `pnpm lint:fix` / `pnpm test:browser`
  （レイアウト・CSS 解決が絡むため browser 必須）。
- 実装後に敵対的レビュー（review-code/adversarial-reviewer.md）→ Critical/Important を潰す。

## 既知のリスクと対策

1. **COMMENT/ANNOTATION_REBUILD_META の欠落** → ポップオーバーのトグルハンドラに必ず含める
   （テストで dispatch を assert）。
2. **Toolbar perf 回帰** → 新規購読は useEditorState selector か、タイピングで変化しないストア値に限定。
   Toolbar.perf.test.tsx が gate。
3. **ツールバー幅計測の破綻** → ユニット数/順序を変えない。アイコン化で幅が変わるのは計測が吸収。
4. **永続化の初期化タイミング** → initFromSettings は settings loadAll 後の既存初期化点に追加。
5. **伏線だけ制御経路が DOM 属性ゲート** → ポップオーバーからは従来どおり
   `cursorSettingsStore.showForeshadowMarks` を切替（EditorContentArea の data 属性が反応）。
6. **CodexHighlightPlugin の隣接 decoration クラッシュ既知問題** → ガターは widget（inline範囲を
   持たない）なので非該当だが、browser テストで縦書き+全レイヤーONの共存を確認。
7. **チップ行とパネルの二重編集** → 編集ロジックはすべて共有ピッカー + treeStore アクションに集約し
   二重管理を避ける。
8. **日付2系統（storyTime* vs chronicle*）** → チップ/パネルとも chronicle* 系（SceneDateEditor が
   編集している方）を正とする。storyTimeLabel は触らない。
