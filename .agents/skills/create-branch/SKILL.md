---
name: create-branch
description: >
  Grimodex の作業ブランチ作成を依頼されたとき、指定された ref または最新の
  origin/master を基点に作成する。commit、push、merge は含めない。
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

   detached HEADは停止する。未コミットの変更がある場合は、既存の変更をstash、reset、checkout、削除で
   隠さず、通常のin-place作成では状況を報告して停止する。現在の作業ブランチが`master`／`main`以外でも、
   それを暗黙の基点にはしない。ユーザーが新worktreeを明示した場合だけ、元checkoutのdirty状態を記録して
   保持したまま、指定保存先が未使用で新branchが衝突しないことを確認して続行する。作成先worktreeは
   解決済み基点から作るcleanな状態でなければならない。

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

## 明示された新worktree

ユーザーが新しいworktreeを明示した場合は、手順4で解決した基点から既存checkoutを変更せずに作成する。
保存先とbranch名の衝突を先に確認し、次の形で`git worktree add -b`を使う。

```bash
git worktree add -b <new-branch> <new-worktree-path> <resolved-base>
```

`git worktree list --porcelain`で既存worktreeを確認し、保存先が存在しないこと、local／remote branchが未使用であることを確認する。
既存の保存先、local／remote branch、または同名のworktreeがある場合は上書きせず停止する。作成後は
`git -C <new-worktree-path> branch --show-current`、`git -C <new-worktree-path> rev-parse HEAD`、
`git -C <new-worktree-path> status --short --branch`、`git -C <new-worktree-path> merge-base --is-ancestor <resolved-base> HEAD`
で新worktreeのHEAD、clean状態、基点の子孫性を確認する。元のcheckoutは保持し、commit、push、mergeは行わない。

## 停止条件

- 通常のin-place作成で未コミット変更がある、または新worktree作成先で既存branch名／保存先／worktreeが衝突する、解決不能な基点、fetch／pull失敗、baseのancestor検証失敗がある。明示された新worktreeでは元checkoutのdirty状態は停止条件にせず、作成先のclean確認を必須とする。
- ユーザーが指定した基点と実際に解決したrefが一致しない。
- `origin/master`が更新された後に、古いローカル`master`から作ろうとしている。

停止時は、作業ツリーを変更せず、解決した／解決できなかった基点、現在branch、失敗したcommandを
そのまま報告する。
