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
| DR-IRB-4 | 2026-11-05 | **prepare の中の Run 単位の memo（第一段）**。`read_snapshot_with_control` の 1 回の呼出し（＝1 つの read tx）の間だけ、同じ Run の次の結果を Root（reviewed revision の根）ごとに繰り返さず使い回す：(a) receipt の hydrate と lifecycle／audit の検証（`load_verified_stage_receipts_for_hydration`）、(b) artifact 行の走査（JSON の parse と canonical digest）、(c) Snapshot の authority の検証（`load_verified_chronicle_snapshot_for_apply`）、(d) 再生が読む accepted artifact（snapshot、window plan、raw、merged、clusters、synthesis）。key は (project_id, run_id)（accepted は run_id と task と kind）。仕組みは **明示の引数 `RunProofMemo`（`&mut`）**：prepare の関数の局所変数として作り、`preflight_build_candidate_with_memo` → `read_revision_material_membership_with_memo` → `read_root_material_with_memo` → `replay::resolve` へ渡し、loop の後で drop する。`BuildSnapshot` には入れない。cache するのは tx 内の同じ snapshot の行だけから決まる値で、SQL エラーは cache せず伝播する。検証失敗は呼出し元が使う分類（hydrate の失敗、Snapshot authority の失敗、artifact 走査の中断の issue）だけを cache し、accepted artifact の失敗（呼出し元が文言で分類する）は cache しない。Root ごとに違う処理（`load_v2_context_artifact`、envelope の検証、lineage、request の proof の再計算）は memo しない。`control.check` は候補ごとに今と同じ位置・回数。memo を渡さない呼出し元（`read_revision_material_membership`、`inspect_material_roster`、revision_eligibility、retrieval_admission、publish 側）は、使い捨ての空 memo で今と同じ順序・結果の経路を通る | 検証の意味（receipt／audit の CAS、Snapshot authority、digest の比較）、fail-closed、publish の再検証、閾値、送信先、保存、IPC、契約は変えない。memo は 1 回の read tx の中だけで、tx の外へ持ち出さない。根拠は、ユーザーの方向の承認（2026-11-05「その方向で進めてよい」）で、U3 ではない | (a) 範囲を限った thread-local の guard：呼出し経路を変えずに済むが、暗黙の状態になり、再入（入れ子の prepare）・panic 時の後始末・publish 側や他の呼出し元への漏れを guard の実装に頼ることになる。明示の引数なら寿命が呼出しの frame に収まり、型が漏れを防ぐ。経路の引数が 3 関数ぶん増えるのは許容、(b) `BuildSnapshot` に持たせる：寿命が tx を超えるので採らない、(c) Root ごとの `RootMaterialRead` を丸ごと memo：envelope と cluster が Root ごとに違うので共有できない。Run 単位の部分だけにした、(d) 失敗も含めて全部 memo：accepted の失敗は文言で分類されるので成功だけにした、(e) 専用の読取接続（DR-IRB-3）：前景を塞がない根本の解で、別の判断 | 実装済み（PR 待ち） |

## 3. 変えないもの・まだ決めていないもの

- 変えない：snapshot の source の束縛（3 回の `validateSceneScope`、`sourceRowsMatch`、`settleExternalSourceMutations`、quiescence lease）。これは安全のための fence。IR の publish の再検証と CAS。receipt の audit の検証の意味。read だけに caller timeout を付ける方針（mutation lane に timeout を付けない）。
- DR-IRB-1 の後の測定（REPS=3、dev 枝の計測の道具）：prepare は m-ja-2 で 10.2 s、m-en-1 で 12.3 s。内訳の最大は `root_material`（Run の receipt の hydrate と artifact の再生）で、receipt の検証の呼出しは receipt の数の 4.8 倍／9.2 倍だった（同じ Run の Root ごとに Run 全体を検証し直していたため）。DR-IRB-4 はこの重複を無くした。測定（同じ道具、REPS=2 の 2 回目、release、2026-11-06。前の値は別の測定で、m-ja-2 の before 10.4 s はこの道具での再計測、m-en-1 の before 12.3 s は前の REPS=3 の値）：m-ja-2 の prepare は 10.4 s → 7.4 s（hydrate 491 → 102 回＝Run の数、receipt の検証 6,934 → 1,417 回、`root_material` 5.2 s → 2.1 s）、m-en-1 は 12.3 s → 7.0 s（hydrate 509 → 59 回、検証 14,291 → 1,546 回＝receipt の数、`root_material` → 3.1 s）。prepare はなお候補の数に線形に伸びるので、前景を塞ぐ問題の根本の解にはならない（残りは下の内訳）。
- 残りの内訳（m-ja-2、DR-IRB-4 の後）：`finalize.freshness` 3.1 s（候補ごとの Freshness の読み）、`root_material` の残り 2.1 s（`load_v2_context_artifact` 0.4 s、Root ごとの request の proof と material の再計算）、`root_material` の外の membership 1.7 s（revision の lineage の読み、envelope の検証）。次に効くのは Freshness の Run 単位の共有、lineage の読みの共有、または prepare を前景に譲らせる・dirty を debounce する・専用の読取接続（DR-IRB-3）。いずれも別の判断として設計する。
- DR-IRB-4 の memo は prepare の間じゅう、全 Run の parse 済み artifact の Value（snapshot の payload は `ArtifactScan` と accepted の 2 部）を持つ。写しの DB の artifact の payload は 106 Run で計 14.4 MiB（m-ja-2）、59 Run で計 14.9 MiB（m-en-1）で、Value 化で数倍になる見込み（推測。peak RSS は未測定）。大きい作品で問題になるなら、`ArtifactScan.snapshots` を検証に要る項目だけに絞るか、Run ごとに memo を捨てる。次の段で一度測る。
- 前景の read の lock 待ちに期限を付ける案は、関連場面の IR の窓（D=40 ms）との関係があるので、案を並べてユーザーに聞く。
- `projectSnapshotAdapter.ts` の catch が読込みの例外を `SNAPSHOT_SOURCE_CHANGED` などに付け替える件（原因が記録に残らない）は、別の判断で直す。fail-closed は保ち、`SNAPSHOT_SOURCE_CHANGED` は実際の比較の不一致だけにする方向。
- PD 評価の harness（失敗の時刻を discard の前に取る、error の cause を残す）は、次の事前登録の版で直す。第 5 版の道具は凍結のまま。
- この修正を含む build で PD 評価を取り直すと、IR build の時間が変わるので、事前登録の新しい版が要る。

## 4. 検証

- DR-IRB-4 の試験 `nir1_chronicle_index::run_proof_memo_tests`：(a) 同じ fixture の全 roster revision で、memo ありと memo なしの preflight（Ok の中身、unavailable の理由、error）が一致すること。receipt の hydrate、artifact の digest、artifact の inline 欠落、Snapshot authority（snapshot task の output の改変）、accepted artifact（window plan の行の削除）の 5 種類の改変でも一致すること。5 種類は、それぞれ意図した分岐（`receipt-hydration-invalid`、`artifact-digest-mismatch`、`artifact-inline-binding-missing`、`snapshot-authority-invalid`、`recipe-input-binding-invalid`）に届くことを `read_revision_material_membership`（memo なし）と `read_revision_material_membership_with_memo` の Unavailable の status と issue の code で確かめ、preflight が unavailable の理由を 1 つに潰す前の段で比べる、(b) 1 つの Run に 2 つ以上の Root がある fixture で、prepare の hydrate が 1 回、receipt ごとの lifecycle／audit の検証が receipt の数だけになり、memo なしだと Root の数の倍になること、(c) 連続する 2 回の prepare で Run の検証が毎回やり直され（hydrate が毎回 1 回）、間に入った永続の変更（model binding の削除）が 2 回目に見えること。
- 試験 `stage_provenance::audit_count_plan_tests`：migrate 済みの DB で、2 つの SQL の実行計画が `SCAN ai_audit_events` を含まず、`idx_ai_audit_scope_` の index を `scope_id=?` で引くこと。
- receipt の再生を通る既存の試験（material roster の golden、IR の build、hydration）で、数える行が変わらないこと。
- 写しの DB（`sqlite3` の読み取りだけ）：実行計画が `SEARCH ai_audit_events USING INDEX idx_ai_audit_scope_operation (scope_id=? AND operation_id=?)` になり、同じ件数（4）を返すこと。
- prepare の段ごとの時間の実測（修正の前後）は、PD 評価の run の終了後に写しの DB で行う。
