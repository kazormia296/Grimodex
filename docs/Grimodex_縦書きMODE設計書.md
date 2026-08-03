# Grimodex 縦書きライブ編集 MODE 設計書

最終更新: 2026-07-11（Electron / Chromium 移行後の実機QAへ更新）

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

2. **スクローラと縦書き本文を分離**
   `.editor-vertical` は EditorDropDiv（タブ）/ LinearEditorView の scrollRef
   （連続表示）に付けるが、スクローラ自体は `horizontal-tb + direction: rtl` の
   横スクロール軸を使う。直下の content wrapper から `vertical-rl` を開始し、
   `.tiptap` へ継承する。再マウントは不要。

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

## 縦中横（tate-chu-yoko）対応（2026-06-17 実装）

縦書き中、半角数字の連続（run）を `text-combine-upright: all` で正立・横並びに
結合する。CSS `text-combine-upright: all` は Baseline 2022（全エンジン対応）の
native 委譲で、ルビ・圏点と同じ「CSS に任せる」グループ。仕様の `digits N` 値は
どのエンジンも未実装なので、結合範囲（span）は自前で検出して当てる。

- **検出**: `TateChuYokoPlugin.ts` の `buildTateChuYokoDecorations(doc, policy)`。
  Codex と同じ `flattenDocForCodex` で平坦化してから `/[0-9]+/g` で run を取る。
  per-text-node の `matchAll` だと `20<b>26</b>` のように mark で割れた run を
  取りこぼすため、平坦化を single source of truth として共有する。ruby atom と
  block 境界は PM-position の連続性チェックで弾く。doc/schema は触らない純粋な
  inline decoration なので Undo にも乗らない。
- **ポリシー**: 設定 `editor.tateChuYoko`（project scope, 既定 `2`）。
  `off` / `2`（2桁のみ・出版物の慣習）/ `all`（2桁以上すべて・3〜4桁は流儀に
  幅があるため任意）。1桁は縦中横の対象外（2文字以上が定義）。全角数字は mixed で
  既に正立するため対象外。
- **配線**: `useTateChuYoko(editor)` が縦書き時のみ動的登録（横書きでは登録せず、
  CSS も `.editor-vertical` スコープで二重ガード）。EditorPane / LinearSceneBlock の
  両サーフェスに配線（codex highlight と同じ decoration-plugin ライフサイクル）。
- **未対応（将来拡張）**: 欧文（ラテン文字）の縦中横、`！？` などの約物結合、
  単位（kg 等）。いずれも別ルールとして後から足せる足場のみ用意。
- **実機/ブラウザ QA ゲート（happy-dom で再現不能・要 Chromium 検証）**:
  1. 別プラグイン隣接クラッシュ: tcy deco 同士は数字 run が必ず非数字で分かれる
     ため隣接し得ないが、codex/lint/comment 等の別 DecorationSet とは隣接し得る。
     ProseMirror の DOM reconciler は同一 set 内の隣接 inline deco で過去に
     クラッシュした（CodexHighlightPlugin が 8f201e46 で同 set 内ガードを追加）。
     cross-plugin 隣接が同じ経路でクラッシュするかは happy-dom では再現しないため、
     verticalMode.browser.test.tsx の「別プラグインの隣接 decoration + 境界挿入」で
     gate（CI/実機でのみ実行可能）。fragile な plugin 間結合は意図的に避けた。
  2. IME 合成中の再構築: apply は docChanged 毎に DecorationSet を全再構築する
     （"1"+"2"→"12" の新規 run を map では拾えないため意図的）。日本語変換で
     「12月34日」等を連続入力した際の合成中断/ちらつきの有無は実機 IME QA で確認
     （縦書き IME の QA 手順に追加）。コストは1 run の正規表現のみで軽量。

## v1 の既知制限（意図的 defer）

- 欧文（ラテン文字）・約物・単位の縦中横は未対応 — 半角英字等は mixed で横倒しの
  まま（半角数字の縦中横は上記の通り対応済み）
- typewriter / characterFadeOut の縦書き対応版（smoothCaret は対応済み）
- popup 群（Codex/Comment/Foreshadow/Slash 等）の出現方向最適化 —
  viewport 座標なので機能はするが「下に出す」前提が縦組みでは不自然
- maxContentWidth の設定ラベル（縦書きでは「行長（高さ）」の意味になる）
- CharacterFadeOut の縦書き対応
- IME 候補ウィンドウは完全な縦組みにならない（WebView の制約・許容済み）。
  位置はキャレット近傍に出る（Windows 実機確認済 2026-06-12）。MS-IME は
  予測候補グリフを 90 度回転描画するが IME 側の挙動で制御不可。
  **macOS も同じ天井で確定（2026-06-17・ソース調査）**: WebKit が縦シグナル
  `NSTextInputClient.-drawsVerticallyForCharacterAtIndex:` を未実装のため、
  WKWebView は vertical-rl でも候補窓を横向きで出す（Safari 自体も同様）。
  ネイティブ縦候補窓は実装しないと判断。詳細は「IME 変換対応の方針」参照。

## IME 変換対応の方針（2026-06-12 検討確定・2026-06-17 macOS 確定）

外部調査（IMM32/TSF・TATEditor/Mery の対応実態・EditContext API）の結論を
Grimodex のスタック（Tauri WebView + TipTap/PM）に当てはめた確定事項。

### 外的制約（アプリからは動かせない）

- **候補ウィンドウの描画はアプリから制御不可能**。候補窓は OS の IME が描き、
  WebView 内からは IMM32/TSF に触れない。位置・向き・回転は IME 実装次第。
  ※当初「Chromium は縦書き属性（TSATTRID_Text_VerticalWriting）を送らない」と
  推定していたが **実機観察で否定**: WebView2 + MS-IME は縦書きを検知し
  予測候補のグリフを 90 度回転描画した（= 縦書き情報は TSF 経由で IME に
  届いている。ただし窓レイアウトは横のままで完全な縦組み候補窓ではない）。
  **「候補窓がキャレット付近に出る」が上限**という結論自体は変わらない。
- **未確定文字列（下線部分）は追加実装ゼロで縦になる**。contenteditable では
  ブラウザが DOM 内に描くため writing-mode に追従する。既存の composition
  処理（CursorOverlayPlugin の overlay 凍結 → 確定後再描画）も writing-mode
  非依存でそのまま正しい。
- **EditContext API は不採用**。位置制御の Web 標準（Chromium 121+）だが、
  contenteditable の既定編集動作をオプトアウトする設計のため ProseMirror の
  入力パイプラインと根本非互換。WKWebView 未対応も致命的。再検討しない。
- **macOS WKWebView も「横向き・キャレット付近」が天井で確定（2026-06-17・
  ソース調査。実機検証は未だが原因はソースで特定済み）**。macOS が候補窓を
  縦組みにする唯一のトリガは `NSTextInputClient` の
  `-drawsVerticallyForCharacterAtIndex:`（10.6+・ヘッダ "Returns if the marked
  text is in vertical layout"。NSTextView は `layoutOrientation == vertical` で
  YES を返す）。`IMKCandidatePanelType` は候補グリッド形状のみ、
  `baseWritingDirection` は bidi（LTR/RTL）で無関係。**WebKit はこのメソッドを
  未実装**（WebKit source に `drawsVertical` / `NSTextLayoutOrientation` の
  ヒット 0、`validAttributesForMarkedText` に `NSVerticalGlyphFormAttributeName`
  も無し）→ vertical-rl の contenteditable でも Safari / WKWebView は候補窓を
  横向きで出す。Windows（TSF）とは別機構ながら同結論。傍証: Firefox も
  per-platform 未完（Bugzilla 1130935/1130937）、前例ゼロ、自プロジェクトの
  Windows 実機 QA もグリフ回転のみで窓レイアウトは横。
  - **ネイティブ shim は到達可だが hard / fragile で見送り**。wry は objc2 で
    WKWebView を subclass 済のため `-drawsVerticallyForCharacterAtIndex:` を
    足すことは可能だが、(1) writing-mode のネイティブ源泉が無く per-focus IPC
    同期が必要、(2) `firstRectForCharacterRange:` / `baselineDelta` が web
    process から async・横向き rect のみ、(3) **非 NSTextView クライアントに OS が
    縦パネルを描くか自体が未検証**（上記の全傍証は描かない方向）。加えて App
    Store 却下リスク（private `_impl` / selector swizzling）と WebKit 更新での
    破綻。唯一安価な決着手段は実機 Mac で捨てビルドに `drawsVertically` を
    ハードコード YES し Apple 日本語 IME のパネルが回るか目視するスパイクのみ。
    検討の結果、スパイクも含め**実装しない**と判断（2026-06-17）。

### フォールバック階段

1. **現状容認（本命）**: 実機 QA で候補窓がキャレット近傍に出るなら追加実装
   ゼロ。「候補窓は横向き」を既知制限に追記して完了。
2. **横書き入力プロキシ（致命的なズレ時のみ・設計スケッチ）**: 確定までは
   非表示の horizontal-tb 入力面に focus を保持して composition をそちらで
   行い、未確定文字列は縦書き doc 内へ widget decoration でゴースト表示、
   compositionend で PM transaction として挿入。主コストは selection 同期と
   既存 decoration（lint/comment/find）との共存。ネイティブ勢の「候補窓
   位置ずらし」に相当する Web 版の最終手段。
3. **安全弁（実装済み）**: per-project トグルで即横書きに戻せる。

### 診断ツール（実装済み・QA の判定材料）

- `enableImeLog()`（devtools）または **Ctrl+Shift+D → DebugLogViewer ヘッダの
  「IME診断」トグル**（production でも可）。localStorage 永続だがオリジン
  分離のため dev / production ビルドでは別々に enable が必要。
- 有効中は composition{start,update,end} ごとに DOM selection 矩形（エンジンが
  OS に伝える位置の源泉）/ アプリ認識キャレット矩形（resolveCoordsVertical）/
  PM coordsAtPos（flattenV）/ 論理スクロール / dpr / screenX,Y を記録し、
  画面に **赤枠 = DOM selection / 青枠 = app caret** のオーバーレイと左下の
  数値ラベルを描く（候補窓のスクリーンショットに写し込んで突き合わせる）。
- `dumpImeLog()` で JSON 回収（リングバッファ 300 件）。DebugLogViewer の
  Copy all でも detail に JSON 全文が入る。
- **`/ime-test.html`**（DebugLogViewer「IMEテスト」ボタンから遷移）:
  PM を介さない素の contenteditable + vertical-rl。本体エディタとの差で
  PM 起因 / WebView 起因を切り分ける。SPA を離れるため**保存してから開く**。

### 実機 QA 手順（Windows: MS-IME / Google日本語入力 / 任意で ATOK）

QA は `pnpm electron:dev` または packaged Electron build で行う。

1. 縦書き ON + IME診断 ON →「きしゃのきしゃはきしゃできしゃした」を入力。
2. Space 変換 → Shift+←/→ で文節移動しつつ、各文節での候補窓位置を
   スクリーンショット（オーバーレイの赤枠/青枠/ラベルを写し込む）。
3. 確定 → Ctrl+Z（確定直後 undo）→ 変換キーで再変換。
4. 位置バリエーション: 行頭 / 行末（折返し境界）/ 画面左端近くの列 /
   スクロール後（論理オフセット > 0）。
5. 同操作を `/ime-test.html` でも再現し、`dumpImeLog()` の JSON を保存。
6. macOS / Linux（Wayland と X11）でも同手順（scrollLeft 符号チェックと同時に）。

### 決定表（観察 → 次アクション）

| 観察結果                                         | 判定          | 次アクション                   |
| ------------------------------------------------ | ------------- | ------------------------------ |
| 候補窓がキャレット近傍（横向きでも可読位置）     | 許容          | 既知制限に追記して完了         |
| 画面隅/前回位置/ウィンドウ外、ime-test.html も同 | Chromium/OS IME 制約 | Wayland/X11 flag と fallback を再評価 |
| ime-test.html は正常、本体エディタのみズレ       | アプリ起因    | imeLog の rect 突合せで個別修正 |
| 未確定文字列が縦にならない                       | CSS 継承バグ  | node-island リセット等の修正   |

## 実機 QA ゲート（コードで検証不能・リリース判定チェックリスト）

- [ ] **IME 変換窓**（最重要）: Windows / macOS / Linux の Electron Chromium で縦書き
      キャレットに候補窓が追従するか。文節変換・再変換・確定直後 undo。
      安全弁 = per-project トグルで即横書きに戻せること。
      手順・判定基準・診断ツールは上の「IME 変換対応の方針」を参照。
      **2026-06-12 Windows 実機（位置確認）: 合格**。予測候補（imeLog #66）・
      カタカナ候補（#71）・変換候補リスト（#83）いずれもキャレット直近
      （dom rect 直下/隣接）に出現、決定表の「許容」に該当。位置は IME に
      よって多少異なるが可読位置。MS-IME は予測候補グリフを 90 度回転描画
      （上記のとおり IME 側挙動・実害なし）。スクショ = temp/ime（dpr=1）。
      残（Windows）: 再変換・確定直後 undo・行末/左端/スクロール後の位置
      バリエーション。
      **macOS（2026-06-17・ソース調査で確定）**: WebKit が縦シグナル
      `-drawsVerticallyForCharacterAtIndex:` を未実装のため WKWebView も
      横向き・キャレット近傍が天井（Windows と同結論）。ネイティブ縦候補窓は
      実装しないと判断。詳細は「IME 変換対応の方針」の macOS 項を参照。
- [ ] scrollLeft 符号: 3 OS の Chromium 実機で
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
- `src/lib/imeLog.ts` — IME 診断ログ基盤（enableImeLog/dumpImeLog、+ unit test）
- `src/features/editor/ImeDiagnosticsPlugin.ts` — composition 記録 + 矩形オーバーレイ（+ unit test）
- `public/ime-test.html` / `public/ime-test.js` — 素の contenteditable 切り分けページ
- `src/features/editor/TateChuYokoPlugin.ts` — 縦中横 decoration プラグイン（+ unit test）
- `src/features/editor/useTateChuYoko.ts` — 縦書き時のみ動的登録するフック
- `src/features/editor/verticalMode.browser.test.tsx` — 縦書き幾何 gate（縦中横の CSS 解決も gate）
- `src/features/editor/linearVerticalGeometry.browser.test.tsx` — Linear スクロール幾何 gate
- `src/index.css` — `.editor-vertical` ブロック + 論理プロパティ化された prose CSS
