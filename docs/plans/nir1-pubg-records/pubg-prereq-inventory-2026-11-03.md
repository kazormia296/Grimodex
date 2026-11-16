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

**【最新の集計（2026-11-16）：済み 28 ／ 残り 19 ／ 不明 1（計 48 行）。内訳と前回からの変化は「6. 追記（2026-11-16。付け直し）」。】** 以下は 2026-11-09 時点の集計（済み 18 ／ 残り 21 ／ 不明 7、計 46 行。2026-11-09 に #23・#24・#31・#34 を済みへ更新：PR #833・#837・#839 の merge による。#32 は試験を追加したが置き場所が未解決のため残りのまま）。

### 1.1 ゲートと公開条件の大枠

| # | 前提の項目 | 出典 | 状態 | 根拠（実物で確かめた事実） | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 1 | Native の公開 gate が閉じていること（PUB-G で開ける対象） | `electron/native/grimodex-node/src/nir1_graph_product.rs:64-65`、:568 | 済み（閉の確認） | `const PRODUCT_GRAPH_PUBLISHED: bool = false;` と `const _: () = assert!(!PRODUCT_GRAPH_PUBLISHED);`。`publication_open()` は「定数→eval feature の flag→cfg(test)→false」。`scripts/quality/nir1-graph-eval/native-architecture.mjs:430-439` が false を強制 | PUB-G の PR で true にする（Session C-1 の承認の後）。architecture 検査の期待も同時に変える必要（推測） |
| 2 | renderer の定数がすべて閉 | `src/features/related-scenes/nir1GraphAvailability.ts:13`、`src/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationAvailability.ts:13`、`src/features/profile-egress/profileActivationAvailability.ts:23`、`src/features/chat/nir1/nir1LocalGenerationAvailability.ts:19` | 済み（閉の確認） | 4 つとも `false as const`。最後の 1 つは PUB-L の対象で PUB-G では開けない | PUB-G は `NIR1_GRAPH_UI_ENABLED`・`BODY_DECLARATION_UI_ENABLED`・Native gate を**同じ承認で**変える（LD/cp3b-decisions.md:159、LD/cb3-decisions.md:133）。`PROFILE_ACTIVATION_UI_ENABLED` は C-1 で承認（LD/da2-decisions.md:104 は「PUB-G と C-1 の承認の単位が違う」と書く） |
| 3 | `PrePublicationEntry` の 3 入口が閉 | `electron/native/grimodex-node/src/main_grant.rs:166-178` | 済み（閉の確認） | `SceneBodyDeclaration`（K2/4）、`ProfileActivation`（K3/2。コメント「PUB-G and Session C-1 do」）、`LocalGeneration`（PUB-L）。製品の起動で開く経路は無いとコメントに明記 | PUB-G で前 2 つを開ける配線（Session C-1 の承認の後）。`LocalGeneration` は開けない |
| 4 | D2a（公開条件の 1 項）の実装 | 続行計画:163、:10（#690 DA-1 開放、#702 DA-2a、#706 DA-2b） | 済み（実装） | 続行計画:10 に #690（`own-data-read` の開放）、#702、#706 の merge の記録。UI と開示は Session C-1 の別承認（l6-l9:47） | — （UI と開示文言は §2 の C-1） |
| 5 | B（独立 Graph Index）の製品経路：production registry への登録、policy の行、wake 源と再構築の頻度、refusal の UX | LD/broute-decisions.md:425-430、:37、:184 | 残り | 「PUB-G で決めること」として 5 点を列挙。B-ROUTE の route は「gated、PUB-G までは production route の集合に入れない」 | integrator の技術判断（U3 委任の範囲と推測）＋実装。新しい policy 行は integrator の担当（broute:45） |
| 6 | A3 consumer activation の証跡（全 Scope 軸の positive／negative／unavailable、非開示 bridge の禁止、再検証、fallback） | l6-l9:48 | 不明（2026-11-16 に更新） | l6-l9:48 は「HOLD。開始条件は確認台帳の Session B2 の lane snapshot」のまま更新が無い。CP-4 の S6 の trace 再計算に `ii-a3-ineligible-at-start: 0`（`a22080bd:.../s6-aggregation-s5r6/trace-k64-recompute.json:55`）はあるが、A3 の受入れとしての記録は読んだ範囲に無い。2026-11-03 の調査（`nir1-pubg-records/cp4-quality-rest-and-pubg-unknowns-2026-11-03.md`）：受領書に出る A3 の理由は 5 種だけで、POV・phase・story-scope・auto-scope・query の軸は一件も出ない（Rust 側の語彙は約 20 超）。2026-11-16 の時点でも、s7r2 の受領書で A3 の理由の集計は走らせておらず、TASK `cp4-task.md`（CP-4 の範囲）も読んでいない。済みとも残りとも言えないので不明のままにする | integrator が 5 種の集計と、未演習の軸の扱い（foundation〔#598〕の Rust 試験で足りるとみなすか、実製品経路で測るか。後者は G-case の追加＝凍結の変更で別の確認）を決める |
| 7 | C-resource の受入れ（C-query） | l6-l9:36-41 | 済み（2026-11-16 に更新） | G-2 の [precheck] は CQ-LIM-2・3（DR-CQL-5・6、`LD/cq-lim-decisions.md`）で解除された。CQ-LIM-1〜4 は PR #678（master `a789039a`）で merge 済み。台帳 `nir1-c-query-acceptance-2026-10.md` の RB-2 は「充足（proposal/7 の後）」。実 worker（Q 16 MiB）で decision・envelope の形のちょうど N、payload 形の約 2.03 MB、製品形の A2 2,094,880 B の registration が READY。l6-l9:40 の状態欄は「HOLD」のままで、文書が古い。**限界（C-1 の開示に載せる）**：製品形でちょうど 2,097,152 B の候補は作っておらず（2,272 B 下まで）、A2 が 2,097,152 B を超える承認済み Revision があると project の worker は READY にならず Graph は unavailable になる（安全側の動作）。旧：不明（G-2 が未解決と読んでいた） | — （l6-l9:40 の状態欄の更新は文書だけ。開示 2 点は #12 と同じく C-1 で） |

### 1.2 CP-4（Graph arm の評価）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 8 | CP-4 の正式な測定（可用性）が事前登録の規則で HOLD に当たらないこと | S7 §1、`a22080bd:.../s6-aggregation-s5r6/README.md` §3 | 済み（2026-11-16 に更新） | S4b'''' `3734e501`・候補 `cbf33077`、run 8 件 attempt 1。Gold の pool の欠落 0/270（許容 2）、編集 trace の失効 0/201・欠落 1/201（許容 2）、閲覧 0、SP-P4 passed、N2〜N4 measured。「物差しを超える指標は無く HOLD の条件に当たらない」。**2026-11-16 に更新**：その後の正式 run も同じ。s7r1（候補 `3f333a83`、K6/6）と s7r2（候補 `29a120dd`、DR-CP4-S6-6〔#911〕）はいずれも HOLD にも `[precheck]` にも当たらない。s7r2：Gold の pool の欠落 0/270（許容 2）、編集 trace の失効・窓外 0/201、閲覧 0、SP-P4 passed、Graph arm の p95 60.10 ms（余裕 34.1 ms）。ただし (1) K6/2 の字義では pool の窓外は 270/270（K6/6 の数え方に依存。S7 §3）、(2) PUB-G の判定に使うのは次の S4（9 回目）の下の正式 run（K6/7、凍結 `b9559a22`）で、s7r2 は参考（#15） | — |
| 9 | CP-4 の結果の確定（ユーザー） | `origin/claude/nir1-contracts` `94b6e04e`（`user-confirmation-2026-11-03-s7-ok-handoff-p3.md`） | 済み（2026-11-16 に更新） | 2026-11-09T03:10:38Z：s7r1 の結果について「CP-4 の Graph arm は可用性を満たした」を AskUserQuestion の「確定する (Recommended)」で確定（contracts `user-confirmation-2026-11-09-s7r1-acceptance.md`）。2026-11-15T11:23Z ごろ：s7r2（候補 `29a120dd`）にも「今回も確定する (Recommended)」（同 `user-confirmation-2026-11-15-s7r2-acceptance.md`）。いずれも製品の公開・PUB-G の承認は含まない。旧：2026-11-03 の自由記述「OKです」は確定の根拠にしなかった。次の S4（9 回目）の run の結果には改めて確定が要る | — （次の S4 の run の確定は #15 に含める） |
| 10 | DR-CP4-S6-3 の master への記録 | PR #780（OPEN、head `ce84b9b8`。差分は続行計画 +1 行と LD/cp4-decisions.md +24 行） | 済み（2026-11-16 に更新） | PR #780 は merge 済み（master `51981e81`。題は「DR-CP4-S6-3 — S4b''''・候補 cbf33077 の測定の判断…と、最終関門の P3 の扱いを記録する」）。旧：OPEN（head `ce84b9b8`） | — |
| 11 | CP-4 の品質の条件（G-01 の事前指定改善、macro 非回帰、Evidence 100%、禁止寄与 0）と P（Hybrid p95 ≤ 65.04 ms） | K6/2 `docs/plans/nir1-final-request-eval-proposal-2-draft.md:620`、K6/4 `...-4-draft.md:171`、post-B:219-225、l6-l9:670 | 残り（測定。旧：不明）（2026-11-16 に更新） | 所在が分かった。品質判定 v2（補助。contracts `quality-verdict-prereg-v2.md`、実装 `quality-verdict.mjs`、DR-CP4-QV-1）が s6r1・s7r1・s7r2 に当てられ、s7r2（候補 `29a120dd`）は全体 **hold（unverified-required-items）**。pass：G-01 の事前指定改善、macro 非回帰（G-case 13 variant）、Hybrid p95（R+IR arm 26.10 ms、Graph arm 60.10 ms、n=390、判定の上限 94.2 ms。**65.04 → 94.2 ms は K6/5 でユーザーが承認した変更**〔D を 10.84 → 40 ms にしたため。続行計画:178・:865、contracts `nir1-final-request-eval-proposal-6-draft.md:9`。この行の見出しの 65.04 ms は古い〕。60.10 ms は旧の 65.04 ms 以下でもあるが、契約の P〔24 query×720 call、AB/BA〕の母集団とは違う）、edge の束縛（9 variant、270 件）、禁止寄与の (a)(b)。fail・hold の条件は無し。**not-evaluable**：既存 24 件の Graph arm の受領書、evidence の 4 項目（utf16-range、explicit-pin-association、raw-excerpt-unchanged、added-scene-body-anchor）、禁止寄与の (c)。2026-11-09 にユーザーが (i) を選択：次の S4（9 回目。DB 段 1 の PR-3 の再凍結と束ねる）で受領書の形を広げて測る。2026-11-15 は「凍結はそのまま」で 8 回目＝s7r2 は再凍結なし、Q6（2026-11-16）で記録は範囲・hash・ID だけ。K6/2:620 は「Evidence 100%、禁止寄与 0」を Positive の条件に含むので、not-evaluable のまま PUB-G に進むのは合格基準の黙示の変更に近い | 9 回目の S4 の準備と run（測定）。S4 の再凍結・失効の確認はユーザー（Q5「前例どおり」は手順の承認で、失効そのものの確認ではない）。閾値は変えない |
| 12 | CP-4 の開示（S7 の 5 の 12 点、DR-CP4-S4-8 (8) の 5 点、X1/3 (e)-1） | S7 §5、LD/cp4-decisions.md:875（DR-CP4-S4-8 (8)）、l6-l9:646 | 残り（2026-11-16 に更新） | S7 §3 の 3 は「(a) 最終関門の P3 を次の S2 改版まで直さないこと、(b) 1 回の測定の結果をどこまで頼るか」をユーザーの判断とする。l6-l9:646 は見通しを「新しい候補の実測で置き換えて Session C-1（PUB-G）に示す」と書く。**2026-11-16 に更新**：開示の正本は s7r2 の報告 `s7-report-s7r2/README.md` §6（15 点）と、s7r1 の §6（有効のまま）。s7r2 の追加分：Gold は 1 回だけ（V-10 は確率的）、p95 が下がった機構は未確認（候補は 69 commit 進んだ）、窓外は K6/2 の字義で 270/270、`G-03/frontier-exceeded` の期待の理由は未観測（#48）、品質判定の not-evaluable（#11）。S7 §5 の 1・3 は 2026-11-15 に確定済み（#9）で、開示文の承認は C-1 に残る | Session C-1 での開示文の承認（ユーザーの承認） |
| 13 | IR の edge を持つ Scene を編集する trace の新しい事前登録（(a)-1b の製品への効果の証拠） | l6-l9:646、:223（X1/3 が許さないもの） | 残り（判断） | 「その事前登録は X1/3 の範囲の外で、要るか、いつ作るかは integrator とユーザーが決める」。凍結した G-02 の編集 trace は IR の edge を持たない。2026-11-16 に contracts の記録と master の続行計画を検索したが、2026-11-01 の確認（X1/3、G-04 v2）の「範囲外」以後の事前登録・判断は見つからなかった（変更なし） | integrator とユーザーの判断。作るなら事前登録と測定 |
| 14 | 最終関門の P3（S2 の文面）を次の S2 改版で直すこと | PR #780 の DR-CP4-S4-8 追記 6（P3-1〜P3-7）、S7 §5-9 | 残り（判断。P3-6 は対処済み。ほかの照合は未了。2026-11-16 に更新） | S2・v3・作者の宣言は S4b'''' の freeze record に sha256 で束縛され、直すと 6 回目の凍結と再測定になる。P3-6（iron-laws の S4 の `--merge` 例外）は別の依頼が要る。**2026-11-16 に更新**：P3-6（iron-laws に S4 の `--merge` の例外が無い）は PR #784（master `21c25c73`）で GDX-TRACE-001 に「S4 の PR を唯一の squash 以外の merge の方法」として書き足し済み。残りの P3（P3-1〜5・7。S2・v3・作者の宣言の文面）は、DR-CP4-S4-8 追記 6 が「次の S2 改版で直す」とした。その後 S4b は `f2f99b13`（7 回目、K6/6）になり、9 回目の再凍結が予定されている（Q5）が、P3-1〜5・7 が 7 回目で直ったか、9 回目に含めるかは今回照合していない（S7 §6 の開示 6「S2 の pin は 94 件とも一致」は、S2 を変えていないことを示すだけ）。旧の「直すと 6 回目の凍結」は古い（今は 7 回目） | PUB-G の前に S2 改版が要るか、ユーザーの判断（要るなら S4 の再凍結＋再測定） |
| 15 | CP-4 の候補（`cbf33077`）と PUB-G の最終候補の差の扱い | S7 §2、`665a30f3`（JA sparse の着手） | 残り（測定。旧：不明。規則は決定済み）（2026-11-16 に更新） | 規則が決まった：**2026-11-16 のユーザー決定 Q7「次の S4 の run を正とする (Recommended)」**（contracts `user-confirmation-2026-11-16-pr3-q5-q7.md`、`f7ea87a6`）。PUB-G は、次の S4（9 回目の凍結のやり直し）の下の正式 run（K6/7、凍結済み `b9559a22`）の結果を正とする。s7r2 の結果は新しい候補へ持ち越さず、参考として開示する。残っているのは、その run の実施（DB 段 1 の PR-3 は実装中で、S4 の再凍結の後に run）。PUB-G の最終候補とその run の候補の差の扱いは、Q7 の記録に書かれていない（読んだ範囲では不明） | 9 回目の S4 の下の正式 run（測定）。run の結果の確定（ユーザー）。旧：持ち越しの規則（判断）は Q7 で解決 |
| 16 | CP-3a の申し送り：製品ではほぼ常に graph-late、lease 越しの end-to-end は未実施 | 続行計画:176（CP-4 行）、LD/cp3a-decisions.md:69（DR-CP3A-55） | 済み（評価 build・Linux。限界あり）（2026-11-16 に更新） | DR-PUBG-16-1（PR #822、master `19598c30`、contracts `nir1-pubg-records/pubg-16-e2e-2026-11-07/README.md`）：評価 build の実 Native と実 renderer が、begin → continue（Graph-only あり）→ click（`qualified`、`keep_click` の経路）→ unused settle → graph-ready → 再 begin（`cached`）→ used settle に、判定を直した後の 3 回（reach-4〜6）とも到達した（ユーザーの決定：案 (C) の第一段、合格基準は到達の有無、Linux の評価 build だけ）。さらに CP-4 の正式 run に判定外の診断として組み込まれ（G-01 の凍結素材。`g01-e2e-s6r1-1`・`g01-e2e-s7r1-1`・`g01-e2e-s7r2-1`）、s7r2 の診断も `reachedEndToEnd: true`、click は `qualified`。**限界**：Linux の評価 build だけ（3 OS は未確認）。製品の `.node`（gate が閉）では seed つき begin は `not-activated`（na-1。DR-CP3A-58 のとおり）。precision は測っていない。lease 失効後の click・settle の後の click・再 continue の graphOnly の click は未試験。旧：不明（CP-4 の run が click を通したか読めなかった） | — （C-1 の開示に限界を載せる） |

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
| 24 | owner の Suspended の復帰の配線 | `nir1_graph_product.rs:14`、続行計画:797、CP2a-D47〜D49（PR #839、MERGED 2026-11-08、`1aa40216`） | 済み（実装。到達の確認は残り）（2026-11-16 に更新） | maintenance cycle の `work_completed` closure から `note_maintenance_work_completed(item)` を呼び、run kind が `Nir1GraphIndexBuild` のときだけ既存の `resume_after_graph_index_change()` を呼ぶ（attempt の記録より前。D47）。D48：hook が slot の lock の中で `graph_index_change` を進め、prepare の最中の publish を `SessionGuard::drop` が同じ lock の中で比べて取りこぼしを無くす。D49：復帰の後の ledger は 0 でなく `failures_before_suspend - 1`（復帰の後は 1 回だけ試す。CP2a-D8 の意味は「最初は 5 回、復帰の後は 1 回」）。hook は project を見ない（どの project の publish でも解ける。今は受け入れ）。D48 の「取りこぼし無し」は Suspended に入る失敗の prepare の最中だけ（失敗が 1〜4 回のときの publish は ledger を戻さない。記録のみ）。process worker の start は gated のまま（`PRODUCT_GRAPH_PUBLISHED = false`）。**2026-11-16 に更新**：s7r2（候補 `29a120dd`）の Gold で、前回 s7r1 の `G-03/frontier-exceeded` の `registration-unavailable` 30／`suspended` 23 は 0／0（35 sample すべて `graph-late`、slot `empty`）。連鎖の原因側は #47 で扱った。ただし Suspended が起きなかったので、復帰の配線（#839）が実際に働いたことの確認にはならず、「B の publish の後に Suspended が解ける」「複数 project の publish が Suspended を繰り返し解かない」の確認は未実施のまま | PUB-G の前の journey で、B の publish の後に Suspended が解けること、複数 project の publish が Suspended を繰り返し解かないことを見る（#839 の未決） |

### 1.4 DA-2a／DA-2b（D2a の UI）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 25 | DA-2b 必須 1：場面の会話でない会話の編集して再送を閉じる | `LD/da2b-renderer-decisions.md:13`、PR #720（MERGED、`c87bd446`） | 済み | `gh pr view 720`: MERGED 2026-10-25 | — |
| 26 | DA-2b 必須 2：W-1 の完了後の自動再試行 | 同:14 | 済み | 「解消済み（2026-10-25、`a4461425`）」 | — |
| 27 | DA-2b 必須 3・4：AI の入口の閉鎖の拡大、送信の閉鎖の 3 状態 | 同:15-16、PR #724（MERGED、`8e93bb31`） | 済み | `gh pr view 724`: MERGED | — |
| 28 | DA-2b 必須 5：route が capture の外なら場面の会話でも閉じる | 同:17、PR #733（MERGED、`58023306`） | 済み | `gh pr view 733`: MERGED。ユーザーの決定は案 (a)（2026-10-26 12:56 JST） | — |
| 29 | K3/2 の文面（`:28`、`:177`「編集して再送は場面の会話でだけ使える」）の改め | `LD/da2b-renderer-decisions.md:17` | 残り | 「K3/2 の文面の改めは Session C-1 の束で確かめる（PR-C は draft を編集しない）」 | Session C-1 での確認（ユーザーの承認） |
| 30 | 定数 true のときの起動時 JS の予算 | `LD/da2b-renderer-decisions.md:164`（DR-DA2B-R25）、続行計画:797、`scripts/check-performance-budgets.mjs:17-31` | 残り（測定。旧：不明）（2026-11-16 に更新） | 実測が進んだ。(1) 2026-11-03（master `21c25c73`、contracts `startup-js-budget-gates-true-2026-11-03.md`）：`NIR1_GRAPH_UI_ENABLED`＋`BODY_DECLARATION_UI_ENABLED` を true にしても raw は増えない（gzip +55）。D2a の `PROFILE_ACTIVATION_UI_ENABLED` も true にすると raw +1,591 で、当時の上限を 1,536 超過。(2) 起動時 graph はその後 #865（master `69327d6b`、raw −478 KB）で縮み、現行の予算は baseline raw 3,803,500／gzip 1,195,200、absoluteMax raw 3,903,000／gzip 1,232,000。(3) DR-CB3-35 (3)（2026-11-15、master `5706c2f4`、ci.yml run 43652948535）：現行の起動時 graph は raw 3,806,510／gzip 1,197,115／assets 156、`BODY_DECLARATION_UI_ENABLED` だけを一時的に true にした build は raw 差 0／gzip −35 で、残りは raw 96,490／gzip 34,885。**未測定**：3 定数すべてを true にした現行 build。D2a 分の +1,591（旧基点の値）は残りに対して十分小さいので緩和は要らない見込みだが、直接測っていない | PUB-G の PR（または C-1 の前の使い捨て worktree）で 3 定数を true にした `pnpm build`＋`pnpm perf:budget`（測定）。超えれば lazy 化が先、足りない分だけ独立 commit で緩和 |
| 31 | 状態の表示の error boundary（R3-7） | LD/da2-decisions.md:116、:367、DR-DA2-62／-64（PR #837、MERGED 2026-11-08、`8b40480d`） | 済み（実装。2026-11-09 に更新） | `ProfileEgressStatusSlot.tsx` に class の `ProfileEgressStatusBoundary` を `Suspense` の外側（lazy chunk の外）に置き、例外と chunk の読込失敗（旧 `import().catch` は廃止）は何も描かず `debugLog.error` に残す。閉鎖は boundary から呼ばない（表示は UI 側だけ。防御は Main の gate と Native）。DR-DA2-64（レビュー指摘）：表示の render の例外で閉鎖の effect が commit されない欠落を、Indicator を hooks だけにして描画を内側の boundary の下の `ProfileEgressStatusView` に分け、閉鎖の effect を他の effect より先に宣言して直した。chunk の読込・評価の失敗では閉鎖が立たないのは変更前と同じ（退行ではない）。定数 `PROFILE_ACTIVATION_UI_ENABLED` は false のまま | — |
| 32 | 左下の表示と LayoutShell の操作要素の重なりの browser invariant（R3-8） | LD/da2-decisions.md:116、:367、DR-DA2-63（PR #837、MERGED 2026-11-08、`8b40480d`） | 残り（試験は追加済み。置き場所と phone 幅が未解決。2026-11-09 に更新） | `layoutInvariants.browser.test.tsx` に、実 `LayoutShell` と実 `ProfileEgressStatusIndicator` を同じ画面に置き、3 layout × 3 viewport（1200x800、768x600、360x640）で操作要素との重なり・ヒットを測る invariant を追加。元の位置では 9 件が全部落ち、位置を stripe と gap の外（左 62 px、下 61 px）へ移して直した。**開示・未解決**：(1) 実 `EditorPaneStatusBar` を置く probe で、1200x800 の既定の layout でも restricted の pill が editor の scene の状態の button を覆うことを実測で確認（`it.fails` で記録。位置は直していない。左下の panel の中身も覆う見込み＝幾何の推定）。(2) phone 幅（720 未満）の `phone-workspace-chrome__nav` との交わりは**未測定**（360x640 の case は製品で到達しない layout。幾何からの推定）。置き場所の最終判断は C-1／PUB-G（DR-DA2-31）で、定数を on にする前に扱う | C-1／PUB-G での置き場所の決定（scene の状態の button と左下の panel の中身を覆わない位置）、phone workspace の nav との交わりの測定（実装と試験） |
| 33 | 読めない状態ファイルのとき `dialog.showErrorBox` が Native の文をそのまま出す | 続行計画:796 の (5)、`electron/main/backend.ts:253-256` | 済み（実装。実機の dialog の見え方は未確認）（2026-11-16 に更新） | DR-PUBG-33-1（PR #817、master `2cb73eec`、記録先 `LD/cp3b-decisions.md`）：fail-soft の `dialog.showErrorBox` を固定の日英併記の文面にし、Native の message（path・OS の error・内部の code）は dialog に出さず `console.error` にだけ残す。IPC の契約・fail-fast・gate は変えていない。試験 `electron/main/backend.test.ts`（Native の message を戻す変異で落ちる）。旧：Native の message をそのまま表示（`backend.ts:253-256`） | — |
| 34 | renderer の呼出しを実 router に通した試験が無い typed writer（CW4、baseline の CAS、snapshot、chat を含む import） | 続行計画:796 の (6)、DR-PUBG-34-1（PR #833、MERGED 2026-11-08、`3631ffa4`） | 済み（試験。未検証の開示が残る。2026-11-09 に更新） | `electron/main/pubgRendererWriters.pipeline.spec.ts`（製品のコードと seam は変えない）。renderer の呼出しを Main の `grim:invoke` の handler に繋ぎ、実 router・実 gate・実 Native に unrestricted（対照）→ restricted の順で通す。CW 4（`deleteMessage`／`deleteMessages`）、baseline の CAS（read と write の間の競合で `updated:false`→再読取→再試行、両方の更新が残る）、snapshot の作成・削除、chat を含む import（chapters は通り、chat は `D2A_EGRESS_DENIED` で `notImported: 3`・行 0）。変異 4 件で該当の試験が落ちる | 未検証として Session C-1 で開示：`saveBaseline` の generic な INSERT／UPDATE の restricted での拒否（製品が baseline を書くのは unrestricted の間だけという前提は UI 層の `useAiGate` の閉鎖に依る。`runImpactReview` 自体は restricted を見ない）、実 Electron の UI、restricted の `importTree` の他の入口、snapshot の restore |
| 35 | phone の幅での段 2 の合成の終端の toast（生の marker） | LD/da2-decisions.md:112 | 残り（判断） | 「直すなら PUB-G の前に置き場所を決める」（lazy chunk にするか、起動時の graph に置くか） | integrator の判断（予算に影響） |

### 1.5 CP-3b／CB-3（Graph と宣言の UI）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 36 | quarantine の下の未保存の編集への手当て（toast の誤りと `exit(1)` での喪失。D7 (B) か同等）**必須** | LD/cp3b-decisions.md:161（引継ぎ 1） | 済み（実装。実機の確認は記録に無い）（2026-11-16 に更新） | DR-PUBG-36-1（PR #814、master `7ea2114a`、ユーザー決定は案 (B+)）：Native が quarantine の拒否に固定 code `WORKSPACE_QUARANTINED` を付け、scene の自動保存は「保存できない・控える・再起動」の sticky toast を 1 回出して自動の再試行を止め、Main は終了失敗の `exit(1)` の前に未保存が残る窓があれば確認 dialog（既定「戻る」）を出す。IPC は `report_unsaved_edits({hasUnsaved})`（真偽値 1 つ）の追加だけ。保存先・保存範囲は増やさず、本文の退避（案 C）は不採用。DR-PUBG-36-2（PR #818、master `a5371fd0`）：Codex・phase・snippet・Chronicle の store の失敗にも cause を伝え、scene と同じ sticky toast・再試行の停止・未保存の数え上げを効かせた。旧：残り（対処の commit を見つけられなかった） | — |
| 37 | 段階的に見える表示の手当て（lazy chunk の先読み）**必須** | LD/cp3b-decisions.md:162（引継ぎ 2） | 済み（実装。実機の体感の確認は記録に無い）（2026-11-16 に更新） | DR-PUBG-37-1（PR #811、master `4208ea8c`）：`RelatedScenesSection` の mount で、`isNir1GraphUiEnabled()` が true のときだけ Graph と SeedPanel の chunk を先読みし、読込み済みなら同期に解決する `preloadableLazy` で最初の描画を中断させない。実 Chromium の browser test（`RelatedScenesSection.graph.preload.browser.test.tsx`、MutationObserver で fallback の行が一度も commit されないこと）で確認。旧：残り（対処の記録が見つからなかった） | — |
| 38 | `restart-required` の文言を IR の到着に依らずに出す経路 | LD/cp3b-decisions.md:168（引継ぎ 8） | 残り（判断） | 「PUB-G で文言を必須の案内にするなら…経路を決める」 | integrator の判断と、必要なら実装 |
| 39 | 宣言の UI の再読取で 5 軸の確認が消える（DR-CB3-34 (1)）と初期描画（DR-CB3-31 (2)） | LD/cb3-decisions.md:148-149 | 済み（実装）（2026-11-16 に更新） | DR-PUBG-39-1／39-2（PR #820、master `1e6b3e0b`）：再読取の間も直前の form の「形」を持ち越して `DeclareForm` を mount したままにし（確認欄は form の key で守る。`refreshKey` や形が変わると確認を捨てる）、初期描画は最初の応答が来るまで題も読み込み中も描かない（gate が閉じていれば何も描かない）。旧：残り（実装） | — |
| 40 | 宣言の section の lazy chunk の失敗時の表示と error boundary、起動時 graph の再測定（DR-CB3-35） | LD/cb3-decisions.md:150 | 済み（実装。起動時 graph の再測定まで完了）（2026-11-16 に更新） | DR-PUBG-40-1（PR #902、master `663d6da6`／`fa7b018b`）：section の lazy と `Suspense` のすぐ外側に error boundary を置き、chunk の fetch・module 評価・render・effect の失敗では section だけを隠して `debugLog.error` に残す（新しい UI 文言なし。A1 の編集は残る）。DR-CB3-35 (2) は #39 で扱い済み。(3) 起動時 graph の測り直しは 2026-11-15 に完了（#30 の (3)：raw 3,806,510、定数 true でも差 0、`SceneBodyDeclarationSection` の chunk は modulepreload に現れない）。旧：残り（判断＋実装） | — |
| 41 | 宣言の UI の再確認（en の UI でも確認ダイアログは日本語、form の一瞬の消失、ダイアログ中の直列待ち） | LD/cb3-decisions.md:133 | 残り（確認。一部は対処済み）（2026-11-16 に更新） | 「PUB-G の lane は…その前に次を再確認する」。**2026-11-16 に更新**：「form の一瞬の消失」は #39（DR-PUBG-39-1／39-2、#820）で対処済み。残りは、en の UI でも確認ダイアログが日本語固定であること（扱いの判断）と、ダイアログ中の直列待ち（実機での再確認）。実機の再確認の記録は読んでいない | integrator の実機での再確認。日本語固定のダイアログは C-1 で扱うか判断 |

### 1.6 その他の開示の材料と承認

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 42 | K3/3 の開示 7 の (a)（Y-1 の結果。i〜v） | K3/3:314、l6-l9:605 | 残り | 「文言は C-1 で承認を得る。この /3 の確認は、開示の文言と activation の UI の公開を承認しない」。macOS の `.local` unverified と 127.0.0.2 の canary 不可（`LD/cp2b-g-pub/README.md`「注意」）もここに入る | Session C-1 での文言の承認 |
| 43 | `shell.openExternal` に渡る経路（乗っ取られた renderer が unrestricted で OS の browser を開ける）を開示するか | LD/cp2b-decisions.md:224 | 残り（判断） | 「PUB-G の開示（C-1）で扱うかを integrator が決める」 | integrator の判断 → C-1 |
| 44 | 送信の遅れ（最大 W = 4 s）の開示、NC-LISTENER-LOST の限定の書き方 | LD/di1a-decisions.md:110、LD/nc1-decisions.md:90 | 残り | DI-1a「CP-4／PUB-G：送信の遅れ（最大 W = 4 s）の開示」。NC-1「PUB-G／Session C-1 の開示文…では『close() 起因の消失だけを数える』と限定して書く」 | Session C-1 の文言 |
| 45 | pin の自動化の段階 1（#744）が Graph の gate の内側にあること | 続行計画:10 | 残り（判断。旧：不明）（2026-11-16 に更新） | 事実は閉じた（2026-11-03 の調査 `cp4-quality-rest-and-pubg-unknowns-2026-11-03.md`：起点パネルと pin ボタンは `NIR1_GRAPH_UI_ENABLED` が true のときだけ出る＝PUB-G で Graph UI を開けると同時に有効になる。pin は作者の click だけで、保存範囲・送信先・IPC は増えない〔DR-SEEDSUG-5〕。CP-4 の測定は setup の pin で seed を与えており、このパネルの click は測定対象外。renderer の定数だけで出るので、Native の gate が閉じていても出て pin を書ける）。承認範囲に含めるかの記述は 2026-11-16 の時点でも読んだ範囲に無い | integrator が C-1 の承認の範囲に、起点表示と pin ボタンを明示で含めるかと、DR-SEEDSUG-4・-10 の暫定文言・focus の見直しを文言承認に載せるかを決める（判断 → C-1） |
| 46 | Session C-1 の承認そのもの | 続行計画:426（§9 停止点 4）、:177 | 残り | 「Session C-1: PUB-G と D2a の UI の承認」。続行計画:10（2026-10-31）時点で「未承認で閉じたまま」。以後の承認の記録は見つからない | ユーザーの承認（§2） |

### 1.7 追記の行（2026-11-09 の行 A・B を表の本体に入れた。2026-11-16）

| # | 前提の項目 | 出典 | 状態 | 根拠 | 残りなら誰の何が要るか |
|---|---|---|---|---|---|
| 47 | 維持の dependency-verify の取消しの連打 → registration の refused → Graph の slot の Suspended（旧「行 A」。DR-CP4-L-27 の続き） | §5 の行 A、DR-CP4-S6-4（#842）、DR-MPS-15（PR #843、master `4594820d`）、DR-MP-8（PR #859、master `12d62ee0`）、`user-confirmation-2026-11-15-s7r2-acceptance.md` | 済み（実装＋正式 run 1 回の観測。2026-11-16 に更新。旧：残り） | (c) 維持の連続 preempt の backoff（DR-MP-8、#859）と (f) Related Scenes の周期処理が維持の接続を見たら取り消さず tick を飛ばす（DR-MPS-15、#843）が merge 済みで、s7r2 の候補 `29a120dd` に入っている（#859 と #843 の対応づけは s7r2 の S7 報告も PR の題からの読みと書く）。dev の A/B は DR-MPS-15 が a2 型で 3/3。**s7r2 の Gold で連鎖は起きていない**（`G-03/frontier-exceeded` の 35 sample は `graph-late`、slot `empty`。前回は `registration-unavailable` 30／`suspended` 23）。(g)（LP-GATE を維持の cycle にも広げる）は 2026-11-15T11:23Z ごろ、ユーザーが「不要として閉じる (Recommended)」を選択し、着手しない。(a′)（refused を drift と incomplete に分ける）は DB 段 1 の PR-2（#881、DR-DBC-5）に含まれず（`LD/db-connection-decisions.md` の DR-DBC-5「触れないもの」に PR-3 と並べて明記）、窓を縮める lane の DR-GRW でも「やらないこと」（`LD/graph-registration-window-decisions.md`）で、契約の変更として保留のまま。**限界**：Gold は 1 回だけで、前回の V-10 は確率的（S7 §3）。この項目は次の S4（9 回目）の run でも再確認される（#15） | — |
| 48 | frontier の上限超過の Graph を製品経路で全体拒否することの端から端の検査（旧「行 B」） | §5 の行 B、`nir1_graph/tests.rs`（`graph_entities_at_50_is_available`、`graph_entities_at_51_refuses_the_whole_graph`、`two_hop_limit_stops_before_a_third_hop`）、`s7-report-s7r2/README.md` §3 | 残り（実装・測定。2026-11-16 に確認：状態は変わらず） | `G-03/frontier-exceeded` は s5r5・s5r6・s6r1・s7r1・s7r2 のどの正式 Gold でも期待の理由（製品の reason 語彙では `limit`、受領書では `graph-limit-exceeded`）が観測されていない（s7r2 は `limit` 0。35 sample すべて `graph-late`）。機構は Rust の unit test で検査済み。この variant は pool に入らないので欠落の結論には効かないが、S7 報告は PUB-G の前提として載せてある | 凍結外の dev fixture か integration で、端から端の検査を足す（実装・測定） |

（数え方（2026-11-09 時点）: 済み＝#1〜4、8、17〜20、22〜28、31、34 の 18 行。不明＝#6、7、11、15、16、30、45 の 7 行。残り＝それ以外の 21 行。2026-11-16 の最新の集計は §6。）

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
- **#11（CP-4 の品質の条件）の充足の形（2026-11-09T03:10:38Z にユーザーが (i) を選択。`user-confirmation-2026-11-09-s7r1-acceptance.md`。次の S4（9 回目）で測る。DB 段 1 の PR-3 の S4 再凍結と束ねる。今始める承認ではない。2026-11-09 の決定時は「8 回目の S4」と呼んだが、2026-11-15 の「凍結はそのまま」で 8 回目＝s7r2 は再凍結しない run になったため、再凍結を伴う S4 は 9 回目へ繰り下がった）**：品質判定 v2（補助）の not-evaluable は、既存 24 件の Graph arm の受領書が無い、evidence の 4 項目（utf16-range、explicit-pin-association、raw-excerpt-unchanged、added-scene-body-anchor）が受領書に無い、禁止寄与の (c)。(i) 次の S4（9 回目）で受領書の形を広げて測る（受領書を作る `k64-record.mjs`・`receipt.mjs`・`availability.mjs`・`frozen-k64-run.mjs` は S4 の pin。DB 段 1 の PR-3 の S4 再凍結と束ねて S4 を 1 回で済ませる。推奨）、(ii) 開示して受け入れる。K6/2:620 は「Evidence 100%、禁止寄与 0」を Positive の条件に含むので、not-evaluable のまま PUB-G に進むのは合格基準の黙示の変更に近い。
- **#15（CP-4 の候補と PUB-G の最終候補の差の扱い）**：どの製品修正も候補を変えるので CP-4 の receipt は旧候補に束縛される（K6/2:624「候補…が変わったら失効」、K6/4 変える点 12）。DB 接続の段 1（4,000〜6,000 行）でも必ず起きる。持ち越しの規則は読んだ範囲に無い（不明のまま）。これが PUB-G の本当の前提で、製品の連鎖の lane が新しく作る問題ではない。
  - **持ち越しの規則（2026-11-16 のユーザー決定 Q7、`user-confirmation-2026-11-16-pr3-q5-q7.md`、contracts `f7ea87a6`）**：PUB-G は、次の S4（9 回目の凍結のやり直し）の下の正式 run（K6/7、凍結済み `b9559a22`）の結果を正とする。s7r2 の結果は新しい候補へ持ち越さず、参考として開示する。


## 6. 追記（2026-11-16。付け直し）

読んだ版：master `3948eeb2`（#911 の merge）、contracts `a8c3cf92`。コードと PR の状態は `git show origin/master:<path>` と `git log origin/master` の merge commit の題で確かめた（`gh` は使っていない）。この追記は公開・有効化の判断をしない。`PRODUCT_GRAPH_PUBLISHED` と renderer の 4 定数は master で `false`（#1・#2 を再確認。該当 file の 2026-11-03 以後の commit も無い）。表の 48 行すべてを照合し、変えた行は状態欄に「（2026-11-16 に更新）」と付けた。行は消していない。

### 6.1 新しい集計（48 行）

- **済み 28**：#1〜4、7、8、9、10、16、17〜20、22〜28、31、33、34、36、37、39、40、47
- **残り 19**：#5、11、12、13、14、15、21、29、30、32、35、38、41、42、43、44、45、46、48
- **不明 1**：#6（A3 consumer activation の証跡。理由は #6 の行）

前回（2026-11-09 の追記まで）は 済み 18／残り 23／不明 7（計 48 行。行 A・B を残りに数えた）。

### 6.2 前回からの変化（済み 18 → 28、残り 23 → 19、不明 7 → 1）

**残り・不明 → 済み（10 行）**

| # | 変化 | 根拠（merge と記録） |
|---|---|---|
| 7 | 不明 → 済み | G-2 の [precheck] は CQ-LIM-2・3 で解除済み（PR #678、`a789039a`）。l6-l9:40 の状態欄は文書が古いだけ。開示 2 点（製品形でちょうど 2,097,152 B は未作成、超えれば Graph は unavailable）を C-1 に |
| 9 | 残り → 済み | s7r1 は 2026-11-09、s7r2 は 2026-11-15 に AskUserQuestion で確定（`user-confirmation-2026-11-09-s7r1-acceptance.md`、`user-confirmation-2026-11-15-s7r2-acceptance.md`）。公開・PUB-G の承認ではない。次の S4 の run には改めて確定が要る |
| 10 | 残り → 済み | PR #780 merge（`51981e81`） |
| 16 | 不明 → 済み（評価 build・Linux） | DR-PUBG-16-1（#822、`19598c30`）で実 Native の end-to-end に 3 回到達。CP-4 の判定外の診断（s6r1・s7r1・s7r2）でも `reachedEndToEnd: true`。限界は 3 OS 未確認、製品 `.node` は `not-activated` |
| 33 | 残り → 済み | DR-PUBG-33-1（#817、`2cb73eec`）。実機の dialog の見え方は未確認 |
| 36 | 残り → 済み | DR-PUBG-36-1（#814、`7ea2114a`）、DR-PUBG-36-2（#818、`a5371fd0`） |
| 37 | 残り → 済み | DR-PUBG-37-1（#811、`4208ea8c`） |
| 39 | 残り → 済み | DR-PUBG-39-1／39-2（#820、`1e6b3e0b`） |
| 40 | 残り → 済み | DR-PUBG-40-1（#902、`663d6da6`）と、起動時 graph の測り直し（DR-CB3-35 (3)、2026-11-15。定数 true でも raw 差 0） |
| 47（旧 行 A） | 残り → 済み | #843（DR-MPS-15）、#859（DR-MP-8）が候補 `29a120dd` に入り、s7r2 の Gold で連鎖なし。(g) は 2026-11-15 に不要として閉じた。Gold は 1 回だけという限界つき |

**不明 → 残り（4 行。理由が分かった）**：#11（品質判定 v2 の所在と not-evaluable が分かり、次の S4 で測る）、#15（規則は Q7 で決定。残りは次の S4 の run）、#30（3 定数 true の現行 build が未測定。余裕は raw 96,490）、#45（事実は閉じ、承認範囲の判断が残る）。

**不明のまま 1 行**：#6。**状態は同じで根拠だけ更新**：#8（s7r1・s7r2 を追加）、#14（P3-6 は #784 で対処済み。ほかは未照合）、#13（検索したが新しい記録なし）、#12（開示の正本を s7r2 の §6 に）、#24（s7r2 で Suspended の連鎖なし。ただし復帰が働いた確認ではない）、#41（form の一瞬の消失は #39 で対処済み）。**新たに表へ入れた行**：#47・#48（§5 の行 A・B）。**再確認して変更なし**：#1〜#5、#17〜#23、#25〜#29、#31・#32、#34・#35、#38、#42〜#44、#46（#32 は #867 の layout 変更の後の位置を再測していない）。

**§3 の「確かめられなかったこと」の更新**：1（品質と P）は #11 のとおり一部が判定済みで、残りは次の S4。2 のうち DR-CP3A-55 は #16 で解消、A3 は #6 のまま。3（G-2）は #7 で解消。9（#36・#37）は上の merge で解消。7（`cbf33077` 以後の master の canonical Full の green、最終候補の Full／Quick の扱い）、4・5・6・10 は今回も確かめていない。8（定数 true の起動時 JS）は #30 で一部更新した。

### 6.3 残り 19 行の種類別

- **実装・測定の工程（3）**：#5（B の production registry・policy の行・wake 源と再構築の頻度・refusal の UX。integrator の技術判断＋実装）、#32（左下の表示の置き場所。scene の状態の button を覆う、phone 幅の nav との交わりの測定）、#48（frontier 上限超過の端から端の検査）。
- **Session C-1 の文言・承認（8）**：#12（CP-4 の開示文）、#29（K3/2 の文面の改め）、#41（宣言の確認ダイアログの日本語固定の扱い、実機の再確認）、#42（K3/3 の開示 7 の (a)）、#43（`shell.openExternal` を開示に入れるかは integrator の判断 → C-1）、#44（送信の遅れ W = 4 s、NC-LISTENER-LOST の限定）、#45（pin 自動化・起点表示を承認の範囲に含めるか。判断 → C-1）、#46（C-1 の承認そのもの）。公開・有効化・文言の承認はユーザー。
- **測定（4）**：#11（次の S4＝9 回目で not-evaluable の受領書を広げて測る。S4 の失効・再凍結は個別にユーザー確認）、#15（9 回目の S4 の下の正式 run＝K6/7、凍結 `b9559a22`。DB 段 1 の PR-3 は実装中。run の結果の確定）、#21（PUB-G の最終候補で `packaged-smoke.yml` を dispatch し直す）、#30（3 定数を true にした build の `perf:budget`）。
- **判断（4）**：#13（IR の edge を持つ Scene を編集する trace の事前登録。integrator とユーザー）、#14（最終関門の P3＝S2 の文面を次の S2 改版で直すか。9 回目の S4 の再凍結と同時に扱えるかは未確認）、#35（phone 幅の合成の終端の toast の置き場所。予算に影響）、#38（`restart-required` の文言を IR の到着に依らず出す経路）。
- **不明（1）**：#6（integrator が A3 の理由 5 種の集計と、未演習の軸の扱いを決める）。

### 6.4 注意

- PUB-G の判定に使う CP-4 の結果は、Q7（2026-11-16）により **9 回目の S4 の下の正式 run** になった。s7r2 の合格は参考の開示で、#8・#9・#47 の「済み」はその前提つきである。この run が通るまで、#11・#15 は残る。
- 済みにした行の多くは「実装・試験」であり、実 Electron の UI・3 OS・実機の体感を確かめた意味ではない（#16・#33・#36・#37 の限界の記述を参照）。
- 次の S4 の後・C-1 の前に、この一覧をもう一度付け直す。

## 2026-11-16 追記 2：古い記述の訂正（本文は書き換えず、ここで読み替える）

棚卸し（`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/pubg-remaining-triage.md`、master `f885c6da` 基準）で、古くなった記述が 3 つ見つかった。

1. **#11 の P の上限**：見出しと 14 行・135 行の「Hybrid p95 ≤ 65.04 ms」は、K6/5（`docs/plans/nir1-final-request-eval-proposal-5-draft.md:7,17,32`、変える点 R-4）で **94.2 ms**（B=54.2 ms ＋ D=40 ms）に変わっている。K6/6・K6/7 は、この値を変えていない。
2. **#14 の「6 回目の凍結」**：今の S4 は **9 回目**（枝 `claude/s4-9-pr3`）。S2 を改版すると、その時点の凍結のやり直しと再測定になる、という趣旨は変わらない。P3 の扱いは、9 回目の S4 の記録とまだ照合していない。
3. **#11・#15 の「S4 の失効・再凍結は個別にユーザー確認」**：確認は済んでいる。`user-confirmation-2026-11-16-refreeze-9th-and-r5.md`（`7a03eaf9`）の「失効して進める」「S4 の PR の merge まで一括」。

あわせて、(A) の 8 件（#5、#6、#30、#32、#35、#38、#41、#48）への着手を、ユーザーが 2026-11-16 に回答した（`user-confirmation-2026-11-16-setup-quiesce-and-pubg-a.md`、`337ff239`）。残りの件数は、各件が閉じたときに更新する。
