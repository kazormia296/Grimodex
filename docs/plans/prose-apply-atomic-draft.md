# 本文の提案の適用を、記録と本文の保存で 1 つの transaction にする（起案）

状態：**起案（draft、未確認）**。2026-11-28、M4 の担当。利用者の回答「根から直す」（contracts `267858439`、M4 の記録の追記 25）。実装は Mastra の道（A1・4c-2・A3・A2）が落ち着いた後（統合の指示）。公開の前の残りとして扱う。この文書はコードを変えない。

## 1. 直すもの

本文の提案（`prose_staging`）は、適用の記録（`accepted`）を本文の保存より前に確定し、保存に失敗しても戻さない。

- 画面を開かない自動適用（設定 `ai.autoAcceptBodyProposals`、既定は無効）：`autoApplyProseProposal` が accept → `persistSceneBody` の順（`autoApplyProse.ts:257-269`）。保存が失敗しても `accepted` のまま（試験：`claude/m4-auto-apply-check` の `autoApplyProse.saveFailure.test.ts`、偽装は DB と保存の境界）。手動の確認に積まれるが、「適用」は `not in proposed status` で拒まれて「処理済み」で閉じる。再起動の後の一覧は `proposed` だけ（読み）。
- 画面の手動「適用」：accept → `diffApi.accept()`（入力欄へ反映）→ 自動保存（`useAgentProseStaging.ts:176-218`）。保存の失敗は通知され、本文は未保存のまま入力欄に残る。タブを閉じると未保存の確認が出る。**保存できないまま破棄を選ぶか強制終了すると**本文を失いうる。提案の読み直しは `proposed` だけなので再表示されない（読み）。
- アプリ内 agent と Mastra の `propose_scene_body` は `proposed` を作るだけで、適用は上の 2 経路。standalone MCP は dispatch の前に拒むので、適用へは来ない。

併せて見つかった別の穴（読み。試験はしていない）：自動適用は事前に版を照合するが保存には版を渡さず、Native は版の指定が無ければ版を条件にせず本文を上書きする（`scene_body.rs` の `AND (?9 IS NULL OR version = ?9)`）。stale の検査と保存の間に別の書き込み（別の窓の編集など）が入ると、上書きする。

## 2. 案の比較

比べる場面：S1 commit の後に応答だけが失われる／S2 記録と保存の間でアプリが終わる／S3 2 つの窓や drain が同じ提案を取る／S4 stale の検査と書込みの間に人の編集が入る。

| 案 | S1 | S2 | S3 | S4 |
| --- | --- | --- | --- | --- |
| A：記録と本文を 1 つの tx（版の条件も） | 本文と記録がそろって残る。再試行は `proposed` でないので書かない | 不可分 | `proposed` の検査が tx の中。負けた側は本文も書かない | 版の条件で拒み、`proposed` のまま残る |
| B：本文を先に書き、後で記録 | 本文あり・`proposed` が残り、次の drain で二重に入る | 同じ | 両方が書く（後勝ちか二重） | 別に版の条件が要る |
| C：失敗したら `proposed` に戻す | 本文が入ったのに戻すと二重の元 | 戻す前に終われば取りこぼし | 旧 receipt が残り再送が矛盾する | 別に版の条件が要る |

A でも残る限界：版の条件で防げるのは「適用の時点で、本文を組み立てた版からの変更」まで。たとえば伏線の操作の取り消しが保持していた古い本文を、版の指定なしで後から書くと、`accepted` のまま提案の文が消える（`foreshadowStore.ts:1211`、`tree/api.ts:1142`、読み）。S1 は、呼び手が同じ要求 ID で再送して commit 済みの結果を確かめる必要がある（今は毎回 UUID を作る）。

**A を採る。C は採らない**（利用者への問いの説明に「失敗したら未適用に戻す」を挙げたが、調査の結果、S1・S2 で二重か取りこぼしが残る）。B も採らない。

## 3. 形（案）

- Native（`grimodex-db`）：`save_scene_body_bundle` と `agent_accept_prose_stage_impl` は、それぞれ `with_conn` と `BEGIN IMMEDIATE` を持つ。中身を `&Connection` を受ける関数に切り出し、新しい関数が 1 つの `BEGIN IMMEDIATE` の中で順に行う。
  1. 冪等の receipt（新しい domain）。
  2. 提案が `proposed` であること、project と scene の一致。
  3. 版の条件：呼び手の渡す版（自動適用は提案の `base_version`）と今の版が一致すること。
  4. 本文の bundle（今の `save_scene_body_bundle` が書くものすべて）。
  5. `accepted` への更新と `prose.accept` のイベント、receipt。
  どこかで失敗したら全部を戻し、提案は `proposed` のまま。呼び手は要求 ID を保持して再送する（本文を書き直さず、commit 済みの結果を返す）。手動では、提案時の版と、利用者が確認した本文の版を区別する。
- IPC：新しい typed command 1 本（名前は実装で決める）を推す。適用だけの必須条件（`proposed`、版の一致）を普通の保存の入口に混ぜないため。もう一つの案は、既存の `save_scene_body_bundle` に任意の指定を足す形で、通常の保存の挙動は変わらず登録も少ないが、全ての保存の入口に分岐が入る。
- 表の変更は無い見込み（`idempotency_requests` の domain に CHECK は無い）。schema の版は取らない。
- renderer：commit の後の副作用（tree の更新、mention、semantic の再索引など）は、今の `persistSceneBody` の後処理を共有する。

## 4. 段

1. **段 1：自動適用**。`autoApplyProseProposal` を新しい命令 1 回に置き換える（版の条件つき）。失敗した提案は `proposed` のまま、今の手動の確認の流れ（stale は conflict の案内）に乗る。段 1 だけの間は、同じ提案を旧の手動「適用」と自動が同時に取ると、手動が先に `accepted` を確定して自動が拒まれ、手動の保存が失敗した場合の取りこぼしが残る。
2. **段 2：手動の「適用」**。入力欄へ反映した直後の内容を、自動保存を待たずに同じ命令で保存する。難所：失敗した場合、入力欄には本文があるのに提案は `proposed` なので、自動保存が本文だけを後で保存すると、提案が再表示されて二重に入りうる。扱い（反映を戻す／次の自動保存に記録を同梱する）は段 2 の設計で決め、伺う。

Release B の「提案が適用されたら手順を完了」（問 32）は手動も対象なので、段 2 が無ければ手動の適用は完了の根拠にできない。段 1・2 の後は、新しい経路の `accepted` は適用の時点で本文も保存した証拠になる（今の本文に残っていることは別。版の復元などは `accepted` を変えない）。それまでは本文の保存の成功を根拠にする（`release-b-session-tasks-screen-draft.md` の下書き）。

## 5. 他の道との重なり

- A2（Mastra の担当の回答、2026-11-28）：A2 の承認は mutate・destructive の tool だけで、本文への適用（accept）は含まない。accept を承認の対象にするかは Write-Safety の「ステージングの分離」の事項。利用者のクリックを承認点にするなら A2 の仕組み（main が要求を作る）は要らない。
- 自動適用が有効な場合、accept は実質 AI の書き込みになる（Mastra の担当の注意）。この起案では認可を足しも外しもしない：自動適用の許可は今の設定（作者の opt-in）と提案時の `bodyWrite` のまま。承認の対象にするかは「ステージングの分離」で決める。
- A4：本文の保存の Native は `bodyWrite` を確かめ直さない。新しい命令で main が確かめるなら認可の追加で、A4 の後に、`claude/a4-design` の DR-A4-5 の読み方と状態の表に合わせる（Mastra の勧め）。その時点で伺う。
- 順番：`electron/main/ipc.ts` は A4 → A2 の後。`ipcContract.ts` の命令の追加は追記なので、A2 の後に入れれば衝突しない。
- 評価用の固定（`observation-prep.mjs` の `SOURCE_PINS`）に `scene_body.rs`・`agent_writes.rs`・`ipcContract.ts` は無い。実装の直前に確かめ直す。

## 6. 画面で見える挙動（実装の前に示す）

- 保存に失敗した提案は `proposed` のまま残り、手動で適用できる。
- 失敗を画面で知らせるか（今はログだけ）。
- 版が変わっていて適用できなかった提案は、今の stale と同じ扱い。
- 直す前に取りこぼした `accepted` の行は見分けられない（確実に区別する記録が無い）。提案の文は DB と AI 監査の ZIP に残る。

## 7. 実装の注意

- 不可分の証明は、本文の書込みと status の更新の間に失敗を入れる Rust の failpoint の試験で行う。
- `autoApplyProse.saveFailure.test.ts` は今の挙動を固定する試験なので、直すときは期待値を反転して使う。
- DB の schema の版は変えない。経路の分類と台帳（D2a の分類、`change-feed-writers.json`）は更新する。今の accept の `staging-only` の除外は、本文も書く新しい経路に引き継がない。
- 新しい命令の登録先は `save_scene_body_bundle` の名前で grep して合わせる（profile の egress など）。実装のとき利用者の `/add-electron-command` が要る。
- この文書は roadmap と作業記録を改訂しない。

## 8. 利用者に伺う点（出す前に前提を別の目で照合する）

1. 範囲：段 1（自動適用）だけにするか、段 2（手動の「適用」）まで含めるか。
2. 新しい IPC の命令 1 本（新しい契約）を足すこと。
- `bodyWrite` の main での確かめ直し（認可の追加）は、Mastra の返事を受けて伺う。

## 9. 未確認

- 応答の喪失、強制終了、複数の窓は実機で再現していない（静的な調査と、別のモデルの反証 1 回）。
- 版を渡さない上書きの隙間は試験していない。
- 段 2 の失敗時の扱い。
- `restore` や scene の削除が適用と重なる場合。
