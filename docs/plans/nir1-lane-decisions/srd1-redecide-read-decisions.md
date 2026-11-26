# 判断の記録：SRD/1 の RD（承認し直せる提案の読み取り。RD1・RD2・RD3・RD5）

確認済みの行は、台帳 `docs/plans/nir1-l6-l9-execution-plan.md` の `nir1-chronicle-scene-review-apply-delta/1#chronicle-applied-proposal-redecide`（RD1〜RD6 を含む）と `nir1-chronicle-scene-review-apply-delta/1#caller-profile-egress`（確認 139、2026-11-23、blockedReason none）。RA の判断は `srd1-reapproval-decisions.md`。

## この PR の範囲

RD1・RD2（場面の提案の一覧の item）、RD3（作品全体の一覧の新しい読み取り）、RD5（年表の「AI 抽出」の review bundle の提案）の Native・napi・IPC・TypeScript の型と wrapper・方針の登録・試験。画面（RA7）と復元の確認の件数（RD6）は、後の PR。

## DR-SRD-RD-1　own-data-read に足す根拠

`electron/main/profileEgress.ts` は、own-data-read に命令を足すには新しい draftRef が要るとする。台帳の `caller-profile-egress` の SRD/1 の行が、命令 `narrative_extraction_list_redecidable_proposals` を名指しで own-data-read に足すと書き、それが求められる draftRef に当たる。行は「40 本から 41 本」と書くが、その後に別の作業が命令を足したので、実際は 43 本から 44 本になる。命令は名前で固定されているので、範囲は変わらない。区分のコメントと固定の試験の件数を、実際の 44 に揃えた。review bundle の命令は既に own-data-read で、返す項目を足すだけ（命令は増えない）。

## DR-SRD-RD-2　判定の共有

RA の判定を、事実の読み取りと、DB に触らない判定に分けた。RA は 1 件分の事実を読み、書く直前にもう一度判定する（今までと同じ）。場面の一覧・review bundle・作品全体の一覧は、ページの提案の事実を 1 本の SQL でまとめて読み、同じ判定に通す。読み取りでの「入力の版」は、提案の現行の版。理由の符号ごとに、4 か所の判定と RA の飛ばす理由が一致することを試験で固定した。

## DR-SRD-RD-3　表示の項目の決め方

- `rejectedBy` は、最新の決定が本体の却下（出来事の削除による、現行の版の却下）であるかだけで決める。出来事が無い・取り込みの記録が無いときも `event-removed` を返す（承認し直せるかとは別に、外れた事実を見せる）。
- `removedVia` は、決定の記録の文字列をそのまま返さず、6 種の閉じた列挙に写す。知らない値と欠けた値は `null`。
- キー名は `rejectedBy`・`removedVia`・`rejectedAt`・`reapproval: { available, reason }` で、3 か所とも同じ。`reason` は承認し直せるときは `null`、そうでないときは RA と同じ 6 種の符号。
- 平文は足さない（列挙・時刻・真偽・符号だけ）。review bundle では、今の年表の review のときだけ付ける（まとめて承認の項目と同じ条件）。条件の外では欄が無い。

## DR-SRD-RD-4　作品全体の一覧（RD3）の形

- 並びは提案の id の昇順。cursor は前のページの最後の提案の id（場面の一覧と同じ形）。
- 1 ページは既定 20 件・最大 50 件（場面の一覧と同じ）。大きい値は切り詰め、0 は拒む。
- `total` は承認し直せる提案の件数。ページごとに作品全体の取り込みの記録を 1 回走査する（設計 §2.3 が挙げた費用）。
- 根拠の場面の id は 16 件まで、超えたら `evidenceSceneIdsTruncated`。根拠の引用と本文は返さない。
- DB のエラーは、ページ全体の失敗（`NEX_REDECIDABLE_PROPOSALS_READ_FAILED`）。
- 読み取りの transaction の中で読み、関数の本体に書き込みを持たない。AI の道具・MCP の道具には足さない（試験で固定）。

## DR-SRD-RD-5　review bundle は接続を直接使ったまま

足した項目の事実は、まとめて承認の項目と同じ接続の上で、続けて読む。review bundle 全体を読み取りの transaction で包むことは、しなかった。まとめて承認の判定（`attach_bulk_approval`）が自分で transaction を始めるので、外から包むと入れ子になって始められず、全部の提案が「素材が読めない」になる（試験で確かめた）。

## 計測

作品全体の一覧（RD3）の 1 ページ：取り込みの記録 5,000 件・承認し直せる提案 25 件・1 ページ 20 件で 12.9 ms（debug build、1 回。`measure_first_redecidable_page_5000_applications`、`#[ignore]` の試験）。SQLite の実行計画では、取り込みの記録の表を 1 回走査し、出来事は主キーで引く。1 ページの上限は、場面の一覧と同じ 50 件のままにした。「全部」を押す前に最後のページまで読むと、ページの数だけこの走査が起きる（未測定。設計 §7）。

## 残る制限

- 承認し直せると出ても、運用が止まっている間は、押すと失敗する（設計 RD2。読み取りでは運用を見ない）。
- 製品の既定では、年表の抽出の取り込み自体が閉じているので、製品の DB では一覧は空になる。
