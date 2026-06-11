# Grimodex 縦書きライブ編集 MODE 設計書

最終更新: 2026-06-11（v1 実装完了時点）

## 概要

per-project トグル（`editor.verticalMode`、project_settings KV）で TipTap 編集面を
`writing-mode: vertical-rl` のままライブ編集できるモード。従来の VerticalPreview
（read-only オーバーレイ）とは独立しており、置き換えではない。

切替 UI: 設定ダイアログ > エディタ > 書字方向（Project スコープ）/
エディタツールバー右側の「縦」ボタン（即時トグル）。

## 設計の柱

1. **CSS 論理プロパティで「分岐しない」**
   行長制限・余白・ガター等は `max-inline-size` / `margin-inline` /
   `padding-inline-start` / `border-block-start` 等の論理プロパティに付け替え済み。
   横書きでは従来と計算結果が同一、縦書きでは自動で軸がマップされるため、
   style 生成（`editorLayout.buildEditorContentStyle`）にモード分岐は無い。
   ※ 行長 = inline-size（縦書きでは物理高さ）。`max-block-size` ではない。

2. **writing-mode はスクロールコンテナに付与**
   `.editor-vertical` クラスを EditorDropDiv（タブ）/ LinearEditorView の
   scrollRef（連続表示）に付ける。スクロール軸の反転はコンテナ自身の
   writing-mode で決まり、`.tiptap` へは継承で波及。再マウント不要。

3. **スクロールの論理化は 2 関数に閉じ込め**
   Chromium の vertical-rl は scrollLeft=0 が先頭（右端）・末尾方向が負値。
   この符号規約は `editorLayout.getLogicalScrollOffset` /
   `setLogicalScrollOffset` のみが知っている。エンジン差が出たらここだけ直す。
   browser test に canary あり（崩れたら即検知）。

4. **縦書き非対応機能は「実効 OFF」（設定値は書き換えない）**
   - typewriter scroll: Y 軸固定計算のため `effectiveTypewriter` で gate
     （useTypewriterScroll + EditorPane の即時センタリング effect の両方）。
   - characterFadeOut: coordsAtPos→fixed ゴーストのグリフ向きがズレるため実効 OFF。
     fadeIn は opacity のみなので両モード有効。
   - smoothCaret は v1 で実効 OFF だったが **論理軸化して縦書き対応済み**
     （ユーザー要望）。CursorOverlayPlugin に getVertical を注入し、
     (a) キャレット箱: 縦書きでは横棒 width=文字幅/height=2px（caretBox）、
     (b) 行跨ぎ affinity: 行スタック軸を前方=増加に正規化して
     resolveVerticalBias を両モード共用（lineAxisContentCoord、vertical-rl
     の負方向 scrollLeft も吸収）、(c) キー意味の入替: 縦書きでは ←/→ が
     行跨ぎ・↑/↓ が行内、(d) クリック affinity は X 軸比較。
     純関数は cursorCoords.test.ts で gate、実機 QA は IME + 行跨ぎ移動。

5. **縦書きのスクロール/ハイライト調整（ユーザー要望で追補）**
   - マウスホイール縦回転 → 読み進み方向（横）スクロール変換
     （useVerticalWheelScroll、非 passive listener。トラックパッド横/
     Shift+wheel/ctrl ズームは奪わない）。タブエディタ・リニア両方に配線。
   - Codex ハイライト背景の padding は論理 `padding-inline: 2px`
     （物理 `padding: 0 2px` は縦書きで行の太さ方向に効いて横幅が太る）。

6. **node-island は horizontal-tb リセット**
   scene-beat / scene-break / table / pre（コードブロック）/
   taskList（ul ごとリセットで nested にも継承）。
   browser test（verticalMode.browser.test.tsx）が寸法潰れと flex 軸を gate。
   generated-prose-block は当初島に含めていたが、Beat 生成の**本編プロセ**を
   doc に永続ラップするノードで横読み UI チャンクではない — 島にすると
   AI 生成シーンが縦書きリニアで丸ごと横書きで mount される（実バグ報告で発覚）。
   vertical-rl 継承へ変更し、同 browser test が縦書き継承側も gate する。

7. **per-scene スクロール保存は論理オフセット**
   EditorPane の savedEditorStateRef は `scrollOffset`（論理値）を保存。
   縦書きトグル時は保存済みオフセットと heightMap（Linear placeholder）を破棄して
   軸跨ぎ復元事故を防ぐ（カーソル位置 from/to は論理なので保持）。

## 無改修で成立している箇所（根拠つき）

- `text-emphasis-position: over right`（圏点）= 正準 2 キーワード形。縦書きで
  自動的に行の右側（日本語慣習）。
- ルビ = native `<ruby>/<rt>`。`.editor-vertical .tiptap ruby rt { font-size: 0.5em }` のみ追加。
- decoration（lint/comment/codex/find/diff/focus/fade-in）= inline/node decoration の
  native CSS 委譲。
- `scrollIntoView({block:'start'})`（Linear 外部ナビ）= CSSOM 論理解決。
  vertical-rl で右端整列 + scrollLeft 負方向になることを browser test で実証済み。
- Arrow/Home/End = native 委譲。Ctrl+Home/End（InlineAtomNavigation）は
  Selection.atStart/atEnd の論理軸で正当。

## v1 の既知制限（意図的 defer）

- 縦中横（text-combine-upright）未対応 — 半角数字/欧文は mixed で横倒し
- typewriter / characterFadeOut の縦書き対応版（smoothCaret は対応済み）
- popup 群（Codex/Comment/Foreshadow/Slash 等）の出現方向最適化 —
  viewport 座標なので機能はするが「下に出す」前提が縦組みでは不自然
- maxContentWidth の設定ラベル（縦書きでは「行長（高さ）」の意味になる）
- CharacterFadeOut の縦書き対応

## 実機 QA ゲート（コードで検証不能・リリース判定チェックリスト）

- [ ] **IME 変換窓**（最重要）: Windows WebView2 / macOS WKWebView で縦書き
      キャレットに候補窓が追従するか。文節変換・再変換・確定直後 undo。
      安全弁 = per-project トグルで即横書きに戻せること。
- [ ] scrollLeft 符号のエンジン差: WKWebView / WebKitGTK 実機で
      get/setLogicalScrollOffset の前提（0 起点・負方向）を確認。
- [ ] 句読点・括弧・長音の縦書き字形（vert/vpal）: Noto Serif JP + 任意フォント。
- [ ] ルビ実挙動: 列の右側に出るか、選択・キャレット通過・Backspace。
- [ ] native キャレット/選択: 矢印キーの視覚方向、クリック位置、ドラッグ選択。
- [ ] ホイール/トラックパッドが列方向（横）スクロールに変換されるか。
- [ ] decoration 目視: lint 波線の出る側、find ハイライト、FocusMode dim。
- [ ] 長文パフォーマンス: 2〜5 万字シーンのタイピング/スクロール。
- [ ] Linear: 連続スクロール、Scenes パネル⇔エディタ双方向同期、placeholder
      通過時のジャンプ、初期スクロール位置。
- [ ] リサイズで行長（max-inline-size）が再計算されるか。
- [ ] popup 群の実害チェック（被って操作不能になるケースが無いか）。
- [ ] 縦中横なしの仕様確認（既知制限として了承）。

## 関連ファイル

- `src/features/editor/editorLayout.ts` — 論理レイアウト純関数（+ unit test）
- `src/features/editor/verticalMode.browser.test.tsx` — 縦書き幾何 gate
- `src/features/editor/linearVerticalGeometry.browser.test.tsx` — Linear スクロール幾何 gate
- `src/index.css` — `.editor-vertical` ブロック + 論理プロパティ化された prose CSS
