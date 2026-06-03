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
| 3 | **useBeatDragDrop** onDragEnd 全分岐 | happy-dom×3 + browser-geometry×1（実装済 ✅ `useBeatDragDrop.test.ts` / `.browser.test.tsx`） | **層判定を訂正**: 当初「50ccdb57 で再発した geometry 分岐を browser で gate」としたが、`git show 50ccdb57` で確認すると同 commit が直したのは **unplaced reorder / useDroppable 登録 / collision fallback**（=`posAtCoords` を使わない側）。よって ① bug 履歴のある reorder/unplace/place-at-end の 3 分岐は **happy-dom** で gate（renderHook + 合成 DragEndEvent、reorder を潰すと落ちる差分検証済）② `posAtCoords` placed-move 分岐のみ **browser**（履歴無しの browser-only 新規カバレッジ。固定 pos を食わせると落ちる差分検証で beatOperations.test との非重複を確認）。 | **6** |

## Tier B — 完了（4/4 実装済）

実装の総括: 監査の層判定を **2件で訂正**（#7 storybook-play→happy-dom、#8 storybook-play→hitTest happy-dom seam）。
いずれも「最も決定的で安い層」を実測で選び、差分検証で gate 成立を確認。各々を honest にスコープ（browser 統合や flaky gesture は対象外と明記）。

| # | 対象 | 確定した層 | gate（差分検証） |
|---|------|-----------|-----------------|
| 5 | **ContextBar** pill overflow grouping | browser-geometry ✅ `ContextBar.browser.test.tsx` | **coverage INVERSION** 是正。count fallback と反転する 2 ケース(中幅×6→group / 広幅×8→個別)を実幅で。width→count 差し替えで両方落ちる。col 潰れ(=fallback 再来)回避の中間幅を実測。 |
| 6 | **SpotlightOverlay/カード配置** | happy-dom（純関数抽出）✅ `spotlight.test.ts` / `cardPlacement.test.ts` | onboarding テストゼロ→ buildFocusClipPath/boundingRect/computeCardStyle を gate。computeCardStyle は UI 依存から `cardPlacement.ts` へ挙動不変で抽出。**browser 実 rect 統合は ROI 低で defer**(幾何は pure 側で gate 済)。 |
| 7 | **usePanelDropdownPointerDrag** dropdown→region drop | ~~storybook-play~~ → **happy-dom** ✅ `PanelToggleDropdown.test.tsx` | **層訂正**: 未カバーは drop 配線のみ(閾値/toggle/lock/target解決/実geometry着地は既存カバー)。browser専用 resolveDropTargetFromPoint だけ stub し gate。drop を潰すと当該テストだけ落ちる。 |
| 8 | **TrashBinPhysicsView** pickup | ~~storybook-play~~ → **happy-dom seam** ✅ `dropTargetRegistry.test.ts` | **層訂正**: load-bearing な hitTest(containment + z-order)を合成 DOMRect で決定的に gate。.reverse() を外すと z-order 落ちる。**flaky な pointer gesture 本体は非対象**(回帰履歴も座標/クランプ側で hitTest 幾何には無し)。 |

## Tier C — まず happy-dom 純関数抽出（browser 化はその後・限定的）

| # | 対象 | 方針 | 優先 |
|---|------|------|------|
| 9 | **GridPanel** collision detection + axis-lock | `gridCollisionDetection`（純関数だが未 export・未テスト）を**先に export して happy-dom unit**。live-rect 収集 + scroll 補正の glue だけが browser。drivability 未証明なので seam 抽出推奨。candidate のバグ履歴は perf 由来で inflate 気味。 | 5 |
| 10 | **Tree ScenesPanel** dnd | zone 閾値 / multiselect sequencing / cmpKeys は**全部 happy-dom 可**（grid が純関数で証明済）。browser が要るのは transform 配下の DragOverlay portal offset（49b19a9c）の 1 invariant のみ。大半は unit work。 | 5 |
| 11 | **Codex / CodexPanel / Matrix** 共通 virtualization windowing | browser 化するなら 3 つまとめて parametrize。**global の virtualizer mock を local unmock 必須**（しないと theater）。own-logic は薄く lib 依存大。 | 4 |

## critic 由来・低信頼（敵対的 verify 未通過 → Tier 入りは要追加検証）

completeness critic が拾った 3 件。**確定 10 と違い 14/24 を落とした verify gate を通していない**。着手前に同じ skeptical pass を要する。

- **AnimatedRegionChrome clip-path**（MEMORY の 3回再発・framer `inset↔none` → box-shadow が border-box で clip）:
  **現状ツールで assert 不可**。box-shadow / clip-path の clip は **paint-time** で `getBoundingClientRect` に出ず、
  repo に視覚回帰 infra は**ゼロ**（`toMatchImageSnapshot`/`toHaveScreenshot`/percy/argos 全て不在を確認）。
  → これは「browser-geometry の quick win」ではなく **pixel/screenshot 回帰基盤の新規導入を伴う大物**。安易に Tier A に入れない。
  代替: un-portal/inset 値の **string 契約**（`layoutAnimation.test.ts` 拡張）で回帰ベクトルの一部だけ happy-dom gate するのが現実的。
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
