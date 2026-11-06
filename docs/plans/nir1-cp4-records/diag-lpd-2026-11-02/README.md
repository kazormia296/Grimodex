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

---

# 第 3 回（run `lpd-diag-3`）：gate を取り込んだ build で、表示の欠落が 11 → 0 件になった（dev 専用。CP-4 の結果ではない）

2026-11-03（JST）00:02〜00:12。診断の枝 `claude/cp4-lp-diag` の HEAD `2e1c8815`（master `8dd7a9c0`＋診断の計装＋gate `59c5415e` の merge＋gate の counter の出力）。同じ手順（eval build → feature つき worker → 静けさの確認〔load 0.53〕→ 編集 trace 200 cycle、Q=201、setup は `lpd-diag-setup` を再利用）。`.node` sha256 `52142ddf…2a90b`、worker sha256 `d0deb469…6647`（Main の path と eval-build が bytes 一致）。記録：`observation.json` sha256 `a02c25ed…ec46f3`（49.3 MB）、`receipt.json` sha256 `c4359432…a0520`。置き場所は diag worktree の `.artifacts/cp4/lpd-diag-3/`。第 1・2 回と同じく dev fixture（S4b''' の凍結 trace と同じではない）、受領書の `k64` が `invalid` なのも同じ理由（dev preview の F6）。**正式の測定に数えず、集計・閾値の選択に使わない**（DR-CP4-LPD-1 (4)）。

gate の branch は、この run の後に試験の直しの 2 commit（`f0519ace`、`e7d6fe4a`。`nir1_graph_gate_tests.rs` と DR だけ）が入った。製品コードは `59c5415e` と同じなので、この run の build は PR #777 の head の製品コードと同じ。

## 結果（Q=201）

| 区分 | 第 1 回 | 第 2 回 | **第 3 回（gate）** |
|---|---|---|---|
| 親の ticket が available | 198 | 198 | **201** |
| 親の ticket の失敗（登録の拒否、stale） | 3 | 3 | **0** |
| child の合流が available | 190 | 190 | **201** |
| child の合流の無効化（`assemble-unavailable`） | 8 | 8 | **0** |
| `graph-ready` の通知 | 198 | 198 | **201** |
| prepare の失敗 | 1 | 3 | **0** |
| 表示されなかった合計 | 11（5.5%） | 11（5.5%） | **0（0%）** |

- 前の 2 回と同じ割合（約 5.5%）が続くと仮定したとき、201 件で 0 件になる確率は約 0.945^201 ≈ 1e-5 で、偶然とは読みにくい。ただし **dev の 1 回（N=1）**で、正式の候補での割合は再測定まで不明。
- 仮説（欠落 11 → 0〜2 件／run）の範囲に入った。仮説は外れなかった。

## gate の counter（run 全体の累計。`nativeReads[201].lpd.gate`）

| counter | 値 | 読み |
|---|---|---|
| `windowsOpened` | 201 | 全 query で Graph の窓（lease）を開いた |
| `graphWaited` | 8 | Graph が in-flight の Freshness の区間を待った回（うち `gate-opened-after-wait` 8 件） |
| `graphWaitExpired` | 0 | Graph の待ちが 100 ms を超えて窓なしで進んだ回は無い |
| `waitedAdmit` | 13 | Freshness の cycle が窓の終了を待ってから入った回 |
| `deferred` | 0 | Freshness が 250 ms の待ちを超えて延期された回は無い |
| `overridden` | 0 | 累計 1 s の天井で lease を無視した回は無い |
| `stopped`／`leaseExpired` | 0／0 | lifecycle の停止・lease の期限切れは無い |

窓の outcome（`records[].ticket.lpd.window.outcome`）：`gate-opened` 193、`gate-opened-after-wait` 8。

## 副作用の確認（T_late への影響）

ticket の発行から settle までの所要（ms）：

| | p50 | p90 | p99 | max | 150 ms 超の件数 |
|---|---|---|---|---|---|
| 第 1 回 | 33.2 | 42.4 | 294.4 | 315.1 | 7 |
| 第 2 回 | 33.3 | 37.1 | 287.1 | 322.5 | 6 |
| 第 3 回 | 33.5 | 37.7 | 322.1 | 414.6 | 4 |

- 中央値と p90 は変わらない。150 ms 超の遅れ（ticket の発行から prepare の開始まで約 140〜390 ms）は**第 1・2 回にもあった**（7 件、6 件）。gate が作った遅れではない。第 3 回の 4 件（seq 235、299、349、399）は、すべて `gate-opened-after-wait` で、max が第 2 回より約 90 ms 長い（322.5 → 414.6）。**訂正（2026-11-03、独立レビューの指摘を生データで確認）**：当初ここに『Graph の待ち（上限 100 ms）が足された分と読める』と書いたが、4 件の Graph の窓の開きの待ち（`open_window` の呼出し 1 回の時間）は 8.2／8.6／47.0／48.0 ms で、遅れの大半は **ticket の発行から窓の開きまでの 255〜347 ms**（gate より前の段）にある。after-wait と遅い群が重なる理由は未調査。
- 遅れの原因は未調査。第 2 回の stale／unavailable 2 件（seq 81、195）もこの遅い群に入っていた。**『prepare の開始までの約 250〜350 ms』は、Freshness の cycle が長く続いたあとに Graph の読みが始まる群の可能性がある**【推測。未確認】。確かめるなら、遅い群の Freshness の cycle の長さを記録する。
- Graph の窓の開きの待ち（`open_window` の呼出し 1 回の時間）：p50 0.0 ms、p99 9.9 ms、max 48.0 ms。**訂正（2026-11-03）**：当初『窓の長さ（lease を持っていた時間）』と書いたが誤り。`WindowNote`（`lpd.rs`）は `open_window` 1 回の始めと終わりで、lease の保持時間ではない。lease は child の合流まで続く（settle から合流の開始まで最大 836 ms、第 4 回 seq 27）。
- `deferred` が 0 なので、Freshness が TS の再 poll で 1 s 遅れた回は無い。

## 限界（この run が確かめていないこと）

- dev fixture・1 回・200 cycle。run ごとの揺れは未測定（もう 1〜2 回回せば揺れの幅が見える）。
- 残る隙間は未検証：(i) 窓を開く時に区間が in-flight で 100 ms を超える場合（`graphWaitExpired`＝0 なので起きなかった）、(ii) child の合流が 500 ms を超える場合（`leaseExpired`＝0）、(iii) 保存・audit・D-final など Freshness 以外の commit。
- 正式の再測定（新しい候補。S4 の扱いは未確認）はしていない。Gold、N2／N4（blocked）、K6/4 の検出力の記録は動かしていない。

---

# 第 4・5 回（run `lpd-diag-4`、`lpd-diag-5`）：同じ build でもう 2 回。603 件で欠落 1 件（dev 専用。CP-4 の結果ではない）

2026-11-03（JST）01:13 と 01:23 の開始（UTC 16:13:47 と 16:23:57）。第 3 回と同じ build（診断の枝 HEAD `2e1c8815`、`.node`・worker は第 3 回と同じ bytes）、同じ手順（静けさの確認 → 編集 trace 200 cycle、Q=201、setup は再利用）。ユーザーの確認：`user-confirmation-2026-11-03-lapse-next-steps.md`（`02a8555a`）。記録：第 4 回 `observation.json` sha256 `b96b135b…8a973b38`（49.3 MB）、`receipt.json` `a3c89e73…f5784ccb`。第 5 回 `observation.json` `0b137d9d…b0b2bc21`（49.3 MB）、`receipt.json` `7d04d7e8…39e9548d`。置き場所は diag worktree の `.artifacts/cp4/lpd-diag-4/`、`lpd-diag-5/`。受領書の status は第 3 回と同じ `invalid`（dev preview の F6）。**正式の測定に数えず、集計・閾値の選択に使わない**（DR-CP4-LPD-1 (4)）。

## 結果（Q=201。第 3 回と並べる）

| 区分 | 第 3 回 | 第 4 回 | 第 5 回 | gate の 3 回 | （参考）gate なしの第 1・2 回 |
|---|---|---|---|---|---|
| 親の ticket が available | 201 | 201 | 201 | 603 | 396／402 |
| 親の ticket の失敗 | 0 | 0 | 0 | 0 | 6 |
| child の合流が available | 201 | 200 | 201 | 602 | 380／402 |
| child の合流の無効化 | 0 | **1** | 0 | **1** | 16 |
| `graph-ready` の通知 | 201 | 201 | 201 | 603 | 396 |
| prepare の失敗 | 0 | 0 | 0 | 0 | 4 |
| 表示されなかった合計 | 0 | **1** | 0 | **1／603（0.17%）** | 22／402（5.47%） |

- 3 回の合計 1/603 から言える本当の割合の 95% 上限は、片側で約 0.8%、両側で約 0.9%（Clopper–Pearson の計算。おおよその見積もり）。物差し 1% は下回るが、余裕は小さい（0 件だったときの見込み約 0.5% よりも広い）。正式の物差しは 1 run（201 件）で 2 件以下なので、上限の割合とは別物：点推定 0.17% なら 1 run で 3 件以上になる確率は約 0.5%、95% 上限の 0.78% なら約 21%（ポアソン近似）。**dev の 3 回で、正式の候補の割合ではない。**
- 第 4 回の 1 件は、gate の**設計に書いた『残る隙間』の 1 番**が実際に起きたもの（下）。

## 第 4 回の欠落 1 件（ticket seq 385）

- 親の ticket は available。Graph の待ちが上限 100 ms で尽きた（window の開始から終了まで 100.07 ms、outcome `gate-wait-expired`。`graphWaitExpired` 1）→ **窓（lease）なしで進んだ**（`cachedBegins` の `window: false`）。ticket の発行から settle まで 227.2 ms（窓の開始まで 108 ms、待ち 100 ms、prepare の開始から settle まで約 19 ms）。
- child の合流（seq 386）は `assemble-unavailable`、`dropped = path-not-current`、`path.stage = edge-holds-false`、**`tokenMismatch = ["freshness-token"]` だけ**、`feedHeadSequence == feedAcknowledgedThroughSequence = 212`。第 2 回の child の 8 件と同じ形（Freshness の commit が worker の答えと合流の間に入った）。
- 読み：窓を開く時点で Freshness の区間が in-flight で、その残りが 100 ms を超えた。T_late（確認済み 100 ms）を守るために Graph の待ちを 100 ms に切っている設計（gate の DR §9.1、GATE-2）の**予定された代償**。Freshness の cycle が 100 ms を超えて続く回が実在することを示す【推論】。

## gate の counter（run 全体の累計）

| counter | 第 3 回 | 第 4 回 | 第 5 回 |
|---|---|---|---|
| `windowsOpened` | 201 | 200 | 201 |
| `graphWaited` | 8 | 5 | 2 |
| `graphWaitExpired` | 0 | **1** | 0 |
| `waitedAdmit` | 13 | 10 | 7 |
| `leaseExpired` | 0 | **2** | 0 |
| `deferred`／`overridden`／`stopped` | 0／0／0 | 0／0／0 | 0／0／0 |

- 窓の outcome：第 4 回 `gate-opened` 195、`gate-opened-after-wait` 5、`gate-wait-expired` 1。第 5 回 `gate-opened` 199、`gate-opened-after-wait` 2。
- **`leaseExpired` 2（第 4 回、seq 27 と 93）**：child の合流の開始が settle の約 836 ms と約 749 ms 後で、lease の期限 500 ms を超えた（gate の『残る隙間』の 2 番）。**2 件とも合流は成功した**（その間に Freshness の token の変動が無かった）。第 5 回の合流の開始の遅れは最大 278 ms。
- Freshness 側：`deferred` 0、`overridden` 0 が 3 回とも続いた（Freshness が 250 ms の待ちを超えて延期された回、天井 1 s で lease を無視した回は無い）。

## 副作用（T_late への影響）

| | p50 | p90 | p99 | max | 150 ms 超の件数 |
|---|---|---|---|---|---|
| 第 3 回 | 33.5 | 37.7 | 322.1 | 414.6 | 4（すべて after-wait） |
| 第 4 回 | 33.1 | 36.9 | 311.3 | 341.4 | 6（after-wait 5、wait-expired 1） |
| 第 5 回 | 33.4 | 39.5 | 240.3 | 278.6 | 4（**すべて `gate-opened`＝gate の待ちが関与しない**） |

- 中央値は 3 回とも 33 ms 台で、第 1・2 回（33.2、33.3）と変わらない。
- 第 5 回の 150 ms 超の 4 件は gate の待ちを伴わない。**遅い群（ticket の発行から prepare の開始まで約 140〜390 ms）は gate の待ちだけでは説明できない**。第 4 回は遅い 6 件がすべて gate の待ちに当たったが（待ちは 5 件が 6.5〜8.4 ms、`gate-wait-expired` の 1 件が 100.1 ms。遅れの大半は窓の開きの前の 108〜318 ms）、第 5 回はそうでない。原因は未調査のまま。

## 限界

- dev fixture・計装の入った build・3 回（603 件）。run ごとの揺れは小さく見える（0／1／0）が、正式の候補では未確認。
- 残る隙間は 1 番が 1 回、2 番が 2 回見えた。3 番（Freshness 以外の commit）と 4 番（天井）は、この 3 回の範囲では欠落を作らなかった。
- 正式の再測定（新しい候補。S4 の扱い）、Gold、N2／N4（blocked）、K6/4 の検出力の記録は動かしていない。

## 追記（2026-11-07）：隙間 3 の診断（LP-D 4。DR-CP4-LAPSE-2）

dev 専用の枝 `claude/cp4-lp-diag`（`8cf81725` の計装、`e1b4ab65` の記録。merge しない・push しない）で、書き手ごとの commit の区間を記録して編集 trace を 3 回（lpd-diag-6-1〜3、各 200 cycles）走らせた。結果は integrator だけが見るもので、CP-4 の判定・集計・閾値の選択には使わない（DR-CP4-LPD-1 の規則 (4)）。詳細は同 dir の `gap3-commit-instrumentation-2026-11-07.md`（計装）と `gap3-diag-results-2026-11-07.md`（結果）。

- drift の起きる区間と gate の lease の間に入った commit は、3 run・603 窓でどの書き手も 0 件（95％ 上限は約 0.5％）。gate の待ちの期限切れも 0。
- ただしこの 0 は trace の拍子による。書き込みが一様に来るなら lease の間に約 4 件／run 入る見込みで、AI の書込み・MCP・maintenance の頻度は示していない（この trace では maintenance・D-final・migration・trusted SQL は動いていない）。上限を言うには §9.6 (2) の注入の表が要る。
- 隙間 3 とは別に、表示の欠落が 2 種類見えた：(a) run 3 で Chronicle の publish が親の begin の 45〜135 ms 後に来た親が 4／201、(b) `graph-late` が 2／603（begin 自身の audit の区間が最長 294 ms。以前の「遅い群」17 件中 16 件がこれに一致）。
- run 1・2 の exit 1 は集計段の precheck（N-7）：harness の D は 10.84 ms のままで、製品の窓は #802 で 40 ms。run 自体の失敗ではない。run 3 の exit 0 は begin 206 回に対して native の記録が 202 件で行が作られなかったためで、きれいな run の意味ではない。3 run とも native の記録は完全。
