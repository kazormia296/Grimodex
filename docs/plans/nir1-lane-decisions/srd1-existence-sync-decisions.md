# 判断の記録：SRD/1 の X（出来事が年表から無くなったら、提案の承認を外す）

設計は `docs/plans/nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md`（行の確認は確認 138）。ここには、実装で決めた技術の判断と、見つけたことを残す。

## DR-SRD-X-1　書き手

- 決定を書くのは、`repository.rs` の新しい関数 `append_event_existence_decisions_in_tx` だけ。transaction の中でないと失敗する。
- 既にある `append_decision_on_conn`・`append_decision_on_conn_with_reuse` は変えない。本体の SHA-256 を試験で固定する。
- X2 の対象は、1 回の探索で引く。`narrative_proposal_applications` を結合の外側に置き、出来事の id の集合は `json_each` で渡す。索引は足さない（大きい作品で測ってから決める）。
- 型付きの Entity／Relation の提案には働かない（X3 (2)）。
- 決定の表（`narrative_proposal_decisions`）に追記する本番の関数は 2 つだけで、`narrative_scope_storage_authority.rs` の `proposal_decision_writer_inventory` が固定する。
- 試験は `grimodex-db/src/event_existence_tests.rs`（`repository.rs` の試験 module から `include!`）。製品の削除の入口を通すので、「`narrative_extraction` の下のコードは writer を呼ばない」という境界の検査の対象の外に置く。検査と許可の一覧は変えていない。

## DR-SRD-X-2　入口と `removedVia`

| 入口 | 場所 | `removedVia` |
| ---- | ---- | ------------ |
| 単体の削除 | `agent_writes.rs`。DELETE の直後 | 画面は `screen-delete`。main が固定する route `interactive-agent-command` は `agent-delete`。MCP の surface は `mcp-delete` |
| まとめて削除 | `chronicle_bulk.rs`。処理の後に 1 回 | `screen-delete` |
| 元に戻す・やり直す | `event` の journal は `row.entity_id`、`chronicle_bulk` の journal は「あり→なし」の枝で id を集める | `undo-redo` |
| スナップショットの復元 | `project_snapshots.rs`。出来事を入れ替えるときだけ、前にあって後に無い id | `snapshot-restore` |
| 取り込みの取り消し | `narrative_extraction/undo.rs`。消した出来事の id をまとめて 1 回 | `commit-undo` |

共有の `delete_event_cascade` には置かない（X4）。出来事を消す呼び出し元の集合は、`narrative_scope_storage_authority.rs` の試験で固定する。

## DR-SRD-X-3　失敗の扱い

- 却下の書き込みは、削除と同じ transaction。書けなければ、操作の全部が失敗して戻る（X5）。
- 元に戻す・やり直すの中の書き込みの失敗だけに、`NEX_EXISTENCE_SYNC_FAILED:` を付ける。元のエラーは Native のログに残す。
- renderer は、この符号を version の衝突の文言より先に判定し、履歴の 2 つの積みを変えない（HK2・HK3）。

## DR-SRD-X-4　期待を変えた既存の試験（設計 §7 の「読んで書き換える」）

「取り込み → 取り込みの取り消し → やり直し」の後も、承認が残ることを期待していた 2 件。設計の表と確認 138（出来事が戻っても承認は自動では戻らない）に合わせた。印の無い出来事が戻ることの確かめは、残した。

- `tests/narrative_extraction.rs` の `current_chronicle_unmarked_event_survives_undo_and_redo`：提案は却下（`removedVia` は `commit-undo`）。版と本文と封筒は変わらない。
- `tests/narrative_nir1_retrieval_admission.rs` の `edited_revision_apply_survives_undo_and_redo_as_unmarked_events`：2 つの版は、関連する過去シーンに使えない。

## 見つけたこと（X の前からの挙動。直さない）

- MCP の削除は、成功の後に同じ `request_id` を再送すると、Native の保存済みの応答に届く前の存在の確認で「見つからない」になる。二重の書き込みは無い。取り込んだ出来事は、MCP の経路では欄の所有の検査で消せない（試験で確かめた）ので、X の動きには影響しない。

## PR の前に残ること

- （済）§5 の 0 (c) と確認 59 の件数（2026-11-26、読み取り専用で件数だけ）：`fusion-eval-data` の下の DB 19 個のうち、取り込みの表がある 15 個は、出来事の取り込みの記録が 0 件。版の違い、承認でない提案、消された出来事の承認のままの提案は、どれも 0 件。残り 4 個は、表の無い測定用の DB。作者の手元の作品の DB は読んでいない（製品の取り込みは閉じている）。
- （済、読みで）HK1 の符号が画面に届くこと：Native の戻り値の文面の先頭が符号であることは試験で確かめた。その後の `app_err_to_napi`（`to_string`）、main の `toErrorString`（`message`）、renderer の分類（`includes`）は、読んで確かめた。実機では実行していない。
- （済）§5 の 0 (f)：取り込み済みで却下の提案を、review bundle の読み込み（Native と画面の側）、場面から提案を引く読み取り、IR の再構築が受け付けること。取り込みの取り消し・やり直しは、DR-SRD-X-4 の 2 件で確かめた。
- （済）§2.6 の X の追補：ADR 004・005・006 は、#1037 で追補済み。Gate B2 の checklist の文書と、「適用後の撤回の禁止」を言う 4 文書は、この変更で追補した。ADR 011 の読み（X は retract を製品に繋がない）は、ADR 004 の追補にある。
- **NIR0-CERT:156 の読み（起案者の読み。認証の文書は書き換えない）**：認証の範囲外の一覧の「Chronicle `revise`, `retract`, `merge`, and `split`」は、今もそのとおり。X が書くのは、出来事が無い解釈を関連に使う許可を外す却下で、Projection の撤回ではない。
