# Mastra 移行 MP-4c-2 の判断記録（renderer の engine 分岐）

- 状態：**草稿**。コード・確定した脅威モデルは変更しない。
- 基点：`origin/master`（作業依頼の指定）。
- 前提：[移行計画](mastra-migration-plan.md) の MP-4、[MP-4 判断](mastra-mp4-decisions.md) DR-MP4-26・29・31・57・58、[脅威モデル](mastra-migration-threat-model.md)。

## 1. 範囲

4c-2 は renderer 側の接続を 3 PR に分ける。宣言する tool の集合が main の集合内に収まる MP の直前に merge する（[移行計画](mastra-migration-plan.md:362)）。旗 L は閉じたまま。

1. engine 分岐、Mastra start の前の scene write flush、audit export registry の予約・完了。
2. authority watcher、quiescence lease 通知での cancel、進行中の send の abort。
3. `send-accepted` の表示位置、`finishReason: "length"` の結果値と画面表示、start 時に確定した会話への保存。

PR 3 は MP-5 の 5c と `chatTurnStoreActions.ts` を共有する。5c が turn の closure を callback で受け渡す形を先に確定し、その後に PR 3 を実装・merge する。並行する場合も、同ファイルの変更を先に統合する。

## 2. 確かめた事実

- 4c-2 の renderer 範囲は engine 分岐、Mastra 分岐に限る flush、authority watcher／lease cancel、pending start の直列化、audit export registry（[MP-4 判断](mastra-mp4-decisions.md:98-103)）。
- workspace 切替の drain は start の終了を期限なしで待つ。main の forced は drain 後。cancel は workspace lease 中も拒否されない（[MP-4 判断](mastra-mp4-decisions.md:766-772)）。
- watcher は project、chat authority、policy、license、scene の変化を監視する案。Q5 の残る窓は回答済みだが、確定脅威モデルへの追記は4c-2 PR時に再確認する（[MP-4 判断](mastra-mp4-decisions.md:717-730)、[移行計画](mastra-migration-plan.md:385)）。
- 実行中状態は `(chatSessionId, turnId)` で束ね、完了時に開いている会話でなく start 時の会話へ保存する要件（[MP-4 判断](mastra-mp4-decisions.md:2000-2003)）。
- 進捗 W2 は数値・識別子のみで本文を含めない。従って legacy の逐次本文表示と異なり、Mastra は終端でまとめて表示する（[MP-4 判断](mastra-mp4-decisions.md:1940)、[同](mastra-mp4-decisions.md:2025-2028)）。
- Chat Completions の `finish_reason: length` は現行経路で `end_turn` にまとめられる（[移行計画](mastra-migration-plan.md:295-299)）。
- 調査資料 `.codex-jobs/mp4c2-survey.out.md` はこの作業ディレクトリに無く、内容は未確認。

## 3. 判断（案）

- **DR-MP4C2-1 分割。** 第1節の3 PR とする。PR 1 は start の入口と登録、PR 2 は取消し lifecycle、PR 3 は結果・画面・保存を担う。
- **DR-MP4C2-2 identity と保存。** 実行状態を `(chatSessionId, turnId)` で管理し、保存先 conversation は start 時に固定する。終了時の現在選択値で上書きしない。
- **DR-MP4C2-3 lease と abort。** watcher が失効を検知したら既存 cancel 経路を呼ぶ。lease 取得時にも cancel し、start 時点で lease active なら start しない。drain の対象や意味は変えない（[DR-MP4-29](mastra-mp4-decisions.md:784-791)）。
- **DR-MP4C2-4 進捗・結果。** `send-accepted` は audit begin と送信直前の再確認が成功した後、provider 呼出しの直前に出す。begin 待ち中に Stop された未送信 request の通知を残さない。`finishReason: "length"` は通常完了と区別できる結果値として保持し、画面に途中終了を示す。途中本文を進捗 wire に追加する判断は第7節で確認する。
- **DR-MP4C2-5 共有部。** MP-5 5c の callback が closure を渡す形を先に統合し、PR 3 はその呼出し形に合わせる。handler 前後の authority 確認を維持する（[MP-5 判断](mastra-mp5-decisions.md:85)）。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 経路                  | owner                                                          | entry・終了／取消し                                                         | 失敗・有限性                                                                    |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| start と実行状態      | renderer の turn coordinator。key は `(chatSessionId, turnId)` | Mastra 分岐のみ。start 前 flush 後に登録し、terminal で解除                 | start 失敗も登録を解放。start は turn の終端まで settle                         |
| audit export registry | renderer の execution registry                                 | start 前に予約、terminal で完了。export の drain が待つ                     | reservation の失敗時は start しない                                             |
| watcher／lease        | renderer の turn coordinator                                   | authority 変化または lease 取得で cancel。terminal で購読解除               | cancel が失敗したら黙って継続しない。workspace drain を期限なしに延ばさない     |
| provider send         | main の turn owner                                             | send 中は abort signal を保持。forced／Stop は既存の owner lifecycle に従う | native の進行中処理は signal で止まるとは限らない。結果は既存の終端処理で閉じる |
| 結果表示・保存        | renderer の start 時 closure                                   | 受理済み send を表示し、固定した会話へ保存。terminal 後に callback を破棄   | length は別結果。遅延 callback が別会話を書かない                               |

## 5. 影響と PR の分け方

| PR              | 主な範囲                                                                | 主な受入れ                                                                                 |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 4c-2a           | engine 分岐、Mastra start 前 flush、pending start、audit registry       | legacy の呼出し順維持、flush 失敗時に start しない、registry の予約・完了・drain           |
| 4c-2b           | watcher、lease cancel、in-flight abort                                  | 条件ごとの購読、lease active 時 start 拒否、terminal で解除、切替 drain が高々1 sendを待つ |
| MP-5 5c → 4c-2c | closure callback の先行統合後、send 表示、length 結果、固定会話への保存 | begin 待ち中の Stop では accepted を出さない、length を区別表示、会話移動中の保存先を固定  |

N-API／Rust の新規経路はこの案に含めない。3 PR の各々で既存の wire と authority を確認し、追加契約が必要なら第7節の確認まで止める。

## 6. 脅威モデルへの影響

Q5 は legacy より弱い時間窓を受容済みだが、確定文書への追記は未承認。4c-2 PR の起案時に再確認する（[MP-4 判断](mastra-mp4-decisions.md:1879-1884)）。watcher の遅延中に対象が変わる窓、scene 切替後の保存・表示先、進行中 request の abort 到達性を残るリスクとして記載する。新しい送信先・保存先・authority を増やさない。脅威モデルの変更をこの草稿だけで確定しない。

## 7. ユーザーに確認する点

回答（2026-11-26）：停止の条件＝止める：workspace・project・AI の方針（projects.ai_policy の chat）・license。続ける：会話の切替（応答は start の会話に保存）、会話の対象の表示の移動、model と接続先の変更（その turn は始めた model のまま、次の turn から新しい model）、**場面の切替（メッセージを送った時点の場面で最後まで処理する。利用者「あくまでメッセージを送ったタイミングの現在の場面で処理するべき」）**。途中の本文は**少しずつ表示する**（W2 の「進捗に本文を含めない」を変える。送る先は開始した窓だけ。PR③で、脅威モデルの追記〔Q5〕と一緒に改めて伺う）。

| ID  | 問い                                                                                                                                                                                                                                                                                                                                                          | 推奨             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Q1  | DR-MP4-57(a)「scope の移動を cancel と扱わない」と DR-MP4-26 の watcher cancel の衝突について、どの変化を cancel 対象から外しますか。**推奨：workspace／project／chat session・authority／policy／license／scene の変化では cancel を維持し、scope 表示の移動だけを cancel から外す**。別の条件を外す場合は、Q5 の前提と脅威モデル追記も4c-2 PRで確認します。 | 推奨案           |
| Q2  | 途中の本文が逐次表示されず、終端にまとめて表示される画面差を受け入れますか。それとも W2 の「本文を含めない」約束を変更し、本文を進捗 wire に加えますか。本文を加える場合は契約・開示範囲の変更として確認が必要です。                                                                                                                                          | まとめ表示を受容 |
| Q3  | 送信先・保存範囲・authority・IPC／wire 契約・既存閾値に変更が必要と判明した場合、変更案を別途確認してから進めてよいですか。特に W2 に本文を追加する案は明示承認を要します。                                                                                                                                                                                   | 個別確認         |

## 8. 採らなかった案と、未確認

- start を drain 対象から外す、start を即返して結果を event にする案：quiescence／wire の契約を変える。必要になれば C-17 に従って停止し確認する（[MP-4 判断](mastra-mp4-decisions.md:784-790)、[同](mastra-mp4-decisions.md:1586)）。
- scope の全変化を無条件に無視する案：DR-MP4-26 が守る対象変更後の開示ずれを広げるため採らない。
- 途中本文を W2 に含める案：確認までは採らない。
- 未確認：調査資料の内容、実装時の `finishReason: length` の既存結果型との対応、audit begin 後に send-accepted を出す正確な境界、lease watcher と abort の実際の到達・終端証跡。C-17：drain 対象の変更が必要なら作業を止める。
