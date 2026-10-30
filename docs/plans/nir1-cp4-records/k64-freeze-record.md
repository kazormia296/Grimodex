# K6/4（graph-eval-procedure）の事前登録の凍結の記録

K6/2 の「事前登録の凍結」の 1 と 7(a) に従う、integrator の作業記録。K6/4 の「この file」はこの draft の bytes（K6/4 の引き継ぐもの 3、変える点 14）。

## 凍結の記録（1）

| 項目 | 値 |
|---|---|
| ref | `refs/heads/claude/nir1-contracts`（merge しない branch。K1 の draft と同じ） |
| 凍結の commit | `5dea38af158283c2a925d68ef0d8b0771c0ea209` |
| file | `docs/plans/nir1-final-request-eval-proposal-4-draft.md`（draftRef `nir1-final-request-eval-proposal/4`、contractId `graph-eval-procedure`） |
| file の SHA-256（`git show 5dea38af…:<file>` の出力） | `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`（2026-10-26 00:41 JST にユーザーが確認した値と一致） |
| push 直後の `git ls-remote origin refs/heads/claude/nir1-contracts` | `5dea38af158283c2a925d68ef0d8b0771c0ea209	refs/heads/claude/nir1-contracts` |
| (i) push の時刻（integrator の自己申告） | 2026-10-27T18:11:20+09:00（2026-10-27T09:11:20+00:00） |
| (ii) remote 側の記録の時刻 | 下の (β)、(α) |
| 凍結の前の commit | `21ed9a9c0096df757c10f334ed97e0fd480f3df4`（①＝R5 の照合の記録。同日 09:11:00Z に push）。その前は `14141248`（Session B3 の提示版） |

### (ii) remote 側の時刻

- (β) repository activity（`gh api "repos/kazormia296/Grimodex/activity?ref=refs/heads/claude/nir1-contracts&activity_type=push"`）。`after` が凍結の commit のもの：
  `after=5dea38af158283c2a925d68ef0d8b0771c0ea209 before=21ed9a9c0096df757c10f334ed97e0fd480f3df4 timestamp=2026-10-27T09:11:20Z activity_type=push ref=refs/heads/claude/nir1-contracts`。取得は push の約 1 分後。
  参考：①の記録の commit は `after=21ed9a9c… timestamp=2026-10-27T09:11:00Z`。
- (α) PushEvent（`gh api repos/kazormia296/Grimodex/events` のうち `type=PushEvent`、`payload.head` が凍結の commit のもの）：push の直後の 1 回目の取得では現れなかった。GitHub の文書は遅れが 30 秒から 6 時間ありうるとするので、「なし」とは書かない。取り直した時刻と結果は、この file の下の「(α) の取り直し」に追記する。
- 照合 3 の (c) の push の時刻は、(ii) のうち早い方（現時点では (β) の 2026-10-27T09:11:20Z）を使う。

## R5 の照合（K6/4 の凍結の前の前提）

- 記録：`docs/plans/nir1-cp4-records/r5-check-r5-1027/`（commit `21ed9a9c`、`r5-check-record.json` の sha256 `4230ba3be42564087a65565c1504940a3922c55a3a28be0fccdb33e5314bd5ce`）。13 variant すべて match、`--verify` は `verified: true`。候補の commit は origin/master `7a2669ea`。S4 は `r5CheckRecord` の所在に、この commit の path を書く。
- この記録は凍結の前に push した（09:11:00Z、凍結は 09:11:20Z）。

## 凍結の後の規則

- 凍結の後、`claude/nir1-contracts` は fast-forward だけで進める（rebase、amend、squash、force-push をしない）。K6/4 の bytes は変えない。
- (i) で判定する CP-4 の run と、条件の判定に使う診断は、この凍結の後に始めたものに限り、receipt の先頭に凍結の commit と SHA-256 を書く（`K64_FREEZE.freezeCommit` に固定する PR は別）。

## (α) の取り直し

- 取り直した時刻：2026-10-30T13:48:48Z（2026-10-30 22:48 JST）。push（2026-10-27T09:11:20Z）の約 3 日後。
- 取得：`gh api 'repos/kazormia296/Grimodex/events?per_page=100' --paginate` のうち `type=PushEvent` かつ `payload.ref=refs/heads/claude/nir1-contracts`。今回は 4 件が現れた（`created_at` の昇順）：
  - `2026-10-27T09:11:01Z` id 25447971275 `payload.head=21ed9a9c…` `payload.before=14141248…`（①＝R5 の照合の記録）
  - **`2026-10-27T09:11:20Z` id 25352607173 `payload.head=5dea38af158283c2a925d68ef0d8b0771c0ea209` `payload.before=21ed9a9c…`（凍結の commit）**
  - `2026-10-27T09:11:55Z` id 25351646922 `payload.head=a0b20a38…` `payload.before=5dea38af…`（凍結の記録）
  - `2026-10-27T10:29:29Z` id 25359365639 `payload.head=2f622c70…` `payload.before=a0b20a38…`（②'＝合成の記録による検出力）
- 読み：(α) の PushEvent の `created_at` は (β) の repository activity の `timestamp` と秒まで一致した（凍結の commit は 09:11:20Z）。①の記録の commit は凍結の commit より 19 秒前（PushEvent）にあたり、(β) の 09:11:00Z とは 1 秒の差がある（server 側の取り込みの丸め。順序は変わらない）。凍結の commit の push が、CP-4 の最初の Graph の観測より前であるという (ii) の根拠は、(β) と (α) の 2 つの独立した server 側の記録で揃った。
- 照合 3 の (c) の push の時刻は、(β) と (α) が一致するので 2026-10-27T09:11:20Z のまま変えない。
- この追記は凍結の bytes（K6/4）を変えない。`claude/nir1-contracts` へは fast-forward だけで push する。
