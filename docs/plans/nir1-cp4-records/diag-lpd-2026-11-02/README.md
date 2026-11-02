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
