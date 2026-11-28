# Mastra 移行 MP-9 判断記録（草稿）

状態：未確認。2026-11-27 の U-12 回答を反映した判断案。第 7 節の新しい契約は利用者確認後に確定し、実装する。

## 1. 範囲

旗 M が開いた turn における要約、関連する過去会話、pin、prompt の控え、embedding の移行。旗 M が閉じた legacy 経路では、これらと `chat_message_chunks` を MP-14 まで維持する。

## 2. 確かめた事実

- R-2 の基準値（tool 1 往復）。実 Mastra と一時 DB で、2 回のモデル呼び出しの直前はいずれも保存済みメッセージが 0 件だった。完了時に `saveMessages` が 1 回呼ばれ、user と assistant が 1 行ずつ残った。次のモデル呼び出しには tool の結果本文が届き、完了後の再読込では同じ結果の SHA-256 が返った。段ごとの保存の合格条件は、次のモデル呼び出しに入る前に、確定した tool の呼び出しと結果を DB から読み戻せることとする。[Native 結合試験](../../electron/main/mastraMemory.pipeline.spec.ts)
- Mastra が履歴を持ち、renderer は新規 user message を渡す案。既存保存との二重化を避ける（`docs/plans/mastra-migration-plan.md:481-484`）。
- 要約・過去会話・pin は system／context で渡し、cache の volatile tail に置く案（`docs/plans/mastra-migration-plan.md:482`）。
- MP-7 案の表は全て closed。`mastra_message_parts`、`mastra_thread_metadata`、`mastra_resources`、`mastra_observational_memory`、`mastra_memory_vectors`（`docs/plans/mastra-migration-plan.md:428-431`）。
- 2026-11-27 の回答で、要約は OM、過去会話は Mastra 検索、pin と prompt の控えは Mastra、二重 embedding は直ちに Mastra に寄せる方針。DR-MP9-2（目的欄）は取り下げ済み。

## 3. 判断案

- **DR-MP9-1 保存境界。** M turn は main adapter が Mastra に保存し、legacy の persist を呼ばない。M が閉じた turn は MP-14 まで従来の保存経路を使う。commit receipt を保存完了の証跡にする。
- **DR-MP9-3 検証。** M を閉じたまま入口 journey から最小の 2 turn 保存・再読込を試し、legacy の挙動を維持する。M は開かない。
- **DR-MP9-4 要約。** M turn の要約は Mastra OM（`mastra_observational_memory`）に移し、観察・反映（reflection）で thread の記憶を更新する。OM の設定は MP-8 adapter の provider／model 設定に合わせ、現行の窓・予算制約内で扱う。同じ会話の旧要約を重ねて注入せず、作者向けの要約表示も OM の内容を元にする。M turn では要約の旧保存・読込を止め、記録先が Mastra に変わる。legacy は MP-14 まで従来どおり。
- **DR-MP9-5 関連する過去会話。** M turn は Mastra semantic recall を使い、現行 chatRecall と同じ対象範囲の別会話だけを検索する（現在の thread や対象外の会話へ範囲を広げない）。検索結果は system／context の volatile tail に渡す。作者からは自動参照が続くが、検索元と選ばれる結果が変わる。M turn は旧検索と `chat_message_chunks` を読まず、Mastra memory vectors を使う。legacy の索引・検索は MP-14 まで残す。
- **DR-MP9-6 pin。** M turn の pin は、作者が pin した内容を出典 ID 付きの resource として Mastra memory（`mastra_resources`）へ写し、作者指定であることと元の参照を保つ。AI が抽出した記憶と混ぜず、context に同じ内容を旧 pin 経路から重ねて渡さない。作者には pin が引き続き会話に反映される想定だが、追加・解除の反映方法と表示元は第 7 節で確認する。M turn の pin 保存・読込は Mastra に移し、legacy は MP-14 まで現行保存を続ける。
- **DR-MP9-7 prompt の控え。** M turn で実際に送った確定 prompt は `mastra_message_parts` の独立した記録として当該 message／turn に結び付けて保存し、過去メッセージから見返す控えにする。作者には送信時の内容を確認できる状態を保つ想定だが、画面の表示元は第 7 節で確認する。M turn の `chat_message_prompts` 保存・読込は Mastra に移し、legacy は MP-14 まで現行保存を続ける。
- **DR-MP9-8 embedding。** M turn は Mastra の `mastra_memory_vectors` を使い、旧 `chat_message_chunks` との二重 embedding を直ちに止める案。作者には M turn の semantic recall が Mastra の索引から返る。legacy の旧索引は MP-14 まで保持する。M turn が Mastra vectors のみを使う契約は第 7 節で確認する。
- **DR-MP9-9 A3 durable AgentRun との保存合意（2026-11-27）。** (1) 旗 M の turn では tool の呼び出しと結果を段ごとに `mastra_message_parts` に本文付きで保存する（問 14 の承認）。A3 checkpoint は MP-9 message への参照と未解決 1 件だけを持ち、本文を重複保持しない（DR-A3-8）。(2) 各 tool 結果には、場面 revision や Codex 版など、読み取り元 source の印を parts に持たせる。値は read core が返す版を使い、設計は実装 PR で決める。(3) 段ごとの本文は Run 終端まで残し、終端時に MP-8 の DR-MP8-4 と同じ digest に置き換える。完了 turn の本文は残さず、A3 port の終端記録から置き換えを呼べる口を設け、Mastra 経路は owner が呼ぶ。(4) backup、復元前退避、migration 前 snapshot では未完了 Run の途中段本文を空にする（問 19・21、A3 脅威モデル確定）。grimodex-db の backup 写し処理で行い、復元された中断 Run は続行不可とする。(5) 実 Mastra の保存回数（計画 R-2、1〜8 回は未確認）と各段が確実に残ることを試験で確かめる。MP-9 と再入の実証までは A3 が Mastra Run を `resumable=false` で記録する。

## 4. owner／lifecycle（案）

| 対象                                                    | owner                                                   | 終了・失敗                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M turn の buffer／commit                                | main adapter                                            | terminal で Mastra に commit し receipt を記録。abort 時は未 commit の buffer を破棄（`docs/plans/mastra-migration-threat-model.md:337-348`） |
| OM 要約                                                 | Mastra OM。adapter が設定・参照                         | thread の OM として更新。thread 削除に追随して削除。M turn では旧要約を読まない                                                               |
| semantic recall／vectors                                | adapter が検索し、Mastra memory vectors が索引を所有    | 現行 chatRecall と同じ対象範囲に限定。thread 削除時は対象 vector を削除。M turn は旧索引へ書かない                                            |
| pin の反映                                              | adapter が Mastra memory へ同期                         | pin 追加・解除の同期と表示元は第 7 節の確認事項。thread 削除時に写しも削除                                                                    |
| prompt の控え                                           | adapter が送信確定内容を Mastra の message／turn に記録 | turn の commit と一緒に保存。thread 削除に追随。表示元は第 7 節の確認事項                                                                     |
| legacy の要約・recall・pin・控え・`chat_message_chunks` | 現行 legacy 経路                                        | M が閉じた turn で MP-14 まで現行の保存・削除 lifecycle を維持                                                                                |

## 5. 影響と PR の分け方

MP-8 adapter を基点として、その後に MP-9 の PR を積む。MP-8 には戻り変更を入れない。MP-9a で M turn の保存境界と legacy 非干渉を置き、その後に DR-MP9-9 を (b) 段ごとの tool 本文保存、(c) tool 結果の source 印、(d) Run 終端での digest 置換、(e) backup・復元前退避・migration snapshot の本文消去に分ける。実 Mastra の保存回数と段ごとの永続性は該当 PR の試験で確認し、MP-9 と再入の実証までは A3 の Run を `resumable=false` にする。続けて (f) OM 要約、(g) semantic recall と Mastra vectors の単一利用、(h) pin 同期、(i) prompt 控えの保存・表示を分ける。第 7 節の契約確認が必要な pin・prompt・embedding は回答後に着手する。legacy の終了は MP-14 で別に扱う。各段階で入口 journey、削除・再生成、旧経路との二重保存がないことを確認する（`docs/plans/mastra-migration-plan.md:492-497`）。

## 6. 脅威モデルへの影響

旗 M のとき、OM、recall、pin、送信確定 prompt、vector の保存先を Mastra の既存テーブルへ移す。provider への送信先は既存の設定のまま。prompt 控えは送信時の確定内容を永続化するため、その保存範囲と thread 削除時の消去を確認する。新しい authority や送信先は追加しない。legacy の保存範囲は MP-14 まで維持する。

## 7. 利用者に確認する点

回答（2026-11-27）：(a) pin は **Mastra を正本にする**（作者の pin の操作を adapter が Mastra の memory に同期し、画面もその記録から表示する）。(b) prompt の控えは **Mastra に保存して表示**（Mastra の turn で実際に送った確定の prompt）。(c) 埋め込みは **Mastra の索引だけ**（Mastra の turn は mastra_memory_vectors だけ。今の経路の chat_message_chunks は MP-14 まで残す）。どれも旗 M の turn の扱いで、旗の閉じた今の経路は変えない。

### (a) pin の編集と参照

pin を追加・解除したとき、Mastra memory への反映と表示の元をどうしますか？

- **推奨：**作者の pin 操作を adapter が Mastra memory に同期し、画面もその Mastra の記録を元に表示する。
- 現行 pin を編集・表示の正本として残し、Mastra memory は同期先にする。
- pin の Mastra 同期は保留し、M turn では pin を使わない。

### (b) prompt の控え

過去メッセージから送信内容を見る控えを、Mastra の送信記録から表示しますか？

- **推奨：**M turn で実際に送った確定 prompt を Mastra に保存し、その記録から表示する。
- 控えは現行 `chat_message_prompts` から表示し、Mastra には複製しない。
- M turn では控えを保存・表示しない。

### (c) embedding の寄せ方

旗 M の turn は `mastra_memory_vectors` だけを使い、`chat_message_chunks` への二重 embedding を直ちに止めますか？

- **推奨：**M turn は Mastra vectors のみを使う。`chat_message_chunks` は legacy turn 用に MP-14 まで残す。
- M turn でも移行期間は両方へ書き、検索結果を比べてから一本化する。
- M turn の semantic recall を一時停止し、Mastra vectors のみで使えることを確認してから再開する。

## 8. 採らなかった案

M turn でも旧要約・recall・pin・控えを併用する案（Mastra 経路で重複保存・注入になる）。M turn で旧 `chat_message_chunks` と Mastra vectors の両方を作る案（二重 embedding が続く）。目的欄を追加する案（不要との回答を受け、DR-MP9-2 を取り下げ済み）。
