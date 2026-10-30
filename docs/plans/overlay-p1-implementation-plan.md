# オーバーレイ P1（土台）実装計画

> 状態: 確定（2026-10-31）。§5 の確認事項はユーザーが決めた。
> 設計の正本: [オーバーレイ領域と切替演出 設計メモ](../Grimodex_オーバーレイ領域と切替演出設計書.md)（以下「設計メモ」）の §3 と §7 の P1。
> P1 の範囲外: DnD の受け口、3D の演出（P2）、レイアウト切替の飛行（P3a／P3b）、タブの Flip（P4）。

## 1. 調査で分かった前提の修正

コードを読んで、設計メモの前提と食い違う点が 4 つ見つかった。本計画はこの修正を前提にする。設計メモにも反映する。

| # | 設計メモの前提 | 実際 | 本計画での扱い |
| --- | --- | --- | --- |
| a | スキーマの版を 4 に上げ、v3 から移行する | 読み込みは版の一致を `===` で判定する（`layoutStore.ts` L348）。版を上げると、古い版のアプリに戻したときに保存中のレイアウトが既定に初期化される | 版は 3 のまま、`overlays` を任意項目として足す（§2.1） |
| b | 「エディタだけの表示」の間はショートカットで呼べる | `editorOnly` は phone 幅のときだけ true（`EditorWorkspaceShell.tsx` L176） | phone 幅と同じく無効にする |
| c | 非表示のパネルを置けないことを `validateLayoutState` で検査する | `hiddenStripePanels` は `LayoutState` の外にある（`layoutTypes.ts` L87-102） | 読み込みとプリセット適用の後に、別の関数で外す |
| d | `focusout` の `relatedTarget` が外なら閉じ、プログラムの `focus()` では閉じない | プログラムの `focus()` でも `focusout` は起きるので、この 2 つは両立しない | Tab キーの直後の `focusout` だけで閉じる |

## 2. 設計の詳細

### 2.1 データ

```ts
// layoutTypes.ts
export type OverlayId = "left" | "right";
export interface OverlayState { panel: ToolWindowPanelId | null }
export interface LayoutState {
  // 既存の項目
  /** 任意。無いときは両方空として扱う（getOverlays で補う）。 */
  overlays?: Record<OverlayId, OverlayState>;
}
```

- **版は 3 のまま**にする（前提の修正 a）。
  - `bottomCorners?`（L74）と同じく任意項目にし、`getOverlays(state)` で空の既定値を補う。
  - 古い版のアプリは `overlays` を知らない。そのため、オーバーレイに置いたパネルを未登録とみなし、`ensureRegisteredPanels`（`layoutStateUtils.ts` L103）が既定の領域へ自己修復する。レイアウトは消えない。
  - 必須項目にすると、5 つのプリセットの定義と約 10 本のテストの組み立てをすべて直す必要がある。
  - 設計メモの「移行の 3 か所」は、この方式では `getOverlays` による補完で足りる。
- `validateLayoutState`（L332〜、`seenPanels` の加算は L485 の前）で、overlay のパネルも「ちょうど 1 か所」の数に入れる。
- `ensureRegisteredPanels` は overlay のパネルを登録済みとして数える。数えないと slot に二重に注入される。
- `stripUnknownPanels`（L147）は、未知の ID と、slot と重なっている overlay を外す。重なっている場合は slot 側を残す。
- 新しい関数：
  - `findOverlayOfPanel`
  - `replacePanelInPlace`（入れ替え用。同じ index に置き換え、Stripe のアイコン順を保つ）
  - `getOverlayRailReserve`（rail の幅の合計）
  - `detachHiddenOverlayPanels`（前提の修正 c。非表示のパネルを overlay から外す）
- `findPanelLocation`（L828）は変えない。呼び出しが 14 か所あり、すべて slot があることを前提にしているため。
  overlay のパネルにはこの関数が null を返すので、zoom の対象からも自然に外れる。

### 2.2 store（`layoutStore.ts`）

- 揮発の `openOverlay: OverlayId | null` と、`toggleOverlay(id)`、`closeOverlay()`、`movePanelToOverlay(panel, id)` を足す。
- **入れ替え**：移動先の overlay に別のパネルがあれば、移すパネルが元いた slot の同じ位置へ戻す。表示状態は元のパネルのものを引き継ぐので、幅は変わらない。
- **overlay から slot へ**：
  - `movePanelInLayout`（L225）は今、元の場所が overlay だと外さずに追加して、検証で弾かれる。overlay から外す処理を足す。
  - これで、既存の「移動先」メニュー、`addPanelToStripeSlot`、ドロップダウンからのドラッグが、そのまま戻り道になる。
  - 右クリックメニューの「元に戻す」の行き先は、既定の領域（`DEFAULT_REGION_MAP`）の最後の slot にする。
- **開閉は layout を変えない**：
  - `togglePanel`／`showPanel`／`isPanelActive`（L619-675）は、対象が overlay のパネルなら `openOverlay` だけを変える。
  - layout の参照を変えると、次の購読ですぐ閉じてしまう。
  - 対象は Mod+Alt＋英字のパネル切替や外部からの呼び出し（約 30 か所）。今と同じ操作で、overlay のパネルも開閉できる。
- **自動で閉じる**：
  - layout の参照が変わったら閉じる。zoom の自動解除（L1603-1613）と同じ購読に足す。
  - zoom に入るとき（`toggleMaximizePanel`）にも閉じる。
- **画面幅**：
  - `getViewport()`（L94、呼び出し 16 か所）を `getViewport(layout)` にして、rail の幅を引く。
  - `layoutReducer.ts` L139 の `window.innerWidth` も同じく直す。
- **読み込みとプリセット**：
  - `ensureLayoutStateV3` の呼び出し（L391、L1354、L1385、L1458、L1475、L1580）の後に `detachHiddenOverlayPanels` を通す。
  - `resolveBuiltinPresetState` の上書き経路（`layoutPresets.ts` L543）も同じ扱いにする。

### 2.3 画面

- **LayoutShell.tsx**：
  - 外側を flex の `lrail | grid | rrail` で包む。grid は `flex-1 min-w-0`。
  - `data-layout-shell` は grid（L267）に残す。`index.css` L693 と DnD の層が参照しているため。
  - rail を出さないのは、Zen モード、phone 幅（`editorOnly`）、zoom 中、overlay が空のとき。
- **新規 `OverlayRail.tsx`**：
  - つまみ（アイコンと縦書きの名前、`aria-expanded`／`aria-controls`）を置く。幅は `OVERLAY_RAIL_SIZE = 30`。
  - busy の印と右クリックメニューを持つ。
  - 縦書きの中では flex を使わない（設計メモ §8）。
- **新規 `OverlayLayer.tsx`**：
  - `PANEL_COMPONENT_MAP` で overlay のパネルを描き、`isActive` に開閉状態を渡す。
  - 幅は `OVERLAY_WIDTH = 440`（画面幅の 0.5 で clamp）。grid と Stripe の上に重ねる。
  - 閉じている間は `visibility: hidden` と `inert` で保持する。unmount しない。
  - 開閉は平らなスライドで 300ms。値は `animation.ts` に `OVERLAY_DURATIONS` として置く。Reduced Motion では即時に切り替える。
  - パネルのヘッダーの `PanelChromeMenu`（最大化・折りたたみ）は出さない。
- **新規 `usePanelBusy.ts`**：`ToolWindowIcon.tsx` L83 の busy の判定を切り出し、Stripe と rail で共有する。

### 2.4 閉じる条件とフォーカス（新規 `useOverlayDismiss.ts`）

- **外での pointerdown**：
  - 中か外かは React の木で判定する（オーバーレイの React 木の `onPointerDownCapture` で印を付ける）。
  - Radix の menu や dialog は portal に描かれるので、DOM で判定すると「外」になってしまうため。
- **Tab で外へ抜けたとき**：Tab キーの直後の `focusout` で、`relatedTarget` が外のときだけ閉じる（前提の修正 d）。
  プログラムによる `focus()` では閉じない。
- **Esc**：
  - document の bubble で受け、閉じたら `preventDefault` する。
  - zoom（`LayoutShell.tsx` L127）と Zen（`ZenModeController.tsx` L40）の Esc より先に処理され、二重に反応しない。
  - `isComposing`（IME の変換中）と `defaultPrevented` のイベントは奪わない。
- **フォーカス**：開いたらパネルの先頭の操作できる要素へ移し、閉じたら開く前の要素へ戻す（戻す先が消えていたらエディタ）。

### 2.5 操作

- **右クリックメニュー**（`ToolWindowIcon.tsx` L170-188 の付近）：
  - Stripe のアイコンに「左のオーバーレイへ」「右のオーバーレイへ」を足す。
  - rail のつまみには「元に戻す（領域へ）」を出す。「サイドバーから削除」は出さない。
  - レイアウトのロック中は、割り当ての変更を無効にする（L173 と同じ扱い）。開閉はできる。
- **ショートカット**：`keybindings.ts` に `toggleLeftOverlay`／`toggleRightOverlay` を足す。
  - 既定のキーは §5 の確認事項 1。設定画面（`KeysCategory`）には自動で出る。
  - `GlobalCommandHost.tsx` の L67 の後に分岐を足す。phone 幅では何もしない。
  - 開閉は layout を変えないので、`canScheduleQuiescenceMutation` では止めない。
  - zoom 中に押したら、zoom を解いてから開く。
- **通知**：busy の印をつまみに出す。
- **文言**：`locales/ja.json`・`en.json` に `layout.overlay.*` と `keys.*` を足す。

## 3. commit の分け方とテスト

| # | 内容 | テスト |
| --- | --- | --- |
| 1 | データと utils（`overlays?`、検証、自己修復、未知 ID の除去、入れ替え、非表示の除去） | unit：v3 の保存データがそのまま読めること、古い版を想定して overlays を無視しても自己修復されること、重複の検出、入れ替えでアイコン順が変わらないこと |
| 2 | store の action（開閉・移動・入れ替え・戻し・自動で閉じる・ロック） | unit：入れ替え（slot に 1 枚だけ、center、左右の overlay どうし）、非表示パネルの拒否、ロック中、zoom と layout の変更で閉じること、overlay のパネルを `togglePanel` で開閉しても layout が変わらないこと。L844 のランダム操作テストに overlay の操作を足す。既存の「applyPreset の perf 契約」（`layoutStore.test.ts` L1247-1330）が通ること |
| 3 | rail と画面幅の差し引き | `pnpm test:browser`：既存の幾何の不変条件 13 本を rail がある状態でも回す。rail と Stripe が重ならないこと |
| 4 | オーバーレイの層、スライド、Reduced Motion | browser：閉じているときに inert であること、開くとパネルが rail の内側から出ること。unit：Reduced Motion で即時に切り替わること |
| 5 | 閉じる条件とフォーカス | unit（jsdom）：portal 内のクリックで閉じない、Tab で抜けると閉じる、プログラムの `focus()` では閉じない、IME の変換中の Esc を奪わない。手動：Wayland で日本語を変換中に Esc |
| 6 | ショートカット | unit：`keybindings` の重複検出。手動：TipTap と衝突しないこと、JIS キーボードでの動き |
| 7 | 右クリックメニュー、busy の印、Zen・phone・zoom・ロック | unit：`ToolWindowIcon` と rail のテスト |
| 8 | docs | 置換設計書の §2-5 と §13 の改訂、設計メモへの前提の修正の反映 |

- commit 1 と 2 は画面を変えない。
- 検証はレイアウトの変更なので、幾何は `pnpm test:browser`（実 Chromium）で確かめる（CLAUDE.md の規則）。
- PR の前に Quick を通す。

## 4. 既存の挙動を壊すリスクと確認

- **保存データ**：v3 の保存データを fixture にした `initializeLayout` のテストで、カスタムの配置が残ることを確かめる。
  版を上げないので、古い版に戻してもレイアウトは消えない（オーバーレイの割り当てだけが既定の領域へ戻る）。
- **プリセット**：組込みの上書きとカスタムに、非表示のパネルが overlay に入った状態で保存されている場合を確かめる。
- **zoom**：overlay のパネルは `findPanelLocation` が null を返すので、zoom の対象にならない。Esc は §2.4 の順で処理する。
- **DnD**：ドロップダウンから overlay のパネルをドラッグして slot へ移す経路を unit で確かめる。
- **Stripe のアイコン順**：入れ替えは同じ index に置き換えるので、ほかのパネルの順は変わらない。テストで固定する。
- **幾何**：テストの土台は host が fixed（`layoutInvariants.browser.test.tsx` L122-145）。包む要素の中で grid を `flex-1 min-w-0` にし、rail の背景は canvas の色に合わせる。

## 5. ユーザーの決定（2026-10-31）

1. **ショートカットの既定のキー**：Mod+Alt+[ ／ Mod+Alt+] のままにする。
   - キーの判定は物理キーの位置（`e.code`）で行う（`platform.ts` の `eventKeyToken`）。
     そのため JIS キーボードでは刻印と合わない可能性があるが、設定画面で変えられることに頼る。
2. **Zen モードとレイアウトのロック**：仮の案のとおりにする。
   - Zen モード中は rail を出さず、ショートカットでだけ呼べる。
   - ロック中は開閉だけでき、割り当ての変更はできない。
   - phone 幅（と、それと同じ扱いの「エディタだけの表示」）では無効。

## 6. 規模

製品コードが約 1,000〜1,100 行、テストが約 700〜800 行、合計で約 1,800 行。
内訳は、store が約 200 行、utils が約 130 行、新しいコンポーネント 3 つで約 420 行、その他。
