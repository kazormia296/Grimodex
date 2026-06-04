# ブラウザ / Storybook テスト カバレッジギャップ監査（2026-06-03）

33 features を fan-out 調査し、「**実ブラウザでしか捕れない × 現状ノーカバー × バグ履歴あり**」の
交差点を洗い出し、各候補を敵対的に検証（happy-dom で stub すれば assert できるなら棄却）した結果。

- 候補 24 → **確定 10**（敵対的 verify 通過）/ **棄却 14**（+ completeness critic が 3 件追加発見＝**verify 未通過・低信頼**）
- 重要な含意: **棄却 14 件は「happy-dom で rect/ResizeObserver を stub すれば assert できる」= browser 化は coverage theater**。
  機械的に story/browser test を増やすと大半がこの罠に落ちる。監査はそのフィルタそのもの。
- **証拠の階層を混ぜない**: 「確定 10」は 14/24 を棄却した敵対的 verify gate を通過済。
  critic 由来の 3 件（Timeline / Map frame-draw / AnimatedRegionChrome）は **同じ gate を通していない候補**であり、Tier A と同列に置かない。

## 質問への直接回答（CI / 前提の補正）

- **前提の軽い補正**: 最 ROI は user が名指しした **Storybook E2E 層ではなく browser-geometry 層**。
  下記 Tier A の上位 4 件中、Storybook なのは MapHeader 1 件のみ。→「Storybook E2E を充実させるべき？」への正直な答えは
  「**狭く、かつ大半は別の層で**」。
- **CI への組み込みは追加配線不要**: 新規 `*.browser.test.tsx` は `vitest.browser.config.ts` の
  `include: ["src/**/*.browser.test.{ts,tsx}"]` に、新規 `*.stories.tsx` は `.storybook/main.ts` の
  `../src/**/*.stories.@(ts|tsx)` に **glob で自動取り込み**。既存の `browser` job（`test:browser` + `test:storybook`）がそのまま拾う。
- **ただし flake surface が増える**: 433 happy-dom テストより browser/Storybook は遅く脆い。browser job は
  `timeout-minutes: 15`。これが「**dnd-kit を full drive せず geometry seam を決定的に assert**」原則を
  per-test だけでなく **CI レベルでも**守るべき理由。

## 横断原則（実装時の必須ルール）

1. **store 全 mock 禁止**。`ForeshadowPanel.stories` 型（`vi.mock('./foreshadowStore')` で丸ごと差し替え）は
   coverage theater。real store（zustand `setState`）+ DB 境界（`mapApi`/`xxxApi`）のみ mock。
2. **dnd-kit の full drag を駆動しない**。repo 全体で dnd-kit の drag lifecycle を回すテストは前例ゼロ
   = pointer sensor / activation constraint が flaky。代わりに **geometry seam**
   （measured rect → computed pos/offset）を決定的に assert する。
3. **browser 化の前に「純関数抽出 → happy-dom unit」で足りるか必ず判定**。
   project 既定の「純関数抽出 + unit test」precedent に従う。Grid/Tree は大半がこれで足りる。
4. **差分検証**: fix を外すとテストが落ちることを確認する。落ちないなら何も gate していない。

## Tier A — やる価値が明確（bug 履歴 + 低コスト + 真の盲点）

いずれも敵対的 verify 通過済。bug 履歴コミットは 5 件とも実在・subject 一致を確認済（`git show -s`）。
**※印 = 「browser-only であること」が probe 実測でなく論証ベース。実装初手で差分検証（fix を外すと落ちる）して事実化すること。**

| # | 対象 | 層 | 根拠 | 優先 |
|---|------|----|------|------|
| 1 | **MapHeader** ボード rename/create/delete popover | ~~storybook-play~~ → **happy-dom**（実装済 ✅ `MapHeader.test.tsx`） | 「popover 即閉じ」が **2回再発**（38e56bba / 0a4f5c60、setTimeout 誤診の false-start も）。**verifier の「browser-only / storybook-play」判定は論証ベースで、差分検証により覆った**: create(onSelect) と rename(F2) は happy-dom で fix を外すと落ちる＝gate 成立。よって storybook 不要・happy-dom で確定。caveat: hover アイコン onClick 経路と delete 確認(autofocus input 無し)は happy-dom で即閉じを駆動/再現しない→ canonical Radix 経路で核を gate、delete は flow テスト止まり。 | **7** |
| 2 | **MatrixTable** 列ヘッダー横スクロール同期 | browser-geometry（実装済 ✅ `MatrixTable.browser.test.tsx`） | 4d947fbe が**この invariant 専用の fix**。実装の要点: ① test-setup-browser の virtualizer global mock を **importOriginal で実物に上書き**（windowing assertion が番人）② sync を潰すと追従テストが落ちる差分検証済 ③ 測定用 `data-testid` を4つ追加。header rect.left == body rect.left をスクロール後も assert。 | **6** |
| 3 | **useBeatDragDrop** handler 分岐 + collision seam（**登録位置は非対象**） | happy-dom×4 + browser-geometry×1（実装済 ✅ `useBeatDragDrop.test.ts` / `.browser.test.tsx`） | **層判定を訂正**: `git show 50ccdb57` で同 commit が直したのは **① unplaced reorder ② collision fallback ③ useDroppable 登録位置(EditorDropDiv)**（=`posAtCoords` 側ではない）。gate 状況: ① reorder/unplace/place-at-end の 3 分岐 = happy-dom（合成 DragEndEvent、reorder 潰しで落ちる差分検証済）② collision fallback(pointerWithin→rectIntersection) = happy-dom（合成 args、fallback 潰しで落ちる差分検証済）③ **登録位置は非 gate（意図的）**=実 DndContext + 実ジェスチャ要・programmatic に flaky。④ `posAtCoords` placed-move = browser（履歴無しの新規カバレッジ・固定 pos 差分検証で非重複確認）。**※ 当初「onDragEnd 全分岐」と過大記述 → Codex 指摘で訂正。合成 over を渡す本テストは「dnd-kit が over を解決できるか」は検証しない。** | **6** |

## Tier B — 完了（4/4 実装済）

実装の総括: 監査の層判定を **2件で訂正**（#7 storybook-play→happy-dom、#8 storybook-play→hitTest happy-dom seam）。
いずれも「最も決定的で安い層」を実測で選び、差分検証で gate 成立を確認。各々を honest にスコープ（browser 統合や flaky gesture は対象外と明記）。

| # | 対象 | 確定した層 | gate（差分検証） |
|---|------|-----------|-----------------|
| 5 | **ContextBar** pill overflow grouping | browser-geometry ✅ `ContextBar.browser.test.tsx` | **coverage INVERSION** 是正。count fallback と反転する 2 ケース(中幅×6→group / 広幅×8→個別)を実幅で。width→count 差し替えで両方落ちる。col 潰れ(=fallback 再来)回避の中間幅を実測。 |
| 6 | **SpotlightOverlay/カード配置** | happy-dom（純関数抽出）✅ `spotlight.test.ts` / `cardPlacement.test.ts` | onboarding テストゼロ→ buildFocusClipPath/boundingRect/computeCardStyle を gate。computeCardStyle は UI 依存から `cardPlacement.ts` へ挙動不変で抽出。**browser 実 rect 統合は ROI 低で defer**(幾何は pure 側で gate 済)。 |
| 7 | **usePanelDropdownPointerDrag** dropdown→region drop | ~~storybook-play~~ → **happy-dom** ✅ `PanelToggleDropdown.test.tsx` | **層訂正**: 未カバーは drop 配線のみ(閾値/toggle/lock/target解決/実geometry着地は既存カバー)。browser専用 resolveDropTargetFromPoint だけ stub し gate。drop を潰すと当該テストだけ落ちる。 |
| 8 | **TrashBinPhysicsView** pickup | ~~storybook-play~~ → **happy-dom seam** ✅ `dropTargetRegistry.test.ts` | **層訂正**: load-bearing な hitTest(containment + z-order)を合成 DOMRect で決定的に gate。.reverse() を外すと z-order 落ちる。**flaky な pointer gesture 本体は非対象**(回帰履歴も座標/クランプ側で hitTest 幾何には無し)。 |

## Tier C — 純関数抽出 → happy-dom（#9/#10 実装済、#11 は ROI 判定で defer）

「純関数抽出 → happy-dom」を 2 件で実施（抽出は挙動不変・DRY 改善も兼ねる）。browser の irreducible slice は honest に非対象化。

| # | 対象 | 結果 | gate（差分検証） |
|---|------|------|-----------------|
| 9 | **GridPanel** collision detection | happy-dom ✅ `gridCollisionDetection.ts` / `.test.ts` | 未 export だった `gridCollisionDetection` を抽出。gap-snap(20px 境界)/同列ガード/X-padding/rectIntersection fallback の選別を合成 args で gate。20px→<0 で snap 落ちる。**live-rect/scroll glue は非対象**(browser・drivability 未証明)。 |
| 10 | **Tree ScenesPanel** dnd | happy-dom ✅ `treeDropZone.ts` / 3 テスト | 二重定義の zone 判定を `treeDropZone.ts` へ集約し閾値 gate。multiselect sequencing(cmpKeys 昇順 + prevAfterId 連鎖)を renderHook で gate(sort 潰しで落ちる)。cmpKeys(全 sort の基盤・未テスト)も gate。**dnd-kit の over 解決は非対象**。 |
| 11 | virtualization windowing | **defer（ROI 判定）** | windowing 自体は @tanstack/react-virtual の挙動（=lib テスト）。app-owned は scroll-to-entry の `findIndex + scrollToIndex + onScrollComplete` の薄い glue のみ。最も layout-coupled な **Matrix の実 windowing は #2 の scroll-sync テストが既に依存・gate 済**。専用の codex windowing browser テストは大半が lib 再検証 = coverage theater に近く ROI 低 → 見送り。 |

## critic 由来・低信頼（敵対的 verify 未通過 → Tier 入りは要追加検証）

completeness critic が拾った 3 件。**確定 10 と違い 14/24 を落とした verify gate を通していない**。着手前に同じ skeptical pass を要する。

- **AnimatedRegionChrome clip-path** — **2026-06-04 解決（pixel infra **NO-GO** / browser computed-style gate **GO**）**。
  実証で当初判定の前提を 3 点訂正:
  1. **「3回再発」は誤帰属**。clip-path バグは機能導入コミット `929e4fca` 内で fix まで完結（同一コミットに
     bug 値と `inset(-200px)` 回避策・解説コメント）＝ **開発時 1 回・本番再発ゼロ**。CLAUDE.md の「過去3回再発」は
     Splitter / region overflow / stripe 整列の別系統であり、本バグではない（`layoutAnimation.ts` の履歴も単一コミット）。
  2. **「現状ツールで assert 不可」は誤り**。視覚効果（影クリップ→region gap にグレー透け）が paint-time で
     `getBoundingClientRect` に出ないのは事実だが、**原因**＝Framer の `none`→`inset(0 0 0 0)` 置換後の値は
     **CSSOM に載り `getComputedStyle().clipPath` から parseable 文字列で読める**。「paint-time ⟹ assert 不可」の
     推論が誤り。∴ pixel/screenshot 回帰基盤は不要。
  3. 実証マトリクス（実 Chromium・**closed→open toggle**・settled t≥260ms）:
     open=`none` → `inset(0px 0% 0px 0px)`（border-box クリップ＝バグ再現）/ open=`inset(-200px)` → `inset(-200px)`（全 offset 負＝非クリップ）。
     happy-dom は WAAPI 補間を実行せず値を素通し（`none`→`none`）で置換を再現できない → **browser 必須**。
     string 契約（happy-dom / `layoutAnimation.test.ts` 拡張）案は値 pin に留まり挙動を証明しないため不採用。
  → **gate を実装**: `AnimatedRegionChrome.browser.test.tsx`（4 region × toggle 経路必須 × settled computed clip-path の
     全 inset offset `< 0` を assert）。差分検証済（`REGION_OPEN_CLIP="none"` で 4/4 fail・`inset(-200px)` で 4/4 pass）。
     既存 `vitest.browser.config.ts` の glob が自動取り込み、pixel baseline 不要で flake 源を増やさない。
     **注意（gate を殺さない）**: `render(<X open />)` の mount-open は `AnimatePresence initial={false}` が enter 補間を
     抑制し置換が起きないため、バグ値でも素通しする。必ず closed→open の rerender toggle で開くこと。
  → **pixel/screenshot 回帰 infra の deferral**: 本バグ単体では正当化されない（dev 時 1 回・本番ゼロ・今 browser で安価 gate 済）。
     **トリガー付き defer** — 「`getComputedStyle` で原因値を読めない真の paint-only 回帰が複数顕在化したら」pixel infra を再評価。
     隣接候補の backdrop-filter は別件で dead-end 確認済（Chromium で屈折表現不可）のため母数は薄い。
- **Timeline story-time drag**: critic は「未カバーの browser gap」と指摘したが、別の verifier は
  「happy-dom の rect=0 は**安定**なので `svgX=clientX` で決定的に drive 可能。off-by-one 再発（1ffe6249）も
  rect=0 で再現する」と**反証**。→ おそらく **unit gap**。browser が要るのは scroll 時の負 rect.left の sliver のみ。
  低優先。**workflow 内部で結論が割れた唯一の項目**として記録。
- **Map rubber-band frame-draw**（`screenToFlowPosition`）: 実 React Flow viewport が必要。頻度低、優先 4-5。
  兄弟の `useFrameGroupDrag` は model space 計算なので unit gap（browser 不要）。

## 棄却 14 件（再 litigation 防止のため記録）

いずれも「happy-dom で rect/ResizeObserver/relatedTarget を stub すれば assert 可能 = browser 化は theater」。
TabBar / PseudoCommentBubble / Timeline dot drag / SnippetPanel responsive grid / MentionPopup scroll-follow /
SelectionToolbar / ContextPillGroup / ForeshadowMarkHoverPopover / LinterPanel ContextMenu /
ManageLabelsDialog reorder / NodeContextMenu submenu / TrashBinPopover / ImportDropzone / ExportPresetPicker。

特に **ExportPresetPicker** は「transform containing-block で fixed dialog が trap される」という一見 browser 必須の
主張が、Motion が rest 時に `transform:none` を返す（identity 時）ため **broken でも assert が通る**ことを
primary-source（motion-dom build-transform.mjs）で反証。mid-animation でしか見えず CI gate にならない好例。
