# K6/5（graph-eval-procedure）の事前登録の凍結の記録

K6/2 の「事前登録の凍結」の 1 と 7(a)、K6/5 の「確認までの手順」の 6 に従う、integrator の作業記録。K6/5 の「この file」はこの draft の bytes（K6/5 の「変える点」の 7）。形は `k64-freeze-record.md` と同じ。

## 凍結の記録（1）

| 項目 | 値 |
|---|---|
| ref | `refs/heads/claude/nir1-contracts`（merge しない branch） |
| 凍結の commit | `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f`（確認の記録 `user-confirmation-2026-11-07-k65-graph-eval-procedure.md` の commit。確認の後の最初の push） |
| file | `docs/plans/nir1-final-request-eval-proposal-5-draft.md`（draftRef `nir1-final-request-eval-proposal/5`、contractId `graph-eval-procedure`） |
| file の SHA-256（`git show 07fc80ec…:<file>` の出力） | `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`（2026-11-07 にユーザーが確認した値と一致） |
| push 直後の `git ls-remote origin refs/heads/claude/nir1-contracts` | `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f	refs/heads/claude/nir1-contracts` |
| (i) push の時刻（integrator の自己申告） | 2026-11-07T04:24:32Z（2026-11-07 13:24 JST） |
| (ii) remote 側の記録の時刻 | 下の (β)、(α) |
| 凍結の前の commit | `96c657cf68cdc509326254243a9d273615ed51c5`（改訂 5。この file の bytes を最初に置いた commit。2026-11-07T04:05:24Z に push、確認の前） |

- 確認された bytes は `96c657cf` で置かれ、`07fc80ec` までの間に変わっていない（`07fc80ec` は確認の記録の file を足しただけ）。凍結の commit は、確認の後に push した最初の commit とする。

### (ii) remote 側の時刻

- (β) repository activity（`gh api "repos/kazormia296/Grimodex/activity?ref=refs/heads/claude/nir1-contracts&activity_type=push"`）。`after` が凍結の commit のもの：
  `after=07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f before=96c657cf68cdc509326254243a9d273615ed51c5 timestamp=2026-11-07T04:24:31Z activity_type=push ref=refs/heads/claude/nir1-contracts`。取得は push の約 10 秒後（04:24:43Z）。
  参考：改訂 5 の commit は `after=96c657cf… timestamp=2026-11-07T04:05:24Z`。
- (α) PushEvent（`gh api repos/kazormia296/Grimodex/events` のうち `type=PushEvent`、`payload.head` が凍結の commit のもの）：push の直後の 1 回目の取得（04:24:43Z）では現れなかった（最新は 2026-11-06T21:31:37Z の `9bef2134`）。GitHub の文書は遅れが 30 秒から 6 時間ありうるとするので、「なし」とは書かない。取り直した時刻と結果は、この file の下の「(α) の取り直し」に追記する。
- 照合 3 の (c) の push の時刻は、(ii) のうち早い方（現時点では (β) の 2026-11-07T04:24:31Z）を使う。

## 凍結の後の規則

- 凍結の後、`claude/nir1-contracts` は fast-forward だけで進める（rebase、amend、squash、force-push をしない）。K6/5 の bytes は変えない。
- /5 で判定する CP-4 の run と、条件の判定に使う診断は、この凍結の後に始めたものに限り、receipt の先頭に /5 の凍結の commit と SHA-256 を書き、/4 の凍結の commit（`5dea38af`）と SHA-256（`d205b35f…`）も併せて書く（K6/5 の「変える点」の 7、K6/5-N3）。
- この凍結の前に取った receipt（/4 の下の receipt を含む）と dev の観測は予告で、/5 の判定に使わない。
