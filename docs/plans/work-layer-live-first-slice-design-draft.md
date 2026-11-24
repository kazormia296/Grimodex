# Work Layer（ヘッダーの Work Pulse・Task Tray）に実データの件数と入口を出す最初の版 — 設計草稿（draft）

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `work-layer-live-first-slice/1`（草稿） |
| Status | draft。**`[precheck]`：作者に見える挙動・新しい契約（新しい読み取り・保存）・出す時期は、ユーザーの個別の確認が済むまで確定しない。この草稿は docs だけで、コードは 1 行も書いていない。問い W1〜W6（一枚目）は未回答**。旗は閉じたまま（作者には何も見えない）を前提にする |
| 基点 | worktree `claude-work-layer-design`（枝 `claude/work-layer-live-design`、基点 `origin/master` `373c8d4b5`）。行番号はこの基点のもの |
| 由来 | ADR 014 D6（`docs/adr/014-scene-information-in-editor.md:78-83`）と :136（Consequences「Work Layer を実データにつなぐとき、件数の数え方と、場面へ飛ぶ入口を、統合ペインと共通にする」）。ADR 012（Work Layer の表示。Status は「実装・公開の承認ではない」）。`m3-live-structure-health-design-draft.md` の「Work Layer への移設は、実データへの配線の設計ができてから」 |
| ユーザーの決定 | 2026-11-24：「Work Layer って実装始められますか？」→「**次のセッションで始めましょう**」。範囲は、**件数と入口に絞った最初の版（Task を含めない）を、設計草稿から始める**ことまで。contracts の M3 確認記録の追記 25（`4542ac6ac`）に、「着手の了承であって、範囲の細目は個別に確認していない」と記録済み。**この草稿の「推奨」は起案者の意見で、ユーザーの決定ではない**。M3 の技術判断（作り方・PR の分け方・試験）は、NIR-1 の残レーンと同じ範囲で委任済み（memory `m3-pullforward-decisions-2026-11-23`）。作者に見える挙動・新しい契約・保存・出す時期は、委任の外 |
| 表記 | 【確認済み】は今の worktree で読んだもの。【実測】は今日実行した結果。【報告】は調査 agent（Codex、read-only）の報告で、本文で再読していないもの。【未確認】は確かめていないもの。【起案者の技術判断】は M3 の委任の範囲内で起案者が決めたもの。【起案者の意見】はユーザーの確認が要るもの。調査の報告から引いた行は、主なものを今の内容で読み直した |

用語：**Work Pulse**＝ヘッダー中央の小さな表示（Focus・Attention の件数・System の状態）。**Task Tray**＝Pulse から開く面（Attention／Focus の 2 つの面）。**Attention**＝作者の判断を待つ項目（ADR 012：「観測・判断候補であって、作者が引き受けた Task ではない」）。**port**＝`WorkLayerPort { load() }`（`src/features/work-layer/types.ts:140-142`）。**live／fixture**＝実データの port／見本データの port。**Inbox**＝`narrative_maintenance_inbox_list` が返す「保守が気にしている項目」の一覧。

## 一枚目：何を作るか、作らないもの、伺う問い

**何を作るか（案）**
- ヘッダーの Work Pulse の数字と、Task Tray の Attention の面に、**実データの件数と入口**を出す。項目 1 件ずつの行ではなく、**種類ごとの行（件数＋開く入口）**を出す。
- **読むだけ**（承認・拒否・保留・保存はしない）。**既存の読み取りだけ**を使う（新しい IPC・schema・保存・AI への送信を足さない）。
- 種類の候補は 2 つ。**C1 未登録の固有名詞の候補**（`extract_codex_candidates` の件数。入口は構造抽出のレビュー画面）。**C2 根拠が古くなった提案**（Inbox の件数。作品の保守機能の許可が入っているときだけ。入口は最初の版では付けない）。
- **旗は新設して閉じたまま**。作者には何も見えない。出す時期は別に伺う。

**作らないもの（最初の版の外）**：Task・Focus・作業の捕捉・System の状態・Resolve・まとめて処理・変更レビュー（M4 の `ChangeReview` と重なる。§4）／項目ごとの行（題・場面）と場面へ飛ぶ入口／全作品の未確認の提案の件数／書き込み。

**この草稿が見つけた、設計に効く事実（上位 5 つ）**
1. **製品 build でもヘッダーに何も出ない**のは、port が null だから。Work Layer の UI 部品（`WorkLayerSurface` の chunk、約 89 KB）と見本の印の文字列は**製品 bundle に入る**が、fixture 本体は入らない【実測。§1.3】。
2. **今の Attention の型は、実データから作れない。** 1 行ごとに候補・根拠・前の値・影響・状態の欄を必須にしている（`WorkLayerFindingView`）。今ある読み取りのどれも、題も場面も返さない。だから最初の版は「件数と入口」に絞るのが、**今の読み取りで作れる上限**である。
3. **Inbox の gate は画面だけ。** 「作品の保守機能」の許可は既定で切れ、作者が入れる画面は確認できない。ところが IPC 自体は、許可が切れていても結果を返す【確認済み。§1.5】。Work Layer がこれを読むとき、許可を見るかどうかは、**作者に見える挙動の判断**になる（W3）。
4. **候補の件数は重い走査**（全場面の本文の形態素解析）で、今は Codex 画面の mount・作品の切替・手動の再スキャンでだけ走る。ヘッダーに常駐させて自動で走らせるのは、**測ってから**でないと決められない（W4）。しかも、取得の失敗も非日本語の作品も、今の wrapper は**空配列を返す**ので、「0 件」と「数えられなかった」を区別できない【確認済み。§1.5】。
5. **数え方で決まっているのは「統合ペインと共通にする」と「複数の場面にまたがる提案は作品全体で 1 件」だけ**で、統合ペイン側にはまだ集計のコードがない（23 の確認）。最初の版の 2 種類は、どちらも統合ペインの「今の場面の解釈」と重ならないので、**共通にする対象の件数（未確認の提案）は最初の版に入れない**ことで、正本の置き場の決定を後の版へ送れる（§2.4）。

**伺う問い（作者から見える場面の言葉で。選択肢と推奨。どれも未回答。回答は構造化質問で個別に伺う）**
- **W1 トレイに何を出すか**：A＝種類ごとの行（件数＋開く入口）。ヘッダーの数字はその合計（推奨）／B＝ヘッダーの数字だけ（トレイは開けない）／C＝項目ごとの行（題・場面）。C は、今の読み取りでは出せず、新しい読み取りが要る（W2）。
- **W2 新しい読み取りを足すか**：A＝最初の版は足さない（推奨）／B＝全作品の未確認の提案の件数を読む新しい読み取り（新しい契約。23 の SRD/1 の RD3 は「承認し直せる提案」だけで、別の定義）／C＝Inbox の絞り（3 欄。DR-M3-14）を広げ、題・識別子を renderer に出す。
- **W3 保守機能の許可との関係**：A＝許可が切れているときは、C2「根拠が古くなった提案」の行を出さない（推奨。今の「健全性」ボタンと同じ扱い。既定の作者には、C1 だけが出る）／B＝許可と無関係に、C2 も出す。
- **W4 候補の件数を、いつ数えるか**：A＝トレイを開いたとき、または Codex 画面で数えた結果があればそれを使う。ヘッダーは自動では数えない（推奨）／B＝ヘッダーが出たとき自動で数える（重い走査。作品の大きさで待ちが出うる。測定が要る）／C＝作者が「数える」を押したときだけ。
- **W5 ロードマップの Deferred との整理**：A＝Deferred の「Project Focus／WorkBeacon」と、除外の「Header WorkBeacon」は、Task・Focus・agent の run の表示を指し、**Attention の件数（今回）は別**と読む。ロードマップは変えない（推奨）／B＝この読みをロードマップに追記する（別の PR。枠に数える）／C＝今回も Deferred に当たるので、Release A の後まで待つ。
- **W6 出す時期**：旗は閉じたまま実装し、**作者に出す時期（旗を開ける PR）は、見えるようになった絵を見てから別に伺う**（推奨）。review 画面の旗（構造抽出）を開ける PR とは別の時期になりうる（§3）。

## 1. 現状（確かめた事実）

### 1.1 ヘッダーと Provider
- `<WorkPulse />` は通常のヘッダーの中央（`src/features/editor/EditorWorkspaceHeader.tsx:113`）。Zen・phone では header ごと出ず、panelWindow では WorkPulse のない header になる【報告。`:47-58`】。
- `WorkLayerProvider` は `EditorWorkspaceProviders` が常に置く（`EditorWorkspaceProviders.tsx:14-27`、`EditorWorkspaceShell.tsx:94-105`）。`active` は lifecycleLocked・Zen・phone・panelWindow・screenshot panel のどれでもないときだけ true（`workLayerAvailability.ts:9-22`）。【確認済み】
- **Provider と port は、今の作品（project）を受け取らない。** `load()` に引数はなく、model にあるのは `scopeId` だけ（`types.ts:110-122, 135-142`）。作品の切替で Provider が作り直されるかは**未確認**【報告】。作品の id は `useCurrentProjectId()`（`src/features/project/projectStore.ts:910`）で取れるが、**作品が無いときは代わりの id を返す**ので、live は「作品なし」を別に扱う必要がある。

### 1.2 port と model
- データの口は `load()` の 1 つだけ。実装は fixture だけ（`types.ts:135-139`「The production NIR adapter intentionally does not exist」）。書き込みの口は無い。work-layer の非テスト source に、IPC・store・Tauri／Electron の import は 0 件（handoff の調査）。
- **`load()` を呼ぶのは Provider の effect だけ**で、依存は `active`・`initialModel`・`port`（`WorkLayerContext.tsx` の effect。:52-79）。トレイを開いても再読込しない。**reject すると model が null になり、Pulse もトレイも消える**。loading の表示はなく、model が null の間は何も出ない（`WorkPulse.tsx:18`、`WorkLayerContext.tsx:122-124`）。【確認済み】
- 件数を出す箇所は、Pulse の数字（`WorkPulse.tsx:78-80, 118-120`）、トレイの見出し（`TaskTray.tsx:47-56`）、Attention の面（`AttentionTrayBody.tsx:53-57, 101-117`）、処分済み（`DisposedAccordion.tsx:57-77`）、Focus の面（`FocusTrayBody.tsx:64-81`）、live region（`WorkPulseLiveRegion.tsx:15-29`）。どれも `attention.length` 系を直接読む【報告】。
- Attention の 1 行（`WorkLayerFindingView`、`types.ts:63-84`）は、`kind` が**自由な文字列**で、`"source-missing"` の直書きの分岐が 6 か所にある（`AttentionTrayBody.tsx:40,74,77`、`ResolveLens.tsx:64`、`ResolvedReceipt.tsx:28,37`、`BatchReview.tsx:139`、`ResolveProjection.tsx:154`。handoff の調査）。種類を足す登録口も、外の面を開く action の口も無い（`workLayerContextTypes.ts:4-32`、`workLayerReducer.ts:1-47`）。

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
- 「UI PREVIEW」「NOT SAVED」「PREVIEW ONLY」は、**component の 15 ファイル**の直書き（BatchReview・BatchReviewFooter・ChangeReview・ChangeReviewActions・ContextPortal・CorrectionRulePreview・ProjectionCandidateContext・ResolveLens・ResolveProjection・ResolvedReceipt・SystemActivity・SystemBlocked・SystemRunInspection・TaskDraftComposer・TaskTray）と、**`ja.json`・`en.json` の `workLayer` の名前空間に各 9 行**ある。handoff の「11 部品の直書き」は不完全だった【確認済み。`rg -c`】。
- **live の経路上（Pulse とトレイの Attention の面）に残る印は少ない**：`TaskTray.tsx:50` の枠の「UI PREVIEW」、`WorkPulseLiveRegion.tsx:25` の「（UIプレビュー）」、Focus の面への切替（`AttentionTrayBody.tsx:25, 160` の `switchFocusPreview`）、`TaskTrayFooter` の「作業を捕捉」（disabled）【確認済み／報告】。ほかの 14 ファイル（Resolve・Batch・Change・Task の下書き・System）は、**live で面ごと出さなければ、印の出し分けを要らない**。

### 1.5 実データ側（今ある読み取り）
**(a) Inbox**（C2 の元）
- `narrative_maintenance_inbox_list`（引数は `projectId` だけ。未知の欄は拒否。`ipcContract.ts:1870-1884`）。返すのは作品の現行 Semantic Epoch の保守項目の一覧で、現行 Epoch が無ければ**空配列**（`inbox_read_model.rs:399-417`）。1 行は 1 Consumer（提案の 1 つの版）か保守停止の記録で、`InboxEntry`（:214-224）に**場面の識別子も題もない**。
- 読み取り専用で、保存済みの Freshness を読む（再計算しない）。**件数の上限もページングも無く、作品内の全行を読む**。大きな作品での時間は未測定【報告。`inbox_read_model.rs:148-176, 539-545`】。N-API は `run_blocking` 内で読む（`lib.rs:16322-16340`）。
- renderer の読み口は `narrativeMaintenanceInboxList`（`src/application/narrative-extraction/nativeApi.ts:1194-1201`）で、**3 欄（entryKind・consumerKind・evidenceFreshness）だけを allow-list で残し**、識別子・題は捨てる（DR-M3-14、`m3-decisions.md:26`）。件数の数え方は `structureHealthModel.ts:50-72`（1 行＝1 Consumer。根拠が古い提案・保守停止・未認識に分ける）。今の呼び手は `StructureHealthPanel` だけ。
- **gate**：画面は `maintenancePreviewAllowed === true` かつ `effectiveMode !== "disabled"` のときだけ「健全性」ボタンを出す（`maintenanceFlags.ts:11-18`）。既定は `maintenanceEnabled: false`（`narrativeRuntimePolicy.ts:31-37`）。**IPC の handler は、この許可を見ない**（`ipcContract.ts:11764-11772`、`lib.rs:16322-16340`）。作者が許可を入れる画面は、今の renderer には確認できなかった【報告】。`narrative_maintenance_inbox_list` は own-data-read の一覧に入っている（`electron/main/profileEgress.ts:225`、一覧の範囲は :177-226）。
- attention の set／clear の IPC はあるが、renderer の wrapper は無い。

**(b) 構造抽出の候補**（C1 の元）
- `extractCodexCandidates(projectId)`（`src/features/codex/candidateExtractor.ts:31-43`）は、`extract_codex_candidates` を呼び、**失敗しても、日本語以外の作品でも、空配列を返す**（:35 `supportsNativeCandidateExtraction`、:42 の catch）。0 件と取得失敗を区別できない。
- 作品の全場面の本文を走査し、形態素解析で集計する CPU 負荷のある処理（blocking pool）【報告。`codex_candidates.rs`、`lib.rs:13328-13360`】。今の再実行の契機は、`CodexCandidatesReport` の mount・作品の切替・手動の再スキャン（`CodexCandidatesReport.tsx:81-110`）。**旗が閉じていても走る**（旗は Dialog の mount とボタンだけを守る）。
- 件数は「抽出 − 登録済みの名前・別名 − 却下キー」で、0 件なら report は null（:307）。却下キーは `project_settings` の `codex.candidates.dismissed`（JSON 配列。作品ごと。`codexCandidateDismissals.ts:19-36`）。却下の読込が済む前は空集合なので、件数が一時的に多く見える（:65-67）【報告】。
- 構造抽出のレビュー画面（`CodexStructureExtractDialog`）は、props が `open`・`onOpenChange`・`folderId?`・却下の復元 callback・却下キー、マウントは `CodexCandidatesReport.tsx:309-316` の 1 か所、open の state はそのローカル。旗は `isCodexStructureExtractionReviewEnabled`（`codexStructureExtractionFlag.ts:11-18`）で、**DEV の build では既定で開き、製品 build では閉じている**。Work Layer から開く経路は無い。

**(c) 提案**（W2 の B の元）
- 提案を読む経路は、場面単位（`narrative_extraction_list_scene_proposals`。`ipcContract.ts:11515`）と run 単位（`get_run_review_bundle`）と、NIR-1 の revision 単位だけ。**作品全体の一覧・件数を返す読み取りは無い**【報告。確認できた範囲】。review bundle は AI 抽出の再開にも使われる【報告】。
- 「未確認」は `narrative_proposals.status = unreviewed`（`migrate.rs:2776`）。Chronicle の「未取り込み」件数は別の定義（applicable・未適用で rejected 以外）【報告】。
- docs には「作品全体の一覧を引く読み取り 1 本」が 2 つの文脈である：ADR 014 D10 追補（:157）と、23 の SRD/1 の **RD3 `narrative_extraction_list_redecidable_proposals`（`nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md:222`）。ただし RD3 の対象は「取り込み済みで、本体の却下のままで、出来事が年表にある提案」だけで、未確認の提案ではない**。コードには無い（draft）。

### 1.6 試験・journey
- header の browser 試験（`EditorWorkspaceHeader.browser.test.tsx`）は、fixture の model で Pulse が出る状態だけを描画し、左レールと中央 slot の位置を測る。**Pulse の有無で header の幅・高さが変わるかは assert していない**【報告。「変わるか」は未確認】。幾何の invariant は `src/features/layout/layoutInvariants.browser.test.tsx`。
- fixture に依存する試験：`TraySystemPreview.test.tsx`・`WorkLayerSurfaceHost.test.tsx`・`WorkLayerSpecification.test.tsx`・`disposeWorkLayerFinding.test.ts`・`EditorWorkspaceHeader.browser.test.tsx`・stories【handoff の調査】。`WorkLayer.test.tsx` は自前の model と、mock の port を渡せる。
- journey：`electron/scripts/product-journey-catalog.mjs` の `editor` が `src/features/editor/**` を paths に持つ（5e の確認。:572-575）。**header を直すと editor の journey が選ばれる**。`src/features/work-layer/**` はどの journey の paths にもなく、評価の規則（`evals/impact-map.yaml`・`evals/quality-manifest.yaml`・`policies/quality/`）にも出てこない（5e の確認）。journey の catalog 自体を触るときは `scripts/local-ci-full-workload-allocation.json` の digest も直す。

## 2. 設計（項目 1〜9）

### 2.1 live port：何を・いつ・どう読むか【起案者の技術判断。W4 は意見】
- **形**：`WorkLayerPort` に `kind: "fixture" | "live"` を足し、`load(request)` に理由（`"mount"`／`"tray-open"`）を渡せるようにする。fixture は理由を無視する。live の port は、**作品ごとに作る**（`useWorkLayerLivePort(projectId, active)`。作品の切替で作り直され、Provider の既存の effect〔port が変わると読み直す〕と、古い結果の破棄〔`cancelled`〕がそのまま使える）。作品が無いとき（`useCurrentProjectId` の代わりの id）は、port を作らない。
- **読み口は注入**する。live の port は、`readMaintenancePolicy`（既存の `getNarrativeRuntimePolicy`）、`readMaintenanceInbox`（既存の `narrativeMaintenanceInboxList`。集計は既存の `structureHealthModel` を再利用）、`readCandidateCount`（候補の件数）を引数に取る。これで work-layer の中に IPC・store の import が入らず、試験は fake の読み口で書ける。
- **いつ読むか**：`mount`（ヘッダーが出たとき。作品の切替を含む）では**安い読み取りだけ**（policy と Inbox。保存済みの値を読むだけ）。`tray-open` では、それに加えて候補の件数（W4 A）。**ヘッダーは候補の走査を自動では起こさない**。候補の件数は、Codex 画面の report と **1 つの走査結果を共有**する（作品ごとの single-flight。同時に走る走査は 1 つ、待つのは最新の 1 つだけ）。
- **失敗**：読み口ごとに失敗を受ける。失敗した種類は `status: "unavailable"` の行になり（「数えられませんでした」。件数を 0 としない）、ほかの種類は出す。`load()` 自体は、種類ごとの失敗では reject しない。**再読込（`tray-open`）の失敗では、前の model を残す**（今の「reject で全部消える」を live では使わない）。
- **候補の「0 件」の言い方**：「0 件」は「問題なし」ではない。非日本語の作品は**対象外**、走査の失敗は**取得できず**と、3 つを区別する。そのため、`extractCodexCandidates` の wrapper が失敗を空配列に潰す点を、live 用の読み口では避ける（既存の wrapper を変えず、失敗を返す別の関数を足すか、wrapper の戻りを判別型にするか。実装の PR で決める。既存の呼び手の挙動は変えない）。
- **測定**：Inbox の全行読み取りと候補の走査は、大きな作品での時間が未測定。P3 の前に、既存の大規模 fixture（NIR-1 の capacity 系）で、`mount` の安い読み取りの時間を測る（閾値は設けず値を記録する）。

### 2.2 見本の印と本物の印【起案者の技術判断】
- 出し分けの単位は、文言ごとではなく **port の種類（`kind`）の 1 か所**。Provider が `useWorkLayerProvenance(): "preview" | "live"` を公開する。
- **live では、見本が前提の面を出さない**：Focus の面（`NOW`）・System・Resolve・Batch・Change・Task の下書き・処分済みは、live の model では入口ごと無い（`focus: null`、`system` は idle）。したがって、14 ファイルの印には触らない。live の経路に残る 3 か所（`TaskTray.tsx:50` の枠、`WorkPulseLiveRegion.tsx:25`、`switchFocusPreview` と `TaskTrayFooter`）だけを、`provenance` で出し分ける。**preview の見た目は変えない**。
- 試験：preview の試験が assert する印（`TraySystemPreview.test.tsx:79,91`、`WorkLayer.test.tsx:654`、`ChangeReview.test.tsx:102`）はそのまま通る。live の試験を足す（印が出ないこと）。
- 【未確認】Pulse が `focus: null`・`system: idle` のとき何を描くか。P2 で、live の model を渡した実描画の試験で確かめる。

### 2.3 項目の種類の足し方と、外の画面を開く口【起案者の技術判断】
- **finding の `kind`（自由な文字列）は広げない。** `"source-missing"` の直書き 6 か所と fixture に触らないため。live の種類は、別の閉じた型にする：`WorkLayerLiveEntry { id: "codex-candidates" | "stale-proposals"; status: "ready" | "unavailable" | "not-counted" | "not-applicable"; count: number | null; open?: WorkLayerOpenSurface }`。model には `liveEntries?` を足し、live では `attention: []`。
- **件数は 1 つの selector 経由**にする（`selectAttentionCount(model)`）。今 `attention.length` を直接読む 6 か所（§1.2）を、selector に寄せる。preview では `attention.length`、live では `ready` の行の和。Pulse の数字と、トレイの行の数字が食い違わない単一の出所になる。これは §2.4 の「数え方の置き場」の、Work Layer 側の入口でもある。
- **外の画面を開く口**：`WorkLayerOpenSurface = { surface: "structure-extract-review" }`（最初の版はこの 1 つ）。work-layer は features/codex を import せず、**host（`EditorWorkspaceProviders`）が `onOpenSurface` を Provider に渡す**。host が、surface の名前を実際の画面に結ぶ。
- **構造抽出のレビュー画面を開くために**、Dialog の open state と、候補・却下の所有者を、`CodexCandidatesReport` のローカルから**共有の host に持ち上げる**（調査の案 1：共有 hook に候補・却下をまとめ、Dialog を共通領域に置く）。これは §2.1 の「走査結果の共有」と同じ持ち上げで、report とヘッダーが同じ状態を見る。案 3（callback だけ足す）は、report が未 mount のとき受け手が無いので採らない。影響は `CodexCandidatesReport.tsx`・新しい hook・shell の host・既存の report／却下復元の試験【報告。`CodexCandidatesReport.test.tsx` ほか】。
- **旗が閉じている間（review 画面の旗が製品 build で閉じている間）は、C1 の行に入口を付けない**（件数だけ）。入口が行き先のない button にならないため。

### 2.4 数え方を統合ペインと揃える（ADR 014 :136）
- 統合ペインの集計コードは**まだ無い**（23 の確認。SRA/1 の実装は未着手）。docs で決まっているのは、**共通にする**（D6 :80-81、SRA/1 §1.1 の 8）と、**根拠が複数の場面にまたがる提案は、作品全体では 1 件**（SRA/1 S2）だけ。何を 1 件と数えるか（提案か、解釈か、版か）・pending の定義・関数の置き場は決まっていない。
- 最初の版の 2 種類は、統合ペインが数える「今の場面の解釈（未確認の提案）」と**重ならない**：C1 は固有名詞の候補、C2 は根拠が古くなった提案（Inbox の 1 行＝1 Consumer）。したがって、**最初の版は、共通にする対象の件数を持たない**。数え方の正本の置き場（TS の純粋な関数 1 つか、Native の集計か）は、**「未確認の提案」を Work Layer に足す版の前に**、23 と相談して決める（23 の見立ては「揃える。置き場は未決」）。W2 の B を選ぶ場合は、その決定が先に要る。
- 二重数えの注意：C2 の「根拠が古くなった提案」は、後に「未確認の提案」の件数が足されると、**同じ提案が両方に数えられうる**。足す版で、重なりを避ける規則（どちらに数えるか）を決める。最初の版の Pulse の数字は、種類ごとの件数の和であり、「作業が残っている量」を表さない、と文言で誤解を避ける（文言は作者に見える。W1 の回答の後に起案する）。

### 2.5 Revision（提案）の扱い
- 作品全体の提案の一覧・件数を返す読み取りは無い（§1.5 (c)）。23 の RD3 は別の定義。**最初の版には、提案の行を入れない**（W2 A、推奨）。
- 入れる場合（W2 B）の選択肢：(1) 新しい読み取りを足す。**新しい契約**になるので、その時に個別に伺う。23 の RD3 と同じ形（`projectId`・`cursor`・`limit` だけ、`deny_unknown_fields`、project の束縛、読むだけ、AI の道具に足さない）を土台にできる。「未確認」の定義（`unreviewed`か、Chronicle の「未取り込み」か）と数え方の正本が先に要る。(2) 既存の場面単位の読み取りを全場面に回す。N+1 になり採らない。
- M4（変更レビュー）が `ChangeReview.tsx`（試作）と重なりうる（01 の連絡）。最初の版は触らない。M2〜M4 の持ち主と、**提案の読み取りと変更レビューの置き場**を整理する点として残す（§4）。

### 2.6 構造の健全性（`StructureHealthPanel`）の件数を最初の候補に入れるか【W3 とあわせて】
- C2 が、そのまま入る。既存の読み口と集計を再利用でき、新しい IPC は要らない（DR-M3-14 の allow-list は広げない）。**ただし、許可が切れている既定では出ない**（W3 A）。したがって、**既定の作者に見えるのは C1 だけ**になる。
- 「健全性」の画面そのものの Work Layer への移設（m3 草稿 DR-M3-14）は、最初の版に含めない。C2 の行に入口を付けるなら、`StructureHealthPanel` の open state も持ち上げる必要があり（今は `ForeshadowPanel.tsx` が持つ）、最初の版では C2 を**件数だけ**にする。

### 2.7 旗の扱いと、製品 bundle の検証【起案者の技術判断。出す時期は W6】
- **旗を新設**する：`VITE_WORK_LAYER_LIVE`（`src/features/work-layer/workLayerLiveFlag.ts`。`true`／`1` のときだけ開く。**DEV でも既定は閉じる**。review 画面の旗〔DEV は既定で開く〕とは違う。理由：Work Layer は ADR 012 の「実装・公開の承認ではない」の面で、通常の開発でも「Work Layer は無い」状態を保つ。`useWorkLayerPreviewPort` のコメントと同じ考え）。fixture（DEV かつ `VITE_WORK_LAYER_FIXTURE`）と live が両方指定されたときは、fixture を優先する（DEV 限定のため）。`useWorkLayerPreviewPort` の DEV 限定は変えない。
- **live の port と読み口は、動的 import の中に置く**（旗が false のとき build で届かなくする）。起動時の graph（`perf:budget`）を増やさないため。旗を開ける PR で、初めて製品の chunk に入る。
- **製品 bundle に fixture が入らないことの確認（再現できる手順）**：①`VITE_WORK_LAYER_FIXTURE=true pnpm exec vite build --outDir <scratch> --emptyOutDir`。②出力で、fixture の識別子（`createWorkLayerFixturePort`）と作例の題が 0 件、ファイル名に `workLayerFixture` が無いこと。③live の旗が閉じた build に、live の port の識別子が入らないこと。本日の結果は §1.3。**固定の guard として、P3 で静的な試験を足す**：`workLayerFixture` と live の port が、動的 import を経てのみ参照され、かつ `import.meta.env.DEV`／旗の guard の内側にあることを、source の走査で assert する（build を回さないので速い）。
- 旗を開ける PR（P6）では、**実 Chromium の geometry 試験**（Pulse の有無で header の寸法・位置が変わらないこと）を足す。ロードマップの Project Focus の節も、header の変更に同じ要求をしている（`agent-collaboration-roadmap.md:669-672`。:672「Header／Drawer変更はreal Chromium geometry testを必要とし、closed stateでEditor寸法を変えない」）。

### 2.8 ロードマップの Deferred との関係【W5】
- `agent-collaboration-roadmap.md:80`「Project Focus／WorkBeacon — **Deferred**。まず Session-local status を提供する」、:140「Header WorkBeacon または Project-wide Drawer」は非対象（Release A の Excluded）、:343（A6 の除外：Header WorkBeacon・Project-wide run counter・Task list・Drawer・Workspace review state）。:660-672 の WorkBeacon は、Current・Next・Blocked（Task の状態）を出す Project Focus の話で、`ADR 007:208` も「Global WorkBeacon、Project task tree、progress percentage、Kanban、deadline、Project Focus UI」を並べる。
- **起案者の読み**：これらは agent の run と Task・Focus の表示を指す。**今回の「Attention の件数と入口」は、Task・Focus・run の状態を含まない**ので当たらない。ただし、**ヘッダーの同じ面（Work Pulse）を共有する**ので、header の geometry の要求（§2.7）と、後に Focus・run を足す版との整合は、そちらの版で決める。W5 の A（読みを確認し、ロードマップは変えない）を推奨する。

### 2.9 GDX-PRECHECK-001 の判定
| 観点 | 判定 |
| ---- | ---- |
| 新しい送信先（秘密・データ）、AI への送信 | **なし**。live の model は renderer の表示専用で、chat の文脈・tool・MCP に入れない。将来「この仕事について相談する」（ADR 012）に件数を渡すなら、新しい受け手として別に確認する |
| 保存範囲の拡大 | **なし**。読むだけ。却下キー（`project_settings`）も読むだけ |
| 新しい IPC・契約・authority | **なし**（W2 A の場合）。使うのは既存の `narrative_maintenance_inbox_list`（own-data-read）、policy の get、`extract_codex_candidates`、`project_settings` の読み取り。W2 の B・C を選ぶと**新しい契約**になり、その時に個別に伺う |
| security-sensitive な threat model | **該当しない**と読む（新しい actor も攻撃面も無い）。起案者の読みで、ユーザーの確認ではない。hidden（Codex）の項目は、件数の計算で「登録済み」として除外に使われるだけで、画面に出ない。AI にも送らない |
| 外部 egress／subprocess | なし |
| background／async lifecycle | **該当しうる**（作品の切替・トレイの開閉・走査の再入）。**下の owner／lifecycle 表を、実装の前提にする**（subprocess ではないが、規則の趣旨に沿って置く） |
| `[precheck]` で止まる条件 | W1〜W4・W6 の回答が揃うまで、コードに進まない。W2 の B・C は、さらに新しい契約として個別に確認 |

**owner／lifecycle 表（live の読み取り。案）**
| 経路 | 所有者 | 再入・並行 | 取消・破棄 | 完了の証拠 | 再起動後 |
| ---- | ------ | ---------- | ---------- | ---------- | -------- |
| mount（作品の切替を含む） | Provider の effect（port ごと） | port が変われば前の結果を破棄（`cancelled`）。同じ port の `load` は single-flight | 前の port の結果は捨てる。読み取り自体は止められない（read-only で副作用なし） | `load` の promise の解決（種類ごとの `status`） | 保存しない。再び読む |
| tray-open | 同上（`load("tray-open")`） | 走査中なら新しい走査を始めず待つ。**待つのは最新 1 つ** | 同上 | 同上 | 同上 |
| 候補の走査 | 共有の host（作品ごとの single-flight） | 同時に走るのは 1 つ。作品が変われば結果を捨てる | N-API の走査は途中で止められない。結果を捨てるだけ。**止めたことの証拠は要らない（read-only）が、走査が積み重ならないこと**を試験で固定する | 走査の promise の解決（成功・失敗を区別） | 保存しない |

## 3. PR の分け方（案。docs だけの PR は枠に数えない。コードの PR は 2 本の枠に数える）
| PR | 内容 | 備考 |
| -- | ---- | ---- |
| P0 | この設計草稿（docs だけ） | 回答を記録して出す |
| P1 | DR-M3-30（`m3-decisions.md`）。判断と信頼境界を記録 | `m3-decisions.md` を触る PR は枠に数える。P2 に同梱してよい |
| P2 | live／preview の出し分け（`provenance`）と、件数の selector。**見た目は変えない** | header は直さない。work-layer の試験と、live の model を渡す描画の試験 |
| P3 | live port（read-only）、読み口の注入、旗 `VITE_WORK_LAYER_LIVE`（閉じる）、静的な bundle guard。**事前に `mount` の安い読み取りを測る** | header の既存の配線は、port が null の間は変わらない |
| P4 | live の行の型と、Attention の面の「種類ごとの行」 | 文言は作者に見える（W1 の後に起案） |
| P5 | 構造抽出の入口：Dialog と候補・却下の持ち上げ（共有 host）、`onOpenSurface` | `CodexCandidatesReport` の試験を移す。**review 画面の旗は閉じたまま** |
| P6 | 旗を開ける PR（Work Layer）。実 Chromium の geometry 試験。review 画面の旗を開ける PR とは**別**で、実 Electron の確認 A〜F を取り直す | 出す時期は W6 |

各コード PR は、実装を Codex（workspace-write）に委譲し、PR の前に別系統・結論を伏せた独立レビューを 1 回入れる。**header を直す PR（P6、必要なら P2）は、editor の journey が選ばれる**（§1.6）。catalog を触るなら digest を直し、push 前に `verify:quality`（Node 22）と、electron の tsc・eslint を回す。

## 4. 残る制限・未確認・整理する点
- **最初の版は、作者が見ても、判断する材料が少ない**：項目の題も場面も出さず、場面へ飛べない。件数と入口だけである。項目の行と場面への飛びは、読み取りが場面を返す版（W2 B・C）で足す。
- **既定の作者に見えるのは C1 だけ**（W3 A の場合）。C2 は、保守機能の許可を入れる画面ができるまで、実際には出ない。
- **Pulse の数字は、種類の和**で、種類によって「作者の判断を待つ量」の意味が違う。二重数えの規則は、提案の件数を足す版で決める（§2.4）。
- 【未確認】大きな作品での、Inbox の全行読み取りと候補の走査の時間（§2.1。P3 の前に測る）。
- 【未確認】作品の切替で `WorkLayerProvider` が作り直されるか（§1.1）。port を作品ごとに作る設計なので、どちらでも動くはずだが、試験で確かめる。
- 【未確認】Pulse が `focus: null`・`system: idle` の model で何を描くか（§2.2）。
- 【未確認】header の幅・高さが Pulse の有無で変わるか（§1.6。P6 で測る）。
- **M2〜M4 の持ち主と整理する点**：M4 の変更レビューと `ChangeReview.tsx`（Work Layer の試作）の置き場。提案の読み取りの共通化（23 の RD3、W2 B）。
- **23 に知らせる点**：統合ペインの実装を始めるとき（c7 に先に知らせると 23 が回答済み）。数え方の正本の置き場の決定は、「未確認の提案」を Work Layer に足す版の前。
- 32（Mastra）：`mastra:agent-turn-progress`（W2、未 push）は、Work Layer の port・件数・header とは別。agent の run の状態をトレイに出す案は、今は無い（32 の回答）。
- review 画面の旗（構造抽出）を開ける 1 行の PR は、**トレイの入口の見通しが立った後**（contracts 追記 23・24）。この草稿の P5 が入った後に出す。**適用（Codex への取り込み）は SRA/1 の P1 まで閉じたまま**で、この草稿は触らない。
