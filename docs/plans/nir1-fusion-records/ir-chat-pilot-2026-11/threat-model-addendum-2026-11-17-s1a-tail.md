# 脅威モデルの追補：S1-A の終端の audit の書き足し（tail）と §3.8 の改訂（2026-11-17）

- 状態：**追補（2026-11-18 に統合者が contracts に置いた）**。未決の 1 点：停止が 30 s の予算の切れ際に立つと、最後の `CLOSE_FLUSH` が 30 s を越えうる（0.2 の細部 (a)）。統合者は、`close_flush` を残り予算で切る直しを別 PR で入れて承認の文言どおりに守る方針（ユーザー確認は不要の向き）。直しが入るまでは、この例外の記述が有効。置き場の案は `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/threat-model-addendum-2026-11-17-s1a-tail.md`。確認済みの脅威モデル（`contract-confirmation-2026-11-09/consumer-contract-threat-model-draft.md`、contracts `357a87b7`、SHA-256 `08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3`）は書き換えない。形は前例 `threat-model-addendum-2026-11-17-generic-sql-envelope.md` に合わせた。
- 根拠（ユーザーの承認）：回答「tail を承認 (Recommended)」。contracts `a56a808b` の `user-confirmation-2026-11-17-s1a-flush-tail.md`（SHA-256 `0854ff78a08f8bb50fa4f2c70faf35638414aeccb8bcfffa183b4799210a808b`）。内容は、終端の書き足しを応答の後に同じ task で最長 30 s 続けてよい、その間 permit と participant を握る、停止は区切りごとに確かめる、§3.8 は確認済みの版を書き換えず追補で改める、の 4 点。前提の回答は contracts `dc533a4e` の `user-confirmation-2026-11-17-s1-a0-audit-terminal.md`（「終端を書けなければ IR を返さない (Recommended)」。SHA-256 `2a742c3feed51909492f01aa4bdf53651ba7606ccd8faa2ad8f84aeb4366d34b`）。
- 実装：PR #935（merge commit `01dd6821`、2026-11-17、枝 `claude/chat-ir-s1-a`、コードの head `0a372e82`）。判断の記録は repo の `docs/plans/nir1-lane-decisions/chat-ir-s1-decisions.md` の DR-CHATIR-S1-13〜27。tail は DR-CHATIR-S1-15。tail が書く `PendingTerminalAudit` は S1-A0 の DR-CHATIR-S1-11・12。
- DR との食い違い：DR-CHATIR-S1-15 の 4 点（停止後の遅れの書き込みの回数、落とす順、`Drop` の log の内容、tail の長さの上限）は、この追補が実装に合わせて精密化した（7.2）。DR の訂正が要るかは統合者が判断する。
- 下書き：`design-notes/chat-ir-2026-11-08/threat-model-addendum-s1a-draft.md`。この本文は、下書きを実装と照合して直したもの。差分と理由は 7、点検の指摘と扱いは末尾の 8。
- 照合の基点：`origin/master` = `01dd6821beceb3222bb858c216678e06a658428b`。`git show`／`git grep`／`git diff` で読んだだけで、build・試験・測定は走らせていない。
- 記号：【確認】＝このコードの読みで確かめた。【記録】＝判断の記録・検証の記録を引いた（読み直していない）。【推測】＝推測。【未確認】＝確かめていない。`file:line` は `01dd6821` の行番号。

---

## 0 確かめたこと

### 0.1 gate は閉じていて、製品の挙動は変わらない

1. **Native の gate**：`select` の最初の検査が gate で、閉じていれば request を parse する前に `CHAT_IR_GATE_CLOSED` の error を返す（`chat_ir.rs:106-112`）。gate は全 entry が false で始まる（`main_grant.rs` の `PrePublicationGate::new`）。`ChatAgentIr` を開けるのは Main 専用の `main_open_pre_publication_gate`（`lib.rs:8073`）だけで、これは `NAPI_COMMANDS` に無い（`mainGrant.test.ts` の F8）。非 test の Main の呼び手は **3 つ**の CI seam（`bodyDeclarationCiSeam.ts:229` の `"scene-body-declaration"`、`nir1LocalGeneration.ts:172` の `"nir1-local-generation"`、`profileActivationCiSeam.ts:165` の `"profile-activation"`）で、渡す kind は固定の定数。`git grep -n mainOpenPrePublicationGate -- electron src packages` の test 以外の呼び手はこの 3 つだけで、ほかは型の宣言（`ipcContract.ts:959`、`index.d.ts:87`）と、test 用の helper（`electron/native/grimodex-node/test/profile-activation-helper.mjs:48`）。`chat-agent-ir` を渡す呼び手は無い。`chat-agent-ir` の文字列を持つ file は、`git grep -l 'chat-agent-ir' -- electron src packages` で test 以外では Native の `main_grant.rs`（enum の wire 名）だけで、TS／JS の非 test source には無い。`chatAgentIr.test.ts` の「no product source opens the chat IR gate」が同じ検査を固定する【確認。試験の実行はしていない】。
2. **Main の closed gate**：`chatAgentIrGateRefusal`（`chatAgentIr.ts`）が invoke の handler の中で、`cmd` が文字列かの検査と local generation の gate の後、sender・profile・引数の検査より前に、無条件で `ok:false`（`CHAT_IR_GATE_CLOSED`）を返す（`ipc.ts:2205-2207`）。seam・opener・環境変数による解除は無い【確認】。
3. **restricted**：Main の拒否台帳で `chat_agent_ir_select` は `plaintext-publication`（`profileEgress.ts:315`）【確認】。
4. **renderer**：`chat_agent_ir_select` を呼ぶ renderer の caller は無い。renderer にあるのは、read lane の caller timeout の登録（`tauri.ts:244`）と、拒否台帳の写し（`profileEgressClosure.ts:62`。防御に数えない）だけ。**renderer の定数 `CHAT_AGENT_IR_ENABLED` は S1-B で、S1-A にはまだ無い**【確認。DR-CHATIR-S1-27 の「renderer の `CHAT_AGENT_IR_ENABLED` は S1-B」と一致】。
5. **起動時の副作用が無い**：`AppState.chat_ir`（`state.rs:2861`）は `ChatIrState::default()`。作るのは `PermitPool`（`AtomicUsize`）と空の台帳（`HashMap`）だけで、thread・task・timer を起こさない。設定（`ChatIrConfig`）は製品では `Default` 以外で作られず、環境変数も読まない（`git grep` の範囲。`env::var` は test だけ）。tail は gate を通った呼び出しの blocking task の中でだけ生じるので、gate が閉じている間は存在しない【確認】。
6. **既存の挙動への差分は登録と可視性だけ**：#935 は 34 files（`git diff --stat 01dd6821^1 01dd6821`）。既存 file の変更は、`related_scenes.rs`／`ranking_policy.rs` の可視性（`pub(crate)`）、`ipc.ts` の 1 呼び、`profileEgress.ts` の 1 行、`tauri.ts` の登録、`ipcContract.ts` の追加、`profileEgressClosure.ts` の 1 行、`state.rs` の field、`main_grant.rs` の enum、`lib.rs` の napi 1 つ。`src-tauri/` の変更は無い。S1-A0 で足した共有 crate の API の製品の呼び手は `chat_ir/native.rs` だけ【確認。`git grep`】。

### 0.2 承認の範囲との照合

| 承認の記録の要素 | 実装 | 判定 |
|---|---|---|
| 応答を返した後に | `execute` が `answer.send(result)` の後に `run_tail`（`flow.rs:201-222`）。応答は oneshot で、tail を待たない【確認】 | 一致 |
| 同じ task で | `spawn_blocking` の 1 task の中（`chat_ir.rs:135`）。第 2 の task・thread・queue・registry・ticket は無い【確認】 | 一致 |
| 最長 30 s | `tail_budget` は `TERMINAL_BACKFILL_BUDGET`（30 s、`runtime_chat_ir.rs:46`）。`run_tail` が応答の後に deadline を置く（`tail.rs:62-`）【確認】 | **一致。ただし例外が 1 つ**：停止が最後の ≈ `SLICE` の間に立つと、停止後の最後の 1 回（`CLOSE_FLUSH`）が 30 s の外に出る（`tail.rs:73-81`。下の細部 (a)、1 の「最長 30 s の読み方」）。30 s は flush を打ち切る時刻で、始まった書き込み 1 回は止められない |
| その間 permit と participant を握る | permit は `execute` の引数で、最後に落ちる（`flow.rs:226`）。participant は backend の field で、pending の後に落ちる【確認】 | 一致 |
| 停止は区切りごとに確かめる | `run_tail` が slice（250 ms）ごとに `backend.stop_requested()` を呼ぶ（`tail.rs:73`、`native.rs:394`）【確認】 | 一致 |
| §3.8 は追補で改める（確認済みの版は書き換えない） | この文書。確認済みの file の SHA-256 は contracts `357a87b7` で `08f26f78…` と一致した【確認】 | 一致 |
| S1-A の PR 本文に GDX-PRECHECK-001 の背景作業の行 | 判断の記録（DR-CHATIR-S1-15、matrix の後の区分の行）に「background は当たる」を書いた【記録】。PR 本文そのものは読んでいない | 【未確認】 |

**承認の範囲を超える記述は、1 点を除いて無い。** 1 点は、停止が最後の ≈ `SLICE` の間に立ったときの tail が、承認の「最長 30 s」を最大 ≈ 1 s＋書き込みで越えうること（下の細部 (a)。点検で見つかった。内側と読めるかは統合者が判断する）。それ以外では、この追補に、新しい送信先・保存範囲の拡大・閾値の緩和・gate を開く経路・新しい契約や authority を足す記述は無い。実装にも無いことを次で確かめた。独立の queue／worker は無い（`spawn_blocking` が 1 つ。0.2 の表）。in-flight は 2 のまま（`max_in_flight: 2`、`ChatIrConfig::default` だけ）。model の load は起こさない（`with_resident_until` は loader を取らない。`runtime_chat_ir.rs`）。発行の記録は disk に書かず押し出さない（`ledger.rs`）。policy の値は変えていない（`ranking_policy.rs` の差分は可視性だけ）。**S1-A（#935）と tail は、audit に新しい event・metadata を足さない**（tail は同じ event を元の id・時刻のまま書き足す）。ただし S1-A0（別 PR）は、埋め込みの audit の metadata に `"consumer": "chat-ir"` を足している（`runtime_chat_ir.rs:464-465`。既存の `runtime_audited_query.rs:125-129` の metadata には `consumer` key が無く、`sharedConsumers` だけ）。DR-CHATIR-S1-11 の (2) は、これを「既存の `ai_audit_events` に既存の形で書く」範囲と記録し、新しい宛先・保存範囲・閾値・契約・authority は無いとする【記録】。この追補は S1-A0 の判断を再判断しない。確認済みの §3.5 の (4)（埋め込みの audit の rawText は既存の延長）の範囲と読むかは、統合者が判断する。gate を開ける呼び手は無い（0.1 の 1）【確認】。

承認の文面に直接の記述が無い実装の細部が 3 つある。(b)(c) は承認の内側（permit・participant の保持、既存の audit への書き足し、gate が閉じていて何も送らないこと）に収まると読む。(a) は 30 s を越えうるので、内側と読めるかを統合者が判断する。いずれも、統合者が範囲内かを見る材料として明記する。

- **(a) 停止の後の最後の 1 回（`CLOSE_FLUSH` 1 s）**：承認は「最長 30 s」と「停止は区切りごとに確かめる」と言う。実装は、停止を見たら即座に捨てず、最後に 1 回 1 s だけ書き足しを試す。
  - この 1 回は `tail_deadline` で切られない（`tail.rs:73-78`）。停止の判定が予算切れの判定（`:81`）より前にあり、`flush_until(Instant::now() + close_flush)` は残り予算を見ない。
  - したがって、30 s を使い切って書けずに残っている tail に、停止が最後の ≈ `SLICE` の間（または切れた直後のループの先頭）で立つと、tail は 30 s＋最大 ≈ 1 s＋書き込み（最後の slice と最後の試みのそれぞれが書き込み 1 回分を越えうる）まで続きうる【確認。コードの読み。予算の端の試験は無い】。participant の保持も、その分だけ延びる。
  - この超過が起きるのは、停止が立った場合に限る。停止が立たなければ、30 s の予算で終わる（始まった書き込み 1 回を除く）。
  - 承認の「停止は区切りごとに確かめる」が停止後の最後の 1 回を含むと読めるか、30 s を文字どおりに守るべきかは、統合者が判断する。
  - 技術的な直しは、`close_flush` を残り予算で切ること（`min(close_flush, tail_deadline − now)` とし、予算が尽きていれば試みない）。別 PR で、この追補の範囲外。直せば、この項は無くなる。
  - 停止後の participant の保持は、通常の停止でも ≈ `SLICE`＋1 s＋書き込みかかる（1.3、1.4）。
- **(b) 発行の記録が Scene の題を memory に持つ**（tail ではなく S1-A の他の部分。2 の 5）：確認済みの §3.5 の「残さないもの」は quote・summary・性質の本文で、Scene の題は列挙に無い。process 内の memory だけで disk に書かず、再起動で消えるので、保存範囲の拡大には当たらないと読む。
- **(c) 要約 400 字・quote 180 字は仮の値**（2 の 8）：確認済みの §3.6 は字数の上限を未定とする。S1-A は gate が閉じていて何も送らない。下げるのは技術判断、上げるのは確認の対象（DR-CHATIR-S1-21）。

---

## 1 §3.8 の改訂する行（確認済みの文 → 追補後）

確認済みの §3.8 の表（`consumer-contract-threat-model-draft.md` の 322-336 行、contracts `357a87b7`）の行のうち、tail で意味が変わるものだけを改める。「確認済みの文」は、その表のセルの逐語（略記しない）。ここにない行は確認済みの文のまま。

**コードの識別子と、DR・承認の記録の呼び名の対応**（この節と 0 で使う）：

- `SLICE`＝`ChatIrConfig.tail_slice`（初期値 250 ms。`chat_ir.rs:61,73`）。
- `CLOSE_FLUSH`＝`ChatIrConfig.close_flush`（初期値 1 s。`chat_ir.rs:62,74`）。
- tail の予算（30 s）＝`ChatIrConfig.tail_budget`。既定値は共有 crate の `TERMINAL_BACKFILL_BUDGET`（`runtime_chat_ir.rs:46`、`chat_ir.rs:72`）。
- 期限（10 s）＝`ChatIrConfig.deadline`（`chat_ir.rs:54,68`）。同時実行の上限（2）＝`max_in_flight`（`chat_ir.rs:57,70`）。

**「最長 30 s」の読み方**（点検の M2 を受けて足した）：

- 30 s は、`run_tail` が flush の試みを打ち切る予算（`tail_deadline`）。
- 始まった書き込み 1 回は途中で止められない（DR-CHATIR-S1-11 の (3)）ので、予算の端で書き込み 1 回分は越えうる。
- 停止の判定は予算切れの判定より前にあり、停止後の最後の 1 回（`CLOSE_FLUSH`）は `tail_deadline` で切られない（`tail.rs:73-81`）。停止が最後の ≈ `SLICE` の間に立つと、tail は 30 s＋最大 ≈ 1 s＋書き込み（最大 2 回分）まで続きうる【確認。コードの読み。予算の端の試験は無い。`unit.rs:686` の試験は予算 10 s で、停止は最初から立っている】。
- 停止が立たなければ、この超過は無い。承認の内側と読めるかは 0.2 の細部 (a)。

### 1.1 実行中の handle

- 確認済みの文：持たない（one-shot）。lease も ticket も出さない
- 追補後：**変わらない**。
  - tail は registry・handle・ticket・queue・独立の thread を作らない。
  - 呼び出しは `spawn_blocking` の task 1 つ。`JoinHandle` は待たず捨てる（`chat_ir.rs:135`）。
  - `PendingTerminalAudit` は task の中の `execute` の local。`run_tail` に `&mut` で借りるだけで、task の外へ move しない（型は `#[must_use]`、`runtime_chat_ir.rs:137`）。
  - Main・renderer から見えない【確認】

### 1.2 tail を起こす条件（確認済みの文に無い行）

- 確認済みの文：—
- 追補後：
  - tail は **IR を返さなかった呼び出しの後にだけ**生じる。pending を作るのは `prepare` だけで、`timeout` か `inference-failed` の status と一緒に返る（`flow.rs` の `Prepared::Unavailable`）。
  - `ChatIrQuery` は終端の audit が期限の内に durable になった後でだけ作られる（`runtime_chat_ir.rs:535`）。`available`／`none-above-threshold` の後に tail は無い。
  - 終端が期限の内に書ければ、その場で書かれ、tail は無い【確認】

### 1.3 取り消し

- 確認済みの文：Stop と session の切替は、tool が返った後の `shouldAbort` で結果を捨てる（`agentLoop.ts:318-323`）。Native の呼び出し自体は期限で終わる。途中で止める仕組みを足すかは技術判断
- 追補後：
  - **期限で終わるのは「応答」まで**。応答の後の tail は、期限（初期値 10 s）の外で、予算 30 s 続く（上の読み方）。
  - 停止は participant の `stop_requested()` を `SLICE` ごとに見る（`tail.rs:73`）。
  - `stop_requested()` が真になるのは、shutdown の要求、transition、RecoveryRequired、Closed、互換の switching。読めない（`Err`）ときも停止と数える（`workspace_lifecycle.rs:726-741`、`native.rs:394-396`）。
  - 停止が立てば、最後に 1 回だけ `CLOSE_FLUSH` で書き足しを試し、書けなければ捨てる。
  - 捨てると `PendingTerminalAudit` の `Drop` が `tracing::error` を出す。出すのは execution_id の一覧と event の件数だけで、query・本文は出さない（`runtime_chat_ir.rs:206-216`）。
  - tail は停止のほかに、予算の切れ（30 s）と、busy でない error が**累計** 5 回（`MAX_FLUSH_ERRORS`）でも終わり、どちらも捨てる。`errors` は `Ok(false)`（busy）を挟んでも 0 に戻らない（`tail.rs:68,88-92`）。コメント（`tail.rs:59`）の "in a row" とは違い、連続ではなく累計。
  - 終わり方は `TailEnd`（Flushed／Stopped／Expired／Failed）で、`tracing::debug` に出る（`flow.rs:220-221`）【確認】

### 1.4 待ちの上限

- 確認済みの文：Native の期限。期限を過ぎれば `index-unavailable`（timeout）で、年表の結果だけを返す
- 追補後：
  - **応答までの待ち**は変わらず Native の期限（初期値 10 s）。`accepted_at` から数え、blocking pool の待ちを含む。止められない推論 1 回分と audit の append の書き込み 1 回分が上乗せされる。
  - **tail の待ち**は、応答の後の 30 s の予算（読み方は上の注）。
  - 停止が立った後の tail の長さは ≈ `SLICE`＋`CLOSE_FLUSH`＋append の書き込み。進行中の slice と最後の試みのそれぞれが、自分の期限を書き込み 1 回分だけ越えうるので、書き込みは最大 2 回分【推測。製品の値では未測定】。
  - 確認済みの文の「`index-unavailable`（timeout）」は、実装では閉じた status の `timeout`（DR-CHATIR-S1-25）。IR なし・`success:false` の意味は同じ【確認】

### 1.5 終了の証拠

- 確認済みの文：Native の応答か期限のエラー。どちらでも、その turn の配列に `tool_result` が 1 件入る（宣言 gate と同じ対の維持）
- 追補後：
  - **応答の証拠**は変わらない（応答か期限の status。caller の Promise の settle は証拠にしない）。
  - **task の終了の証拠**は、(1) tail の終了（pending が空になる、または捨てる）、(2) participant の数が 0 に戻ること、(3) permit が戻ること、(4) 呼び出しが握る `PinnedWorkspaceDb` の Arc が戻ること（`PendingTerminalAudit` の `db` と、pin した request。`wait_for_sole_owner` が通る）。
  - 落とす順は `execute` の中で pending → request（DTO）→ backend（宣言順で、pin した request の Arc → participant）→ permit（`flow.rs:222-226`、`native.rs:37-40`）。
  - この順は保証ではない（`flow.rs:196-200` のコメント）。必要なのは、task の外へ何も残らないことと、停止の後の tail が短いこと【確認】

### 1.6 同時実行の数（確認済みでは「開始」の行）

- 確認済みの文：tool の呼び出し 1 回につき、Native の呼び出し 1 回。agent の loop は直列なので、1 つの loop の中で同時に走るのは 1 つ。sender ごとに同時に走る数の上限を置くか（窓や会話が並ぶ場合）は技術判断
- 追補後：
  - **process 全体で in-flight 2**（DR-CHATIR-S1-4・19。sender ごとではない）。
  - permit は async 側で `try_acquire`（待たない）して task へ move し、**tail が終わるまで離さない**（`permit.rs`。caller timeout・Promise の settle では離れない）。
  - pending を持てるのは permit を握る task だけなので、pending は 2 以下で、queue は無い。
  - tail の間は新しい呼び出しが `busy`（IR なし）になりうる。可用性は下がる側で、T12 の「同時に走る数の上限」を弱めない。
  - blocking pool の thread も、応答の後に最大 2 本、30 s の予算の間占める【確認】

### 1.7 エラーの持ち主

- 確認済みの文：executor が `ToolResult.error` に包む（`executeTool` の既存の型）。本文は log に出さない
- 追補後：
  - **変わらない**。tail の失敗（書けない・停止）は呼び手に届かない（応答は既に返っている）。
  - 終端の無い execution が残る（`dispatched` のまま）が、その結果は IR として使われていない。
  - **S1-A に executor は無い**（S1-B）。この行の適用先は S1-B 以降。
  - log に出るのは execution_id の一覧と event の件数だけ【確認】

### 1.8 再起動時の状態

- 確認済みの文：保存しない（`usedIds` は tool_calls の一部として保存するだけ）
- 追補後：**変わらない**。pending は process 内のみで、process の終了で消える（終端の無い execution が残る。crash と同じ読み）【確認】

### 1.9 workspace／project の切替と restore

- 確認済みの文：turn の authority（`assertTurnAuthority`）と、Native の `expectedWorkspacePath` で拒否する。restore の後は、索引の generation の無効化で unavailable になる見込み【推測】
- 追補後：
  - **tail の間も participant を握る**。
  - transition と shutdown は、participant の数が 0 になるまで**上限なしで**待つ（`acquire_transition_physical_exclusive`、`wait_participants_gone_for_shutdown`。`workspace_lifecycle_view.rs:389,419`）。`ReaderStopBoundedWait` が外へ出すのは専用の reader（`with_chronicle_reader`）だけで、chat IR の participant は対象外。
  - 停止は transition の admit と shutdown の要求で立つので、待ちは tail の停止後の長さ（1.4）で終わる。
  - restore は `begin_workspace_lifecycle_transition_wire(Restore)` と `acquire_transition_physical_exclusive` を経て `restore_backup_core_with_open_lock` に入る（`lib.rs:12097,12139-12141`）。
  - **Arc の待ちは別**。`wait_for_sole_owner` は 10 s（10 ms × 1000。`backup_restore.rs:1909-1920`）で error になる。呼び手は restore（`backup_restore.rs:653`）、`shutdown_workspace_storage`（`open.rs:390`）、同じ path の再 open の quiesce（`open.rs:904`）の 3 つ。participant の待ちの後なので、通常は tail の Arc は先に戻っている。
  - tail が停止を見逃して 10 s を超えれば、これらは error で中止される。restore の文言は「実行中のDB操作が完了せず復元を中止しました。少し待って再試行してください。」。
  - 中止の後の状態として**確認できるのは次だけ**【確認】。
    - active authority を元に戻す。restore は `backup_restore.rs:653-656`、同じ path の再 open は `open.rs:904-910`（`*inner = Some(old)`）。`shutdown_workspace_storage` は error を記録し、`inner` を取らずに返る（`open.rs:390-393`）。
    - restore では、live の置換の前に返る。`backup_restore.rs:659-662` のコメントが、checkpoint の停止・安全複製・seal・置換をこの待ちの後に置く。
    - restore の error の経路で、admission を戻す（`lib.rs:12225-12233`）。
  - **lifecycle が Ready に戻るか RecoveryRequired になるか、再試行できるかは読んでいない**【未確認。6 の 9】。`QuiescedSamePath` の `Drop` は、置換が失敗した後の復旧は lifecycle supervisor が持つと log に書く（`open.rs:950-952`）。
  - 切替の遅れは、pending があるときだけ、最大で ≈ 停止後の tail の長さ【推測。未測定】。
  - project の切替（workspace は同じ）は participant に影響しない。tail は pin した DB に、元の `project_id` の scope で書く。切替の後に別の workspace の DB へ書くことは無い（`PendingTerminalAudit` の `db` と `project_id`。`runtime_chat_ir.rs:138-142`）【確認】

### 1.10 接続の握り

- 確認済みの文：索引の build や保守が接続を握っている間は待たず、期限で落とす。DR-IRB の系の事象への対策
- 追補後：
  - tail の flush も、応答の前の append と同じ waiter を名乗らない取得（`try_append_ai_audit_events_for_scope_until`）で、foreground waiter を名乗らない。
  - maintenance の no-wait guard が生きている間は、接続が空いていても取らない（DR-CHATIR-S1-12、`connection_deadline.rs:102`）。
  - busy の間の再試行は 1 ms 間隔で、2 か所にある（`connection_deadline.rs:42`、`runtime_chat_ir.rs:48`）。
  - したがって maintenance の cycle が長いと、tail は予算を全部 busy で使い切り、捨てうる（その execution は `dispatched` のまま）。
  - tail は embedder の admission を握らない（admission は `with_resident_until` の closure の中だけ）。
  - 1 ms の polling の CPU・wakeup は未測定【確認。測定は未実施】

---

## 2 tail 以外の S1-A と、確認済みの文との関係（改訂ではなく照合）

下の行は §3.8・§4.5 の文を**書き換えない**。S1-A の実装が確認済みの文を弱めない（同じか、強める向き）ことの記録で、DR の記録（技術判断）に基づく。ユーザーの個別の承認を主張するものではない（承認は 1 の tail だけ）。

| # | 確認済みの文・防御 | S1-A の実装【確認】 | 関係 |
|---|---|---|---|
| 1 | §3.8 入口・開始・受付を閉じる。T9、T12 | `select` の順は、gate → 形（`deny_unknown_fields` の 4 key。違えば `CHAT_IR_INVALID_REQUEST` の error）→ query（UTF-16 500 unit、空・空白のみは `query-invalid`、切り詰めない）→ permit（待たない）→ participant → pin → blocking task（`chat_ir.rs:106-`）。permit の前の拒否は audit も推論も起こさない。Main にも同じ bound（`ipcContract.ts` の `CHAT_AGENT_IR_QUERY_UTF16_MAX`）があるが、Main の gate が常に閉なので到達しない（Native が正） | 強める向き |
| 2 | §3.8 受付を閉じる「Main：restricted、unavailable、activation の最中は拒否。renderer：agent モードと定数の後ろ」 | Main は**常に**拒否（0.1 の 2）。restricted は `plaintext-publication`。renderer の定数は S1-B で、S1-A には無い。Native の gate は既定で閉で、開ける呼び手が無い | 強める向き（定数の位置が S1-B に移る） |
| 3 | §3.8 待ちの上限、T11・T3 | 3 回の participant read。T1 `first_read`（接続待ち上限 `CONNECTION_PROBE` 1 s。admission も embedder も取らない）→ `prepare`（read transaction の外）→ T2 `qualify` → `score` → T3 `select`（`native.rs:188-`）。各 read の最初に `projects.language` を読み、spec・floor・cap をその値から導く。T2・T3 で T1 と違えば `project-changed`。support は "ja"／"en" の完全一致だけ（DR-CHATIR-S1-16）。期限は呼び出しの受付から 10 s で、SQL・qualify の途中でも効く（`ChatIrControl`） | 同じ（細部の追加） |
| 4 | §3.8 同時に走る数 | 1 の行（process 全体で 2、待たずに `busy`） | 同じ |
| 5 | §3.5 保存しない。T14・T16（S1-C の照合の前提）。DR-CHATIR-S1-5・23 | **発行の記録**（`ledger.rs`）：process 内の `Mutex<HashMap>`、件数の上限 4,096、満杯なら全件を atomic に拒否（`ledger-full`、IR なし）、押し出さない、DB の identity が変われば破棄、disk に書かない。持つのは digest・byte 長・revision ID・Scene ID・Scene の題・score・generation で、**要約・quote の本文は持たない**。S1-A は発行だけで、読む側（`get`）は S1-C。同じ digest は 1 件に数える | 「保存しない」に当たる（process 内のみ）。Scene の題の扱いは 0.2 の細部 (b) |
| 6 | §3.3 状態の集合、「不可・不明を IR 0 件の成功と数えない」 | 閉じた status 17 値（`available`、`none-above-threshold`、`timeout`、`connection-busy`、`embedder-cold`、`busy`、`ledger-full`、`index-unavailable`、`unsupported`、`no-current-scene`、`project-unavailable`、`project-changed`、`workspace-unavailable`、`workspace-changed`、`query-invalid`、`inference-failed`、`internal`）。`success` は `available` と `none-above-threshold` だけが true。対応表は wildcard なしの `match`（`status.rs`）。gate が閉の呼び出しは status でなく error | 同じ。文言 `index-unavailable`（timeout）は `timeout` に分かれた（1 の待ちの行） |
| 7 | §3.8 待ちの上限（caller 側）、DR-CHATIR-S1-3 | `READ_ONLY_COMMAND_TIMEOUTS` に `chat_agent_ir_select` を 20 s で登録（`tauri.ts:63,244`）。登録しないと mutation lane・timeout なしになり、workspace の切替・close の静止を握る。20 s は終了の上限（期限 10 s＋推論 1 回＋append 1 回）より長い。caller timeout は Native を止めず、permit も返さない。応答の後の tail とは独立 | 同じ |
| 8 | §3.3 出力、★4「要約と quote に限る」、§3.6 閾値 | item の key（`item.rs:122-136`）は、`$grimodexIr` の印（`:25`）、`origin:"manuscript"`（`:27`。確認済みの §3.3 の `origin`）、`revisionId`、`sceneId`、`sceneTitle`、`score`（小数 4 桁）、`summary`（先頭 400 字、超えれば `…`）、`review:"human-approved"`、`quotes`（1 件、evidence の抜粋 180 字＋`…`【記録】）。`revisionId`・`sceneId`・`sceneTitle`・`score` は、確認済みの §3.3 の出力の列挙（★1 で承認した契約）に由来する。★4（外部へ送るデータの範囲。回答は「承認の文言どおり要約と quote に限る」）との関係は、DR-CHATIR-S1-21 が「★4 の内」と読む【記録】。**性質（actuality・attribution・narrativeFrame）は送らない**（allowlist。`item.rs`）。floor（ja 0.813、en 0.66）と cap 8 は `ranking_policy::for_language` の値のまま（`ranking_policy.rs` の差分は可視性だけ）。S1-A は gate が閉じていて、誰にも渡さない | 同じ。400／180 字は仮の値（0.2 の細部 (c)）。出典の ID・題・score と ★4 の関係の読みは 6 の 11 |

---

## 3 §7（GDX-PRECHECK-001 の記録の項目）の改訂する行

| 区分 | 確認済みの文 | 追補後 |
|---|---|---|
| background | **当たらない**。常駐の仕事は作らない | **当たる**。応答の後に、予算 30 s の task（tail）が続く（停止が最後の ≈ `SLICE` の間に立てば、最後の 1 回の分だけ越えうる。0.2 の細部 (a)）。matrix を 1 のとおり改めた。常駐ではなく、1 呼び出しに 1 つで、permit と participant を握る間だけ。独立の queue／worker／registry は作らない。S1-A の PR 本文に「当たる」と根拠を書く（承認の記録の指定）。DR-CHATIR-S1-15 と matrix の後の区分の行には書いてある【記録】 |
| async lifecycle | **当たる**。§3.8 の matrix | 当たる。§3.8 を 1 のとおり改める |
| subprocess | 当たらない見込み | 当たらない。新しい process は起こさない。blocking pool の thread を応答の後も 30 s の予算の間、最大 2 本使う（1.6。30 s の読み方は 1 の冒頭） |
| 保存範囲 | 当たる（(1)〜(6)） | 変わらない。tail は既存の `ai_audit_events` に、同じ event_id・payload・時刻のまま書き足すだけ（既存の append が同じ event を冪等に扱う）。tail と S1-A は、新しい event・metadata・宛先を足さない。S1-A0（別 PR）が埋め込みの audit の metadata に `consumer: "chat-ir"` を足している（0.2。DR-CHATIR-S1-11 の (2)）。pending は process 内の memory だけ |
| 外部送信 | 当たる | 変わらない。新しい送信先は無い。S1-A は gate が閉じていて、IR は誰にも渡らない（tail は埋め込みの audit の終端を書くだけで、本文・query の送信は無い） |
| 閾値 | 当たる（未定） | 変わらない。tail の値は新しい閾値ではなく、値の出所は次のとおり分かれる。緩める変更は無い。ただし 30 s の例外（0.2 の細部 (a)）は、読みしだいで「承認した値の超過」に当たる。<br>・**30 s**：ユーザーが承認した値（承認の記録 `a56a808b`）。<br>・**250 ms（`SLICE`）と 1 s（`CLOSE_FLUSH`）**：DR-CHATIR-S1-15 の技術判断。承認は「短い区切り」とだけ言い、値を指定しない。<br>・**10 s（期限）と 2（in-flight）**：確認済みの §3.6・§3.8 が「期限」「同時に走る数の上限」の値を技術判断とする枠の中の初期値（DR-CHATIR-S1-1・4・19）。10 s を「期限＋推論 1 回＋append 1 回」より延ばす、in-flight を 2 より上げることは確認の対象（`chat_ir.rs:48-50` のコメント）【記録】 |
| 新しい契約・authority | 当たる（★1） | 変わらない。consumerKind を登録せず、Freshness・承認・開示の authority を足さない |
| 製品公開 | 当たる（後で） | 変わらない。gate は閉じたまま（0.1）。開けるのは S3 で、別に確認する |
| threat model | 当たる | 当たる。この追補を確認済みの版への追補として、候補の台帳（`threatModelRef`）に併記する |

---

## 4 audit export への影響

- `ai_audit_read_snapshot` は immutable な high-water snapshot で、選んだ high-water より後に追記された行は export から除かれる（`read_ai_audit_snapshot_for_scope`、`ai_audit.rs:1856-`）。`ai_audit_verify` も `high_water_sequence` を取る（`ai_audit.rs:1929-`）。`ai_audit_append_batch` の doc は、workspace の切替で visible な非終端の execution が残ることを既存の許容された状態として書く（`lib.rs:12702-`）。【確認】はここまで。snapshot の SQL は `sequence > ? AND sequence <= ?` で high-water までだけを読む（`ai_audit.rs:1895-1902`）。これらから、tail の遅い終端の追記が export の整合を壊す心配は小さいと読む【判断】。
- 非終端の execution（start があり terminal が無い）は `reportCoverage.ts:350` で `ambiguousExecutionCount` に数えられ、export の本文に件数として出る（`exportBundle.ts:798-799`）【確認。下書きの「未確認」はこれで解けた】。
- 残る影響は 2 つ。(i) export の時点で pending だった chat IR の execution が、報告に非終端（ambiguous）として載る。tail が後で書いても、その export には入らない。(ii) G3 §4 の「Native の期限が export の待ちの上限になる」は成り立たなくなる。tail の終端の append は、export が待つ「走っている IPC task の実終了」（応答まで）の外にある。G3 の file（repo の外の `s1-gate-g3-matrix.md`）は書き換えていない。
- 時刻と sequence の順（tail の終端は元の時刻のまま、後の sequence で入る）を audit の読み手がどう扱うかは未確認（6 の 6）。材料として、`ai_audit_events` には event の `timestamp`（元の時刻）とは別に `recorded_at`（追記の時刻。`recorded_at_now_ms()`、`ai_audit.rs:1154`）があり、どちらも hash の入力に入る（`ai_audit.rs:1155-1167`）【確認】。遅れた書き足しは、`timestamp` が元の時刻のまま `recorded_at` だけが遅れる行として区別できる【推測】。

---

## 5 変わらないもの（確認済みの防御・actor・送信先・保存範囲・閾値）

- tail は新しい受付ではない（permit・participant は応答の前から保持している）。renderer・Main に handle・ticket を出さない。
- 同時実行の上限は 2 のまま、期限の初期値は 10 s のまま、`CONNECTION_PROBE` は 1 s、query は UTF-16 500 unit。
- 新しい送信先・保存範囲の拡大・閾値の変更・gate を開く経路・新しい契約や authority は無い（ただし 30 s の予算の例外の読みは、0.2 の細部 (a) のとおり統合者の判断）。gate は Main の closed gate（常に閉）、Native の gate（既定で閉、開ける呼び手なし）、restricted の `plaintext-publication` で閉じたまま。renderer の定数は S1-B で、S1-A にはまだ無い（0.1）。
- 信頼する／しない actor、範囲内／範囲外の攻撃（乗っ取られた renderer は範囲外、§4.1・§4.4）は確認済みの文のまま。tail はこれらを動かさない。

---

## 6 未解決・未確認（この追補では決めていない）

1. **実物の通し**：実 model と公開済みの Chronicle index で、`PendingTerminalAudit` の tail まで通した試験は無い（Native の試験では作れない）。tail の制御は Fake の pending（`flow.rs` の試験と `real.rs` の `shutdown_is_not_held_up_by_a_call_in_its_tail`）、`flush_until` は S1-A0 の試験で固定している【記録・読み。試験の実行はしていない】。
2. **製品の値での測定**：停止の後の tail の長さ、shutdown の遅れを、製品の値（250 ms／1 s）で測っていない。試験の値（100 ms／200 ms）で 2 s 未満と観測しただけ【記録】。
3. **polling と cycle**：1 ms の再試行の CPU・wakeup、maintenance の cycle の長さと頻度（tail が 30 s を全部 busy で使い切る頻度）は未測定。
4. **PR 本文**：PR #935 の本文に GDX-PRECHECK-001 の背景作業の行があるかは読んでいない（0.2）。
5. **log**：捨てた pending の `tracing::error` の出力先と保持期間は未確認（出すのは execution_id と件数だけ）。
6. **時刻と sequence の順**：tail の終端は元の `timestamp` のまま、後の sequence、遅れた `recorded_at` で入る（DR-CHATIR-S1-11。`recorded_at` の列は 4）。audit の検証・読み手が時刻の単調性を見ているかは、`grep` の範囲では見つからなかったが、読み切っていない。
7. **仮の値**：要約 400 字・quote 180 字（確認済みの §3.6 は字数を未定とする）。S2 の後に決める。上げる向きは確認の対象。
8. **S1-B 以降**：executor、renderer の定数、`usedIds`、audit の置き換え（S1-C）、gate を開ける S3 は、この追補の範囲外。S3 の前に、開け方と送信の範囲を別に伺う。
9. **`wait_for_sole_owner` が失敗した後の lifecycle の最終状態**：tail が停止を見逃して 10 s を超えたとき、restore・shutdown・同じ path の再 open が error で中止される。中止の後に確認できたのは、active authority が戻ること、restore では live の置換の前に返ること、admission が戻ることだけ（1.9）。lifecycle が Ready に戻るか RecoveryRequired になるか、再試行できるかは読んでいない（`publish_workspace_lifecycle_from_workspace_off_runtime` が workspace の状態から決める。未読）。通常は participant の待ちの後に Arc が戻るので、この経路に入るのは tail が停止を見逃したときだけ。
10. **30 s の予算を越える最後の 1 回**：0.2 の細部 (a)。承認の内側と読めるか、`close_flush` を残り予算で切る直し（別 PR）を先にするか、ユーザーに伺うかは統合者が判断する。直しの要否は、この追補では決めない。
11. **出典の ID・題・score と ★4 の関係**：item の `revisionId`・`sceneId`・`sceneTitle`・`score` は確認済みの §3.3（★1）の出力に由来する。★4 の回答は「承認の文言どおり要約と quote に限る」で、DR-CHATIR-S1-21 は「★4 の内」と読む。この読みは S1-A では効かない（gate が閉じていて何も送らない）が、S3 の前に、送る範囲を別に伺うときの材料にする（8 と同じ）。

---

## 7 下書きとの差分と、その理由（作業の記録。contracts に置くときは削ってよい）

### 7.1 下書きとの差分

| # | 下書き | この本文 | 理由 |
|---|---|---|---|
| 1 | 状態「下書き。repo には入れない」、根拠は回答の ref のみ | 状態を「追補（contracts に置く前の候補）」にし、承認の記録の SHA、前提の回答、PR #935（merge `01dd6821`）、DR-CHATIR-S1-13〜27、照合の基点を冒頭に追記 | 依頼（冒頭に状態・根拠）。前例の追補の形に合わせた。`357a87b7` の SHA 一致も確認した |
| 2 | 確かめた事実の節が無い | 0（gate が閉じて挙動が変わらないこと、承認の範囲との照合、承認の文面に無い細部 3 点）を追加 | 依頼（明記する）。実装の読みで確かめた |
| 3 | §4「gate は renderer の定数 false、Main の closed gate、Native の gate で閉じたまま」 | renderer の定数は S1-B で、S1-A にはまだ無いと直した（0.1 の 4、5） | 誤り。DR-CHATIR-S1-27 と `src/` の `git grep` で、S1-A の renderer に定数も caller も無い |
| 4 | 「`tracing::error`（execution_id のみ）」 | execution_id の一覧と event の件数に直した | `Drop` の実装（`runtime_chat_ir.rs:206`）が `events` の件数も出す。本文・query は出さない点は同じ |
| 5 | tail の終わり方は「停止」と「30 s」 | `Failed`（busy でない error の累計 5 回、`MAX_FLUSH_ERRORS`。点検で「5 連続」を直した）と `TailEnd` の debug log を追加。`stop_requested()` が真になる条件と、`Err` も停止と数えることを追加 | `tail.rs` と `workspace_lifecycle.rs:726` の読み。下書きは記録の要約だった |
| 6 | 「停止後の tail ≈ `SLICE`＋`CLOSE_FLUSH`＋append の書き込み 1 回」 | 書き込みは最大 2 回分（進行中の slice と最後の試み）に直し、【推測・未測定】を付けた | `run_tail` の構造（`flush_until` が 2 回走りうる）。製品の値では測っていない |
| 7 | 落とす順「pending → request（Arc）→ participant → permit」 | pending → request（DTO）→ backend（pin した request の Arc → participant）→ permit に直し、「順序は保証ではない」を追加 | `execute` の `drop` の並び（`flow.rs:222-226`）と `NativeBackend` の宣言順。`request` は Arc でなく DTO |
| 8 | tail を起こす条件の記述が無い | 「tail は IR を返さなかった呼び出し（`timeout`／`inference-failed`）の後にだけ生じる」の行を追加 | `prepare_chat_ir_query_with` と `run_steps` の読み。`ChatIrQuery` が終端の durable の後でだけ作られることの帰結 |
| 9 | 切替・restore の行：「`wait_for_sole_owner`（10 s）が error になる」 | participant の待ちは上限なし（専用の reader だけ別）、Arc の待ちは 10 s で、呼び手は restore・shutdown・再 open の 3 つ、restore は transition を経由、project の切替は影響しない、別 workspace の DB には書かない、を追加 | `workspace_lifecycle_view.rs`、`backup_restore.rs`、`open.rs`、`lib.rs` の `restore_backup_supervised` の読み |
| 10 | 接続の握りの行 | tail が embedder の admission を握らないこと、1 ms が 2 か所（db と semantic）にあること、cycle が長いと 30 s を使い切って捨てうることを追加 | `with_resident_until`、`connection_deadline.rs`、`runtime_chat_ir.rs` の読み |
| 11 | 待ちの上限の行 | 確認済みの「`index-unavailable`（timeout）」が実装では `timeout` に分かれたことを追記 | DR-CHATIR-S1-25。意味は同じで、文言の差を記録する |
| 12 | 同時実行の行 | 「sender ごとではなく process 全体」「blocking pool の thread を最大 2 本、30 s の予算の間占める」を追加 | 確認済みの §3.8 は「sender ごとに置くか」を技術判断としていた。`permit.rs`、`chat_ir.rs` の読み |
| 13 | 「エラーの持ち主」は executor を前提 | S1-A に executor は無く、適用先は S1-B 以降だと追記 | S1-A の範囲（executor は含めない） |
| 14 | §3「未確認：`reportCoverage.ts` と `read_ai_audit_snapshot_for_scope` が非終端の execution をどう数えるか」 | 確認済みに変えた（`ambiguousExecutionCount`、`exportBundle.ts`、high-water の読み）。時刻と sequence の順を新しい未確認として 6 に移した | `reportCoverage.ts:350`、`ai_audit.rs:1856-` の読み |
| 15 | §2 の subprocess の行が無い | 追加（当たらない。blocking pool の thread の占有を明記）。閾値・外部送信・保存範囲・契約・公開の行も追加 | §7 の全区分を追補の側で揃えるため |
| 16 | tail 以外の S1-A の記述が無い | 2（入口の順、3 回の read、同時実行、発行の記録、閉じた status、Main の closed gate・restricted、20 s の caller timeout、送るデータの射影）を照合として追加 | 依頼（実装と合っているかを確かめる対象）。確認済みの文は書き換えず、弱めない向きを記録するだけにした |
| 17 | 変わらないもの（§4） | 5 に移し、actor・範囲外の攻撃が動かないことを追加。値（30 s、250 ms、1 s、10 s、2、1 s、500 unit）は実装と一致 | 実装の `ChatIrConfig::default` と `request.rs` の読み |
| 18 | 未解決・未確認の節が無い | 6 を追加（実物の通し、製品の値の測定、polling と cycle、PR 本文、log、時刻の順、仮の値、S1-B 以降） | 未確認を成功扱いにしないため |

下書きのうち、実装と一致して**変えなかった**もの：30 s、`SLICE` 250 ms、`CLOSE_FLUSH` 1 s、期限 10 s、in-flight 2、`CONNECTION_PROBE` 1 s、query UTF-16 500 unit、`PendingTerminalAudit` が task の local で `#[must_use]`、`ChatIrQuery` は終端の append の後でだけ作られる、pending が process 内のみ、waiter を名乗らない取得と maintenance の cycle の間は取らないこと、`participant` の stop が transition の admit と shutdown の両方で立つこと、audit export の high-water、新しい宛先・保存範囲・閾値が無いこと。

### 7.2 DR-CHATIR-S1-15 との食い違い（この追補が実装に合わせて精密化した点）

repo の `docs/plans/nir1-lane-decisions/chat-ir-s1-decisions.md` の DR-CHATIR-S1-15（および DR-CHATIR-S1-11）の記述と、実装・この追補が違う点。DR の訂正が要るか、どう訂正するかは統合者が判断する。この追補は DR を書き換えない。

| # | DR の記述 | 実装・この追補 | 根拠 |
|---|---|---|---|
| 1 | 「close の遅れの上限は ≈ SLICE＋CLOSE_FLUSH＋append の書き込み 1 回（【推測】。S1A-12・S1A-13 の試験で測る）」 | 書き込みは最大 2 回分（進行中の slice と最後の試みのそれぞれ）【推測・未測定】 | `tail.rs:73-85` |
| 2 | 「落とす順は pending → request（Arc）→ participant → permit」 | pending → request（DTO）→ backend（pin した request の Arc → participant）→ permit。順は保証ではない | `flow.rs:196-200,222-226`、`native.rs:37-40` |
| 3 | 「`tracing::error` で execution_id を残す。本文・query は出さない」（DR-CHATIR-S1-11 も同じ） | execution_id の**一覧**と event の**件数**を出す。本文・query は出さない | `runtime_chat_ir.rs:206-216` |
| 4 | 「`tail_deadline` は応答の後 30 s」「tail は停止を区切りごとに見て必ず終わる」 | 30 s は flush の予算。停止後の最後の 1 回は `tail_deadline` で切られないので、停止が最後の ≈ `SLICE` の間に立つと 30 s を最大 ≈ 1 s＋書き込みで越えうる（0.2 の細部 (a)） | `tail.rs:73-81` |
| 5 | tail の終わり方として、書けた・停止・30 s の切れを書く | もう 1 つ、busy でない error の累計 5 回で捨てる（`TailEnd::Failed`）がある。DR に無い終わり方 | `tail.rs:60,68,88-92` |

---

## 8 点検の指摘と扱い

点検（read-only。基点は同じ `origin/master` `01dd6821`）の指摘ごとに、出典で確かめてから直した。同意しなかった指摘は無い。確かめは `git show`／`git grep`／`git diff` と、contracts の commit（`357a87b7`、`a56a808b`）の `git show` だけで行い、build・試験・測定は走らせていない。

| ID | 指摘 | 扱い | 出典での確かめと、直した場所 |
|---|---|---|---|
| M1 | 「非 test の Main の呼び手は 2 つ」は誤りで 3 つ | **採用**。誤りだった | `git grep -n mainOpenPrePublicationGate origin/master -- electron src packages` の test 以外の呼び手は、`bodyDeclarationCiSeam.ts:229`、`nir1LocalGeneration.ts:172`、`profileActivationCiSeam.ts:165`（kind は `:43` の `"profile-activation"`）の 3 つ。ほかは型の宣言（`ipcContract.ts:959`、`index.d.ts:87`）と test 用 helper（`profile-activation-helper.mjs:48`）。`chat-agent-ir` を渡す呼び手が無い結論は変わらない（`chatAgentIr.test.ts:159-193` が固定）。0.1 の 1 を直した |
| M2 | 「CLOSE_FLUSH は tail を 30 s の内側でむしろ短くする向き」は成り立たない。「最長 30 s」にも注記が要る | **採用**。誤りだった。承認の範囲に関わるので、内側と読めるかは統合者の判断に回した（追補は断定しない） | `tail.rs:73-78` は停止の判定を予算切れの判定（`:81`）より前に置き、`flush_until(Instant::now() + timing.close_flush)` を `tail_deadline` で切らない。`unit.rs:686` の試験は予算 10 s で、停止は最初から立っている。承認の原文（`a56a808b`）は「応答の後、最長 30 s。停止は短い区切りごとに確かめる」。直した場所：0.2 の表と細部 (a)、0.2 の範囲の文、1 の冒頭の「最長 30 s の読み方」、1.3・1.4・1.6、3 の background・subprocess・閾値、5、6 の 10、7.2 の 4。技術的な直し（`close_flush` を残り予算で切る）は別 PR で、この追補の範囲外 |
| R1 | 切替・restore の行の「データは変わらず、再試行できる」の一部が推測 | **採用**。「再試行できる」と「データは変わらず」を削り、確認できる範囲だけを書き、残りを未確認へ移した | active authority を戻すのは `backup_restore.rs:653-656`、`open.rs:904-910`。`shutdown_workspace_storage` は `inner` を取らずに返る（`open.rs:390-393`）。restore の error の経路で admission を戻す（`lib.rs:12225-12233`）。lifecycle の最終状態は `publish_workspace_lifecycle_from_workspace_off_runtime` が決め、読んでいない。`open.rs:950-952` の log は復旧を lifecycle supervisor に委ねると書く。1.9 と 6 の 9 を直した。なお「データは変わらず」は、待ちの前に restore の epoch の取得がある（`backup_restore.rs:625-627` の failpoint の位置。何を変えるかは読んでいない）ので、言い切れない。「live の置換の前に返る」へ弱めた |
| R2 | DR-CHATIR-S1-15 との食い違いを明記する | **採用** | 冒頭に 1 行、7.2 に表（5 点。指摘の 3 点＋tail の長さの上限＋`Failed`）。DR の原文は `git show origin/master:docs/plans/nir1-lane-decisions/chat-ir-s1-decisions.md` の 157 行（DR-15）と 46 行（DR-11）で照合した |
| R3 | 「5 連続」は「累計 5 回」 | **採用**。誤りだった | `tail.rs:68,88-92`：`errors` は `Ok(false)` を挟んでも 0 に戻らない。コメント `tail.rs:59` の "in a row" と挙動が違う。1.3 と 7 の行 5 を直した。試験 `tail_gives_up_after_repeated_append_errors`（`unit.rs:711-719`）は常に error の場合だけで、累計と連続を区別しない |
| R4 | 「audit に新しい event・metadata は足していない」の範囲を明示する | **採用** | `runtime_chat_ir.rs:464-465` が `"consumer": "chat-ir"` と `sharedConsumers: ["chat-ir"]` を足す。既存の `runtime_audited_query.rs:125-129` の metadata に `consumer` key は無い。DR-CHATIR-S1-11 の (2) は「`sharedConsumers` と `consumer` が `chat-ir`」と記録している。0.2 と 3 の保存範囲を「S1-A（#935）と tail」に限定し、S1-A0 の `consumer` に触れた。確認済みの §3.5 の (4) の範囲と読むかは統合者の判断とした |
| L1 | 1 の「確認済みの文」は抜粋で、原文を略した箇所がある | **採用** | 9 セルとも §3.8 の原文（`357a87b7` の 322-336 行）の逐語に直した。機械的に部分文字列の一致を確かめた（9 件すべて一致）。表をやめ、節（1.1〜1.10）にした |
| L2 | `SLICE`／`CLOSE_FLUSH` は DR の呼び名で、コードの識別子と対応を書く | **採用** | 1 の冒頭に対応表（`ChatIrConfig.tail_slice`／`close_flush`／`tail_budget`、`chat_ir.rs:54-62,68-74`。`TERMINAL_BACKFILL_BUDGET` は `runtime_chat_ir.rs:46`） |
| L3 | 3 の閾値の行は、値の出所を分ける | **採用** | 30 s＝承認（`a56a808b`）、250 ms・1 s＝DR-15 の技術判断（承認は値を指定しない）、10 s＝DR-CHATIR-S1-1、2＝DR-CHATIR-S1-4・19。確認済みの §3.6 は期限の値を「技術判断」とする。3 の閾値の行を直した |
| L4 | 4 の「心配は小さい【確認】」は判断。`recorded_at` の列を足す | **採用** | 【確認】は `sequence <= high_water`（`ai_audit.rs:1895-1902`）などの事実だけにし、結論は【判断】にした。`recorded_at` は別の列で、追記の時刻（`ai_audit.rs:1154`）。`timestamp` と共に hash の入力（`:1155-1167`）。4 と 6 の 6 に足した |
| L5 | 2 の 8 に `$grimodexIr` 印と `origin` が無い。由来を書く | **採用** | `item.rs:25,27,122-136`。`revisionId`・`sceneId`・`sceneTitle`・`score` は確認済みの §3.3（★1）に由来すると書いた。さらに、★4 の回答（「承認の文言どおり要約と quote に限る」）との関係を DR-CHATIR-S1-21 が「★4 の内」と読む点を、6 の 11 に未確認として足した（S1-A では送らないので効かない） |
| L6 | 1 の長い行を箇条書きに分ける | **採用** | L1 と同じ直しで、1 の全行を節＋箇条書きにした |
| L7 | `electron/main/chatAgentIr.ts` のコメントは、S1-A に無い renderer の定数を「他の 2 つの閉じ方」の 1 つと書く（repo 側） | **記録のみ**。追補は直さない。追補の「閉じ方は Main の closed gate・Native の gate・restricted の 3 つ」は正しい | 該当は `chatAgentIr.ts` の 10-11 行（点検は 9-10 行）。renderer の定数は S1-B（DR-CHATIR-S1-27）。コメントの訂正は、renderer の定数を足す S1-B の PR で行うのが自然。コードは変えていない |
