# Work Layer（ヘッダーの Work Pulse・Task Tray）に実データの件数と入口を出す最初の版 — 設計草稿（draft）

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `work-layer-live-first-slice/1`（草稿） |
| Status | draft。**問い W1〜W7（一枚目）は 2026-11-24 に構造化質問で個別に回答済み（すべて起案者の推奨どおり。各問いの「回答」に選んだ選択肢を記録）**。この草稿は docs だけで、コードは 1 行も書いていない。**`[precheck]` は、W1〜W7 の範囲では解けた**（W2 は「足さない」なので、新しい契約・保存・送信先は無い）。**残るのは、作者に見える文言と表示の形**（部分合計の「＋」・行の文言・入口の表示。P5 の前に別に伺う）と、**出す時期**（W6 の回答どおり、旗を開ける PR の前に別に伺う）。旗は閉じたまま（作者には何も見えない）を前提にする。**2026-11-25 追記：実装は merge 済みで、旗は既定で開いた。上の記述と §1〜§4 の本文は書いた時点のまま。実装の後の記録は §5** |
| 基点 | worktree `claude-work-layer-design`（枝 `claude/work-layer-live-design`）。**調べた基点は `origin/master` `373c8d4b5`**で、行番号はこの基点のもの。出荷のときに `accab2860`（#1087。Mastra の変更で、work-layer・editor・narrative-extraction・codex のどの path にも差分は無い）へ rebase した |
| 由来 | ADR 014 D6（`docs/adr/014-scene-information-in-editor.md:78-83`）と :136（Consequences「Work Layer を実データにつなぐとき、件数の数え方と、場面へ飛ぶ入口を、統合ペインと共通にする」）。ADR 012（Work Layer の表示。Status は「実装・公開の承認ではない」）。`m3-live-structure-health-design-draft.md` の「Work Layer への移設は、実データへの配線の設計ができてから」 |
| ユーザーの決定 | 2026-11-24：「Work Layer って実装始められますか？」→「**次のセッションで始めましょう**」。範囲は、**件数と入口に絞った最初の版（Task を含めない）を、設計草稿から始める**ことまで。contracts の M3 確認記録の追記 25（`4542ac6ac`）に、「着手の了承であって、範囲の細目は個別に確認していない」と記録済み。**この草稿の「推奨」は起案者の意見で、ユーザーの決定ではない**。M3 の技術判断（作り方・PR の分け方・試験）は、**ユーザーの 2026-11-23 の決定②で、NIR-1 の残レーンと同じ範囲を事前に委任済み**（記録の正本は contracts 枝の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-23-m3-pullforward.md`、commit `71e45bb4`）。これは `AGENTS.md` が列挙する NIR-1 の残レーンの委任とは**別の、M3 についての明示の委任**で、`AGENTS.md` の列挙を M3 に広げるものではない。作者に見える挙動・新しい契約・保存・出す時期は、委任の外 |
| 表記 | 【確認済み】は今の worktree で読んだもの。【実測】は今日実行した結果。【報告】は調査 agent（Codex、read-only）の報告で、本文で再読していないもの。【未確認】は確かめていないもの。【起案者の技術判断】は M3 の委任の範囲内で起案者が決めたもの。【起案者の読み／意見】はユーザーの確認が要るもの |
| 独立レビュー | 2026-11-24、別系統（Codex、read-only、結論を伏せた依頼）の 3 本：事実の裏取り 2 本（work-layer 側・実データ側）と設計レビュー 1 本。裏取りの指摘（`source-missing` は 8 行・5 ファイル、保守 preview の許可を見ないのは route と N-API だけで main の共通 gate は通る、旗は環境変数で製品 build でも開く、ほか）と、設計の指摘 6 件（ライフサイクル表、作品切替時の前の件数、候補の件数の定義、Pulse の部分合計、PR の順序、ADR 014 との整合）を本文に反映した |

用語：**Work Pulse**＝ヘッダー中央の小さな表示（Focus・Attention の件数・System の状態）。**Task Tray**＝Pulse から開く面（Attention／Focus の 2 つの面）。**Attention**＝作者の判断を待つ項目（ADR 012：「観測・判断候補であって、作者が引き受けた Task ではない」）。**port**＝`WorkLayerPort { load() }`（`src/features/work-layer/types.ts:140-142`）。**live／fixture**＝実データの port／見本データの port。**Inbox**＝`narrative_maintenance_inbox_list` が返す「保守が気にしている項目」の一覧。

## 一枚目：何を作るか、作らないもの、伺う問い

**何を作るか（案）**
- ヘッダーの Work Pulse の数字と、Task Tray の Attention の面に、**実データの件数と入口**を出す。項目 1 件ずつの行ではなく、**種類ごとの行（件数＋開く入口）**を出す。
- **読むだけ**（承認・拒否・保留・保存はしない）。**既存の読み取りだけ**を使う（新しい IPC・schema・保存・AI への送信を足さない）。
- 種類の候補は 2 つ。**C1 未登録の固有名詞の候補**（Codex 画面と同じ「未登録かつ未却下」の件数。入口は構造抽出のレビュー画面）。**C2 根拠が古くなった提案**（Inbox の件数。作品の保守機能の許可が入っているときだけ。入口は最初の版では付けない）。
- **旗は新設して閉じたまま**。作者には何も見えない。出す時期は別に伺う。

**作らないもの（最初の版の外）**：Task・Focus・作業の捕捉・System の状態・Resolve・まとめて処理・変更レビュー（M4 の `ChangeReview` と重なる。§4）／項目ごとの行（題・場面）と場面へ飛ぶ入口／全作品の未確認の提案の件数／書き込み。

**この草稿が見つけた、設計に効く事実（上位 5 つ）**
1. **製品 build でもヘッダーに何も出ない**のは、port が null だから。Work Layer の UI 部品（`WorkLayerSurface` の chunk、約 89 KB）と見本の印の文字列は**製品 bundle に入る**が、fixture 本体は入らない【実測。§1.3】。
2. **今の Attention の型は、実データから作れない。** 1 行ごとに候補・根拠・前の値・影響・状態の欄を必須にしている（`WorkLayerFindingView`）。今ある読み取りのどれも、題も場面も返さない。だから最初の版は「件数と入口」に絞るのが、**今の読み取りで作れる上限**である。
3. **Inbox の「保守機能の許可」は、画面（ボタンの表示）だけが見ている。** 許可は既定で切れ、作者が入れる画面は確認できない。ところが Inbox の route と N-API は、この許可を見ない（main の共通 gate と sender の検査は通る）【確認済み。§1.5】。Work Layer がこれを読むとき、許可を見るかどうかは、**作者に見える挙動の判断**になる（W3）。
4. **候補の件数は重い走査**（全場面の本文の形態素解析）で、今は Codex 画面の mount・作品の切替・手動の再スキャンでだけ走る。ヘッダーに常駐させて自動で走らせるのは、**測ってから**でないと決められない（W4）。しかも、取得の失敗も非日本語の作品も、今の wrapper は**空配列を返す**ので、「0 件」と「数えられなかった」を区別できない【確認済み。§1.5】。
5. **数え方で決まっているのは「統合ペインと共通にする」と「複数の場面にまたがる提案は作品全体で 1 件」だけ**で、統合ペイン側にはまだ集計のコードがない（23 の確認）。最初の版の 2 種類は、どちらも統合ペインの「今の場面の解釈」と重ならないので、**共通にする対象の件数（未確認の提案）は最初の版に入れない**ことで、正本の置き場の決定を後の版へ送れる（§2.4）。

**伺った問い（W1〜W7。作者から見える場面の言葉で。選択肢と推奨は問いを出した時点のもの。2026-11-24 に構造化質問で個別に回答済みで、回答はすべて推奨どおり）**
- **W1 トレイに何を出すか**：A＝種類ごとの行（件数＋開く入口）。ヘッダーの数字はその合計（推奨）／B＝ヘッダーの数字だけ（トレイは開けない）／C＝項目ごとの行（題・場面）。C は、今の読み取りでは出せず、新しい読み取りが要る（W2）。
  - **回答（2026-11-24）：「種類ごとの行（件数＋開く入口）」**（推奨どおり）。
- **W2 新しい読み取りを足すか**：A＝最初の版は足さない（推奨）／B＝全作品の未確認の提案の件数を読む新しい読み取り（新しい契約。23 の SRD/1 の RD3 は「承認し直せる提案」だけで、別の定義）／C＝Inbox の絞り（3 欄。DR-M3-14）を広げ、題・識別子を renderer に出す。
  - **回答（2026-11-24）：「足さない（今ある読み取りだけ）」**（推奨どおり）。
  - **【2026-11-25 改訂・W14】** 測定（保守 Inbox の全件の構築が、Consumer 数に比例して重く、その間は共有の DB 接続を握る）の結果、ユーザーが「**件数だけを返す読み取りを新しく足す**」を選んだ（contracts の M3 確認記録の追記 29）。新しい IPC `narrative_maintenance_stale_proposal_count`（読み取り専用、own-data-read）を足す（DR-M3-31）。「足さない」はこの 1 本に限って変わる。W2 の B（全作品の未確認の提案）・C（題・識別子を出す）は別で、足さない。W15：実在の作品の件数を DB から読むかには、「読まない（仮定の規模で判断する）」と回答。
- **W3 保守機能の許可との関係**：A＝許可が切れているときは、C2「根拠が古くなった提案」の行を出さない（推奨。今の「健全性」ボタンと同じ扱い。既定の作者には、C1 だけが出る）／B＝許可と無関係に、C2 も出す。
  - **回答（2026-11-24）：「出さない（許可が切れているときは行ごと無し）」**（推奨どおり）。
- **W4 候補の件数を、いつ数えるか**：A＝トレイを開いたとき、または Codex 画面で数えた結果があればそれを使う。ヘッダーは自動では数えない。数え終わるまで、ヘッダーの数字は「一部だけ」と分かる形で出す（§2.4）（推奨）／B＝ヘッダーが出たとき自動で数える（重い走査。作品の大きさで待ちが出うる。測定が要る）／C＝作者が「数える」を押したときだけ。
  - **回答（2026-11-24）：「トレイを開いたとき（数え済みならそれを使う）」**（推奨どおり）。ヘッダーの数字は、数え終わるまで「一部だけ」と分かる形で出す。その表示の形（「＋」など）と文言は、P5 の前に別に伺う。
- **W5 ロードマップの Deferred との整理**：A＝Deferred の「Project Focus／WorkBeacon」と、除外の「Header WorkBeacon」は、Task・Focus・agent の run の表示を指し、**Attention の件数（今回）は別**と読む。ロードマップは変えない（推奨）／B＝この読みをロードマップに追記する（別の PR。枠に数える）／C＝今回も Deferred に当たるので、Release A の後まで待つ。
  - **回答（2026-11-24）：「別物と読む。ロードマップは変えない」**（推奨どおり）。
- **W6 出す時期**：旗は閉じたまま実装し、**作者に出す時期（旗を開ける PR）は、見えるようになった絵を見てから別に伺う**（推奨）。review 画面の旗（構造抽出）を開ける PR とは別の時期になりうる（§3）。
  - **回答（2026-11-24）：「閉じたまま実装し、出す時期は後で別に伺う」**（推奨どおり）。
- **W7 ヘッダーの読み取りの時機**：A＝ヘッダーが出たとき、保存済みの値を読むだけの安い読み取り（保守の一覧と許可）だけを読んで数字を出す。統合ペインの「開くまで読まない」の規則（ADR 014 D7・D10）は、ヘッダーの Work Pulse には当てはめない読み（推奨。§2.10）／B＝トレイを開くまで何も読まない（ヘッダーの数字は、開かないと出ない）。
  - **回答（2026-11-24）：「よい。ヘッダーが出たとき安い読み取りだけ読む」**（推奨どおり）。
- **W12 Work Layer の旗を開ける時期**（2026-11-25、構造化質問。contracts の M3 確認記録の追記 28）：A＝大きい実作品で mount の安い読み取り（policy・Inbox）の時間を測ってから開ける（推奨）／B＝P5 の merge 直後に開け、測定は後／C＝M3〜M4 が揃うまで閉じたまま。
  - **回答（2026-11-25）：「測定してから開ける」**（推奨どおり）。P4・P5 は旗を閉じたまま merge → 測定 → 旗を開ける PR（P7）。測定の値と「問題なし」の根拠は、その PR の本文に書く。旗を開けても公開（リリース）には当たらず、一度の公開の扱いは変わらない（01 の読み）。
- **W13 review 画面の旗を開ける時期**（同上）：A＝Work Layer の旗と同時に開ける（推奨）／B＝review の旗は後。
  - **回答（2026-11-25）：「Work Layer の旗と同時に開ける」**（推奨どおり）。W6 の「review 画面の旗を開ける PR とは別の時期になりうる」と §3 の P6 の行の「別」は、これで改訂する。適用（Codex への取り込み）は旗でなく保守の policy（`narrativeDomainApplyAllowed`）で閉じたまま。

## 1. 現状（確かめた事実）

### 1.1 ヘッダーと Provider
- `<WorkPulse />` は通常のヘッダーの中央（`src/features/editor/EditorWorkspaceHeader.tsx:113`）。Zen・phone では header ごと出ず、panelWindow では WorkPulse のない header になる（`:47-58`）。
- `WorkLayerProvider` は `EditorWorkspaceProviders` が常に置く（`EditorWorkspaceProviders.tsx:14-27`、`EditorWorkspaceShell.tsx:94-105`）。`active` は lifecycleLocked・Zen・phone・panelWindow・screenshot panel のどれでもないときだけ true（`workLayerAvailability.ts:9-22`）。【確認済み】
- **Provider と port は、今の作品（project）を受け取らない。** `load()` に引数はなく、model にあるのは `scopeId` だけ（`types.ts:110-122, 135-142`）。作品の切替で Provider が作り直されるかは**未確認**。作品の id は `useCurrentProjectId()`（`src/features/project/projectStore.ts:910`）で取れるが、**作品が無いときは代わりの id を返す**ので、live は「作品なし」を別に扱う必要がある。

### 1.2 port と model
- データの口は `load()` の 1 つだけ。実装は fixture だけ（`types.ts:135-139`「The production NIR adapter intentionally does not exist」）。書き込みの口は無い。work-layer の非テスト source に、**IPC・store・Tauri／Electron の import は 0 件**（`@/lib` の `utils`・`animation` の import はある）。
- **`load()` を呼ぶのは Provider の effect だけ**で、依存は `active`・`initialModel`・`port`（`WorkLayerContext.tsx` の effect。:52-79）。トレイを開いても再読込しない。**reject すると model が null になり、Pulse もトレイも消える**。**port が変わっても、新しい `load` が終わるまで前の model は消えない**（`cancelled` が防ぐのは古い promise の反映だけ）。loading の表示はなく、model が null の間は何も出ない（`WorkPulse.tsx:18`、`WorkLayerContext.tsx:122-124`）。【確認済み】
- 件数を出す箇所は一様ではない：Pulse の数字は `attention.length`（`WorkPulse.tsx:78-80, 118-120`）、トレイの見出しは Attention か author task の数（`TaskTray.tsx:47-56`）、Attention の面（`AttentionTrayBody.tsx:53-57, 101-117`）、live region は到着・解消の差分 `attentionDelta`（`WorkPulse.tsx:21-26`、`WorkPulseLiveRegion.tsx:15-29`）、処分済みは `disposedAttention.length`（`DisposedAccordion.tsx:42, 57-77`）、Focus の面は `authorTasks.length` と attention の件数（`FocusTrayBody.tsx:59-81`）。【確認済み／報告と照合】
- Attention の 1 行（`WorkLayerFindingView`、`types.ts:63-84`）は、`kind` が**自由な文字列**で、`"source-missing"` の直書きの分岐が **8 行・5 ファイル**にある（`AttentionTrayBody.tsx:40,74,77`、`ResolveLens.tsx:64`、`ResolvedReceipt.tsx:28,37`、`BatchReview.tsx:139`、`ResolveProjection.tsx:154`）。**種類を足す登録口は無い。** `open*` の action（`workLayerContextTypes.ts:4-18`、`workLayerReducer.ts:24-40`）は、Work Layer の**中**の面（Focus・Attention・Portal・Projection・Change・Batch・System・Inspect）の切替だけで、**Work Layer の外の画面を開く口は無い**。

### 1.3 製品 build に何が入るか【実測】
`VITE_WORK_LAYER_FIXTURE=true` を付けて `vite build`（本番モード）を scratch に出し、文字列を grep した（2026-11-24。node 22）。

| 探した文字列 | 結果 |
| ------------ | ---- |
| `createWorkLayerFixturePort`、fixture の作例の題（2 種類） | **0 件**（fixture chunk なし。ファイル名にも `workLayerFixture` なし） |
| `UI PREVIEW`／`NOT SAVED`／`PREVIEW ONLY` | **3 ファイル**（`WorkLayerSurface-*.js`〔約 89 KB〕と、ja／en の locale chunk） |
| `source-missing` | 5 ファイル |
| `work-layer-preview` | 1 ファイル。fixture の `scopeId` ではなく、`data-work-layer-preview-background` という属性名（`WorkLayerPrototypePreview.tsx:45`、`WorkLayerModalPortal.tsx:33`）の一部 |

つまり、`useWorkLayerPreviewPort.ts` のコメント「Production builds never import the fixture chunk」は、**今の build で成り立っている**。一方、**Work Layer の UI 部品と見本の印は製品に入っている**（lazy chunk。`WorkLayerSurfaceHost.tsx:5`）。これが、実データに繋ぐとき見本の印が誤って出る原因の置き場になる（§2.2）。再現の手順は §2.7。

### 1.4 見本の印
- 「UI PREVIEW」「NOT SAVED」「PREVIEW ONLY」は、**component の 15 ファイル**の直書き（BatchReview・BatchReviewFooter・ChangeReview・ChangeReviewActions・ContextPortal・CorrectionRulePreview・ProjectionCandidateContext・ResolveLens・ResolveProjection・ResolvedReceipt・SystemActivity・SystemBlocked・SystemRunInspection・TaskDraftComposer・TaskTray）と、**`ja.json`・`en.json` の `workLayer` の名前空間に各 9 行**ある。handoff の「11 部品の直書き」は不完全だった【確認済み。`rg -c`。独立の裏取りでも一致】。
- **live の経路上（Pulse とトレイの Attention の面）に残る印は少ない**：`TaskTray.tsx:50` の枠の「UI PREVIEW」、`WorkPulseLiveRegion.tsx:25` の「（UIプレビュー）」、Focus の面への切替（`switchFocusPreview`。`AttentionTrayBody.tsx:25, 160` と `FocusTrayBody.tsx:12, 97`）、`TaskTrayFooter` の「作業を捕捉」（disabled。`TaskTrayFooter.tsx:10-19`）【確認済み／報告と照合】。ほかの 14 ファイル（Resolve・Batch・Change・Task の下書き・System）は、**live で面ごと出さなければ、印の出し分けを要らない**。

### 1.5 実データ側（今ある読み取り）
**(a) Inbox**（C2 の元）
- `narrative_maintenance_inbox_list`（引数は `projectId` だけ。未知の欄は拒否。`ipcContract.ts:1870-1884`）。返すのは作品の現行 Semantic Epoch の保守項目の一覧で、現行 Epoch が無ければ**空配列**（`inbox_read_model.rs:399-417`）。1 行は 1 Consumer（提案の 1 つの版）か保守停止の記録で、`InboxEntry`（:214-224）に**場面の識別子も題もない**。
- 読み取り専用で、保存済みの Freshness を読む（再計算しない）。**件数の上限もページングも無く、作品内の全行を読む**。大きな作品での時間は未測定【報告。`inbox_read_model.rs:148-176, 539-545`】。N-API は `run_blocking` 内で読む（`lib.rs:16322-16340`）。
- renderer の読み口は `narrativeMaintenanceInboxList`（`src/application/narrative-extraction/nativeApi.ts:1194-1201`）で、**3 欄（entryKind・consumerKind・evidenceFreshness）だけを allow-list で残し**、識別子・題は捨てる（DR-M3-14、`m3-decisions.md:26`）。件数の数え方は `structureHealthModel.ts:50-72`（1 行＝1 Consumer。根拠が古い提案・保守停止・未認識に分ける）。今の呼び手は `StructureHealthPanel`（`:54`）だけ。
- **gate**：画面は `maintenancePreviewAllowed === true` かつ `effectiveMode !== "disabled"` のときだけ「健全性」ボタンを出す（`maintenanceFlags.ts:11-18`）。既定は `maintenanceEnabled: false`（`narrativeRuntimePolicy.ts:31-37`）。**Inbox の route と N-API は、この保守 preview の許可を見ない**（`ipcContract.ts:11764-11772`、`lib.rs:16322-16340`）。作者が許可を入れる画面は、今の renderer には確認できなかった【報告】。ただし **main の共通 gate は通る**：sender を取って `profileEgress.assertInvoke` を通し（`electron/main/ipc.ts:2324-2363`）、restricted profile では own-data-read に main 発行の caller identity が要る（`profileEgress.ts:908-920`）【報告】。`narrative_maintenance_inbox_list` は own-data-read の一覧に入っている（`profileEgress.ts:225`。一覧は :177-226）。own-data-read は、profile の外へ公開しない作者自身のデータの型付き読み取りの分類で、restricted でも読める（:169-175）【報告】。
- attention の set／clear の IPC はあるが、renderer の wrapper は無い。

**(b) 構造抽出の候補**（C1 の元）
- `extractCodexCandidates(projectId)`（`src/features/codex/candidateExtractor.ts:31-43`）は、`extract_codex_candidates` を呼び、**失敗しても、native 非対応でも、日本語以外の作品でも、空配列を返す**（:35・:42。Rust 側も日本語以外は空。`codex_candidates.rs:390-419`【報告】）。0 件と取得失敗を区別できない。
- 作品の全場面の本文を走査し、形態素解析で集計する CPU 負荷のある処理（blocking pool）【報告。`codex_candidates.rs`、`lib.rs:13328-13360`】。今の再実行の契機は、`CodexCandidatesReport` の mount・作品の切替・手動の再スキャン（`CodexCandidatesReport.tsx:81-110, 506-513`）。**旗が閉じていても走る**（旗は Dialog の mount とボタンだけを守る。:69, 309-316）。
- **画面の「件数」は、抽出結果そのものではない**：抽出 − 登録済みの名前・別名 − 却下キー（`codexCandidates.ts:32-57`、`CodexCandidatesReport.tsx:132-141`）。0 件なら report は null（:307）。却下キーは `project_settings` の `codex.candidates.dismissed`（JSON 配列。作品ごと。`codexCandidateDismissals.ts:19-36`）。**却下の読込が済む前は空集合なので、件数が一時的に多く見える**（:65-67）【報告】。
- 構造抽出のレビュー画面（`CodexStructureExtractDialog`）は、props が `open`・`onOpenChange`・`folderId?`・却下の復元 callback・却下キー、マウントは `CodexCandidatesReport.tsx:309-316` の 1 か所、open の state はそのローカル。旗は `isCodexStructureExtractionReviewEnabled`（`codexStructureExtractionFlag.ts:11-18`）で、**未指定の既定は DEV の真偽**（DEV の build では開き、製品 build では閉じる）。環境変数で明示すれば製品 build でも開く。Work Layer から開く経路は無い。

**(c) 提案**（W2 の B の元）
- 契約を列挙した範囲（`narrative_extraction_*` の 27 本〔`ipcContract.ts:11440-11732`〕と、`nir1_entity_relation_revision_*` の 5 本〔:10264-10318〕）に、**作品全体の一覧・件数を返す読み取りは無い**。あるのは場面単位（`list_scene_proposals`。:11515）、run 単位（`get_run_review_bundle`）、revision 単位の読み取りだけ【報告。列挙して確認した。検索した範囲の外は未確認】。review bundle は AI 抽出の再開にも使われる【報告】。
- 「未確認」は `narrative_proposals.status = unreviewed`（`migrate.rs:2776`）。Chronicle の「未取り込み」件数は別の定義（applicable・未適用で rejected 以外）【報告】。
- docs には「作品全体の一覧を引く読み取り 1 本」が 2 つの文脈である：ADR 014 D10 追補（:157）と、23 の SRD/1 の **RD3 `narrative_extraction_list_redecidable_proposals`（`nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md:222`）。ただし RD3 の対象は「取り込み済みで、本体の却下のままで、出来事が年表にある提案」だけで、未確認の提案ではない**。コードには無い（draft）。

### 1.6 試験・journey
- header の browser 試験（`EditorWorkspaceHeader.browser.test.tsx`）は、fixture の model で Pulse が出る状態だけを描画し、左レールと中央 slot の位置を測る。**Pulse の有無で header の幅・高さが変わるかは assert していない**（独立の裏取りでも確認）。`src/features/layout/layoutInvariants.browser.test.tsx` に、header・Work Pulse を対象にする assert は無い。
- fixture に依存する試験：`TraySystemPreview.test.tsx`・`WorkLayerSurfaceHost.test.tsx`・`WorkLayerSpecification.test.tsx`・`disposeWorkLayerFinding.test.ts`・`EditorWorkspaceHeader.browser.test.tsx`・stories【handoff の調査】。`WorkLayer.test.tsx` は自前の model と、mock の port を渡せる。
- journey：`electron/scripts/product-journey-catalog.mjs` の `editor` が `src/features/editor/**` を paths に持つ（5e の確認。:572-575）。**header を直すと editor の journey が選ばれる**。`src/features/work-layer/**` はどの journey の paths にもなく、評価の規則（`evals/impact-map.yaml`・`evals/quality-manifest.yaml`・`policies/quality/`）にも出てこない（5e の確認）。journey の catalog 自体を触るときは `scripts/local-ci-full-workload-allocation.json` の digest も直す。

## 2. 設計（項目 1〜9。ADR 014 との整合を 2.10 に追加）

### 2.1 live port：何を・いつ・どう読むか【起案者の技術判断。W4 は意見】
- **形**：`WorkLayerPort` に `kind: "fixture" | "live"` と `scopeKey` を足し、`load(request)` に理由（`"mount"`／`"tray-open"`）を渡せるようにする。fixture は理由を無視し、`scopeKey` は固定。live の port は**作品ごとに作る**（`useWorkLayerLivePort(projectId, active)`。作品の切替で作り直す）。作品が無いとき（`useCurrentProjectId` の代わりの id）は、port を作らない。
- **作品が変わったとき**は、前の作品の件数を**1 フレームも描かない**（§1.2 のとおり今は、新しい `load` が終わるまで前の model が残る）。effect の後に model を空に戻すだけでは、再描画から effect が動くまでの間に前の model が描かれうるので、**描画の時点で同期的に外す**：live の model の `scopeId` を作品の id とし、Provider が描画ごとに `port.scopeKey` と `model.scopeId` を比べ、違えば `visibleModel` を null にする（既存の `visibleModel`〔`WorkLayerContext.tsx:91-96` で導出し、:123 で null なら context を null にする〕の導出に条件を足す）。あわせて、effect でも model を空に戻す。**同じ作品の再読込（`tray-open`）の失敗では、前の model を残す**。今の「reject で全部消える」は、live では使わない。preview の挙動は変えない（fixture の `scopeKey` は固定）。
- **読み口は注入**する。live の port は、`readMaintenancePolicy`（既存の `getNarrativeRuntimePolicy`）、`readMaintenanceInbox`（既存の `narrativeMaintenanceInboxList`。集計は既存の `structureHealthModel` を再利用）、`readCandidateCount`（C1。下）を引数に取る。work-layer の中に IPC・store の import が入らず、試験は fake の読み口で書ける。
- **C1 の件数の定義**：Codex 画面が出す数と同じ、**抽出 − 登録済み − 却下**（§1.5 (b)）。そのため、共有するのは生の走査結果だけでなく、**走査結果・却下キー・却下の読込済みの印・世代番号**を持つ、作品ごとの共有 host である。**却下の読込が済むまで C1 は `not-counted`** とする（多い数を一瞬出さない）。**手動の再スキャンは世代番号を進め、前の結果を捨てて新しく走査する**。作品の言語が日本語以外のときは、C1 の行を出さない（作品の言語を project の値で判定できるかは【未確認】）。
- **いつ読むか**：`mount`（ヘッダーが出たとき。作品の切替を含む）では**安い読み取りだけ**（policy と Inbox。保存済みの値を読むだけ）。`tray-open` では、それに加えて C1 の件数（W4 A）。**ヘッダーは候補の走査を自動では起こさない**。Codex 画面で数えた結果が共有 host にあれば、それを使う。
- **失敗・未計測**：種類ごとに状態を持つ（§2.3）。読み口が失敗した種類は `unavailable`（失敗したことを作者に示し、件数は 0 としない）、未計測の種類は `not-counted`。残りの種類はそのまま出す。`load()` 自体は、種類ごとの失敗では reject しない。
- **「0 件」の言い方**：「0 件」は「問題なし」ではない。live 用の読み口では、`extractCodexCandidates` が失敗を空配列に潰す点を避ける（既存の wrapper は変えず、失敗を返す別の関数を足すか、戻りを判別型にするか。実装の PR で決める。既存の呼び手の挙動は変えない）。
- **測定**：Inbox の全行読み取りと候補の走査は、大きな作品での時間が未測定。P4 の前に、既存の大規模 fixture（NIR-1 の capacity 系）で、`mount` の安い読み取りの時間を測る（閾値は設けず値を記録する）。

### 2.2 見本の印と本物の印【起案者の技術判断】
- 出し分けの単位は、文言ごとではなく **port の種類（`kind`）の 1 か所**。Provider が `useWorkLayerProvenance(): "preview" | "live"` を公開する。
- **live では、見本が前提の面を出さない**：Focus の面（`NOW`）・System・Resolve・Batch・Change・Task の下書き・処分済みは、live の model では入口ごと無い（`focus: null`、`system` は idle）。したがって、14 ファイルの印には触らない。live の経路に残る 4 か所（`TaskTray.tsx:50` の枠、`WorkPulseLiveRegion.tsx:25`、`switchFocusPreview`、`TaskTrayFooter`）だけを、`provenance` で出し分ける。**preview の見た目は変えない**。
- **到着・解消の知らせを出さない**（ADR 014 守ること 5）：live では、`WorkPulseLiveRegion` の読み上げと `attentionDelta` の強調を発火させない。live の model は到着・解消の欄を持たない。トレイを自動で開かず、フォーカスも動かさない。変わるのは件数だけ。
- 試験：preview の試験が assert する印（`TraySystemPreview.test.tsx:79,91`、`WorkLayer.test.tsx:654`、`ChangeReview.test.tsx:102`）はそのまま通る。live の試験を足す（印が出ないこと、到着の知らせが出ないこと）。
- 【未確認】Pulse が `focus: null`・`system: idle` のとき何を描くか。到着・解消の知らせを起こす欄が、live の model で本当に空になるか。P2 で、live の model を渡した実描画の試験で確かめる。

### 2.3 項目の種類の足し方と、外の画面を開く口【起案者の技術判断】
- **finding の `kind`（自由な文字列）は広げない。** 8 行・5 ファイルの直書きと fixture に触らないため。live の種類は、別の閉じた型にする：`WorkLayerLiveEntry { id: "codex-candidates" | "stale-proposals"; status: "ready" | "not-counted" | "unavailable"; count: number | null; open?: WorkLayerOpenSurface }`。**組み合わせの規則**：`ready` は `count` が 0 以上の整数。`not-counted`・`unavailable` は `count` が null。**行を出さない場合は、行を作らない**（許可が切れた C2、日本語以外の作品の C1）。model には `liveEntries?` を足し、live では `attention: []`。
- **Attention の件数は 1 つの selector 経由**にする：`selectAttentionCount(model) → { total, complete }`。`total` は `ready` の行の和、`complete` は、行がすべて `ready` であること。preview では `attention.length`、`complete` は常に true。Pulse の数字・トレイの見出し・Attention の面は、この selector だけを読む（Focus の面・処分済みの件数は、live では出さない面の件数なので対象外）。
- **外の画面を開く口**：`WorkLayerOpenSurface = { surface: "structure-extract-review" }`（最初の版はこの 1 つ）。work-layer は features/codex を import せず、**host（`EditorWorkspaceProviders`）が `onOpenSurface` を Provider に渡す**。host が、surface の名前を実際の画面に結ぶ。既存の `open*` action（Work Layer の中の面の切替）とは別の口である。
- **構造抽出のレビュー画面を開くために**、Dialog の open state と、候補・却下の所有者を、`CodexCandidatesReport` のローカルから**共有 host に持ち上げる**（調査の案 1）。§2.1 の共有 host と同じ持ち上げで、report とヘッダーが同じ状態を見る。案 3（callback だけ足す）は、report が未 mount のとき受け手が無いので採らない。影響は `CodexCandidatesReport.tsx`・新しい hook・shell の host・既存の report／却下復元の試験【報告】。
- **旗が閉じている間（review 画面の旗が製品 build で閉じている間）は、C1 の行に入口を付けない**（件数だけ）。入口が行き先のない button にならないため。

### 2.4 数え方を統合ペインと揃える（ADR 014 :136）
- 統合ペインの集計コードは**まだ無い**（23 の確認。SRA/1 の実装は未着手）。docs で決まっているのは、**共通にする**（D6 :80-81、SRA/1 §1.1 の 8）と、**根拠が複数の場面にまたがる提案は、作品全体では 1 件**（SRA/1 S2）だけ。何を 1 件と数えるか（提案か、解釈か、版か）・pending の定義・関数の置き場は決まっていない。
- 最初の版の 2 種類は、統合ペインが数える「今の場面の解釈（未確認の提案）」と**重ならない**：C1 は固有名詞の候補、C2 は根拠が古くなった提案（Inbox の 1 行＝1 Consumer）。したがって、**最初の版は、共通にする対象の件数を持たない**。数え方の正本の置き場（TS の純粋な関数 1 つか、Native の集計か）は、**「未確認の提案」を Work Layer に足す版の前に**、23 と相談して決める（23 の見立ては「揃える。置き場は未決」）。W2 の B を選ぶ場合は、その決定が先に要る。
- **Pulse の数字が部分合計のとき**：C1 が `not-counted`（まだ数えていない）か `unavailable` のとき、`total` は、数えた分だけの和である。`complete` が false のあいだ、ヘッダーの数字は**部分であることが分かる形**（例：数字に「＋」を添える。読み上げは「数えた分だけ」）で出す。表示の形と文言は作者に見えるので、P5 の前に別に伺う（W4 は回答済み）。
- 二重数えの注意：C2 の「根拠が古くなった提案」は、後に「未確認の提案」の件数が足されると、**同じ提案が両方に数えられうる**。足す版で、重なりを避ける規則（どちらに数えるか）を決める。Pulse の数字は種類ごとの件数の和で、「作業が残っている量」を表さない。

### 2.5 Revision（提案）の扱い
- 作品全体の提案の一覧・件数を返す読み取りは無い（§1.5 (c)）。23 の RD3 は別の定義。**最初の版には、提案の行を入れない**（W2 A、推奨）。
- 入れる場合（W2 B）の選択肢：(1) 新しい読み取りを足す。**新しい契約**になるので、その時に個別に伺う。23 の RD3 と同じ形（`projectId`・`cursor`・`limit` だけ、`deny_unknown_fields`、project の束縛、読むだけ、AI の道具に足さない）を土台にできる。「未確認」の定義（`unreviewed`か、Chronicle の「未取り込み」か）と数え方の正本が先に要る。(2) 既存の場面単位の読み取りを全場面に回す。N+1 になり採らない。
- M4（変更レビュー）が `ChangeReview.tsx`（試作）と重なりうる（01 の連絡）。最初の版は触らない。M2〜M4 の持ち主と、**提案の読み取りと変更レビューの置き場**を整理する点として残す（§4）。

### 2.6 構造の健全性（`StructureHealthPanel`）の件数を最初の候補に入れるか【W3 とあわせて】
- C2 が、そのまま入る。既存の読み口と集計を再利用でき、新しい IPC は要らない（DR-M3-14 の allow-list は広げない）。**ただし、許可が切れている既定では出ない**（W3 A）。したがって、**既定の作者に見えるのは C1 だけ**になる。
- 「健全性」の画面そのものの Work Layer への移設（m3 草稿 DR-M3-14）は、最初の版に含めない。C2 の行に入口を付けるなら、`StructureHealthPanel` の open state も持ち上げる必要があり（今は `ForeshadowPanel.tsx` が持つ）、最初の版では C2 を**件数だけ**にする。

### 2.7 旗の扱いと、製品 bundle の検証【起案者の技術判断。出す時期は W6】
- **旗を新設**する：`VITE_WORK_LAYER_LIVE`（`src/features/work-layer/workLayerLiveFlag.ts`。`true`／`1` のときだけ開く。**DEV でも既定は閉じる**。review 画面の旗〔未指定の既定は DEV の真偽〕とは違う。理由：Work Layer は ADR 012 の「実装・公開の承認ではない」の面で、通常の開発でも「Work Layer は無い」状態を保つ。`useWorkLayerPreviewPort` のコメントと同じ考え）。fixture（DEV かつ `VITE_WORK_LAYER_FIXTURE`）と live が両方指定されたときは、fixture を優先する（DEV 限定のため）。`useWorkLayerPreviewPort` の DEV 限定は変えない。
- **【2026-11-25 改訂・W12／W13】旗の既定の向き**：旗を開ける PR（P7）で、`VITE_WORK_LAYER_LIVE` と `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW` はどちらも**既定で開き、`"false"`／`"0"` で閉じる**（build 時の定数。DEV でも同じ。fixture が指定された DEV では fixture が優先）。上の「`true`／`1` のときだけ開く」「DEV でも既定は閉じる」は、閉じたまま実装していた P4〜P6 の記述で、P7 で置き換わる。閉じる側の build で live の hook と review 画面の host を build が取り除く形（同じ module の定数）はそのまま。
- **live の port と読み口は、動的 import の中に置く**（旗が false のとき build で届かなくする）。起動時の graph（`perf:budget`）を増やさないため。旗を開ける PR で、初めて製品の chunk に入る。
- **製品 bundle に fixture が入らないことの確認（再現できる手順）**：①`VITE_WORK_LAYER_FIXTURE=true pnpm exec vite build --outDir <scratch> --emptyOutDir`。②出力で、fixture の識別子（`createWorkLayerFixturePort`）と作例の題が 0 件、ファイル名に `workLayerFixture` が無いこと。③live の旗が閉じた build に、live の port の識別子が入らないこと。本日の結果は §1.3。**固定の guard として、P4 で静的な試験を足す**：`workLayerFixture` と live の port が、動的 import を経てのみ参照され、かつ `import.meta.env.DEV`／旗の guard の内側にあることを、source の走査で assert する（build を回さないので速い）。
- 旗を開ける PR（P6）では、**実 Chromium の geometry 試験**（Pulse の有無で header の寸法・位置が変わらないこと）を足す。ロードマップの Project Focus の節も、header の変更に同じ要求をしている（`agent-collaboration-roadmap.md:669-672`。:672「Header／Drawer変更はreal Chromium geometry testを必要とし、closed stateでEditor寸法を変えない」）。

### 2.8 ロードマップの Deferred との関係【W5】
- `agent-collaboration-roadmap.md:80`「Project Focus / WorkBeacon — **Deferred**。まず Session-local status を提供する」、:140「Header WorkBeacon または Project-wide Drawer」は非対象（Release A の Excluded）、:343（A6 の除外：Header WorkBeacon・Project-wide run counter・Task list・Drawer・Workspace review state）。:660-672 の WorkBeacon は、Current・Next・Blocked（Task の状態）を出す Project Focus の話で、`ADR 007:208` も「Global WorkBeacon、Project task tree、progress percentage、Kanban、deadline、Project Focus UI」を並べる。
- **起案者の読み**：これらは agent の run と Task・Focus の表示を指す。**今回の「Attention の件数と入口」は、Task・Focus・run の状態を含まない**ので当たらない。ただし、**ヘッダーの同じ面（Work Pulse）を共有する**ので、header の geometry の要求（§2.7）と、後に Focus・run を足す版との整合は、そちらの版で決める。W5 の A（読みを確認し、ロードマップは変えない）を推奨する。

### 2.9 GDX-PRECHECK-001 の判定
| 観点 | 判定 |
| ---- | ---- |
| 新しい送信先（秘密・データ）、AI への送信 | **なし**。live の model は renderer の表示専用で、chat の文脈・tool・MCP に入れない。将来「この仕事について相談する」（ADR 012）に件数を渡すなら、新しい受け手として別に確認する |
| 保存範囲の拡大 | **なし**。読むだけ。却下キー（`project_settings`）も読むだけ |
| 新しい IPC・契約・authority | **なし**（W2 A の場合）。使うのは既存の `narrative_maintenance_inbox_list`（own-data-read）、policy の get、`extract_codex_candidates`、`project_settings` の読み取りで、いずれも renderer から既に呼ばれている（呼び手：`ForeshadowPanel.tsx:400`、`CodexCandidatesReport.tsx:91`、`StructureHealthPanel.tsx:54`【報告】）。W2 の B・C を選ぶと**新しい契約**になり、その時に個別に伺う |
| security-sensitive な threat model | **該当しない**と読む（新しい actor も攻撃面も無い）。起案者の読みで、ユーザーの確認ではない。hidden（Codex）の項目は、件数の計算で「登録済み」として除外に使われるだけで、画面に出ない。AI にも送らない |
| 外部 egress／subprocess | なし |
| background／async lifecycle | **該当する**（作品の切替・トレイの開閉・走査の再入）。**下の owner／lifecycle の表を、実装の前提にする**（subprocess ではないが、規則の趣旨に沿って置く） |
| `[precheck]` で止まる条件 | **W1〜W7 は回答済み（2026-11-24）**。コードは P2 から始められる（W2 は「足さない」なので、新しい契約は無い）。**P5 の前に、作者に見える文言・表示の形（部分合計の「＋」、行の文言、入口の表示）を別に伺う**。W2 の B・C に変える場合は、新しい契約として改めて確認する |

**owner／lifecycle（live の読み取り。案）**

経路ごとの開始と再入：
| 経路 | 開始する者 | 同じ経路が走っている間の扱い |
| ---- | ---------- | ---------------------------- |
| mount（初回・作品の切替） | Provider の effect（port ごと） | port が変われば、前の port の結果を捨てる。`mount` は安い読み取りだけで、候補を数えない。重なりの扱いは下の `tray-open` の行 |
| tray-open | Provider（トレイを開いたとき）。開閉の連打は single-flight | **同じ port の `load` は、理由ごとに single-flight にする。走っているのが `mount` のとき、`tray-open` は `mount` の完了を待ってから、候補を含む自分の読み取りを走らせる**（`mount` の結果で代用しない。候補の要求は失われない）。走っているのが `tray-open` のときは、`mount` も新しい `tray-open` も、その結果を使う。候補の走査が走っていれば、新しい走査を始めず、その結果を待つ |
| Codex 画面の mount・作品の切替（既存の経路。今は `CodexCandidatesReport` の effect） | 共有 host（P3 で持ち上げた後）。それまでは今のまま | 同じ作品の走査が走っていれば、新しい走査を始めず、その結果を共有する。作品が変われば世代番号を進め、前の結果を捨てる |
| 手動の再スキャン（既存。Codex 画面のボタン） | 共有 host | 世代番号を進め、前の結果を捨てて新しく走査する |

共通の規則（GDX-PRECHECK-001 の項目に沿う）：
| 項目 | 規則 |
| ---- | ---- |
| 受付の打ち切り（admission closure） | 作品の切替・Provider の無効化（`active=false`）・unmount の後は、前の port の結果を受け付けない（`cancelled`）。host は作品ごとに世代番号を持ち、世代が違う結果は捨てる |
| 待ちの開始（pending-start） | 走査が走っている間の新しい要求は、**最新の 1 つだけ**を待たせる（積み上げない）。作品が変われば待ちも捨てる |
| 走っているものの所有者 | policy・Inbox の読み取りは port、候補の走査は共有 host。renderer が持つ handle は promise だけで、subprocess も timer も無い |
| 取消 | 読み取りは途中で止められない（N-API の blocking task。Inbox も同じ）。取消＝結果を捨てること。**止めた証拠は取れないので、「同時に走る走査は 1 つ」「待ちは最新の 1 つ」が破れないことを、試験で固定する** |
| 待ちの上限（bounded wait） | **表示上の待ちには上限を置く**：`not-counted`（数え中）が上限を超えたら、その行を `unavailable`（「数えるのに時間がかかっています」）に切り替える。**走査そのものは止められず続く**ので、世代が合う結果が後から届けば、その行を `ready` に直す。上限の値は P4 の測定の後に決める（【起案者の技術判断】。案：60 秒）。UI の待ちはトレイ・Pulse の開閉とほかの操作を塞がない。**走査を止める main 側の期限は置かない**（新しい契約になる。長すぎる作品が測定で見つかったら、その時に伺う。§4） |
| 終了の証拠 | promise の解決（成功・失敗）。この経路には kill も error event も無く、「止めた」と見なす経路を作らない |
| error・timeout の所有者 | policy・Inbox は port が種類ごとに `unavailable` にする。走査の失敗は host が保持し、Codex 画面と Work Layer に同じ失敗を見せる |
| 永続する再起動の状態 | なし（保存しない。アプリを再起動したら読み直す） |

### 2.10 ADR 014 の D7・D10・守ること 5・8 との整合【起案者の読み。W7 で確認済み。ADR の改訂ではない】
- **D7・D10**（「文脈」「この場面の解釈」の節は、開くまで読み込まない）は、**統合ペイン（サイドペイン）の中身**の規則で、理由は「評価の測定がサイドペインごと mount するため」である。Work Pulse は別の面で、ヘッダーの既存の位置（`EditorWorkspaceHeader.tsx:113`）にあり、D6 が「作品全体の件数と入口」を持たせている。したがって D7・D10 は、Pulse の数字には直接は当たらない。
- ただし趣旨（重い読み取りで起動・本文を遅くしない）は守る：`mount` は保存済みの値を読む安い読み取りだけ（policy・Inbox）。重い走査は `tray-open` まで起こさない（W4 A）。
- **守ること 8**（常に出ている領域を増やさない）：Pulse は header の既存の slot で、新しい領域は足さない。live の旗が開くまで何も出ない。旗を開ける PR で、header の寸法が変わらないことを実 Chromium で確かめる（§2.7）。
- **守ること 5**（提案が届いても、ペインを自動で開かない。通知を出さない。フォーカスを動かさない。変わるのは件数だけ）：live では、到着・解消の読み上げと強調を出さず、トレイを自動で開かず、フォーカスを動かさない（§2.2）。

## 3. PR の分け方（案。docs だけの PR は枠に数えない。コードの PR は 2 本の枠に数える）
依存の向きに沿って、型と共有 host を、それを読む PR より前に置く（独立レビューの指摘）。

| PR | 内容 | この PR の終わりに入っているもの |
| -- | ---- | -------------------------------- |
| P0 | この設計草稿（docs だけ） | 設計。回答を記録して出す |
| P1 | DR-M3-30（`m3-decisions.md`）。判断と信頼境界を記録 | `m3-decisions.md` を触る PR は枠に数える。P2 に同梱してよい |
| P2 | **契約の型と出し分け**：`port.kind`・`scopeKey`・`load(request)`、`provenance`、`WorkLayerLiveEntry` の型と組み合わせの規則、`selectAttentionCount`、Provider の作品切替での model のリセット。**preview の見た目は変えない** | 型と selector は、preview の model（`complete` は常に true）で動く。live のデータはまだ無い |
| P3 | **共有 host**：候補・却下・世代番号・single-flight と、構造抽出の Dialog の持ち上げ。Codex 側の整理で、Work Layer は触らない。**review 画面の旗は閉じたまま** | `CodexCandidatesReport` の振る舞いは同じ。試験は host に移す |
| P4 | **live port（read-only）**：読み口の注入（policy・Inbox・共有 host の C1）、旗 `VITE_WORK_LAYER_LIVE`（閉じる）、静的な bundle guard、owner／lifecycle の試験。**事前に `mount` の安い読み取りを測る** | live の port が作れ、model を返す。画面はまだ preview の部品のまま（旗が閉じているので何も出ない） |
| P5 | **live の行の表示**：Attention の面の種類ごとの行、Pulse の部分表示、`onOpenSurface`（構造抽出の入口）、live で出さない面の制御 | 文言・表示の形は作者に見える（P5 の前に別に伺う） |
| P6 | **旗を開ける PR（Work Layer）**。実 Chromium の geometry 試験。review 画面の旗を開ける PR とは**別**で、実 Electron の確認 A〜F を取り直す | 出す時期は W6 |
| P6（geometry）・P7（旗） | **【2026-11-25 改訂・W12／W13】** geometry の試験（P6）と、旗を開ける変更（P7。2 つの旗の既定を開く）に分けた。review 画面の旗は Work Layer の旗と**同時**に開ける（別の PR にしない）。P7 は、大きい作品での mount の読み取りの測定の後に出す | 出す時期は W12・W13 |

**実装の分担**（ユーザー指示 2026-11-24「UIはclaudeが実装して下さい。Codexはデザインが苦手なので」）：**UI（見た目・レイアウト・文言・表示の形・画面部品。P5 の行と Pulse の部分表示、P2 の `provenance` による印の出し分けの見た目、P6 の geometry と旗を開ける変更）は Claude が実装する**。UI の外（型・port・共有 host・読み口・試験・bundle guard。P2 の型と selector、P3、P4）は、Codex（workspace-write）に委譲してよい。1 つの PR に両方が混ざるときは commit を分ける。各コード PR は、PR の前に別系統・結論を伏せた独立レビューを 1 回入れる（Codex には、UI の見た目の良し悪しは判断材料にしてもらわず、挙動・アクセシビリティ・規則への適合だけを見てもらう）。**header を直す PR（P6。P2 で header に触れるなら P2 も）は、editor の journey が選ばれる**（§1.6）。catalog を触るなら digest を直し、push 前に `verify:quality`（Node 22）と、electron の tsc・eslint を回す。

## 4. 残る制限・未確認・整理する点
- **最初の版は、作者が見ても、判断する材料が少ない**：項目の題も場面も出さず、場面へ飛べない。件数と入口だけである。項目の行と場面への飛びは、読み取りが場面を返す版（W2 B・C）で足す。
- **既定の作者に見えるのは C1 だけ**（W3 A の場合）。C2 は、保守機能の許可を入れる画面ができるまで、実際には出ない。
- **Pulse の数字は種類の和**で、種類によって「作者の判断を待つ量」の意味が違う。部分合計のときは、そのことが分かる形で出す（§2.4）。二重数えの規則は、提案の件数を足す版で決める。
- **走査を止める main 側の期限が無い**：N-API の走査は途中で止められず、長い作品では blocking pool を占める。single-flight で積み上がらないようにし、**表示上の待ちには上限を置く**（§2.9。超えたら `unavailable`、後から結果が届けば直す）が、走査そのものの期限は設けない。測定で長すぎる作品が見つかったら、main 側の期限（新しい契約）を、その時に伺う。
- 【未確認】大きな作品での、Inbox の全行読み取りと候補の走査の時間（§2.1。P4 の前に測る）。
- 【未確認】作品の切替で `WorkLayerProvider` が作り直されるか（§1.1）。port を作品ごとに作り、`scopeKey` で model を空に戻す設計なので、どちらでも動くはずだが、試験で確かめる。
- 【未確認】Pulse が `focus: null`・`system: idle` の model で何を描くか。到着・解消の欄が live で空になるか（§2.2）。
- 【未確認】作品の言語を project の値で判定できるか（§2.1）。
- 【未確認】header の幅・高さが Pulse の有無で変わるか（§1.6。P6 で測る）。
- §2.10 の「D7・D10 は Pulse の数字に直接は当たらない」は、ADR 014 の改訂ではなく読みで、W7 で確認済み（2026-11-24）。
- **M2〜M4 の持ち主と整理する点**：M4 の変更レビューと `ChangeReview.tsx`（Work Layer の試作）の置き場。提案の読み取りの共通化（23 の RD3、W2 B）。
- **23 に知らせる点**：統合ペインの実装を始めるとき（c7 に先に知らせると 23 が回答済み）。数え方の正本の置き場の決定は、「未確認の提案」を Work Layer に足す版の前。
- 32（Mastra）：`mastra:agent-turn-progress`（W2、未 push）は、Work Layer の port・件数・header とは別。agent の run の状態をトレイに出す案は、今は無い（32 の回答）。
- review 画面の旗（構造抽出）を開ける 1 行の PR は、**トレイの入口の見通しが立った後**（contracts 追記 23・24）。この草稿の P3・P5 が入った後に出す。**適用（Codex への取り込み）は SRA/1 の P1 まで閉じたまま**で、この草稿は触らない。

## 5. 実装の後の記録（2026-11-25 追記。§1〜§4 の本文は書いた時点のまま）

**実装した PR**【確認済み：`origin/master` の履歴】：P1・P2 が #1097、P3 が #1101、P4 が #1107、P5 が #1109、件数だけの読み取りが #1110（DR-M3-31）、P6・P7 が #1114（DR-M3-32）。2 つの旗（`VITE_WORK_LAYER_LIVE`・`VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW`）は #1114 から既定で開く。判断と信頼境界の記録は `m3-decisions.md` の DR-M3-30〜32。「根拠が古くなった提案」の読み口は、§2 の Inbox の全行読み取りではなく、件数だけの読み取りに差し替えた（W2 の「新しい読み取りを足さない」を、この読み取りに限って変えた。DR-M3-31）。

### 5.1 §4 の【未確認】のその後

| §4 の項目 | 今 | 根拠 |
| ---- | ---- | ---- |
| 大きな作品での Inbox の全行読み取りの時間 | 【実測】合成の DB で、Consumer 200／2,000／10,000／50,000 件の構築が中央値 約 10／102／511／2,650 ms（件数に比例し、その間は共有の DB 接続を握る）。このためヘッダーは件数だけの読み取りにした（50,000 件で 62 ms） | DR-M3-31 |
| 大きな作品での候補の走査の時間 | 【実測】合成の文章で、300 万字が約 2.4 秒。表示の待ちの上限 60 秒より短い | §5.2 |
| 作品の切替で前の作品の件数が残らないか | 【確認済み】前の scope の model は描画の時点で外し、遅れて届いた読み込みは捨てる | `WorkLayerProvenance.test.tsx`「hides a prior scope immediately and ignores its late load」 |
| `focus: null` の model で何を描くか、到着・解消 | 【確認済み】Pulse は ATTN と SYS だけで FOCUS の欄は出ない。live では到着の読み上げと強調を出さない | `WorkLayerLiveRows.test.tsx`、`WorkLayerLiveMarks.test.tsx` |
| 作品の言語を project の値で判定できるか | 【確認済み】できる（作品の言語の値を `isJapaneseProjectLanguage` で判定する） | `workLayerLiveReaders.ts` |
| header の幅・高さが Pulse の有無で変わるか | 【確認済み】実 Chromium の試験が、変わらないことを固定している | `EditorWorkspaceHeader.workLayerLive.browser.test.tsx` |

### 5.2 候補の走査の実測（2026-11-25）

条件：`grimodex-semantic` の release の試験 binary、`:memory:` の DB、固定の seed で作った架空のカタカナ名 300 語と定型の 5 文型の文章（1 場面 3,000 字）、各 3 回。CPU は Ryzen 5 3600。**実在の作品は読んでいない**（W15 の回答のとおり）。

| 本文の量 | Codex の登録 0 件：中央値（最大） | 登録 300 件：中央値（最大） | DB の読みの中央値（0 件／300 件） |
| ---- | ---- | ---- | ---- |
| 10 万字 | 87（88）ms | 90（91）ms | 0.3／0.6 ms |
| 50 万字 | 396（451）ms | 477（485）ms | 1.4／1.7 ms |
| 100 万字 | 790（791）ms | 926（927）ms | 2.7／3.0 ms |
| 300 万字 | 2,374（2,378）ms | 2,402（2,407）ms | 8.0／8.3 ms |

- 登録 300 件の条件は、本文の架空の名前がすべて登録済みで、候補は 0 件になる。
- 登録の有無の差は規模でそろわず（1〜20%）、理由は調べていない。
- 測っていないもの：アプリ（Electron）経由の時間、ファイルの DB（WAL）、実在の作品の語彙、登録済みと未登録の名前が混じる条件、300 万字を超える作品。
- 【起案者の読み】この範囲では、§4 の「長すぎる作品が見つかったら main 側の期限を伺う」の条件に当たっていない。

### 5.3 残る制限に足すもの

- 【確認済み】トレイを開いたときの走査は、作品を開いている間に多くて 1 回（W4 の回答「数え済みならそれを使う」のとおり。`codexCandidateHostStore.ts` の `requestScan`）。その後に本文へ書き足した名前は、Codex の候補の画面を開く・手動の再スキャン・作品の切替のどれかがあるまで、件数に入らない。Codex への登録と候補の却下は、すぐ件数に反映される。
