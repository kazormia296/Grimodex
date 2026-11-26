# 判断の記録：SRD/1 の RA（出来事を消して外れた承認を、作者が承認し直す）

設計は `docs/plans/nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md` の §2.2。ここには、実装で決めた技術の判断と、設計の文に足した読みを残す。

確認済みの行は `nir1-chronicle-scene-review-apply-delta/1#chronicle-applied-proposal-redecide`（確認 139、2026-11-23。台帳は `docs/plans/nir1-l6-l9-execution-plan.md`）。下書きの SHA-256 は `bb7bfbb90ca9dece6e409fc70c73ae7a378742f31b129da371419230b5518c4b` で、実装の時点の下書きと一致する。行の範囲には、脅威モデルの RA の分（§4 の H2′ の RA の分と H4′）が名指しで入る。

## この PR の範囲

Native の命令 `narrative_extraction_reapprove_applied_proposals` と、napi・IPC・TypeScript の型と wrapper まで。読み取りの追加（RD1〜RD3・RD5）、復元の確認の件数（RD6）、画面（RA7）は、後の PR。この PR の時点で、命令を呼ぶ画面は無い。

## DR-SRD-RA-1　書き手

- 決定を追記する場所は増やさない。X の `append_event_existence_decisions_in_tx` に、承認し直しの variant を足した。決定の表の書き手の静的な一覧（`proposal_decision_writer_inventory`）は変わらない。
- 既にある `append_decision_on_conn`・`append_decision_on_conn_with_reuse` は変えない。
- 判定は `reapproval.rs` の `judge_reapproval` 1 つにまとめ、命令（理由の符号を返す）と書き手（書く直前にもう一度判定し、通らなければ失敗する）の両方が使う。呼び出し側の判定だけを信じて承認を書く口を作らないため（設計 X3 (1)(2)：書き手の関数が自分で確かめる）。書き手を直接呼んでも拒まれることを、試験で固定する。

## DR-SRD-RA-2　設計の文に足した読み（どれも、通る範囲を狭める向き）

- 運用の検査（`require_narrative_extraction_allowed`）は、ほかの判定より先に行う（BAO/1 と同じ順）。
- 本体の却下は、却下の版も入力の版と一致することを求める。
- 提案の Application が指す出来事は、**全部**が今あることを求める（X は 1 つ消えれば承認を外すので、対称にする）。版の違う Application が混じる提案は `revision-changed` にする。

## DR-SRD-RA-3　登録

- `change-feed-writers.json` は、既にある人の決定の書き手（`narrative.proposal.append-human-decision`）と同じ形で登録した：経路は `interpreter-projection`、writerId は `narrative.authority`。新しい route と caller は足していない（設計 §2.6 の「足さないと登録できなければ止める」には当たらない）。
- 経路の control の一覧は、決定の書き手の登録の慣例に合わせた宣言である。RA は、自分では prepared commit も根拠の版の照合（source-basis OCC）も行わない。書くのは、取り込み済みの版の承認の記録だけで、出来事と版は書かない。根拠の鮮度は、今までどおり読む側が別に見る。

## DR-SRD-RA-4　まとめて承認と共有する部分

提案ごとの transaction、途中の停止、結果の集計は、BAO/1 の関数を一般化して共有する（理由の型と、失敗の符号の既定値を引数にした）。BAO/1 の応答は変わらない（理由の直列化は、前と同じ `code()`）。

## 残る制限

- この命令は、renderer のコードが、条件を満たす提案に対して、ボタンの操作なしに呼べる（確認 139 で伝えた点。渡せるのは project・提案・版の id だけ）。
- 承認し直した後の「取り込みの取り消し」は、出来事の版が取り込みの時と違うので通らない（確認 139 で伝えた点。まとめて削除して元に戻した場合を、試験で確かめた：`NEX_COMMIT_EVENT_EDITED`）。
- 下書きは、読み取りの命令（RD3）を「41 本目」と書く。その後に別の作業が命令を足したので、実際の番号はずれる（RD3 の PR で、実際の数に合わせる）。
