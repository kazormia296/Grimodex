# 保守の cutover 前停止（再発見の枯渇）の判断記録

対象は、新しい workspace で project を作った直後から Scene の追加と Chronicle 抽出（書き込み）が続くと、
保守の流れ（Backfill → Verify → Rebuild → C2-ZC cutover）が cutover まで進まず、自力で再開しない不具合。
cutover の marker（`schema_data_migrations` の `narrative-c2-canonical-freshness-v1`）が付かないので、
NIR-1 の chronicle index の build が `is_generic_freshness_canonical=false` で `CanonicalAuthorityUnavailable` になり、
関連場面の IR が使えないまま残る。調査は 2026-11-04。委任の根拠は AGENTS.md の「NIR-1 の残レーン」の
worker／owner／終了処理／lifecycle の技術判断の事前委任（U3）。

## DR-MPS-1 原因：再発見の上限が黙って尽き、枯渇した chain は Freshness の再点火も受け付けない

読んだ経路（すべて `electron/main/`）:

- `narrativeMaintenanceTriggers.ts` の `requestRediscovery` は、再発見が `NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS`（3）に
  達すると警告も出さずに return する。保守 cycle が受理されるたびに `narrativeMaintenanceBootstrap.ts` の `onCycleAccepted` がこれを呼ぶ。
- 上限が戻るのは、planner が空を返したときか、返した work の fingerprint が変わったときだけ。
- 書き込みが続くと Verify の証跡は graph state digest の不一致（`NEX_VERIFY_GRAPH_STATE_CHANGED`）で毎回失効し、
  planner は同じ `DesiredWork{Verify, dependency-verify:<epoch>}` を返し続ける。fingerprint が変わらないので、
  最初の発見 1 回＋再発見 3 回の計 4 回で chain が黙って終わる。
- 終わった時点で `lastWakeReason="before-cutover"` が残る（空の discovery のときだけ null に戻る）。
- Freshness は idle poll（1 秒）ごとに cutover を試み、未準備なら `cutoverNotReady` を返す。これは `index.ts` の
  `requestBeforeCutoverPreparation` に届くが、`beforeCutoverChainActive()`（`lastWakeReason==="before-cutover"` だけで true）で捨てられる。
  この「active なら捨てる」は、poll が 1 秒ごとに Verify を回す暴走を防ぐための設計で、既存の試験が意図して固定している。
- 結果、書き込みが止まっても再起動できる経路が workspace の open／epoch-rotated の event しか無く、保守が再開しない。

再現: `electron/main/narrativeMaintenanceTriggers.stall.test.ts`（修正前は「書き込みが止まったあとに再開する」が
`expected 4 to be greater than 4` で落ちる）。DB の写し（失敗 run は Verify が約 330 ms 間隔で 5 回 completed になって止まる、
成功 run は rebuild が走って marker が約 3.5 秒で付く）とも整合する。生きたプロセスの `lastWakeReason` の値は観測しておらず推測。

## DR-MPS-2 修正：枯渇を記録し、backoff 付きで Freshness 由来の再点火だけを許す

変更は `narrativeMaintenanceTriggers.ts` の coordinator だけ。Rust・IPC の契約・閾値は変えない。

- 枯渇の記録: `requestRediscovery` が上限で打ち切るとき、その chain を「枯渇」として記録する
  （時刻、連続回数 k、そのときの fingerprint）。warn を 1 回出す（今は無音）。
- 再点火: `requestBeforeCutoverPreparation`（Freshness の NOT_READY 由来）は、次の 4 条件がすべて成り立つ場合に限り、
  新しい before-cutover chain を始める。(1) 枯渇している、(2) 生きた仕事が無い（timer なし、discovery in-flight なし、
  pendingEvent なし、pendingRetry なし）、(3) cooldown が経過している、(4) higher-value wake（restore／epoch）が active でない。
  cooldown は `min(5 s × 2^(k-1), 60 s)`（k は連続の枯渇回数。1 回目 5 s、2 回目 10 s、…、上限 60 s）。
- 再点火した chain の再発見は、従来どおり最大 3 回。`onCycleAccepted` 由来の `requestRediscovery` の上限は変えない。
- 再点火の枝は fingerprint を保持し、attempts だけを 0 に戻す。k は増やす（戻さない）。
- 停止条件（k と枯渇の記録を戻す）: planner が空を返したとき、または枯渇時と異なる fingerprint の work を受けたとき
  （phase が進んだ）、新しい authority の chain（workspace-opened／restore／epoch／outbox／recovery）が始まったとき。
  cutover が済めば Freshness が NOT_READY を返さなくなり、再点火は起きない。
- cooldown 内の NOT_READY は何も変えない（mutation revision も進めない）。quiescence writer から見た意味は今と同じ。
- 定数の根拠: 再点火 1 回は Verify を最大 4 回走らせる（読み取り中心。前景の書き込みには譲る
  〔`NEX_MAINTENANCE_CONNECTION_PREEMPTED`〕が、譲るたびに cycle が 1 つ無駄になる）。書き込みが止まらない間の頻度を、
  10 分で再点火 15 回未満（discover 60 回以下）に抑える値として基数 5 s・上限 60 s を選んだ。上限を 60 s より長くすると、
  書き込みが止まってから cutover までの待ちが最悪で 60 s を超える。

## DR-MPS-3 信頼境界と lifecycle の matrix

- 新しい送信先・保存範囲・契約・authority は無い。coordinator が持つメモリ上の数値 3 個（時刻、k、fingerprint）を足すだけ。
- 再点火の入口は `requestBeforeCutoverPreparation` で、呼び出し元は `electron/main/index.ts` の Freshness の
  `onCutoverNotReady` だけ（`git grep` で確認）。他の入口（open、epoch、restore）の優先関係は変えない。
- dispose 後は `disposed` で全入口が止まる。chain の世代（`chainGeneration`）が進めば古い timer／discovery は従来どおり捨てられる。

| 状態 | Freshness の NOT_READY | 修正前 | 修正後 |
|---|---|---|---|
| chain が動いている（timer／in-flight／pending） | 来る | 捨てる | 捨てる（変更なし） |
| 発見は済み、受理待ち（attempts < 3、枯渇なし） | 来る | 捨てる | 捨てる（変更なし） |
| 枯渇、cooldown 内 | 来る | 捨てる | 捨てる（mutation も進めない） |
| 枯渇、cooldown 経過 | 来る | 捨てる（永久） | 新しい chain を 1 本始める（k を増やす） |
| restore／epoch の wake が active | 来る | 捨てる | 捨てる（変更なし） |
| cutover 済み | 来ない | － | － |

## DR-MPS-4 代替案

- 案 B（書き込みが静まるまで再発見を数えない）: Freshness の書き込み中の信号を coordinator に新設する。配線が広がり、
  信号が欠けたときの安全側が曖昧で、試験も重い。案 A で足りるので採らない。
- 上限（3）の引き上げ、または無制限化: 書き込みが続く間の Verify の暴走を許す。閾値の緩和でもあるので採らない。
- 枯渇しても cooldown なしで毎 poll に再点火: 1 秒ごとの Verify になる。採らない。

## DR-MPS-5 begin が理由を捨てる件（契約が要るので入れない）

`related_scenes/begin.rs` は `NirIndexUnavailableReason` を一律 `"index-unavailable"` にする。理由を載せるには
`RelatedScenesUnavailableReason`（`electron/shared/relatedScenesSearchWire.ts` の閉じた union）の拡張か field の追加が要り、
main の検証と renderer が共有する型付き IPC の payload を変えるので、新しい契約になる。この lane の委任の外なので入れない。
契約を変えずに main の log へ出す手は、理由が Native から main へ渡らないため Rust 側の変更が要る。今回は含めず、別の小変更として残す。
