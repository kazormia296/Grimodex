# LP-D 診断 run の結果（dev 専用。CP-4 の結果ではない。2026-11-02）

integrator だけが見る診断。**正式の測定に数えず、集計・閾値の選択に使わない**（DR-CP4-LPD-1 (4)）。計装は dev 専用の merge しない枝 `claude/cp4-lp-diag`（`cfc40d97`＝master `8dd7a9c0`〔LP-A1 を含む〕＋計装の 3 commit。push していない）で、`native-architecture.mjs` は落ちる（DR-CP4-LPD-1 (1)）。ユーザーの確認：`user-confirmation-2026-11-02-lapse-diag-first.md`（`681e1cac`）。

## 実行

- 2026-11-02（JST）11:04〜11:24。eval build（`.node` sha256 `6b28b95f…`、worker sha256 `cccb5977…`。worker は feature つきで作り直し、Main の path と eval-build の側が bytes 一致）→ dev setup（`dev-lantern.v1.json`、`setup-complete`、エラー 0）→ 静けさの確認（load 1.63）→ 編集 trace（dev preview、200 cycle、Q=201、約 10 分、run `lpd-diag-1`）。
- 記録（大きいので contracts に入れない）：`observation.json` sha256 `6b4aa686…a82fda9e`（43.8 MB）、`receipt.json` sha256 `2dcf57f8…8153c`。置き場所は diag worktree の `.artifacts/cp4/lpd-diag-1/`。
- 限界：dev fixture は S4b''' の凍結 trace（G-02）と同じではない。計装の入った build で、正式の候補と bytes が違う。受領書の status は `invalid`（dev preview の F6 が Scene 単位のため。診断に無関係）。結果は『この build で何が起きたか』であり、正式の候補で同じ割合になるとは限らない。

## 結果（Q=201）

| 区分 | 件数 | 内容 |
|---|---|---|
| 完全に使えた | 190 | 親の ticket が available、child が `graph-ready`（requalification passed） |
| 親の ticket が失敗 | 3 | 登録の拒否 1（`registration-unavailable`）、stale 2 |
| child の合流の無効化 | 8 | すべて `assemble-unavailable`／`dropped: path-not-current` |
| begin の前の取消し（cancelledBeforeBegin） | **0** | 前回の正式の run は 8。`index-ready` 起因の再 query も 0（`requeries.index-ready`＝0）＝LP-A1 の想定どおり |
| 開始時の B の封印 | current 201 | dirty 0 |

表示されなかった合計は 11/201（5.5%）。

## 分岐の判定

### 登録の拒否 1 件（seq 68）
`registration.branch = postflight-identity-drift`、`inner = null`、`seal = null`、`identityDiff`：`connectionEpoch false`、`totalChangesDelta 0`、**`dataVersionDelta 1`**、schema／user_version 変化なし。登録の窓は約 12.7 ms。→ **登録の snapshot の中の検証（B の完全性・seal）は通っていて、別の接続の commit が 1 回入っただけで拒否された**。drift の仮説は、この 1 件で確認された。どの commit かは特定できない（計装の範囲外）。

### stale 2 件（seq 53、323）
`query.result = worker-registration-drift`、**`stampDiff = null`**（`serve_query` の stamp0≠stamp1 の比較は走っていない）。prepare の ready から query の開始まで 0.06 ms、query は約 5.1〜5.6 ms。→ query の時点の identity／seal の drift（worker の判定）。登録の拒否と同じ系統（窓の中に別の接続の commit）。

### child の合流の無効化 8 件
8 件すべて `site = assemble-unavailable`、`claim = cached`、**`dropped = path-not-current`**。合流の所要は 4.4〜8.7 ms で、成功した 190 件（p50 10.4 ms、max 16.5 ms）より短い（assemble が途中で落ちる形）。`current = chronicle-bound-batch`、`chronicle = binding-or-epoch-check` は**成功した 190 件にも同じ値が付く**ので、判別に使えない（同じ operation の stage の残り。runbook の開示のとおり）。
- `related_scenes_requalification.rs` の `attach_paths`（:1010 以降）が `PathNotCurrent` を返す分岐は複数ある：(a) `path_edges` が None（:1035）、(b) path が名指す Revision の live の評価（`evaluate_nir1_entity_relation_disclosure_for_graph`）が Unavailable／`derive` が None（:1061-1066、:1077-1080）、(c) `edge_holds` が false（:1086）、(d) relation の text が無い（:1092）、(e) 表示する Scene の pin の再検証が失敗／None（:1100-1113）、(f) `EdgeText::Inconsistent`（:737）。**この計装は、どの分岐かを区別していない**。
- `ReadIdentity` は `related_scenes/` に出てこない（survey S6）。**案 1（登録の identity を B の入力に絞る）では減らない**。

## 結論（診断の範囲で）

1. 親の ticket の失敗 3 件（登録の拒否 1、stale 2）は、**B の入力に関係しない別の接続の commit による identity の drift**（登録の検証自体は通っていた）。案 1 のような絞り込みか、drift のときの再検証が効く種類。
2. **child の無効化 8 件が最大の群（4.0%）で、案 1 では減らない**。親の 3 件を全部直しても 8/201 が残り、物差し 1% を超える。HOLD を解くには、`path-not-current` の分岐の特定が先。
3. LP-A1 の効果は dev で確認された（cancelledBeforeBegin 0、index-ready 起因の再 query 0）。ただし dev fixture での 201 件の 1 回で、正式の候補での効果は再測定まで不明。
4. 次の診断（案）：`attach_paths` の `PathNotCurrent` の分岐（a)〜(f)）と、(b) の Unavailable の理由を ticket／join の note に足して、もう一度走らせる（build と trace で約 30〜40 分）。

---

# 第 2 回（run `lpd-diag-2`）：child の無効化 8 件の分岐が確定した

2026-11-02（JST）11:43〜11:59。`path-not-current` の分岐を区別する追加の計装（診断の枝 `claude/cp4-lp-diag` の `df32c29d`、`761bdd61`。HEAD `761bdd61`）で、同じ手順（eval build → feature つき worker → 静けさの確認 → 編集 trace 200 cycle、Q=201、setup は `lpd-diag-setup` を再利用）。記録：`observation.json` sha256 `94930724…386f0`、`receipt.json` sha256 `fc7d93de…bd1e1`、`.node` sha256 `bd21d77e…20101`、worker sha256 `4e93b66f…f928c`（Main の path と eval-build が bytes 一致）。置き場所は diag worktree の `.artifacts/cp4/lpd-diag-2/`。dev 専用・CP-4 の結果ではない点は第 1 回と同じ。

## 結果（Q=201）

| 区分 | 件数 |
|---|---|
| 完全に使えた | 190 |
| 親の ticket の失敗 | 3（すべて登録の拒否。stale 0） |
| child の合流の無効化 | 8 |
| cancelledBeforeBegin／index-ready 起因の再 query | 0／0 |

表示されなかった合計は 11/201（5.5%）で、第 1 回（11）と同じ。

## 分岐

- **child の 8 件：全件 `stage = edge-holds-false`、`tokenMismatch = ["freshness-token"]` のみ**。query Scene の source token、decision token、scope authority など、ほかの token は一致していた。`path` の序数は全件 `targetOrdinal 0`／`edgeOrdinal 0`。合流の所要は 4.5〜9.2 ms（成功は p50 10.4 ms）。評価の時点の feed の位置は 8 件とも `feedHeadSequence == feedAcknowledgedThroughSequence`（29、64、95、122、152、160、175、199。cycle に概ね比例して進む＝**約 1 cycle に 1 transaction**）。
- `freshness_token` は `Nir1EntityRelationFreshness`（`semantic_epoch_id`、`dependency_set_digest`、`declaration_set_id`、`declaration_set_digest`、`last_evaluated_run_id`、`edge_count`、**`feed_acknowledged_through_sequence`**、**`feed_head_sequence`**）の digest（`nir1_entity_relation.rs:170-180`、`:2830`）。worker の答えを作った時点の token と、合流の時点の live の token の間で、**feed の位置、または `last_evaluated_run_id`（incremental Freshness の cycle ごとに変わる値）が動いた**ことで不一致になったと読める【推測。token の成分の差分は worker の frame に無く、記録していない】。
- **親の 3 件：全件 `postflight-identity-drift`**、`inner = null`、`dataVersionDelta 1`、`totalChangesDelta 0`、登録の窓は 12.3〜13.6 ms。第 1 回と同じ型（登録の検証は通っていて、別の接続の commit が 1 回入っただけで拒否）。

## 含意（診断の範囲で）

1. **child の 8 件は identity（`ReadIdentity`）ではなく、A3 の `freshness_token` が feed の位置と Run の id を束縛していることが原因**。X1-5 が「本文だけの保存で B を dirty にしない」とした後も、本文の保存は feed を 1 transaction 進め、incremental Freshness が Run を進めるので、**Graph の答えを作ってから合流までの間にその cycle が入ると token が合わなくなる**。
2. **親の drift と child の token の不一致は、同じ上流（別の接続の commit＝本文の保存に続く incremental Freshness の cycle など）から来ている可能性がある**【推測。未確認】。確かめるには、incremental Freshness の cycle の commit の窓を記録して、失敗した 11 件の窓（登録・query・合流）と突き合わせる。
3. 案 1（登録の identity の絞り込み）は child の 8 件に効かない。効きうる直し方は 2 種類：(i) `freshness_token` から B と無関係な動く成分（feed の位置、Run の id）を外す（契約・要件の改訂。X1-5 と同じ型）、(ii) Graph の query の窓の間は、incremental Freshness など background の commit を出さない（lifecycle／scheduling。契約を変えない見込み）。(ii) が通れば 3 群（登録の拒否、stale、child の無効化）をまとめて直せる可能性がある。

---

# 背景の commit の調査（read-only。診断 2 回の DB と記録の突き合わせ。2026-11-02）

調査の本文は scratchpad の `lapse-lane/survey/s7-background-commits.md`（付録に 22 件の個別表）。時刻の写像（DB の ms の timestamp → native の時計）の誤差は ±5 ms で、**直接の計装ではなく状況証拠**。

## 要点

1. **欠落 22/22 件（2 回の run の 11＋11）で、Graph の窓に incremental Freshness の cycle の commit が重なっていた。**
   - child の合流の無効化：16/16 で、publish（cursor の ack）の commit が token の窓〔worker の query の開始→合流の終わり〕の中。成功した 378 件では 0 件。
   - 親の登録の拒否：4/4 で、予約か publish の commit が登録の窓の中。ただし窓に commit が入っても通った件が 7 件あり、必要条件にとどまる。
   - stale：2/2 で、予約の commit が query の窓（約 5 ms）の中。
2. **期待値が実測と合う。** Freshness の scheduler は 1 s の idle poll（`electron/main/narrativeFreshness.ts:14-17`）で、保存との位相は 0〜1000 ms にほぼ一様。幅 W ms の窓に当たる確率は約 W/1000。token の窓（約 40 ms）→ 4.0%＝8.0/201（実測 8、8）。登録＋query の窓 → 約 1.4〜2.2%（実測 3、3）。
3. **`freshness_token` で動いた成分は `feed_acknowledged_through_sequence` だけ**（`last_evaluated_run_id` は NULL のまま。203 本の Run はどれも `affectedEdgeCount=0`）。head は保存（query の約 590 ms 前）で既に動いている。→ worker の snapshot（ack＝N−1、head＝N。pending の 1 件は本文だけで無関係なので Eligible）と、合流の live の読み（ack＝N）の違いは ack だけ。
4. **Graph の query の窓の間、背景の Freshness の commit を止める仕組みは無い**（前景の preempt は maintenance の接続が Main の mutex を譲るだけ。D′ は begin 自身の audit の commit の後まで待つだけ。Freshness の quiesce は workspace の切替専用）。
5. 保存 1 回あたりの背景の commit：保存 1、Chronicle の build 1（保存＋約 180 ms。query の前に終わる＝LP-A1 の効果と合う）、Freshness の予約 1＋publish 1、audit は begin ごと（D′ が prepare より前に終わらせる）。idle の poll は書き込まない【推論】。
6. **先行の予告**：X1 /3 の F10 と「X1 が直さない問題」（`nir1-scene-scope-projection-proposal-3-draft.md` :57）、D2b の XF-9 が、『返却時の再検証が canonical Freshness の feed の位置を比べること』と『commit のたびに READY の worker が古くなること』を、X1 の外に残る問題として書いていた。

## 直し方の候補（調査の整理。integrator の評価は別に）

- **(iii-d) 保存の直後に Freshness を起こす**（Main の scheduler の wake。保存の feed append の後に 10 ms 程度で cycle を回す）：最小の変更。Freshness の cycle が query（保存の約 430〜850 ms 後）より十分前に終わり、窓に入らない。この trace の 3 群すべてに効く見込み。lifecycle／scheduling の判断で、契約を変えない見込み。
- (i) Graph の窓の lease で Freshness の予約の前に gate する：一般解。timeout と延期の上限が要る。
- (ii) `freshness_token` から feed の位置を外す：child の群にしか効かず、A3 の identity、D-final の ref、`edge_holds` の契約を変える（契約の改訂。委任の外）。
- (iii-a) drift の後に 1 回だけ再試行する：requery の測定上の読みが未確認。
- 閾値・Gold・失効の読みの緩和は推奨しない。
