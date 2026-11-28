# Write-Safety Gate A A2：対象の読み口（判断記録）

- 状態：技術判断（2026-11-29）。読み口まで。製品の呼び手は無い。schema、`ipc.ts`、`ipcContract.ts` は変えない。
- 根拠：確定した [A2 判断記録](gate-a2-approval-decisions.md) の DR-A2-4・5・10・11 と第 6 節。版の列が無い 4 本の Native の照合は [gate-a2-target-check-decisions.md](gate-a2-target-check-decisions.md)。

## 信頼境界

- 版・識別子・有無は main が DB から読む。モデルと画面の側の版・hash は根拠にしない。
- `modelInput` の id は信頼しない入力。すべての SELECT を `project_id` で縛る（`scene_events` は列が無いので `events` と `tree_nodes` の両方で縛る）。
- `summary` は交換の service がそのまま承認の Interaction に保存する。そのため名前・題・本文は入れず、読みもしない。モデルには戻さない（service の outcome に含まれない）。

## DR-A2R-1 形

- `createAgentApprovalTargetReader({ readDb }) → (request: { projectId, toolName, modelInput }) => Promise<AgentApprovalTarget | null>`。`AgentApprovalTarget` は `agentApprovalExchange.ts` の型をそのまま使う（`expected` は `kind` つき、4 本以外は `null`）。
- `readDb` は `CoreReadDbClient`（`createMainReadDb`）。SQL は `MAIN_READ_TABLES` の表だけで、`checkReadSql` を通る。
- 保護対象の一覧は `agentApprovalProtectedTools.ts` を import。一覧に無い tool は `null`。
- 読めない・形が合わない・版が safe integer でない・id が上限（256 byte）超は `null`（承認を開かない）。
- 対象の事実は対象ごとに 1 回の SELECT（JOIN）で読む。tree plan も 1 回の SELECT（`IN`）。

## DR-A2R-2 tool ごと

| tool                                                                | 対象の id                                           | basis                                                                      | baseVersions        | expected           |
| ------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- | ------------------ |
| create_codex_entry・create_foreshadow・create_snippet・create_event | なし                                                | null                                                                       | null                | null               |
| update_codex_entry・update_foreshadow                               | `id`                                                | その行の version                                                           | 1 件                | null               |
| update_event・delete_event・set_event_participants                  | `eventId`                                           | event の version                                                           | 1 件                | null               |
| stamp・unstamp_scene_event                                          | `sceneId`・`eventId`                                | `scene_event_link` の contentHash（有無と incarnation）と event の version | null                | `scene_event_link` |
| add・remove_event_relation                                          | `causeEventId`・`effectEventId`                     | `event_relation` の contentHash（有無）と両端の event の version           | null                | `event_relation`   |
| apply_ai_tree_plan                                                  | `ops` の move／rename の `nodeId`（重複なし・全部） | node の version（64 件か 32 KiB を超えるときは `tree_node_set` 1 件）      | 全 node（畳まない） | null               |

- `version` は文字列（port の型）。`sourceId` は行の id。組の対象は `JSON.stringify([a, b])`。
- `contentHash` は SHA-256（hex）で、固定した key 順の JSON から作る。並べ替えは code unit 順（`localeCompare` は使わない）。
- `linkIncarnation` は列の値のまま（`''` は「関係がある」、行が無ければ `null`）。
- create だけの tree plan は basis・baseVersions とも null。`agentTreePlanRequiresVersion` が null なら読み口も null。node が 1 つでも見つからなければ null。unique な node が 2000 を超える plan は null（2000 件の読みを実物の addon が受けることは 2026-11-29 に確かめた）。
- 自分自身への関係（cause = effect）は null。

## DR-A2R-3 summary

- `{ "v": 1, "tool", "count", "targets": [{ "kind", "id" }], "omitted"? }`。key の順は固定。
- 入れるのは、台帳の引数と `target_basis` に既にある値（種別と id）だけ。永続の保存範囲を増やさない。
- `count` は対象の全件数。`targets` は 50 件まで（超えた分は `omitted`）。64 KiB を超えるときは `targets` を削る。
- 新規作成は対象が無いので `count: 0`。モデル由来の値は入れない。
- 画面に出す名前や書き換えの前後は、この読み口では作らない。表示の中身を照合値と同じ時点から作ること（DR-A2-3）は、実接続の変更で決める。

## 限界（PR 本文にも書く）

- `delete_event`：この変更では event の版だけを根拠にする。参加者・場面との紐付け・関係の変化は、利用者の回答（contracts の問 43、2026-11-29「止める」）により、次の PR で M3 が Native の子の照合を担当し、`expected` の形を[対象照合の判断記録](gate-a2-target-check-decisions.md)に記す。main の読み口はその形に合わせる。出来事の付箋は照合に含めない（削除の取り消しで戻らないのは今の製品の不具合で、別の担当）。
- 読みと書き込みの間の窓：版つきの対象は Native の版の照合が、版の列が無い 4 本は Native の期待状態の照合が、書き込みの transaction の中で防ぐ。`delete_event` の子の状態（上の項目）と、tree plan の挿入位置の兄弟は、書き込みの時には照らさない。

## 呼び手の約束（実接続の変更で守る）

- `observed` には同じ読み口の結果を渡す。`null` のままだと、版つきの 6 本と版の無い 4 本は `target_changed` で拒まれる。
- `expected` は Native の request hash に入るので、同じ requestId の再送は同じ値。

## 版の進み方（確かめた事実）

- `tree_nodes.version`：本文の保存（`scene_body.rs`）で進む。子の追加・削除では親の版は進まない。
- 紐付けと関係の付け外しは event の版を進めない。
- 手の改名・移動・並べ替えは版を進めない。その後の AI の tree plan は、人が書いた欄の保護（field authority の `/title`・`/parentId`）が拒むので、上書きは起きない（2026-11-29 に実物の addon で確かめた）。
- `codex_entries`・`foreshadows`・`events` の手の名前・題の更新は版を進め、古い版の AI の更新は拒まれる（2026-11-29 に実物の addon で確かめた）。
