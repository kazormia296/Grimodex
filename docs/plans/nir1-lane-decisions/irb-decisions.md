# IRB の判断の記録（関連場面の IR の index build が native の接続を長く握る件）

出所は PD 評価の本測定 第 5 版（`fusion-eval-data/pd-2026-11`、m-ja-2、117 Scene、2026-11-05）の抽出の失敗の調査
（読むだけ。DB の写しとコードで確かめた）。基点は `origin/master` の `d45fa7e8`、branch は `claude/irb-audit-scope-index`。

根拠は、ユーザーの依頼（2026-11-05、引き継いだ NIR-1 の作業と「CI 待ちの間も実装を進めましょう」）の範囲の不具合の修正であること。IRB が AGENTS.md の U3 の対象レーン（C-resource、C-body、C-product、D-final 追補、D-transport、D-dispatch、H-store／H-current、DI-1、E）に含まれるかは確かめられていないので、U3 は根拠にしない。委任の外の項目（閾値の緩和、新しい送信先、保存範囲の拡大、新しい契約）には当たらない。閾値・送信先・保存・契約は変えない。

## 1. 事実

| 事実 | 確認の結果 |
|---|---|
| 抽出の失敗 | m-ja-2 の 117 Scene のうち 11 件が、run が付く前（snapshot の作成と、その前の `listEvents`）で落ちた。`SNAPSHOT_SOURCE_CHANGED` 8、`SNAPSHOT_SCOPE_VALIDATION_FAILED`（32 字で harness が `<long>` に伏せた）2、`Failed query`（`listEvents`）1。最初の失敗は位置 53 |
| source は変わっていない | 写しの DB で Scene の行は全部 `version` 0、`updated_at` = `created_at`。`SNAPSHOT_SOURCE_CHANGED` は実際の比較の不一致ではなく、読込みの例外を `projectSnapshotAdapter.ts` の catch が名前を付け替えたもの |
| 接続の待ち | native の DB の接続は単一の `Mutex<Connection>`。関連場面の IR の index build（`electron/native/grimodex-node/src/related_scenes/build.rs` の 250 ms 周期の loop）は、承認で canonical が変わるたびに prepare を `with_participant_read_transaction` の中で走らせ、その間 mutex を握る。前景の `db_execute` は期限なしで待ち、renderer の read は 10 s（`IPC_TIMEOUT_MS`）で caller だけが timeout する |
| 時刻の一致 | 失敗した窓の終わりは、どれも IR build の最初の embedding の開始（＝prepare の終わり）の 13〜21 ms 以内 |
| prepare の伸び方 | reviewed revision が 127 件で約 4.4 s、249 件で約 10.3 s、335 件で約 18.5 s、442 件で約 32.7 s、483 件で約 36.6 s（写しの DB の時刻からの推定） |
| 走査 | prepare は候補（reviewed revision）ごとに `preflight_build_candidate` → `read_revision_material_membership` → `read_root_material` → `load_verified_stage_receipts_for_hydration` → `validate_receipt_lifecycle_binding` を通り、stage の receipt ごとに `ai_audit_events` を `COUNT(*)` で引く（`stage_provenance.rs`）。この 2 つの query は `project_id` で絞るが、`ai_audit_events` の index は全部 `scope_id` が先頭なので、実行計画は `SCAN ai_audit_events`（全件走査）。写しの DB（26,381 行、receipt 1,452 件）で 1 回 約 11.5 ms |
| 等価性 | `ai_audit_events` の CHECK が、project の行に `scope_id = 'project:' \|\| project_id` を課している（`migrate.rs` の 2 つの定義、写しの DB の schema でも同じ）。本番の書き手は `append_ai_audit_events_in_transaction` の 1 箇所で、`ai_audit_scope_id` が同じ値を導く。写しの全行で成り立つ |
| 本番の他の query | `ai_audit_events` を `scope_id` なしで引く本番の query は、この 2 つだけ（`execute.rs` の 2 つは試験の中） |
| 作者への影響 | 関連場面を一度開いて build の loop が常駐し、reviewed revision が約 250 件を超えると、承認の後の数秒〜数十秒の間、前景の read は 10 s で失敗し、書き（autosave など）は prepare が終わるまで待つ。#801・#802 とは無関係（どちらも `build.rs` を変えていない）。第 4 版の run にも同じ形の失敗があった |

## 2. 判断の表

| ID | 日付 | 判断 | 信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-IRB-1 | 2026-11-05 | **stage の receipt の audit の 2 つの `COUNT(*)` に `scope_id = 'project:' \|\| ?1` を足し、`idx_ai_audit_scope_operation` で引く**。式は schema の CHECK と同じなので、どの `project_id` でも数える行は変わらない。写しの DB で 1 回 約 11.5 ms → 約 0.1 ms。2 つの SQL を定数にし、実行計画が全件走査にならないことを試験で固定する | native の読み取りの SQL の形だけ。検証の意味（`COUNT >= 1` の CAS、比べる列）、fail-closed、送信先・保存・IPC・契約・閾値は変えない | (a) `(project_id, execution_id, operation_id)` の index を足す（migration が要る。CHECK で等価な条件を足せば済むので不要）、(b) Rust で `ai_audit_scope_id` を呼んで束縛する（空や空白を含む `project_id` で先に error になり、error の文が変わる。SQL の式なら挙動の差が無い） | 実装済み（PR 待ち） |
| DR-IRB-2 | 2026-11-05 | **`projectSnapshotAdapter.ts` の catch で、読込み・転送の失敗と確かに分かる例外だけを `SNAPSHOT_SOURCE_READ_FAILED` にする**。対象は IPC の caller timeout（`IpcInvokeError` の `IPC_TIMEOUT`、または wire の文 `IPC timeout after …ms:`）と、`cause` の鎖にある失敗した SELECT の `DrizzleQueryError`。post-seal の `validateSceneScope`・`settleExternalSourceMutations`・公開前の `validateSceneScope` の 3 つの catch に使う（今までは全部 `SNAPSHOT_SOURCE_CHANGED`）。それ以外の例外（pending mutation の reject の `AggregateError`、外部 mount の衝突、lifecycle の cancel、未知の error）は `SNAPSHOT_SOURCE_CHANGED` のまま。1 回目の validate は `SNAPSHOT_SCOPE_VALIDATION_FAILED` のまま。全ての catch の message に、原文でなく原因の種類 `(cause: ipc-timeout\|query-failed\|lifecycle\|other)` だけを足す。settle の catch だけは、基底の文も「変わった」と断定しない文（`The external Scene source fence could not be completed after sealing`）に改めた（READ_FAILED にもなりうるため。message を読む利用者は無い）。分類は純粋関数 `classifySnapshotReadFailure`。新しい code は足さず、どの経路も `ok:false` で fail-closed | renderer の診断の code と message だけ。fence（3 回の validate、`sourceRowsMatch`、settle、quiescence lease、authority）、再試行の有無、IPC・送信先・保存・契約・閾値は変えない。原因の種類は固定の語彙で、SQL・params・本文は message に入らない。`AggregateError.errors` の中は見ない（書き込みや外部 task の失敗は実際の変化を表しうる）。失敗した SELECT だけを読込みの失敗とし、失敗した write の query は `other` | (a) 全ての catch を `SNAPSHOT_SOURCE_READ_FAILED` にする（本当の変化かもしれない mutation の reject まで読込みの失敗に見える）、(b) 例外の原文を message に入れる（SQL・params・本文を含みうる）、(c) 新しい code `SNAPSHOT_SOURCE_READ_TIMEOUT` を足す（利用者が code を表示するだけなので不要） | 実装済み（PR 待ち） |

## 3. 変えないもの・まだ決めていないもの

- 変えない：snapshot の source の束縛（3 回の `validateSceneScope`、`sourceRowsMatch`、`settleExternalSourceMutations`、quiescence lease）。これは安全のための fence。IR の publish の再検証と CAS。receipt の audit の検証の意味。read だけに caller timeout を付ける方針（mutation lane に timeout を付けない）。
- この修正で prepare は大きく縮む見込みだが、audit の走査が prepare に占める割合は 48〜100％ の幅でしか分かっていない。残りの線形の分（約 20 ms／候補の見込み）が大きい作品で 10 s に近づくなら、次を別の判断として設計する：prepare の中の run ごとの memo、prepare を前景に譲らせる・dirty を debounce する、専用の読取接続で prepare する。
- 前景の read の lock 待ちに期限を付ける案は、関連場面の IR の窓（D=40 ms）との関係があるので、案を並べてユーザーに聞く。
- `projectSnapshotAdapter.ts` の catch が読込みの例外を `SNAPSHOT_SOURCE_CHANGED` に付け替える件は DR-IRB-2 で直した：読込み・転送の失敗と確かに分かるもの（IPC timeout、失敗した SELECT）は `SNAPSHOT_SOURCE_READ_FAILED`、message に原因の種類を足す。fail-closed は保つ。pending mutation の reject や外部 mount の衝突など、変化かもしれない例外は保守的に `SNAPSHOT_SOURCE_CHANGED` のまま残るので、「`SNAPSHOT_SOURCE_CHANGED` は実際の比較の不一致だけ」までは行かない（残りは例外の種類を型で分けられてから）。利用者（`extractionCoordinator.ts`、`codexStructureExtractionApi.ts`）は code を連ねて `Snapshot build failed: …` にするだけで、message は表示しないので、画面で見えるのは code の違いだけ。message の原因は診断を読む道具向け。
- PD 評価の harness（失敗の時刻を discard の前に取る、error の cause を残す）は、次の事前登録の版で直す。第 5 版の道具は凍結のまま。
- この修正を含む build で PD 評価を取り直すと、IR build の時間が変わるので、事前登録の新しい版が要る。

## 4. 検証

- 試験 `stage_provenance::audit_count_plan_tests`：migrate 済みの DB で、2 つの SQL の実行計画が `SCAN ai_audit_events` を含まず、`idx_ai_audit_scope_` の index を `scope_id=?` で引くこと。
- receipt の再生を通る既存の試験（material roster の golden、IR の build、hydration）で、数える行が変わらないこと。
- 写しの DB（`sqlite3` の読み取りだけ）：実行計画が `SEARCH ai_audit_events USING INDEX idx_ai_audit_scope_operation (scope_id=? AND operation_id=?)` になり、同じ件数（4）を返すこと。
- prepare の段ごとの時間の実測（修正の前後）は、PD 評価の run の終了後に写しの DB で行う。
- 試験 `projectSnapshotAdapter.test.ts`：`classifySnapshotReadFailure` の分類（timeout、失敗した SELECT、失敗した write、lifecycle、`AggregateError`、循環 cause）と、post-seal の validate・settle・公開前の validate・`loadSourceRows` の 3 回の各 catch で、IPC timeout と失敗した SELECT は `SNAPSHOT_SOURCE_READ_FAILED`、一般の error・pending mutation の reject・lifecycle の cancel は `SNAPSHOT_SOURCE_CHANGED`、比較の不一致は `SNAPSHOT_SOURCE_CHANGED`。message に SQL・params・本文が入らないこと。
