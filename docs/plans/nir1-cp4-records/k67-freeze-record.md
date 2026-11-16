# K6/7（graph-eval-procedure）の事前登録の凍結の記録

K6/2 の「事前登録の凍結」の 1 と 7(a)、K6/7 の「確認までの手順」の 6 に従う、integrator の作業記録です。形は `k66-freeze-record.md` と同じにしました。

## 凍結の記録（1）

| 項目 | 値 |
|---|---|
| ref | `refs/heads/claude/nir1-contracts`（merge しない branch） |
| 凍結の commit | `b9559a220c88eb2e7073b016244a9c45edf9b3be`。確認の記録 `user-confirmation-2026-11-15-k67-graph-eval-procedure.md` を置いた commit で、確認の後の最初の push |
| file | `docs/plans/nir1-final-request-eval-proposal-7-draft.md`（draftRef `nir1-final-request-eval-proposal/7`、contractId `graph-eval-procedure`） |
| file の SHA-256（凍結の commit の時点） | `7b8f81c71a2d7edca9dbef8bdfb7c81120d3873346289b156fc92fdc1d40424d`。2026-11-15 にユーザーが確認した値と一致 |
| push の直後の `git ls-remote origin refs/heads/claude/nir1-contracts` | `b9559a220c88eb2e7073b016244a9c45edf9b3be	refs/heads/claude/nir1-contracts` |
| (i) push の時刻（integrator の自己申告） | 2026-11-15T14:08:45Z（2026-11-15 23:08 JST） |
| (ii) remote 側の記録の時刻 | 下の (β) と (α) |
| 凍結の前の commit | `08b168c9562ff13c314a77f2d03b8a4550774d7f`。改訂 5 の bytes を最初に置いた commit で、確認の前（2026-11-15T14:07:13Z）に push した |
| 前の凍結との順序 | `git merge-base --is-ancestor 56fb4fad… b9559a22…` は真（K6/6 の凍結の commit が祖先）。`08b168c9` も祖先 |

- 確認された bytes は `08b168c9` で置いたもので、`b9559a22` まで変わっていません。`git diff 08b168c9 b9559a22 -- <file>` は空です。
- 間の commit は、確認の記録を足しただけです。
- 凍結の commit は、確認の後に push した最初の commit とします。

### (ii) remote 側の時刻

- **(β) repository activity**
  - 取得の command：`gh api "repos/kazormia296/Grimodex/activity?ref=refs/heads/claude/nir1-contracts&activity_type=push"`
  - `after` が凍結の commit のもの：`after=b9559a220c88eb2e7073b016244a9c45edf9b3be before=08b168c9562ff13c314a77f2d03b8a4550774d7f timestamp=2026-11-15T14:08:45Z`
  - 取得した時刻：2026-11-15T14:08:46Z
- **(α) PushEvent**
  - 取っていません。
  - GitHub の文書によると、反映には 30 秒から 6 時間の遅れがありえます。そのため「なし」とは書きません。
  - 取り直したら、時刻と結果をこの file の下に追記します（fast-forward だけ）。
- 照合 3 の (c) の push の時刻には、(ii) のうち早い方を使います。今の時点では (β) の 2026-11-15T14:08:45Z です。

## 凍結の後の規則

- 凍結の後、`claude/nir1-contracts` は fast-forward だけで進めます。rebase、amend、squash、force-push はしません。K6/7 の bytes は変えません。
- /7 で判定する CP-4 の run と、条件の判定に使う診断は、この凍結の後に始めたものに限ります。
  - 受領書の先頭には、次の 3 組を書きます（`head.k66` と `head.k65` は残します）。
    - /7 の凍結の commit と SHA-256（`head.k67`）
    - /6 の凍結の commit（`56fb4fad`）と SHA-256（`58c634fa…`）
    - /5 の凍結の commit と SHA-256
  - 実装は、PR-3 と次の S4 の harness で行います。
- 次のものは、/7 の判定に使いません。
  - この凍結の前に取った受領書（s6r1、s7r1、s7r2 を含む）
  - 確認の前の dev の試作（`claude/dev-k67-iib`）

## 追記：(α) PushEvent の取り直し（2026-11-16T06:03Z）

- `gh api "repos/kazormia296/Grimodex/events?per_page=100&page=1..3"` で、`claude/nir1-contracts` の PushEvent を探した。
- 2026-11-15 の 11:06Z〜16:01Z の push（`8a5bddce`、`c1eced67`、`d4ad9dc9`、`f7ea87a6`、`a8c3cf92`、`fcd94031`、`160f5fa5`）は見つかった。
- `head=b9559a22…` の PushEvent は、取得できた 300 件の中に無かった。
- events の API は、取得できる件数と期間が限られる。そのため「なし」とは書かない。
- (ii) の時刻は、(β) の 2026-11-15T14:08:45Z のままとする。
