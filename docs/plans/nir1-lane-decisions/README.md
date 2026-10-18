# NIR-1 のレーンの判断記録

[続行計画](../nir1-continuation-2026-10.md) の §3.2 の形式で、各レーンが mutation の前に残した委任判断の記録と、その根拠を書いた decisions 文書を置く（§3.3）。どれも当時の判断の記録で、契約の確認ではない。後から本文を直さない。後の変更は、各レーンの PR 本文と続く記録に書く。

| ファイル | レーン（PR） | 出所 |
|---|---|---|
| [dt1-decisions.md](dt1-decisions.md) | DT-1（#634） | 会話記録から復元（[PROVENANCE.md](PROVENANCE.md)） |
| [dt2-decisions.md](dt2-decisions.md) | DT-2（#642） | 会話記録から復元 |
| [dt3-decisions.md](dt3-decisions.md) | DT-3（#637） | 会話記録から復元 |
| [cres-decisions.md](cres-decisions.md) | CR-1／CR-1b（#636） | 会話記録から復元 |
| [hp-decisions.md](hp-decisions.md) | HP-1（#632） | 会話記録から復元 |
| [cp1-decisions.md](cp1-decisions.md) | CP-1（#641） | 会話記録から復元 |
| [broute-decisions.md](broute-decisions.md) | B-ROUTE（#643） | 会話記録から復元 |
| [cp2a-decisions.md](cp2a-decisions.md) | CP-2a（#655） | integrator の作業領域の写し |
| [x1a-decisions.md](x1a-decisions.md) | X1-1（DR-X1-1。#662） | integrator の作業領域の写し（mutation の前の記録） |
| [cqavail-decisions.md](cqavail-decisions.md) | CQ-AVAIL（DR-CQA-1〜5。#663） | 同上（DR-CQA-4、5 はレビュー指摘の修正の前に足した記録） |
| [cqmem-decisions.md](cqmem-decisions.md) | CQ-MEM（DR-CQM-1〜2。#664） | 同上 |
| [x1-2-decisions.md](x1-2-decisions.md) | X1-2（DR-X1-2-1〜14。S1〜S4: T 方式、Scope 世代の条件つき進行、POV の NULL 化、方式 J1、writer 網羅の manifest。#670） | 確認済み契約 X1/1 の「実装で決めること」の記録 |
| [cb1-decisions.md](cb1-decisions.md) | CB-1（DR-CB1-1〜11。S1〜S4。#673） | 同上（mutation の前の記録。K2/4 の `scope-storage-authority`） |
| [dp-h-decisions.md](dp-h-decisions.md) | DP-H（DR-DPH-1〜76。DPH-1 の契約・scorer・parity ベクトル、DPH-1b の期待値 template とそのレビュー修正、DPH-2 の fixture・期待値・freeze〔pending-review〕、DPH-3 の評価 feature・capture・baseline arm・置き場の検査・build capabilities、DPH-4 の harness・case の setup・receipt・runner・登録、DPH-4 レビュー修正〔freeze の前の Native 観測の遮断と記録、gate の強化、X1-3 後の base〕まで。版 1 は観測済みで freeze できない。#677 で master にあるのは harness まで。evidence の実行は、新しい fixture と freeze 待ちの HOLD） | 同上（mutation の前の記録と、実装後の追記） |
| [cq-lim-decisions.md](cq-lim-decisions.md) | CQ-LIM（DR-CQL-1〜15。CQ-LIM-1〜4、X1-3 の後の再測〔DR-CQL-12。registration の使用量の条件で [precheck] 停止〕、registration の増幅の修正と再測〔DR-CQL-13、14。[precheck] は実装で解消し、proposal/8 は不要〕、G-03 の re-freeze〔DR-CQL-15〕。#678） | 同上（実装と同じ commit に記録） |
| [proposal7-measurement/](proposal7-measurement/measurement-record.md) | proposal/7 の測定の記録（`harness/`、`raw.tar.gz`、`SHA256SUMS`）。CQ-LIM-1〜4 の再測はこの harness で行う | `claude/nir1-contracts` の `40d10adf` を byte 同一で取り込み（Session B2。[確認台帳](../nir1-l6-l9-execution-plan.md)）。委任判断の記録ではなく、確認された draft が引く測定の記録 |
| [webrtc-closure-measurement/](webrtc-closure-measurement/measurement-record.md) | K3/3（`nir1-d2a-activation-proposal/3`）の測定の記録（`harness/`、`records/`、`SHA256SUMS`）。NC-1 の G-open の再走と、記録の判定の道具（`harness/webrtc-block-probe-verdict.mjs`）はこの harness を使う | `claude/nir1-contracts` の `14141248` を byte 同一で取り込み（Session B3。[確認台帳](../nir1-l6-l9-execution-plan.md)）。委任判断の記録ではなく、確認された draft が引く測定の記録 |
| [df-plus-decisions.md](df-plus-decisions.md) | DF+（DR-DFP-1〜26。#669） | 同上（mutation の前の記録） |
| [dt4-decisions.md](dt4-decisions.md) | DT-4（DR-DT4-1〜9a。T1〜T4: 予約 namespace と汎用 append の閉鎖、AI 使用ポリシーの検査〔B-2〕、bounded な監査 writer と終端・sweep の同梱〔S16〕、route 登録と文書・分類。#671） | 同上（mutation の前の記録） |
| [hs1-decisions.md](hs1-decisions.md) | HS-1（DR-HS1-1〜25。HS1-1〜HS1-4。#675） | 確認済み契約 K4/3 の「実装で決めること」の記録 |
| [x1-3-decisions.md](x1-3-decisions.md) | X1-3（DR-X1-3-1〜20。投影 Source の定義・解決・登録・feed routing、型付き Revision の版 2、B の preflight、Scope の形の検査、doc-sync。#674） | 確認済み契約 X1/1 の「実装で決めること」の記録 |
| [da1-decisions.md](da1-decisions.md) | DA-1（DR-DA1-0〜34。ST1: 隔離の固定と書出し経路の遮断〔SF-1、E-3、窓の title、Y-1〕、ST2: 外へ出す経路の閉鎖と `license-control`、ST3: 読取の開放の実装〔開放の commit を除く。開放は未実施〕、ST4: NIR の区分・Scope の Native の検査・parity の道具・文書、レビュー指摘と hosted CI の修正。#676） | 確認済み契約 K3/2 の「DA-1 が決める」ことの記録（mutation の前の記録と、subtask ごとの追記）。末尾の「NC-1 の追記」（Y-1 の試走の訂正と WebRTC の finding の解消）は NC-1（#683）が足した |
| [dt5-decisions.md](dt5-decisions.md) | DT-5（DR-DT5-1〜30。11、12 の行は無く、24、25 に記録した。T0〜T4: 範囲〔IPC／N-API／gate を足さない〕、std だけの client と supervisor／I/O の2本の thread、grimodex-core の wire 層〔`nir1_local_wire`〕、data-less の成功 finisher の修正と owner の入口、終端の写像、byte の上限と期限〔K1b の数値の確定。draft の初期案のまま〕、取消・時限つき join・quarantine、3 OS の I/O の primitive〔`nir1_local_io`〕、受入れの網羅、主要な local server の実測〔未実施〕、Windows CI の修正と `SO_RCVTIMEO` の timeout 後の socket の状態〔DR-DT5-30。未解決〕。#680） | 確認済み契約 K5/3 の記録（mutation の前の記録と、subtask ごとの追記） |
| [hc1-decisions.md](hc1-decisions.md) | HC-1（DR-HC1-1〜25。枝番つき。HC1-1: reader の土台〔legacy／未知の版の除外、session の列挙、ordinal 0 の件数〕、HC1-2: 今回の文脈と記録した文脈の比較と有効期間、HC1-3: `CurrentQualifier` の production 実装、HC1-4: lineage の組立て・run の入口・予算の枯渇を候補ごとの除外にする・受入れの試験、HC-1a の実測〔DR-HC1-12。推奨値。数値は integrator が決める〕、各 subtask のレビュー指摘の修正。#681） | 確認済み契約 K4/3 の「実装で決めること」の記録 |
| [cb2-decisions.md](cb2-decisions.md) | CB-2（DR-CB2-1〜16 と、実装後・レビュー修正の追記。S1: Scene 本文の宣言と取消の writer〔COMMIT と lifecycle の edge の順序、COMMIT 不明の判定と quarantine、表示文、idempotency、本文の読取の上限の訂正〕、S2: MG-1 の grant〔`main_grant.rs`〕と `PrePublicationGate`・lifecycle observer、S3: Main の `mainGrant.ts`・CI seam・route 台帳、S4: pipeline の統合試験と分類。#682） | 確認済み契約 K2/4 の記録（mutation の前の記録と、subtask ごとの追記） |
| [nc1-decisions.md](nc1-decisions.md) | NC-1（DR-NC1-1〜49。S1: 設定の部品と LS-1 の listener、S2: 起動の統合・FC-1・順序の試験〔実行中の失敗の破棄を handler の外の tick へ。DR-NC1-18〕、S3: 実機の probe と G-open の道具、S4: 受入れの実行と記録・Y-1 の再採取・`OPEN_FINDINGS`・分類、レビュー指摘と Windows CI の修正。G-pub と `own-data-read` の開放 commit は含めない。#683） | 確認済み契約 K3/3 の記録（mutation の前の記録と、実装後の追記） |
| [nc1-g-open/](nc1-g-open/README.md) | NC-1 の G-open の記録（K3/3 のゲート表。Linux の実機。採取時の head は `fd549d4c`。JSON の記録、`verdicts.txt`、`SHA256SUMS`）。`electron/main/rendererContainmentGOpenRecord.test.ts` が記録を読んで合否を固定する。DA-1 の開放 commit はこの記録を引く（開放は未実施） | NC-1（#683）が採った実機の記録。委任判断の記録ではない |
| [di1c-decisions.md](di1c-decisions.md) | DI-1c（DR-DI1C-1〜14。S1: create と claim の防御〔期待する Scope binding と restore epoch の比較、作成時刻を Native の時計で決める〕、S2: Native の Revision 選択〔Exclude の規則〕と期待値の同じ snapshot での読取、S3: coordinator と dispatch 直前の再確認・digest の定義・寿命 60 秒、S4: 取消の結束〔registry〕・残余の観測〔A-18〕・DSN の追随。#684） | 確認済み契約 K4/3 と K6/2 の記録（mutation の前の記録と、subtask ごとの追記） |

復元した7本は、2026-10-14 の worktree の片付けで、gitignore の対象（`.ralph/`）の置き場所ごと消えたものである。PROVENANCE.md に、ファイルごとの最終版の根拠、確からしさ、PR 本文との差を書いた。PR 本文との差は、decisions 文書が最後に書かれた後の修正か、PR の側の書き足しによるもので、復元の誤りではない。

decisions 文書の中の相対パス（`cp2a-task.md`、`.ralph/` の下のファイルなど）は、書かれた当時の worktree や作業領域のものである。
