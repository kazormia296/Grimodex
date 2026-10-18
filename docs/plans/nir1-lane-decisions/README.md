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
| [x1a-decisions.md](x1a-decisions.md) | X1-1（DR-X1-1。実装中） | integrator の作業領域の写し（mutation の前の記録） |
| [cqavail-decisions.md](cqavail-decisions.md) | CQ-AVAIL（DR-CQA-1〜5） | 同上（DR-CQA-4、5 はレビュー指摘の修正の前に足した記録） |
| [cqmem-decisions.md](cqmem-decisions.md) | CQ-MEM（DR-CQM-1〜2。実装中） | 同上 |
| [x1-2-decisions.md](x1-2-decisions.md) | X1-2（DR-X1-2-1〜14。S1〜S4: T 方式、Scope 世代の条件つき進行、POV の NULL 化、方式 J1、writer 網羅の manifest） | 確認済み契約 X1/1 の「実装で決めること」の記録 |
| [cb1-decisions.md](cb1-decisions.md) | CB-1（DR-CB1-1〜11。S1〜S4 実装済み） | 同上（mutation の前の記録。K2/4 の `scope-storage-authority`） |
| [dp-h-decisions.md](dp-h-decisions.md) | DP-H（DR-DPH-1〜68。DPH-1 の契約・scorer・parity ベクトル、DPH-1b の期待値 template とそのレビュー修正、DPH-2 の fixture・期待値・freeze〔pending-review〕、DPH-3 の評価 feature・capture・baseline arm・置き場の検査・build capabilities、DPH-4 の harness・case の setup・receipt・runner・登録まで。evidence の実行は freeze 待ちの HOLD。実装中） | 同上（mutation の前の記録と、実装後の追記） |
| [proposal7-measurement/](proposal7-measurement/measurement-record.md) | proposal/7 の測定の記録（`harness/`、`raw.tar.gz`、`SHA256SUMS`）。CQ-LIM-1〜4 の再測はこの harness で行う | `claude/nir1-contracts` の `40d10adf` を byte 同一で取り込み（Session B2。[確認台帳](../nir1-l6-l9-execution-plan.md)）。委任判断の記録ではなく、確認された draft が引く測定の記録 |
| [df-plus-decisions.md](df-plus-decisions.md) | DF+（DR-DFP-1〜26） | 同上（mutation の前の記録） |
| [dt4-decisions.md](dt4-decisions.md) | DT-4（DR-DT4-1〜9a。T1〜T4: 予約 namespace と汎用 append の閉鎖、AI 使用ポリシーの検査〔B-2〕、bounded な監査 writer と終端・sweep の同梱〔S16〕、route 登録と文書・分類） | 同上（mutation の前の記録） |
| [hs1-decisions.md](hs1-decisions.md) | HS-1（DR-HS1-1〜。HS1-1〜HS1-4） | 確認済み契約 K4/3 の「実装で決めること」の記録 |
| [x1-3-decisions.md](x1-3-decisions.md) | X1-3（DR-X1-3-1〜20。投影 Source の定義・解決・登録・feed routing、型付き Revision の版 2、B の preflight、Scope の形の検査、doc-sync） | 確認済み契約 X1/1 の「実装で決めること」の記録 |
| [da1-decisions.md](da1-decisions.md) | DA-1（DR-DA1-0〜。ST1: 隔離の固定と書出し経路の遮断〔SF-1、E-3、窓の title、Y-1〕、ST2: 外へ出す経路の閉鎖と `license-control`、ST3: 読取の開放の実装〔開放の commit を除く〕、ST4: NIR の区分・Scope の Native の検査・parity の道具・文書） | 確認済み契約 K3/2 の「DA-1 が決める」ことの記録（mutation の前の記録と、subtask ごとの追記） |

復元した7本は、2026-10-14 の worktree の片付けで、gitignore の対象（`.ralph/`）の置き場所ごと消えたものである。PROVENANCE.md に、ファイルごとの最終版の根拠、確からしさ、PR 本文との差を書いた。PR 本文との差は、decisions 文書が最後に書かれた後の修正か、PR の側の書き足しによるもので、復元の誤りではない。

decisions 文書の中の相対パス（`cp2a-task.md`、`.ralph/` の下のファイルなど）は、書かれた当時の worktree や作業領域のものである。
