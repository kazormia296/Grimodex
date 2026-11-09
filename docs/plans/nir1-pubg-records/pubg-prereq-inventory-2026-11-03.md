> 注（integrator、2026-11-03）：read-only の subagent（Opus）が作った下書き。integrator が実物で確かめたのは次だけ：済みとされた PR #720・#721・#724・#726・#728・#730・#733 が MERGED、`PRODUCT_GRAPH_PUBLISHED=false` と const assert、renderer の 4 定数が `false as const`、S7 の README に品質（nDCG・macro・Evidence・p95）の語が無いこと、Gold の受領書 G-01_v1 の verdict が `recorded` であること。ほかの行は未検証の下書きとして読む。公開・有効化の判断はしない。

# PUB-G（Graph arm の製品公開）前提の棚卸し（下書き・読むだけの調査）

- 作成: 2026-11-03。読んだ版: master `cbf3307739db9310e2e1d65d947a811591fd77f2`（#779）、contracts `a22080bd`（＋ `origin/claude/nir1-contracts` の `94b6e04e`／`6d8b370a`／`665a30f3`）、PR #780 head `ce84b9b8`（OPEN）。すべて `git show <rev>:<path>` と `gh pr view`（読むだけ）で確認した。root checkout の作業ツリーは読んでいない。
- この文書は公開・有効化の判断をしない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 略記: 「続行計画」＝`docs/plans/nir1-continuation-2026-10.md`、「l6-l9」＝`docs/plans/nir1-l6-l9-execution-plan.md`（確認台帳と残 HOLD 表を含む）、「post-B」＝`docs/plans/nir1-post-b-execution-plan.md`、「LD/」＝`docs/plans/nir1-lane-decisions/`、「K3/3」＝`docs/plans/nir1-d2a-activation-proposal-3-draft.md`、「S7」＝`a22080bd:docs/plans/nir1-cp4-records/s7-report-s5r6/README.md`。行番号はすべて `cbf33077`（S7 などの contracts は `a22080bd`）の行番号。

## 0. PUB-G の条件の正本（文書による表現）

- 続行計画:177（レーン表）: 「Session C-1 の承認後。K3/3 の G-pub が通ってから。K3/3 の確認は PUB-G と開示の文言を承認しない」。状態欄は「現状（2026-10-25）」のまま。
- 続行計画:592（Session B3 の lane snapshot）／l6-l9:605: 「Session C-1 の承認、CP-4、CP-2b、DA-2、A3＋B＋C＋D2a、G-pub（3 OS の packaged smoke で Negative (34)）」。
- l6-l9:830 付近（「実装順序と公開条件」）と post-B:73: Graph の製品公開条件は **A3 ＋ B（B-close を含む受入れ）＋ C（C-query／C-product を含む受入れ）＋ D2a**。「既存 AND 条件は変更しない」。
- post-B:219-225（§7.3）: C-product は「品質・可用性・性能を同時に満たすこと」。G-01 の事前指定改善、macro 非回帰、Evidence 妥当性 100%、禁止寄与 0、P（固定 B=54.2 ms、D=10.84 ms、上限 65.04 ms）。

## 1. 前提の表

状態の数: **済み 18 ／ 残り 21 ／ 不明 7**（計 46 行。2026-11-09 に #23・#24・#31・#34 を済みへ更新：PR #833・#837・#839 の merge による。#32 は試験を追加したが置き場所が未解決のため残りのまま）。

### 1.1 ゲートと公開条件の大枠

| # | 前提の項目 | 出典 | 状態 | 根拠（実物で確かめた事実） | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 1 | Native の公開 gate が閉じていること（PUB-G で開ける対象） | `electron/native/grimodex-node/src/nir1_graph_product.rs:64-65`、:568 | 済み（閉の確認） | `const PRODUCT_GRAPH_PUBLISHED: bool = false;` と `const _: () = assert!(!PRODUCT_GRAPH_PUBLISHED);`。`publication_open()` は「定数→eval feature の flag→cfg(test)→false」。`scripts/quality/nir1-graph-eval/native-architecture.mjs:430-439` が false を強制 | PUB-G の PR で true にする（Session C-1 の承認の後）。architecture 検査の期待も同時に変える必要（推測） |
| 2 | renderer の定数がすべて閉 | `src/features/related-scenes/nir1GraphAvailability.ts:13`、`src/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationAvailability.ts:13`、`src/features/profile-egress/profileActivationAvailability.ts:23`、`src/features/chat/nir1/nir1LocalGenerationAvailability.ts:19` | 済み（閉の確認） | 4 つとも `false as const`。最後の 1 つは PUB-L の対象で PUB-G では開けない | PUB-G は `NIR1_GRAPH_UI_ENABLED`・`BODY_DECLARATION_UI_ENABLED`・Native gate を**同じ承認で**変える（LD/cp3b-decisions.md:159、LD/cb3-decisions.md:133）。`PROFILE_ACTIVATION_UI_ENABLED` は C-1 で承認（LD/da2-decisions.md:104 は「PUB-G と C-1 の承認の単位が違う」と書く） |
| 3 | `PrePublicationEntry` の 3 入口が閉 | `electron/native/grimodex-node/src/main_grant.rs:166-178` | 済み（閉の確認） | `SceneBodyDeclaration`（K2/4）、`ProfileActivation`（K3/2。コメント「PUB-G and Session C-1 do」）、`LocalGeneration`（PUB-L）。製品の起動で開く経路は無いとコメントに明記 | PUB-G で前 2 つを開ける配線（Session C-1 の承認の後）。`LocalGeneration` は開けない |
| 4 | D2a（公開条件の 1 項）の実装 | 続行計画:163、:10（#690 DA-1 開放、#702 DA-2a、#706 DA-2b） | 済み（実装） | 続行計画:10 に #690（`own-data-read` の開放）、#702、#706 の merge の記録。UI と開示は Session C-1 の別承認（l6-l9:47） | — （UI と開示文言は §2 の C-1） |
| 5 | B（独立 Graph Index）の製品経路：production registry への登録、policy の行、wake 源と再構築の頻度、refusal の UX | LD/broute-decisions.md:425-430、:37、:184 | 残り | 「PUB-G で決めること」として 5 点を列挙。B-ROUTE の route は「gated、PUB-G までは production route の集合に入れない」 | integrator の技術判断（U3 委任の範囲と推測）＋実装。新しい policy 行は integrator の担当（broute:45） |
| 6 | A3 consumer activation の証跡（全 Scope 軸の positive／negative／unavailable、非開示 bridge の禁止、再検証、fallback） | l6-l9:48 | 不明 | l6-l9:48 は「HOLD。開始条件は確認台帳の Session B2 の lane snapshot」のまま更新が無い。CP-4 の S6 の trace 再計算に `ii-a3-ineligible-at-start: 0`（`a22080bd:.../s6-aggregation-s5r6/trace-k64-recompute.json:55`）はあるが、A3 の受入れとしての記録は読んだ範囲に無い | integrator が CP-4 の記録で充足とみなすかの判断と、残 HOLD 表の更新（文書） |
| 7 | C-resource の受入れ（C-query） | l6-l9:36-41 | 不明（CR-REC／CR-2 は済み。G-2 の HOLD が未解決） | CR-REC（2026-10-13）と CR-2（2026-10-14）で解除。CQ-LIM-1〜4 は #678（続行計画:592）。ただし l6-l9:40 の G-2（製品形の Revision が 2,097,152 B に届かない）は「HOLD（[precheck]）」と書かれたまま | G-2 が PUB-G を止めるかの整理（integrator。閾値に触れるならユーザーの確認） → 不明として §3 にも記載 |

### 1.2 CP-4（Graph arm の評価）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 8 | CP-4 の正式な測定（可用性）が事前登録の規則で HOLD に当たらないこと | S7 §1、`a22080bd:.../s6-aggregation-s5r6/README.md` §3 | 済み | S4b'''' `3734e501`・候補 `cbf33077`、run 8 件 attempt 1。Gold の pool の欠落 0/270（許容 2）、編集 trace の失効 0/201・欠落 1/201（許容 2）、閲覧 0、SP-P4 passed、N2〜N4 measured。「物差しを超える指標は無く HOLD の条件に当たらない」 | — |
| 9 | CP-4 の結果の確定（ユーザー） | `origin/claude/nir1-contracts` `94b6e04e`（`user-confirmation-2026-11-03-s7-ok-handoff-p3.md`） | 残り（形式） | ユーザーの返答は「OKです。…P3も直してください。」の**自由記述**。integrator は「AskUserQuestion の選択ではないので確定の根拠として強く書かない」「製品の公開・PUB-G の承認ではない」と記録 | 確定として扱うなら、C-1 の束でユーザーの明示の確認を取る（ユーザーの承認） |
| 10 | DR-CP4-S6-3 の master への記録 | PR #780（OPEN、head `ce84b9b8`。差分は続行計画 +1 行と LD/cp4-decisions.md +24 行） | 残り | `gh pr view 780`: state OPEN。DR-CP4-S4-8 の追記 6（P3 の扱い）と DR-CP4-S6-3 を足す docs だけの PR | integrator の push 済み PR の merge（文書） |
| 11 | CP-4 の品質の条件（G-01 の事前指定改善、macro 非回帰、Evidence 100%、禁止寄与 0）と P（Hybrid p95 ≤ 65.04 ms） | K6/2 `docs/plans/nir1-final-request-eval-proposal-2-draft.md:620`、K6/4 `...-4-draft.md:171`、post-B:219-225、l6-l9:670 | 不明 | S6／S7 は可用性の集計だけを述べる。Gold の受領書（`gold-s5r6-1/G-01_v1.receipt.json`）の `verdict` は `{"outcome":"recorded"}`、aggregates は `steadyStateCase`・`invalid`・`requeryCount`・`candidateRegime` だけで、nDCG・macro・Evidence・禁止寄与・p95 の欄は見つからなかった。S6 の行の `qualityHold: true` は `scripts/quality/nir1-graph-eval/availability.mjs:296` の `inPool && inWindow === 0`（K6/2 の窓の flag）で、品質の判定ではない | integrator が品質と P の判定の所在（別の記録か未測定か）を示す。未測定なら測定（測定）。閾値は変えない |
| 12 | CP-4 の開示（S7 の 5 の 12 点、DR-CP4-S4-8 (8) の 5 点、X1/3 (e)-1） | S7 §5、LD/cp4-decisions.md:875（DR-CP4-S4-8 (8)）、l6-l9:646 | 残り | S7 §3 の 3 は「(a) 最終関門の P3 を次の S2 改版まで直さないこと、(b) 1 回の測定の結果をどこまで頼るか」をユーザーの判断とする。l6-l9:646 は見通しを「新しい候補の実測で置き換えて Session C-1（PUB-G）に示す」と書く | Session C-1 での開示文の承認（ユーザーの承認） |
| 13 | IR の edge を持つ Scene を編集する trace の新しい事前登録（(a)-1b の製品への効果の証拠） | l6-l9:646、:223（X1/3 が許さないもの） | 残り（判断） | 「その事前登録は X1/3 の範囲の外で、要るか、いつ作るかは integrator とユーザーが決める」。凍結した G-02 の編集 trace は IR の edge を持たない | integrator とユーザーの判断。作るなら事前登録と測定 |
| 14 | 最終関門の P3（S2 の文面）を次の S2 改版で直すこと | PR #780 の DR-CP4-S4-8 追記 6（P3-1〜P3-7）、S7 §5-9 | 残り（判断） | S2・v3・作者の宣言は S4b'''' の freeze record に sha256 で束縛され、直すと 6 回目の凍結と再測定になる。P3-6（iron-laws の S4 の `--merge` 例外）は別の依頼が要る | PUB-G の前に S2 改版が要るか、ユーザーの判断（要るなら S4 の再凍結＋再測定） |
| 15 | CP-4 の候補（`cbf33077`）と PUB-G の最終候補の差の扱い | S7 §2、`665a30f3`（JA sparse の着手） | 不明 | JA の sparse の実装（lane A。`fetchNir1RelatedScenes.ts` などを触る）が並行で始まった。G-pub には「最終候補で採り直す」規則があるが、CP-4 の結果を別の候補へ持ち越す規則は読んだ範囲に無い | integrator が持ち越しの条件を決める（判断）。Related Scenes の経路を変える変更が入れば再測定の要否（測定） |
| 16 | CP-3a の申し送り：製品ではほぼ常に graph-late、lease 越しの end-to-end は未実施 | 続行計画:176（CP-4 行）、LD/cp3a-decisions.md:69（DR-CP3A-55） | 不明 | DR-CP3A-55 は lease 越しの end-to-end（Graph-only の click から `nir1_evidence_qualify`）を PUB-G の前提条件にした。CP-4 の run がこの click の経路を通したかは読んだ範囲で確認できない | integrator が CP-4 の記録で充足かを示す。未実施なら実機での確認（測定） |

### 1.3 CP-2b と G-pub

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 17 | CP-2b P1：worker の同梱と Main の path の配線 | PR #721（MERGED 2026-10-25、`0f63fc03`） | 済み | `gh pr view 721`: MERGED。続行計画:175 も同じ | — |
| 18 | CP-2b P2：3 OS の packaged smoke の harness と workflow | PR #728（MERGED、`10f7db66`） | 済み | `gh pr view 728`: MERGED | — |
| 19 | CP-2b P3（H1）：更新経路の定期 CI | PR #726（MERGED、`6a8907d9`） | 済み | `gh pr view 726`: MERGED。条件ではない（続行計画:175） | — |
| 20 | G-pub の記録（CP-2b 時点） | PR #730（MERGED、`dedd0ecd`）、`LD/cp2b-g-pub/README.md` | 済み（CP-2b 時点） | run 40256736959、候補 `10f7db66`、3 OS とも (34) pass（Linux 118/0、macOS 118/0、Windows 120/0） | — |
| 21 | G-pub を PUB-G の最終候補で採り直すこと（B 案＝署名・公証済みの配布物） | `LD/cp2b-g-pub/README.md` 冒頭「PUB-G の最終候補では採り直す」、LD/cp2b-decisions.md:227 | 残り | 記録は head `10f7db66` に束縛（GDX-TRACE-001）。最終候補の head が違えば証跡にならない | integrator が最終候補で `packaged-smoke.yml` を dispatch（測定）。B 案の配布物の作成手順は TASK §2.3（読んでいない） |
| 22 | audit 例外の解消（CP-2b を単独で進める条件） | 続行計画:175（2026-10-26 追記）、:10（#760） | 済み | pnpm の GHSA-ch52 は #708、cargo の zip は #719、ProduceSkia の CI 例外は #760 で削除 | — |
| 23 | worker の path の TOCTOU（spawn の直前の再検証） | LD/cp2b-decisions.md:110（P3-2）、DR-CP2B-TOCTOU-1／-2（PR #839、MERGED 2026-11-08、`1aa40216`） | 済み（実装。2026-11-09 に master の記録で更新） | spawn の直前（唯一の `Command::new` の前）に、constructor と同じ強さの `metadata().is_file()` だけを再検証する（symlink の拒否・実行権限・hash は採らない）。失敗は `NIR1_GRAPH_WORKER_PATH`→`WorkerStartup`→`worker-unavailable`、既存の spawn 失敗と同じ Count（連続 5 回で Suspended）で、quarantine にも `restart-required` にもしない。**security の境界ではなく、失敗の分類の精度と無駄な spawn の回避**と明記。**受け入れた残り**：再検証と exec の間の差し替え（閉じるには fd 固定の exec か実行体の hash の照合が要り、新しい authority／契約で委任外）。read-only advisor は呼べず、#839 の独立レビューを advisor 相当として cp2b-decisions.md に記録 | — |
| 24 | owner の Suspended の復帰の配線 | `nir1_graph_product.rs:14`、続行計画:797、CP2a-D47〜D49（PR #839、MERGED 2026-11-08、`1aa40216`） | 済み（実装。到達の確認は残り。2026-11-09 に更新） | maintenance cycle の `work_completed` closure から `note_maintenance_work_completed(item)` を呼び、run kind が `Nir1GraphIndexBuild` のときだけ既存の `resume_after_graph_index_change()` を呼ぶ（attempt の記録より前。D47）。D48：hook が slot の lock の中で `graph_index_change` を進め、prepare の最中の publish を `SessionGuard::drop` が同じ lock の中で比べて取りこぼしを無くす。D49：復帰の後の ledger は 0 でなく `failures_before_suspend - 1`（復帰の後は 1 回だけ試す。CP2a-D8 の意味は「最初は 5 回、復帰の後は 1 回」）。hook は project を見ない（どの project の publish でも解ける。今は受け入れ）。D48 の「取りこぼし無し」は Suspended に入る失敗の prepare の最中だけ（失敗が 1〜4 回のときの publish は ledger を戻さない。記録のみ）。process worker の start は gated のまま（`PRODUCT_GRAPH_PUBLISHED = false`） | PUB-G の前の journey で、B の publish の後に Suspended が解けること、複数 project の publish が Suspended を繰り返し解かないことを見る（#839 の未決） |

### 1.4 DA-2a／DA-2b（D2a の UI）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 25 | DA-2b 必須 1：場面の会話でない会話の編集して再送を閉じる | `LD/da2b-renderer-decisions.md:13`、PR #720（MERGED、`c87bd446`） | 済み | `gh pr view 720`: MERGED 2026-10-25 | — |
| 26 | DA-2b 必須 2：W-1 の完了後の自動再試行 | 同:14 | 済み | 「解消済み（2026-10-25、`a4461425`）」 | — |
| 27 | DA-2b 必須 3・4：AI の入口の閉鎖の拡大、送信の閉鎖の 3 状態 | 同:15-16、PR #724（MERGED、`8e93bb31`） | 済み | `gh pr view 724`: MERGED | — |
| 28 | DA-2b 必須 5：route が capture の外なら場面の会話でも閉じる | 同:17、PR #733（MERGED、`58023306`） | 済み | `gh pr view 733`: MERGED。ユーザーの決定は案 (a)（2026-10-26 12:56 JST） | — |
| 29 | K3/2 の文面（`:28`、`:177`「編集して再送は場面の会話でだけ使える」）の改め | `LD/da2b-renderer-decisions.md:17` | 残り | 「K3/2 の文面の改めは Session C-1 の束で確かめる（PR-C は draft を編集しない）」 | Session C-1 での確認（ユーザーの承認） |
| 30 | 定数 true のときの起動時 JS の予算 | `LD/da2b-renderer-decisions.md:164`（DR-DA2B-R25）、続行計画:797、`scripts/check-performance-budgets.mjs:17-31` | 不明 | R25 時点は定数 true で上限を超えていた（§4 の食い違い参照）。現行の script の `absoluteMax.rawBytes` は 4,261,300 に上がっているが、その間に overlay で約 +12,715 増えた（同:26-28）。定数 true の build は `cbf33077` で測っていない（LD/da2-decisions.md:308 も「PUB-G の PR で測る」） | 定数 true の `pnpm build` での再測定（測定）。超えるなら緩和の判断（memory の方針では lazy 化が先、残りは最小限の緩和を独立 commit で） |
| 31 | 状態の表示の error boundary（R3-7） | LD/da2-decisions.md:116、:367、DR-DA2-62／-64（PR #837、MERGED 2026-11-08、`8b40480d`） | 済み（実装。2026-11-09 に更新） | `ProfileEgressStatusSlot.tsx` に class の `ProfileEgressStatusBoundary` を `Suspense` の外側（lazy chunk の外）に置き、例外と chunk の読込失敗（旧 `import().catch` は廃止）は何も描かず `debugLog.error` に残す。閉鎖は boundary から呼ばない（表示は UI 側だけ。防御は Main の gate と Native）。DR-DA2-64（レビュー指摘）：表示の render の例外で閉鎖の effect が commit されない欠落を、Indicator を hooks だけにして描画を内側の boundary の下の `ProfileEgressStatusView` に分け、閉鎖の effect を他の effect より先に宣言して直した。chunk の読込・評価の失敗では閉鎖が立たないのは変更前と同じ（退行ではない）。定数 `PROFILE_ACTIVATION_UI_ENABLED` は false のまま | — |
| 32 | 左下の表示と LayoutShell の操作要素の重なりの browser invariant（R3-8） | LD/da2-decisions.md:116、:367、DR-DA2-63（PR #837、MERGED 2026-11-08、`8b40480d`） | 残り（試験は追加済み。置き場所と phone 幅が未解決。2026-11-09 に更新） | `layoutInvariants.browser.test.tsx` に、実 `LayoutShell` と実 `ProfileEgressStatusIndicator` を同じ画面に置き、3 layout × 3 viewport（1200x800、768x600、360x640）で操作要素との重なり・ヒットを測る invariant を追加。元の位置では 9 件が全部落ち、位置を stripe と gap の外（左 62 px、下 61 px）へ移して直した。**開示・未解決**：(1) 実 `EditorPaneStatusBar` を置く probe で、1200x800 の既定の layout でも restricted の pill が editor の scene の状態の button を覆うことを実測で確認（`it.fails` で記録。位置は直していない。左下の panel の中身も覆う見込み＝幾何の推定）。(2) phone 幅（720 未満）の `phone-workspace-chrome__nav` との交わりは**未測定**（360x640 の case は製品で到達しない layout。幾何からの推定）。置き場所の最終判断は C-1／PUB-G（DR-DA2-31）で、定数を on にする前に扱う | C-1／PUB-G での置き場所の決定（scene の状態の button と左下の panel の中身を覆わない位置）、phone workspace の nav との交わりの測定（実装と試験） |
| 33 | 読めない状態ファイルのとき `dialog.showErrorBox` が Native の文をそのまま出す | 続行計画:796 の (5)、`electron/main/backend.ts:253-256` | 残り（実装） | `dialog.showErrorBox("Grimodex バックエンドの読み込みに失敗しました", \`${message}\n\n…\`)` で Native の message をそのまま表示。続行計画は「PUB-G の前に扱う」 | 実装 |
| 34 | renderer の呼出しを実 router に通した試験が無い typed writer（CW4、baseline の CAS、snapshot、chat を含む import） | 続行計画:796 の (6)、DR-PUBG-34-1（PR #833、MERGED 2026-11-08、`3631ffa4`） | 済み（試験。未検証の開示が残る。2026-11-09 に更新） | `electron/main/pubgRendererWriters.pipeline.spec.ts`（製品のコードと seam は変えない）。renderer の呼出しを Main の `grim:invoke` の handler に繋ぎ、実 router・実 gate・実 Native に unrestricted（対照）→ restricted の順で通す。CW 4（`deleteMessage`／`deleteMessages`）、baseline の CAS（read と write の間の競合で `updated:false`→再読取→再試行、両方の更新が残る）、snapshot の作成・削除、chat を含む import（chapters は通り、chat は `D2A_EGRESS_DENIED` で `notImported: 3`・行 0）。変異 4 件で該当の試験が落ちる | 未検証として Session C-1 で開示：`saveBaseline` の generic な INSERT／UPDATE の restricted での拒否（製品が baseline を書くのは unrestricted の間だけという前提は UI 層の `useAiGate` の閉鎖に依る。`runImpactReview` 自体は restricted を見ない）、実 Electron の UI、restricted の `importTree` の他の入口、snapshot の restore |
| 35 | phone の幅での段 2 の合成の終端の toast（生の marker） | LD/da2-decisions.md:112 | 残り（判断） | 「直すなら PUB-G の前に置き場所を決める」（lazy chunk にするか、起動時の graph に置くか） | integrator の判断（予算に影響） |

### 1.5 CP-3b／CB-3（Graph と宣言の UI）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 36 | quarantine の下の未保存の編集への手当て（toast の誤りと `exit(1)` での喪失。D7 (B) か同等）**必須** | LD/cp3b-decisions.md:161（引継ぎ 1） | 残り（実装） | 「Native と Core の変更を要するので CP-3b の範囲外」「PUB-G の必須の前提条件」。master の log（2026-10-24 以後）と grep で対処の commit を見つけられなかった | 実装（Native と Core。integrator の監督） |
| 37 | 段階的に見える表示の手当て（lazy chunk の先読み）**必須** | LD/cp3b-decisions.md:162（引継ぎ 2） | 残り（実装） | 「定数が true のとき…fallback の R/R+IR の行から Graph の行へ一度切り替わる」。対処の記録は見つからない | 実装と実機での体感の確認 |
| 38 | `restart-required` の文言を IR の到着に依らずに出す経路 | LD/cp3b-decisions.md:168（引継ぎ 8） | 残り（判断） | 「PUB-G で文言を必須の案内にするなら…経路を決める」 | integrator の判断と、必要なら実装 |
| 39 | 宣言の UI の再読取で 5 軸の確認が消える（DR-CB3-34 (1)）と初期描画（DR-CB3-31 (2)） | LD/cb3-decisions.md:148-149 | 残り（実装） | 「定数を true にする PR の前提条件とする」 | 実装 |
| 40 | 宣言の section の lazy chunk の失敗時の表示と error boundary、起動時 graph の再測定（DR-CB3-35） | LD/cb3-decisions.md:150 | 残り（判断＋実装） | 「現状は `Suspense` だけで error boundary が無く」「起動時の graph の残りは raw 920 しかない」 | 判断と実装、予算の再測定（#30 と合わせる） |
| 41 | 宣言の UI の再確認（en の UI でも確認ダイアログは日本語、form の一瞬の消失、ダイアログ中の直列待ち） | LD/cb3-decisions.md:133 | 残り（確認） | 「PUB-G の lane は…その前に次を再確認する」 | integrator の実機での再確認。日本語固定のダイアログは C-1 で扱うか判断 |

### 1.6 その他の開示の材料と承認

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 42 | K3/3 の開示 7 の (a)（Y-1 の結果。i〜v） | K3/3:314、l6-l9:605 | 残り | 「文言は C-1 で承認を得る。この /3 の確認は、開示の文言と activation の UI の公開を承認しない」。macOS の `.local` unverified と 127.0.0.2 の canary 不可（`LD/cp2b-g-pub/README.md`「注意」）もここに入る | Session C-1 での文言の承認 |
| 43 | `shell.openExternal` に渡る経路（乗っ取られた renderer が unrestricted で OS の browser を開ける）を開示するか | LD/cp2b-decisions.md:224 | 残り（判断） | 「PUB-G の開示（C-1）で扱うかを integrator が決める」 | integrator の判断 → C-1 |
| 44 | 送信の遅れ（最大 W = 4 s）の開示、NC-LISTENER-LOST の限定の書き方 | LD/di1a-decisions.md:110、LD/nc1-decisions.md:90 | 残り | DI-1a「CP-4／PUB-G：送信の遅れ（最大 W = 4 s）の開示」。NC-1「PUB-G／Session C-1 の開示文…では『close() 起因の消失だけを数える』と限定して書く」 | Session C-1 の文言 |
| 45 | pin の自動化の段階 1（#744）が Graph の gate の内側にあること | 続行計画:10 | 不明 | 「pin 自動化の段階 1（#744）は Graph の gate の内側に置いた」。PUB-G で gate を開けると同時に有効になるか（承認の範囲に入るか）は読んだ範囲に記述が無い | integrator が C-1 の承認の範囲に含めるかを明示（判断） |
| 46 | Session C-1 の承認そのもの | 続行計画:426（§9 停止点 4）、:177 | 残り | 「Session C-1: PUB-G と D2a の UI の承認」。続行計画:10（2026-10-31）時点で「未承認で閉じたまま」。以後の承認の記録は見つからない | ユーザーの承認（§2） |

（数え方: 済み＝#1〜4、8、17〜20、22〜28、31、34 の 18 行（#23・#24・#31・#34 は 2026-11-09 の更新）。不明＝#6、7、11、15、16、30、45 の 7 行（#7 は CR-REC／CR-2 は済みだが G-2 が未解決のため不明）。残り＝それ以外の 21 行。）

## 2. 公開そのものに要る承認（Session C-1 で承認するもの）

計画上、C-1 は「PUB-G と D2a の UI の承認」（続行計画:426）。K3/3、K2/4、K6/4、SP/1、X1/3 のどの確認も、Graph の公開、activation UI の公開、開示の文言を承認しない（続行計画:504、:535、:579、:667、:708、:770）。読んだ記録から、C-1 の束に入る候補は次のとおり（束ね方は integrator が決める）。

1. **gate の開放（同一承認の単位）**
   - Native: `PRODUCT_GRAPH_PUBLISHED` を true（`nir1_graph_product.rs:64`。const assert と architecture 検査の期待も変わる）。
   - renderer: `NIR1_GRAPH_UI_ENABLED`、`BODY_DECLARATION_UI_ENABLED`。
   - Native の `PrePublicationEntry::SceneBodyDeclaration`（K2/4 の宣言と取消の入口）。
   - B の production registry への登録と policy の行（B-ROUTE §9。製品での B の自動実行が始まる）。
   - Graph の gate の内側の機能（pin の自動化の段階 1、#744）が同時に有効になるなら、その範囲。
2. **activation UI の公開（D2a）**
   - `PROFILE_ACTIVATION_UI_ENABLED` と `PrePublicationEntry::ProfileActivation`。状態の表示の置き場所（左下の固定）と見た目（LD/da2-decisions.md:106、:304）。
3. **開示の文言**
   - K3/3 の開示 7 の (a) の i〜v（K3/3:314）。macOS の `.local` unverified、127.0.0.2 の canary 不可、Linux の実機だけで確かめたこと、Windows／macOS は CP-2b の結果を添えること。
   - D2a の文言の草案（状態の表示、Related Scenes の `profile-not-restricted` の案内、AI の終端。da2:304）、`profileEgress.writeRetry.failed`（続行計画:796 の (2)）、`profileEgress.chat.editClosedRoute`（案。da2b:17）、`chat.newConversationClosed`（da2b:163）。**コードでの存在を確認**: `src/features/profile-egress/profileEgressTranslations.ts:78`（newConversationClosed）、:86（editClosedRoute）、:93（writeRetry）と en 側 :162／:170／:177。どれも定数 false の後ろで製品に出ない（判断記録の記述。表示経路の実行は確かめていない）。activation UI は `ProfileEgressStatusSlot.tsx`（定数 false で要素を作らない）。
   - K3/2 の文面の改め（「編集して再送は場面の会話でだけ使える」。da2b:17）。
   - 送信の遅れ W = 4 s（DI-1a）、NC-LISTENER-LOST の限定（NC-1）、`shell.openExternal` の扱い（integrator が入れると決めた場合）。
   - 宣言の確認ダイアログが日本語固定であること（cb3:44、:133。扱いの判断を含む）。
4. **CP-4 の開示と結果の扱い**
   - S7 §5 の 12 点（観測の後に直した候補での 1 回の測定、K6/2 の読みの窓外 201/201＝graph-late の設計、欠落 1 件の理由未特定、LP-A1 と LP-GATE の寄与が分けられない、N2／N4 の封印の規則は blocked を見た後に決めた、「開き直しで宣言が失われる」限界、G-04 v2 は観測の後の版、S2 の字義と事実の食い違い、最終関門の P3、SP-P4 の IR の期限切れ 2 件、sampler、dev の診断は数えない）。
   - DR-CP4-S4-8 (8) の 5 点（LD/cp4-decisions.md:875。世代不変の分岐の有効性は X1-5 の分類に依る／「B が current」の意味の変更／N2・N4 の blocked を見た後の規則の変更／開き直しで宣言が失われる欠陥があると区別できない／X1-5 の下で封印待ちの前提を確かめた記録が無い）。
   - X1/3 (e)-1（l6-l9:646）：IR を持つ Scene の編集中の可用性は示していないこと、(a)-1b の製品への効果は測っていないこと。
   - S7 §3 の 3：(a) 最終関門の P3 を次の S2 改版まで直さないこと、(b) 1 回の測定をどこまで頼るか。
   - CP-4 の結果の確定（#9。現状は自由記述の「OKです」）。
5. **CP-2b の同梱リスクの判断**：続行計画:175 の「audit 例外が解消されていなければ PUB-G に同梱し C-1 でリスク判断」は、audit 例外が解消済みなので当たらない（#708、#719、#760）。worker の同梱でディスクが約 90 MB 増えることはユーザーが判断済み（SB-14、SB-15）。

## 3. 確かめられなかったこと

（事実：読んだ範囲で見つからなかった、または読んでいないもの。推測は「推測」と明記）

1. **CP-4 の品質の条件と P**（表 #11）：G-01 の事前指定改善、macro 非回帰、Evidence 妥当性 100%、禁止寄与 0、P の Hybrid p95 ≤ 65.04 ms の判定結果を、S6／S7 と Gold の受領書の中で見つけられなかった。別の記録にあるのか、未測定なのかは不明。post-B:225 は「品質・可用性・性能を同時に満たすこと」を求める。
2. **A3 consumer activation の証跡**（表 #6）と **DR-CP3A-55 の lease 越しの end-to-end**（表 #16）が CP-4 で満たされたか。
3. **l6-l9:40 の G-2（C-resource の製品形の上限）**の HOLD（[precheck]）が今も有効か、PUB-G を止めるか。後の解消の記録は読んだ範囲に無い。
4. **CP-2a の Open／Restore 以外の待ち**（LD/cp2a-decisions.md:185「残りは PUB-G の前提条件にするか…advisor が決める」）の結論。読んでいない。
5. **G-pub の B 案（署名・公証済みの配布物）の手順**（CP-2b の TASK §2.3）。TASK は git に無い（推測：lane の worktree か scratchpad にある）。
6. **引き継ぎ文書 `handoff/nir1-handoff-20261103.md`**：master、`a22080bd`、`origin/claude/nir1-contracts` のどの ref にも無い。ローカルの作業ツリーにだけある可能性（推測）。指示により root checkout の作業ツリーは読んでいない。
7. **`cbf33077` 以後の master の canonical Full の green**、PUB-G の最終候補の Full／Quick の扱い。確認していない。
8. **定数 true の起動時 JS の現在値**（表 #30）。build はしていない（禁止事項）。
9. CP-3b の必須 2 件（表 #36、#37）について、master の log と src の grep では対処を見つけられなかった。別名の PR で直っている可能性は否定できない（推測では低い）。
10. TASK `cp4-task.md` の CP-4 の範囲（「G-01〜G-08、24 件、P の計測と A3 consumer activation の証跡」。続行計画:176）と S6／S7 の範囲の対応。TASK は git に無く読んでいない。

## 4. 文書どうしの食い違い

1. **起動時 JS の予算の値が 3 つある**：
   - DR-DA2B-R25（LD/da2b-renderer-decisions.md:164）：基点 `16797ce7` の定数 true で raw 4,251,408（上限 4,251,000 を 408 超え）、PR-B の上積みは +1,056。
   - 続行計画:797：「定数 true で 4,252,464、現在の上限 4,251,000」（4,251,408 + 1,056 = 4,252,464 なので計算上は整合）。
   - 現行 `scripts/check-performance-budgets.mjs:31`：`absoluteMax.rawBytes = 4_261_300`（overlay の P1 で baseline と上限を +10,300。実測は +12,715。同:26-28）。
   - したがって「上限 4,251,000」は古い。ただし定数 false の graph 自体も増えているので、定数 true で収まるかは再測定しないと言えない。LD/cb3-decisions.md:150 の「残りは raw 920、master 自体が上限まで 3,109」も古い値と推測。
2. **PUB-G の前提の一覧が文書ごとに違う**：
   - 続行計画:797 の「PUB-G の前提で残るのは、起動時 JS の予算の緩和、owner Suspended の復帰の配線、PUB-G を止める項目、C-1 の文言の承認」は DA-2b の観点だけで、CP-3b の必須 2 件（cp3b:161-162）、CB-3 の前提（cb3:148-150）、DA-2a の R3-7／R3-8（da2:116）、B-ROUTE §9、CP-2b P3-2 を含まない。
   - 同じ :797 は「PUB-G を止める項目（行 5）…閉じていない」と書いた後に #733 で閉じた（da2b:17 は「閉じた」）。:797 の後続の文にその更新が無い（#733 は続行計画:266 の表にだけある）。
3. **PUB-G の状態欄が古い**：続行計画:177 は「現状（2026-10-25）」、続行計画:10 は「現在地（2026-10-31）」で master `5ce12211`（#760）止まり。#771〜#779 と s5r6 の結果（HOLD に当たらない）は master の続行計画に無い（PR #780 の追加は 1 行だけ）。
4. **CP-4 の状態が文書で違う**：l6-l9:43 と続行計画:176 は 2026-11-01 の「候補 `86427ee5` で HOLD（DR-CP4-S6-1）」までで、S6-2（#775）と s5r6（HOLD に当たらない）を反映していない。memory の「CP-4 の Graph arm は HOLD」も s5r6 の前の記述。
5. **PUB-G の前提の書き方の層**：続行計画:551（Session B2）は「CQ-LIM-1〜4 の実装（見込み）」、:592（Session B3）は「CQ-LIM-1〜4 は #678 で master」と G-pub を追加。l6-l9:577／:595／:605 も同じ層の重なり（後の追記が正と書かれている）。食い違いではなく時点差だが、どれが現行かを一覧で示す文書が無い。
6. **CP-4 の範囲の書き方**：続行計画:176 と l6-l9:43 は CP-4 に「G-01〜G-08、24 件、P の計測と A3 consumer activation の証跡」を含めるが、S6／S7 は可用性（Gold の pool、trace、SP-P4、parity、負例）だけを報告する（§3 の 1・2）。

## 5. 追記（2026-11-09。正式 run s7r1 の結果と、その独立レビュー・助言を受けて）

s7r1（S4b `f2f99b13`・候補 `3f333a83`・K6/6）の結果（`docs/plans/nir1-cp4-records/s7-report-s7r1/README.md`、contracts `3a69b557`）で分かったこと。**表の「済み 18／残り 21／不明 7」に、残りを 2 行足す（残り 23）。**

- **#24（owner の Suspended の復帰。「到達の確認は残り」）**：#839（復帰の配線。復帰は 1 回だけ）を含む候補 `3f333a83` の 2 回目の Gold で、判定外の `G-03/frontier-exceeded` が Graph arm 35 sample のうち 30 が `registration-unavailable`、23 が `startSlot: suspended` になった（前回 s6r1 は 35／35 が `graph-late`・slot empty）。復帰が働いたか、働かない条件は何かは**未確認**。dev の凍結外 fixture でも同じ連鎖が再現した（`handoff` の `s7r1-dev-ready/results.md`）。
- **#5（B の製品経路・wake 源・再構築の頻度）との関係**：(a′)（refused を drift と incomplete に分け、drift では Suspended にしない）の価値「B の build なしで戻れる」は #5 の B の頻度しだい。(a′) は DB 接続の段 1 の PR-2（同じ関数 `nir1_graph.rs:604-688`）に同梱する方針。
- **新しい行 A（残り）：維持の dependency-verify の取消しの連打 → registration の refused → Graph の slot の Suspended（DR-CP4-L-27 の続き）**。S6-4 の判断：段 1 に吸収されない（段 1 の失効の定義は「どの commit でも」）。別の lane で (c) 維持の連続 preempt の backoff と (f) Related Scenes の reconciler の no-wait 化を、奪い手の特定の計装→設計→dev の A/B まで進める。(g) LP-GATE を維持の cycle にも広げる、は LP-GATE 案 2 の範囲の拡大でユーザーの確認が要る。新しい候補での正式の取り直しはユーザー（前例 DR-CP4-V-1）。
- **新しい行 B（残り）：frontier の上限超過の Graph を製品経路で全体拒否することの端から端の検査**。`G-03/frontier-exceeded` は s5r5・s5r6・s6r1・s7r1 のどの正式 Gold でも期待の理由（製品の reason 語彙では `limit`）が観測されていない（前 3 回は 35／35 が `graph-late`）。機構は Rust の unit test（`nir1_graph/tests.rs` の `graph_entities_at_50_is_available`、`graph_entities_at_51_refuses_the_whole_graph`、`two_hop_limit_stops_before_a_third_hop`）で検査済み。凍結外の dev fixture か integration で端から端を検査する。
- **#11（CP-4 の品質の条件）の充足の形（不明のまま。ユーザーの選択待ち）**：品質判定 v2（補助）の not-evaluable は、既存 24 件の Graph arm の受領書が無い、evidence の 4 項目（utf16-range、explicit-pin-association、raw-excerpt-unchanged、added-scene-body-anchor）が受領書に無い、禁止寄与の (c)。(i) 8 回目の S4 で受領書の形を広げて測る（受領書を作る `k64-record.mjs`・`receipt.mjs`・`availability.mjs`・`frozen-k64-run.mjs` は S4 の pin。DB 段 1 の PR-3 の S4 再凍結と束ねて S4 を 1 回で済ませる。推奨）、(ii) 開示して受け入れる。K6/2:620 は「Evidence 100%、禁止寄与 0」を Positive の条件に含むので、not-evaluable のまま PUB-G に進むのは合格基準の黙示の変更に近い。
- **#15（CP-4 の候補と PUB-G の最終候補の差の扱い）**：どの製品修正も候補を変えるので CP-4 の receipt は旧候補に束縛される（K6/2:624「候補…が変わったら失効」、K6/4 変える点 12）。DB 接続の段 1（4,000〜6,000 行）でも必ず起きる。持ち越しの規則は読んだ範囲に無い（不明のまま）。これが PUB-G の本当の前提で、製品の連鎖の lane が新しく作る問題ではない。

