---
name: create-branch
description: >
  最新のリモート基点から安全に作業ブランチを作成する。
  「ブランチを切って」「作業ブランチを作って」「新しいブランチから始めて」
  と依頼されたときに使用する。既定はorigin/master、明示された場合は指定された
  originまたはローカルのブランチ／refを基点にする。push、commit、mergeは行わない。
---

# Create Branch

作業開始前に、指定された基点を最新状態へ同期し、その基点から新しい作業ブランチを作る。
レビュー対象の古いHEADを、ユーザーが基点として明示していない限り、基点に使わない。

## 手順

1. 現在位置を確認する。

   ```bash
   git branch --show-current
   git status --short
   git worktree list
   git remote -v
   ```

   detached HEADまたは未コミットの変更がある場合は、既存の変更をstash、reset、checkout、削除で
   隠さず、状況を報告して停止する。現在の作業ブランチが`master`／`main`以外でも、それを暗黙の
   基点にはしない。既存作業を残したまま別worktreeで作る場合だけ、そのworktreeのclean状態と
   場所を明示して続行する。

2. 基点を解決する。

   - 基点の指定がなければ`origin/master`を使う。
   - `origin/<name>`が指定されたら、そのremote refを使う。
   - `<name>`だけが指定されたら、手順3のfetch後に`origin/<name>`を探し、なければ存在するローカル
     branch／refを使う。候補が複数ある、または解決できない場合は推測せず停止する。
   - 新しい基点名やremoteを勝手に作らない。

3. リモートの最新状態を取得する。既定のmasterなら次を実行する。

   ```bash
   git fetch origin master --prune
   ```

   指定されたremote branchなら、そのbranchを同じ形でfetchする。名前だけの指定でremote branchが
   まだ解決できない場合は`git fetch origin --prune`でremote refsを更新してから解決する。ローカルの
   基点branchを更新する必要があり、そのbranchがcleanな専用worktreeでcheckoutされている場合だけ、
   そこで次を実行する。

   ```bash
   git pull --ff-only origin <base-branch>
   ```

   現在の作業ブランチ上で基点をpullしない。通常はfetch後の`origin/master`または指定remote refを
   直接基点にする。`pull`がnon-fast-forward、認証、network、または未コミット変更で失敗したら、
   mergeやrebaseを自動開始せず停止する。

4. fetch後の基点を検証する。

   ```bash
   git rev-parse --verify <resolved-base>
   git log -1 --oneline <resolved-base>
   ```

   新ブランチ名はユーザー指定を優先し、未指定ならリポジトリの規約（通常は`codex/` prefix）で
   決める。既存branch名を再利用せず、同名のlocal／remote branchがあれば停止する。

5. 解決済みの基点から作成する。

   ```bash
   git switch -c <new-branch> <resolved-base>
   ```

   `-B`、force、reset、checkoutによる既存branchの上書きは使わない。

6. 作成結果を確認する。

   ```bash
   git branch --show-current
   git rev-parse HEAD
   git merge-base --is-ancestor <resolved-base> HEAD
   git status --short --branch
   ```

   現在HEADが解決済み基点の子孫であり、作業ツリーがcleanであることを確認して報告する。
   このスキルの範囲ではcommit、push、PR作成、mergeを行わない。それらは依頼された場合に
   `/ship-branch`へ渡す。

## 停止条件

- 未コミット変更、既存branch名、解決不能な基点、fetch／pull失敗、baseのancestor検証失敗がある。
- ユーザーが指定した基点と実際に解決したrefが一致しない。
- `origin/master`が更新された後に、古いローカル`master`から作ろうとしている。

停止時は、作業ツリーを変更せず、解決した／解決できなかった基点、現在branch、失敗したcommandを
そのまま報告する。
