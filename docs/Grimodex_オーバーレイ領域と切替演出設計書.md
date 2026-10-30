# Grimodex オーバーレイ領域と切替演出 設計メモ

> 状態: 設計確定前の最終稿（2026-10-31）。§9 の決定事項と §10 の講評を反映済み。次は P1 の実装計画。
> 前提の正本は [レイアウトシステム置換設計書](Grimodex_レイアウトシステム置換設計書.md)（以下「置換設計書」）。
> 本書の採用時は、置換設計書の §2-5 と §13 の「overlay 層はスコープ外」を次のように改訂する：
> undock／floating は引き続きスコープ外とし、名前の付いた固定のオーバーレイは、slot と center segment に次ぐ 3 種類目の置き場所として含める。

## 1. 背景と結論

2026-10-28〜29 に「全パネルを 3D 空間に置く」案を検討し、試作で手触りを確かめた。結論は次のとおり。

- 普段の画面（常時表示の領域）は**平らで静止**させる。傾けると読みにくく、カーソルへの反応も邪魔になる。
- 3D の動きは**瞬間だけ**に使う。対象は次の 3 つ。
  1. 画面全体の左右に新設する**オーバーレイ領域**の開閉と、開いている間の傾き
  2. **レイアウト切替**で、各パネルが元の位置から新しい領域へ飛ぶ演出
  3. **タブ切替**で、タブをカードとして斜めに重ねてめくる演出（Flip）
- 実装は**通常の DOM と CSS の 3D 変形**で行う。HTML-in-Canvas（実験段階の Blink 機能）は使わない。
  製品の renderer 隔離テストが `enableBlinkFeatures` を禁止しており、上の 3 つには不要なため。

試作は作業ブランチ `claude/spike-html-in-canvas-3d`（commit 28552f44）の `experiments/css3d-workspace/`（README あり）。master には入れない。
見た目の検討は Claude Design のキャンバス（https://claude.ai/artifact/RADN2sZgVQTHfQfaEEe1Yy、非公開）。

## 2. 方針

1. **オーバーレイは明示的なデータ**。置換設計書の原則 2（所属を state に明示し、幾何で推測しない）に従い、
   `LayoutState` に `overlays` を足す。位置も大きさも自由な floating／undock とは別物で、
   名前の付いた固定の置き場所（左・右）に 1 パネルだけを置く。`viewMode` のような表示モードは足さない。
2. **開閉は一時状態**。開いているオーバーレイは `maximizedPanelId` と同じく store の揮発フィールドに持ち、
   永続化しない。
3. **パネルの DOM を作り直さない**。開閉とレイアウト切替の演出は、既存の
   `useLayoutPresetCrossfade` と同じく mount を保ったまま transform だけで行う。
4. **Reduced Motion では 3D をやめる**。傾き・飛行・Flip を省き、即時の切替か短いフェードにする。
5. モーションの値は `src/lib/animation.ts` の共有定数に置く（polish-motion の規約）。
6. **オーバーレイは参照用**。開いて読み、閉じて書く。エディタと並べて使い続けるパネル
   （AI の応答と本文を見比べながら書く、など）は常時表示に置く。決定 4（エディタに触れたら閉じる）はこの原則の帰結である。
   ピン留めは設けないが、将来の拡張点として記録しておく。

## 3. オーバーレイ領域

> 2026-10-31 の P1 実装計画（[docs/plans/overlay-p1-implementation-plan.md](plans/overlay-p1-implementation-plan.md) §1）で、本節の前提を次のように修正した。
> - スキーマの版は 3 のまま、`overlays` を任意項目として足す（古い版に戻してもレイアウトが消えないように）。下の「v4」と「移行の 3 か所」はこれで置き換える。
> - 「エディタだけの表示」（`editorOnly`）は phone 幅のときだけなので、phone 幅と同じく無効にする。
> - 非表示のパネルの除去は `validateLayoutState` ではなく、読み込みとプリセット適用の後の別関数で行う。
> - `focusout` で閉じるのは Tab キーの直後だけにする（プログラムの `focus()` では閉じないため）。

### 3.1 データモデル（永続化スキーマ v4）

```ts
type OverlayId = "left" | "right";

interface OverlayState {
  /** 置いているパネル。各オーバーレイに 1 つだけ。null は空。 */
  panel: ToolWindowPanelId | null;
}

/** 開いたときの幅は固定（決定 2）。ビューポートの 0.5 を上限に clamp する。 */
const OVERLAY_WIDTH = 440;

interface LayoutState {
  // 既存: regions / center / collapsedEditorRegionSizes? / bottomCorners?
  overlays: Record<OverlayId, OverlayState>;
}

// store の揮発フィールド（永続化しない）
openOverlay: OverlayId | null;
```

- **所属の一意性**: `validateLayoutState` は今、全ツールパネルが slot か center segment の
  ちょうど 1 か所にあることを要求している（`layoutStateUtils.ts` L332〜、重複 L385／L477、未登録 L487）。
  `overlays[*].panel` も置き場所に含め、「slot・segment・overlay のどれか 1 か所」に拡張する。
- **移行**: `LAYOUT_SCHEMA_VERSION` を 4 に上げ、v3 → v4 では `overlays` を空（両方 `panel: null`）で補う。
  既存の `migrateLayoutStateV2toV3`／`ensureLayoutStateV3` と同じ流れに `ensureLayoutStateV4` を足す。
  - 移行の対象は 3 か所ある：保存中のレイアウト、カスタムプリセット（`customPresets[].state`）、
    組込みプリセットの上書き（`builtinPresetOverrides`）。
  - `applyPreset`（`layoutStore.ts` L1456／L1472）は `ensureLayoutStateV3` を直接呼んでいるので、V4 に差し替える。
  - パネルの所在を引く `findPanelLocation`（zoom の判定に使う。`LayoutShell.tsx` L111）と、
    `movePanelInLayout` の移動先の型（`LayoutRegionId`）に overlay を足す。
  - 「サイドバーから削除」（`hiddenStripePanels`）したパネルはオーバーレイに置けないことにし、置かれていれば外す。
- **プリセット**: `PRESET_DEFINITIONS` とカスタムプリセットは `overlays` も持つ。
  組込みプリセットは当面すべて空のまま出す（§9 の 8）。
- **移動**: `movePanelInLayout`（`layoutStore.ts` L225）の移動先に overlay を足す。
  - overlay に移すと、元の slot から外れる。
  - 移動先の overlay に別のパネルがあれば、そのパネルは元パネルがいた slot に入れ替えで戻す。

### 3.2 画面の構造

LayoutShell の grid（`layoutMetrics.ts` L179-200 の 9 列）には手を入れず、その外側を包む。

```
lrail | [ 今の 9 列の grid（lstripe … rstripe）] | rrail
```

- grid に渡す画面幅から rail の幅を引くだけにする（`clampLayoutStateForViewport`、`layoutStateUtils.ts` L676 に渡す幅を減らす）。
  rail があることは「画面が rail の幅だけ狭い」ことと同じになる。
- そのため、幅の計算（`OUTER_PAD_PX * 2` を使う L315／L606／L709 と `getCenterHorizontalReserve`）、
  grid-template-areas、角の描画、zoom のセル、幾何の不変条件テスト（`layoutInvariants.browser.test.tsx`）は変えずに済む。
- 11 列に広げる案は、これらをすべて動かし、テストも rail の有無で 2 系統にする必要があるため採らない。

- **操作の列（rail）**: 幅 `OVERLAY_RAIL_SIZE = 30`。Stripe の外側、画面の一番端に置く。
  - panel がある間だけ幅を取り、空なら幅 0 にする（決定 1。空の bottom の Stripe を出さないのと同じ扱い）。
  - つまみには、パネルのアイコンと縦書きの名前を出す。1 パネルだけなので、閉じていても何が入っているか読める。
  - Stripe のアイコン（平らなグレーの四角）とは、位置・色（琥珀）・形で区別する。
- **オーバーレイの層**: grid を包む要素の直下に、grid とは別の層として置き、grid と Stripe より上に重ねる。
  §4 の飛行のゴーストも同じ並びの層に置く。
  - DnD ハイライトとドラッグゴーストの層（LayoutShell L255-263）は、さらにその上に置く。
  - 開いている間は、grid 全体を少し奥へ下げて暗くする（§3.4）。
- **閉じている間のパネル**: unmount しない。zoom と同じく `visibility: hidden` と `inert` で保持し、
  開いたときに状態（スクロール位置、入力途中の文字）が残るようにする。

### 3.3 振る舞い

- **開く**: つまみを押す。ショートカットは左が Mod+Alt+[、右が Mod+Alt+]（決定 3）。同時に開けるのは左右どちらか 1 つ。
  - 既存の割り当て（`settings/keybindings.ts`。パネルの開閉は Mod+Alt＋英字）と重ならない。
  - macOS で単語移動に使う Option+←／→ と、文字入力に使う Option+[ ／ ] も避けている。
  - TipTap の既定のキーと衝突しないかは、実装時に確かめる。
- **閉じる**: つまみをもう一度押す、オーバーレイの外を押す、エディタにフォーカスする、Esc。
  オーバーレイなので、エディタにフォーカスしたら自動で閉じる。ピン留めは設けない（決定 4）。
  - 閉じる条件はユーザーの操作に限る：オーバーレイの外での pointerdown、`focusout` の `relatedTarget` がオーバーレイの外、Esc、つまみ。
  - プログラムによる `focus()`（AI の挿入後にエディタへフォーカスを戻す処理など）では閉じない。
  - レイアウトが差し替わったら閉じる。zoom の自動解除（`layoutStore.ts` L1603-1613）と同じ購読の仕組みを使う。
  - Esc は zoom と同じ階層的な扱いにする。`isComposing`（IME の変換中）と `defaultPrevented` は奪わない。
- **フォーカス**: 開いたらパネルの先頭へフォーカスを移し、閉じたら開く前の要素へ戻す。
  背景は閉じる操作を受けるため `inert` にしない（非モーダル）。Tab キーで背景へ抜けたら閉じる（`focusout` の条件）。
  つまみには `aria-expanded` と `aria-controls` を付ける。
- **zoom との関係**: zoom に入ると、開いているオーバーレイを閉じる。オーバーレイのパネルは zoom の対象にしない。
- **phone 幅**: オーバーレイを無効にし、置いているパネルは既定の領域に表示する（保存はしない。phone 幅では今も保存しない）。
- **パネルの割り当て**:
  - ToolWindowIcon の右クリックメニューに「左のオーバーレイへ」「右のオーバーレイへ」を足す。
  - DnD でパネルをドラッグしている間だけ、受け口を出す。空の rail は幅 0 なので、受け口はオーバーレイの層に出す。
- **通知**: 当面は Stripe の busy の印（`ToolWindowIcon.tsx` L140）と同じ仕組みをつまみに流用する。
  「未読」の仕組みは今はないので、必要なら新しい作業として別に設計する。
- **P1 で決めること**: Zen モード・エディタだけの表示（`LayoutShell.tsx` L54-56 の `zenMode`／`editorOnly`）と、
  レイアウトのロック（`layoutLocked`）の間に、rail を出すか・オーバーレイを呼べるか。

### 3.4 見た目と動き

試作で決めた値（`experiments/css3d-workspace/proto.css`／`proto.js`）を初期値にする。

| 項目 | 値 |
| --- | --- |
| 開くときの姿勢 | 外側の端から `translateX` で出て `translateZ(80px)`、内向きに `rotateY(9deg)` |
| カーソルへの傾き | パネルの中心からカーソルへの距離をビューポートの 0.4 倍で正規化し、横は最大 8°、縦は最大 5° |
| 追従 | 行き過ぎない一次の追従（1 秒あたりの係数 7）。閉じたとき・カーソルが窓の外に出たとき・入力中は 0 へ戻す |
| 背景 | 暗幕（不透明度 0.2〜0.25。後ろの本文が読める程度）と grid の `translateZ(-50px)`。値は実機で調整する |
| 入力中 | オーバーレイの中の入力欄にフォーカスがある間は、基本の傾き（9°）も含めて `transform: none` にする |
| 開閉の時間 | 650ms、`cubic-bezier(0.16, 1, 0.3, 1)` |
| Reduced Motion | 傾き・奥行きなし。横からのスライドだけ（または即時） |

- 3D 変形の間は要素が元の解像度でラスタされて拡大されるので、HiDPI で文字がにじむ可能性がある。
  - `will-change` は開閉の間だけ付ける。
  - 実機で気になる場合は、カーソルが 1 秒ほど止まったら平らに戻す、または傾きの最大値を下げる。
- 入力中を平らにするのは、3D 変形の下で IME の候補窓の位置がずれる可能性があるため（推測。Wayland で確かめる）。
- grid の `translateZ` は開いている間の見た目だけで、レイアウトの幾何（Splitter、Stripe と slot の境界）は変えない。
  幾何の不変条件テストは閉じた状態で測る。

## 4. レイアウト切替の飛行

今のプリセット切替は、mount を保ったまま opacity を 0→1 に戻すフェードである（`useLayoutPresetCrossfade.ts` L31-80）。
これを、各パネルが元の位置から新しい位置へ飛ぶ演出に置き換える。

- **方式（FLIP）**:
  1. 切替の直前に、表示中の各パネルの矩形を `panelId` ごとに記録する。
  2. 新しい `LayoutState` を適用する。
  3. 適用後の矩形との差から、パネルを元の位置に置き直す transform を求める。
  4. Web Animations API でその transform から `none` へ戻す。
- **直前の矩形の取り方**: `applyPreset`（`layoutStore.ts` L1448-1482）は 1 回の set で差し替えるため、
  set の前に記録する。store の action を包むか、`applyPreset` を呼ぶ側で記録する。
- **飛ばす実体を 2 系統に分ける**:
  - slot の keepalive（`AnimatedSlotPanel.tsx` L30-33）は、ガラス効果の合成レイヤーを崩さないため、
    子に transform を意図的に当てていない。
  - keepalive は slot 単位なので、slot をまたぐ移動は再 mount になる。
    重いパネル（チャットの TipTap、lazy な chronicle）を mount と同じフレームで動かすと、もたつきが演出中に出る。
  - ガラス効果の `backdrop-filter` と `overflow` は 3D の文脈を平らにするので、実物に `translateZ` を当てても浮かない。
  - そこで次のように分ける。

  | 対象 | 動かすもの | 動き |
  | --- | --- | --- |
  | 同じ領域の中での移動・大きさの変化 | 実物（slot の `gx-panel` 要素。`AnimatedSlotPanel` の子には当てない） | 平面の FLIP |
  | 領域をまたぐ・消える・現れる | 最上層の「枠だけのゴースト」（ヘッダーと背景だけ） | 3D（中間の 45% で `translateZ(180px)`、行き先の向きへ `rotateY(±16deg)`、全体 680ms） |
  | ゴーストを飛ばしている間の実物 | 移動先に置いたまま隠す | 着地でフェードイン |

  - 中身を `cloneNode` で複製する方式は、canvas や重いパネルで空になったり重くなったりするため採らない。
  - P3 に着手する前に、ガラス効果を有効にした状態で、この 2 系統が成り立つかを小さな試作で確かめる。
- **連続した変更**: 300ms の連続切替を飛ばすのではなく、新しい変更が来たら進行中のアニメーションを `cancel()` して新しい位置から始める。
- **エディタ**: 大きさが変わるときに scale で引き伸ばすと本文がゆがむ。エディタは移動だけにし、大きさは即時に変える。
- **演出しない条件**: 今のフェードの条件を引き継ぐ（初回 hydration、Reduced Motion、`layoutLocked`、300ms 以内の連続切替、zoom の出入り）。
  zoom の解除は、今のフェードのまま残す。
- **適用範囲**: プリセット切替、オーバーレイの割り当ての変更、Stripe での個別の開閉（`togglePanel`／`showPanel` など）に使う（決定 7）。
  段階は 2 つに分ける。
  - P3a：プリセット切替とオーバーレイの割り当ての変更。
  - P3b：個別の開閉。P3a を実機で評価してから入れる。
    - 開閉のたびに全パネルの位置を前後 2 回測る負担がある。
    - エディタだけが即座に幅を変える間、隣のパネルが飛んで重なる、または隙間が見える。
    - そのため最小の形から始める：開閉したパネルだけを Stripe 側から短く（目安 300ms 前後）スライドさせ、ほかは即時に変える。
  - Splitter のドラッグによるリサイズ（`setRegionSize`）は、手の動きに直接追従させるので演出しない。
  - DnD による移動は、ドロップ後の着地だけを演出する。

## 5. タブ切替の Flip

### 5.1 振る舞い

今の Ctrl+Tab は、keydown のたびにアクティブグループ内を配列順で即座に切り替える
（`tabSwitchKeybinding.ts` L13-59。keyup の処理はない）。これを次のように変える。

- **開く**: 1 回目の Ctrl+Tab で Flip を開き、次のタブを選んだ状態にする。
- **めくる**: Ctrl を押したまま Tab で次、Shift+Tab で前。ホイールでもめくれる。
- **決定と取り消し**:
  - Ctrl を離すと、手前のカードがエディタの位置へ飛んでそのタブに切り替わる。
  - Esc は取り消し。
  - 窓のフォーカスが外れたときも取り消す。
- **修飾キー**: キーの割り当ては設定で変えられる（`settings/keybindings.ts` L148-155）。
  割り当ての修飾キーを「押し続けている間」として扱う。
  - 押下の追跡は、既存の `src/features/editor/reorder/reorderModifierStore.ts` の方式に合わせる。
    capture で keydown／keyup を見て、窓のフォーカス喪失（blur）と `visibilitychange` で解除し、`preventDefault` はしない。
  - IME の変換中（`isComposing`）は Flip を開かない。開いている間に変換が始まったら取り消す。
  - 修飾キーを Alt や Mod に変えた場合、OS やウィンドウマネージャーが Tab を奪って keyup が届かないことがある。
    その場合も、フォーカス喪失で取り消せるようにする。
  - Ctrl を押したままの Shift の keyup を、「Ctrl を離した」と取り違えない。
  - 今のタブ切替は `canScheduleQuiescenceMutation()` の条件を通ったときだけ動く（`GlobalCommandHost.tsx` L182-190）。
    Flip もこの条件を通ったときだけ開き、開いた後に決定できない状態を作らない。
  - 決定したら、まず `setActiveTab` を発行し、カードの着地はそれと並行させる。本文の読み込みを待って止めない。
- **対象**: アクティブなグループ（最大 2 グループ）のタブだけ。タブが 1 つなら Flip を開かない。
- **並び**: タブの並び順（今と同じ）。最近使った順にはしない（決定 5）。
- **Reduced Motion**: Flip を開かず、今と同じ即時の切替にする。
- **読み上げ**: カードの層は `aria-hidden` にし、選択中のタブ名を `aria-live` で読み上げる。

### 5.2 カードの中身

設定で「あらすじ」（既定）／「本文」／「情報」から選ぶ（global settings に `flipCardContent` を足す）。
カードは 600×430 の読める大きさに固定し、手前の 1 枚以外は中身を薄くする。

| 表示 | 中身 | データの出どころ |
| --- | --- | --- |
| あらすじ | タイトル、状態、あらすじ、登場人物 | `tree_nodes.synopsis`／`status`、登場人物は `scene_codex_pins` |
| 本文 | 冒頭の縦書き | `tree_nodes.content`（ProseMirror JSON）。開いていないタブの本文はフロントにないので、表示するカードの分だけ遅延ロードしてキャッシュする |
| 情報 | 視点、登場、字数、状態、あらすじ | `povCharacterId`（Codex の名前を引く）、`charCount`、`status`、`synopsis` |

- treeStore のノードは `synopsis`／`status`／`povCharacterId`／`charCount` を持つ（`treeStore.ts` L530-544）。
  あらすじと情報は追加のロードなしで出せる。
- 登場人物は `scene_codex_pins`（明示のピン）だけを使う（決定 6）。`scene_codex_mentions`（言及のキャッシュ）は当面使わない。
- シーン以外のタブ（codex／snippet／chronicle_event）は、タイトルと種別と要約だけの簡易カードにする。
- 描くカードは手前から最大 8 枚に絞る。TipTap のエディタは増やさない。

## 6. 検証

- **単体テスト**: v3 → v4 の移行、`validateLayoutState` の一意性、overlay への移動と入れ替え、
  プリセットの `overlays`、Flip のキー操作の状態遷移（開く・めくる・決定・取り消し・窓のフォーカス喪失）。
- **実 Chromium のテスト（`pnpm test:browser`）**:
  - rail と Stripe が重ならないこと。
  - rail があるときも、既存の幾何の不変条件（`layoutInvariants.browser.test.tsx`）が保たれること。
  - オーバーレイを開いたときにパネルが rail の内側から出ること。
- **Reduced Motion**: 傾き・飛行・Flip が無効になること。
- **手動（Wayland、IME）**:
  - オーバーレイを開いたままチャット欄で日本語を変換し、Esc が変換の取り消しに使われること。
  - そのとき IME の候補窓が入力位置に出ること（入力中は平らにするので、ずれないはず）。
  - Flip の最中に IME が干渉しないこと。
  - 傾けた文字のにじみを HiDPI で確かめる。

## 7. フェーズ

1. **P1 オーバーレイの土台**:
   - スキーマ v4 と 3 か所の移行、検証、grid を包む rail、開閉（平らなスライド）、右クリックメニューでの割り当て。
   - 開閉のスライドにも Reduced Motion 対応を入れる（P2 に送らない）。
   - P1 の中で、§3.3 の「P1 で決めること」（Zen モード・エディタだけの表示・レイアウトのロックとの関係）を決める。
2. **P2 オーバーレイの演出**: 開くときの姿勢、カーソルへの傾き、入力中の平坦化、背景の暗幕と奥行き。
3. **P3a レイアウト切替の飛行**:
   - 着手前にガラス効果を有効にした試作で、§4 の 2 系統が成り立つことを確かめる。
   - プリセット切替とオーバーレイの割り当ての変更で、`useLayoutPresetCrossfade` を置き換える。ゴーストと DnD の受け口も含む。
4. **P3b 個別の開閉の飛行**: P3a を実機で評価してから、最小の形で入れる。
5. **P4 タブ切替の Flip**: キー操作の変更、カード 3 種、設定、本文の遅延ロード。P1〜P3 と独立しているので並行できる。

各フェーズは別の PR にする。P1 だけで機能として成立し、P2 以降は演出の追加である。

## 8. 試作で分かった注意点

- 退避中の要素がエディタと同じ奥行きにあると、3D の並べ替えで後ろに隠れる。
  オーバーレイは grid とは別の層に置き、重なり順を z-index で決める（§3.2）。
- 縦書きの要素の中で flex を使うと、row と column の向きが入れ替わる（つまみの縦書きの名前で起きた）。
- Flip のカードをエディタと同じ大きさで縮小表示すると、本文の文字が小さすぎて読めなかった。
  そのためカードは読める大きさに固定し、中身を選べるようにした（§5.2）。
- 常時表示のペインを傾ける案、カーソルの動きにばねで揺らす案は、実機の感触で不採用になった。

## 9. 決定事項

2026-10-31 にユーザーが決めた。

| # | 項目 | 決定 |
| --- | --- | --- |
| 1 | 空のオーバーレイの rail | 幅を取らない（空の bottom の Stripe と同じ） |
| 2 | オーバーレイの幅 | 固定（`OVERLAY_WIDTH`） |
| 3 | 開くショートカット | 既存と重ならない範囲で決める → Mod+Alt+[ ／ Mod+Alt+] |
| 4 | 開いたまま書けるか | 書けない。エディタにフォーカスしたら自動で閉じる |
| 5 | Flip の並び | タブの並び順 |
| 6 | Flip の登場人物 | 明示のピンだけ |
| 7 | 飛行の適用範囲 | Stripe での個別の開閉にも広げる |
| 8 | 組込みプリセットの割り当て | 今の 5 つ（default／plan／chat-main／review／codex-main）はすべて空のまま出す。オーバーレイ用の新しいプリセット（例:「集中」）は足さない。Zen モードがすでにあり、機能が二重になるため。割り当ては実際に使ってから決め直す |

## 10. 講評の反映（2026-10-31）

Fable にメモ全体の講評を頼み、次を取り込んだ。

- §4 の飛ばす実体を 2 系統に分けた。keepalive とガラス効果の制約、slot をまたぐ再 mount があるため。
- §3.2 は 11 列の grid をやめ、grid を包む形にした。
- §3.1 に移行の 3 か所と、プリセット適用時の補完の差し替えを足した。
- §3.3 で、閉じる条件をユーザーの操作に限り、Tab で背景へ抜けたら閉じる扱いを加えた。
  通知は busy の印を流用し、Zen モード・エディタだけの表示・ロックとの関係は P1 で決めることにした。
- §2 にオーバーレイは参照用という原則を足し、§3.4 の暗幕を薄くし、入力中は平らにした。
- §4 と §7 で、決定 7 を P3a と P3b に分けた。
- §5.1 に、修飾キーの追跡を既存の方式に合わせることと、IME・フォーカス喪失・実行条件の扱いを足した。

講評にあった「6 つ目の組込みプリセット（集中）を足す」案は、Zen モードと二重になるため不採用（決定 8）。

## 11. 関連

- [レイアウトシステム置換設計書](Grimodex_レイアウトシステム置換設計書.md): §2、§4、§6.7（zoom）、§8.2（永続化）、§9（プリセット）、§13
- 試作: `experiments/css3d-workspace/`（CSS 3D 版）、`experiments/html-in-canvas-3d/`（HTML-in-Canvas 版、不採用の根拠）
