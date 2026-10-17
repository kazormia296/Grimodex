# DT-4 の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane：DT-4（K5/3 `docs/plans/nir1-d2b-local-send-proposal-3-draft.md`。2026-10-17 の Session B1 で確認済み）。base は origin/master a7666048。
製品入口（PUB-L、Graph の PUB-G）は閉じたまま。新しい IPC・N-API・schema・依存は足さない。T1〜T4 の順に、この表へ追記する。

## owner／lifecycle matrix（GDX-PRECHECK-001。DT-2 の matrix〔DSN §1.10〕との差分）

| 区分 | DT-4 の差分 |
|---|---|
| entry | start writer は DT-5 の `Nir1TransportOwner` からだけ（DT-4 は呼ぶ側を作らない）。終端への同梱は既存の finish／recover の入口を通るだけで、新しい入口を足さない。policy の読取は DT-5／DD-1 が `pub(crate)` から呼ぶ。汎用 append の拒否は既存の入口（db の free 関数と method、N-API `ai_audit_append_batch`、Main の IPC 検証）に拒否を足すだけで、入口は増えない |
| start | start の 3 件は claim の commit の後、接続の前に 1 transaction。start の書込みは lease を持たない（participant、permit、witness で守る）。書けなければ送信 0 |
| retry | start の 3 件は原子的で、冪等な再書込みは既存の eventId 衝突の規則（同内容なら読み飛ばし）。自動の再送・再接続はしない。sweep の `ConnectionBusy` の再試行（1 件あたり 3 回）は変えない |
| reentrant | 同じ execution への start は 1 回（`execution.started` は 1 回しか書けない）。終端は execution ごとに 1 回 |
| admission closure／pending start | start の書込みは Admission の fence（取消、stop、失効で止まる）。終端と sweep の書込みは Pinned（取消でも止まらず、3 つの上限で有限）。T3 で確定して DR に記録する |
| active handle | 新しい handle を持たない。終端と監査の終端は同じ transaction で、owner の participant／permit／slot の解放は変えない |
| cancellation | `cancel()` の経路（stop flag と phase mutex だけ。DB を待たない）は変えない。policy の読取は cancel の lock の外 |
| bounded wait | audit の書込み、policy の読取は DT-2 と同じ 100 ms／100 ms／250 ms。新しい数値は足さず、緩めない。送信の前の待ちの合計（DT-2 の最大 7 操作 1,750 ms に policy の読取 250 ms と start の書込み 250 ms）は DT-5 の matrix に引き継ぐ |
| 終了の証拠 | attempt の終端の行と監査の終端が同じ transaction で durable。execution がない attempt は監査の終端が 0 件であることが証拠 |
| error／timeout／onClosed | commit が不明（Unknown）なら DT-2 の規則（exact ID の再読取と quarantine）。start が Unknown で durable だった場合、呼出し側が書く送信 0 の終端が execution を閉じる（同梱） |
| restart | 永続するのは `ai_audit_events` と `nir1_generation_attempts` だけ（新しい永続状態なし）。再起動の後の sweep が attempt の保守的な終端と同じ transaction で `execution.failed` を書く。execution がなければ書かない。sweep の上限は変えない |

## 判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DT4-1 | 2026-10-17 | DT-4／T1 | 予約 namespace を 1 つの接頭辞 `nir1-local-generation:` にし、path ID は `nir1_local_generation_writing`／`nir1_local_generation_review` の 2 件とする。ID は attempt ID から決定的に導く：execution `nir1-local-generation:execution:<attemptId>`、operation `nir1-local-generation:operation:<attemptId>`、event `nir1-local-generation:event:<attemptId>:<eventType>`（eventType は execution 内で 1 回ずつなので衝突しない）。sweep は attempt ID から execution を exact に引ける。attempt 表に列は足さない。予約の判定は eventId／executionId／operationId／parentExecutionId の 4 種すべてを同じ接頭辞で見る。比較は前後の空白を除き ASCII の大文字小文字を区別しない（`" NIR1-Local-Generation:x"` のような変形も拒否する。拒否が広い分には既存の ID と衝突しない：既存は UUID か run ID）。path ID も同じ正規化の完全一致 | renderer（`ai_audit_append_batch`）は予約に書けない。書けるのは Native の専用 append（`pub(crate)`）だけで、専用 append も全 event が予約の形であることを要求する。privilege の区別は関数の入口で行い、呼出し側の引数では選べない | K5/3 の対案 (a)（registry の allowlist 方式。別 draftRef が要る）。ID を attempt 表の列に保存する（保存範囲の拡大で委任の外） | 不要（K5/3 の推奨どおり） | 該当なし | 新しい owner・thread・egress なし。拒否は書込み前の純関数 | 記録済み（実装前）。T1 で実装：module `grimodex-db/src/nir1_local_audit.rs`（`pub` の定数と ID 導出、`pub(crate) append_reserved_events_in_transaction`。attempt ID は英数字・`-`・`_` の 1〜128 bytes に限る。導出した ID から attempt ID を戻す `attempt_id_from_execution_id` は完全一致で大文字小文字を区別する） |
| DR-DT4-2 | 2026-10-17 | DT-4／T1 | 汎用 append の拒否は db の入口（`append_ai_audit_events_for_scope` の free 関数と `Database` の method）と Main の IPC 検証（`requireAiAuditEvents`）の二重に置く。batch の 1 件でも予約なら batch 全体を typed なエラー（`Nir1LocalAuditReservedError`）で拒否し、何も書かない（BEGIN の前に判定）。N-API は db の method を通るので変更しない。接頭辞と path ID は TS 側が `electron/shared/nir1LocalAuditNamespace.ts` の 1 定数に置き、Rust の source を読む vitest で drift を検出する。CLI claim・post-effect・semantic の writer は挙動を変えない（CLI claim は内部の transaction 版を直接呼ぶので拒否の対象外。予約の ID を渡しても、path が CLI の 2 つに限られ、前提の event もないので書けないことを試験で固定する） | 防御は db が最終（Main は先の拒否）。TS と Rust の定数が食い違えば vitest が落ちる | Rust 側から定数を生成する（build の工程を足す）。Native のみで拒否する（Main の二重防御が無くなる） | 不要 | 該当なし | 不要（同期の純関数） | 記録済み（実装前）。T1 で実装：拒否のエラーは `Nir1LocalAuditReservedError`（`AI_AUDIT_RESERVED_NAMESPACE: events[i].<field>`。anyhow から downcast できる）。N-API は変更せず、実 Native の `ai-audit.test.mjs` で拒否と無書込みを確認した。TS の空白の判定は U+0085 を含めて Rust の `trim` に近づけるが、JS の `\s` には Rust の White_Space に無い U+FEFF などもあり、TS は Rust より広く拒否してよい（over-rejection。db の判定が最終で、DB に届く値は派生 ID と完全一致しない限り namespace に衝突しないので安全側）。小文字化は ASCII だけ。正規化は正規表現の置換をやめ、先頭と末尾から 1 回ずつ走査する線形の trim と、接頭辞の長さ（22 文字）までの prefix だけの小文字化にした（途中に長い空白列を持つ入力で O(n^2) になり Main の IPC 検証を止める経路を防ぐ。ID の長さ上限は別の契約変更なので足さない。"x"+空白20万個+"x" の回帰試験を足した）。drift 試験は `electron/shared/nir1LocalAuditNamespace.test.ts`（`pnpm test:electron` の対象） |
