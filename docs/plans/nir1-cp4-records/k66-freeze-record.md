# K6/6（graph-eval-procedure）の事前登録の凍結の記録

K6/2 の「事前登録の凍結」の 1 と 7(a)、K6/6 の「確認までの手順」の 6 に従う、integrator の作業記録。形は `k65-freeze-record.md` と同じ。

## 凍結の記録（1）

| 項目 | 値 |
|---|---|
| ref | `refs/heads/claude/nir1-contracts`（merge しない branch） |
| 凍結の commit | `56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d`（確認の記録 `user-confirmation-2026-11-08-k66-graph-eval-procedure.md` の commit。確認の後の最初の push） |
| file | `docs/plans/nir1-final-request-eval-proposal-6-draft.md`（draftRef `nir1-final-request-eval-proposal/6`、contractId `graph-eval-procedure`） |
| file の SHA-256（凍結の commit の時点の file） | `58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`（2026-11-08 にユーザーが確認した値と一致） |
| push 直後の `git ls-remote origin refs/heads/claude/nir1-contracts` | `56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d	refs/heads/claude/nir1-contracts` |
| (i) push の時刻（integrator の自己申告） | 2026-11-08T08:30:45Z（2026-11-08 17:30 JST） |
| (ii) remote 側の記録の時刻 | 下の (β)、(α) |
| 凍結の前の commit | `324c804f360b4bb7c87cb8f1fb94d24f134b6d78`（改訂 3。この file の bytes を最初に置いた commit。2026-11-07 に push、確認の前） |
| 前の凍結との順序 | `git merge-base --is-ancestor 07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f 56fb4fad…` は真（K6/5 の凍結の commit が祖先）。`324c804f` も祖先 |

- 確認された bytes は `324c804f` で置かれ、`56fb4fad` までの間に変わっていない（`git diff 324c804f 56fb4fad -- <file>` は空。間の commit は chat の IR の pilot の records と、確認の記録の追加だけ）。凍結の commit は、確認の後に push した最初の commit とする。

### (ii) remote 側の時刻

- (β) repository activity（`gh api "repos/kazormia296/Grimodex/activity?ref=refs/heads/claude/nir1-contracts&activity_type=push"`）。`after` が凍結の commit のもの：
  `after=56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d before=e6f86aae7bd12642a58b6b62ae75e07377ef04d8 timestamp=2026-11-08T08:30:45Z`。取得は 2026-11-08T08:31:03Z。
- (α) PushEvent（`gh api repos/kazormia296/Grimodex/events` のうち `type=PushEvent`、`payload.head` が凍結の commit のもの）：push の直後の取得（08:31:03Z）では現れなかった（最新の event は 08:24:53Z の PullRequestEvent）。GitHub の文書は遅れが 30 秒から 6 時間ありうるとするので、「なし」とは書かない。取り直した時刻と結果は、この file の下に追記する（fast-forward だけ）。K6/5 の凍結 `07fc80ec` の PushEvent も、この時点の取得（最新 100 件）には無い。
- 照合 3 の (c) の push の時刻は、(ii) のうち早い方（現時点では (β) の 2026-11-08T08:30:45Z）を使う。

## 凍結の後の規則

- 凍結の後、`claude/nir1-contracts` は fast-forward だけで進める（rebase、amend、squash、force-push をしない）。K6/6 の bytes は変えない。
- /6 で判定する CP-4 の run と、条件の判定に使う診断は、この凍結の後に始めたものに限り、receipt の先頭に /6 の凍結の commit と SHA-256（`head.k66`）を書き、/5 の凍結の commit（`07fc80ec`）と SHA-256（`1ad10884…`）も併せて書く（`head.k65` は残す）。
- この凍結の前に取った receipt（s6r1 を含む）と、dev の予行（予行 1・3・4・5）は予告で、/6 の判定に使わない。
