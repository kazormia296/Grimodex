---
name: ship-branch
description: >
  現在の clean かつ commit 済み作業ブランチを push し、ready PR の作成または再利用、
  CI・レビュー・HEAD の確認、squash merge、base branch への反映確認まで進める。
  「PR出して」「プルリク作って」「pushしてマージ」「マージまでして」
  「shipして」「リモートに上げてPR」で使用する。commit作成自体は行わない。
  version更新を含むリリース準備は bump-version を主フローとし、release commit後の
  branch push、PR、mergeだけを担う。GitHub Releaseは公開しない。
---

# Ship Branch

現在の作業ブランチを `push → PR → gate確認 → merge → remote base検証` まで進める。base branch へ直接 push しない。失敗・pending・競合・未解決レビュー・HEAD 不一致がある状態ではマージしない。

## 1. ゴールと前提を確認する

1. 依頼が PR 作成までか、マージまでかを依頼文から確定する。マージまで明示されている場合、そのゴールをマージ権限として扱い、green 後に聞き直さない。
2. `git branch --show-current` で detached HEAD、`master`、`main` ではないことを確認する。
3. `git status --short` が clean であることを確認する。未コミット変更があれば停止し、変更内容を保護したまま適切な実装／修正スキルへ渡す。`git add -A` は使わない。
4. GitHub 認証は `AGENTS.md` の sandbox 手順に従って確認する。
5. `git fetch origin master` 後、`git log origin/master..HEAD --oneline` に公開対象 commit があることを確認する。
6. `git rev-parse HEAD` を記録し、この SHA を push と merge の期待値にする。
7. push 前に同じ head branch の open PR を検索し、PR の base、head SHA、draft、auto-merge 状態を確認する。
8. 既存 PR で auto-merge が有効な場合、PR 作成だけがゴールなら push せず停止する。マージまでがゴールなら、push 前に auto-merge を無効化して明示的な HEAD 固定マージへ切り替え、無効化を確認できなければ停止する。

`master`／`main` に公開対象 commit がある場合、base へ直接 push せず作業ブランチへ退避する。安全な branch 名を依頼内容から決められない場合だけユーザーへ確認する。

## 2. Branch を push する

1. `git push -u origin <current-branch>` で現在の branch だけを push する。
2. ゴールに push が含まれている場合、同じ操作を再確認しない。
3. push 後に remote branch の HEAD が記録した local HEAD と一致することを確認する。
4. force push、base branch push、wildcard refspec は、ユーザーが明示しない限り使用しない。

## 3. PR を作成または再利用する

1. preflight で確認した同じ head／base の open PR を再取得し、存在すれば重複作成せず再利用する。
2. PR がなければ `master` 向けの ready PR を作成する。draft 指定がある場合だけ draft にする。
3. title と body は commit と diff から作り、body に次を含める。
   - 変更の概要
   - 重要な設計判断または影響範囲
   - 実行済み検証
   - 省略した検証と理由
4. PR 本文へツール固有の宣伝や署名を自動追加しない。
5. PR 番号、URL、base、head、head SHA を記録する。

GitHub connector が利用できる場合は PR mutation と状態取得に優先して使う。`gh` を使う場合、複数行 body は `--body-file` で渡し、shell 展開で内容を壊さない。

## 4. CI とレビュー gate を待つ

1. required checks と通常 checks の状態を取得する。
2. check がまだ登録されていない場合、即座に green と扱わない。PR workflow の有無と branch protection を確認し、非同期に再取得する。
3. 実行中は長時間 blocking せず、定期的に状態を取得して進捗を共有する。
4. PR の HEAD が記録した local SHA から変わった場合、新しい SHA を自動採用せず停止する。変更 commit を local に取得して明示的にレビュー・検証・commit 状態を確認した後、本フローを新しい SHA で最初からやり直す。
5. fail、cancelled、timed out があればマージしない。失敗 job とログを特定し、一般のPR CIは`/debug-issue`へ、Electron release workflow／tag build／署名／publishの失敗はversionを変更せず`/debug-release-ci`へ渡す。
6. review decision、requested changes、未解決 inline thread、保留中の必須 reviewer を確認する。

チェックが本当に設定されていない repository では、required check が存在しないことを確認してから次へ進む。`no checks reported` だけを根拠にマージしない。

## 5. Merge 直前に再検証する

次を一つの snapshot として取り直す。

- PR が open かつ ready
- base が意図した `master`
- head branch が意図した branch
- head SHA が push 前に記録してレビューした local SHA と一致
- mergeable で競合がない
- 全 required checks が success
- pending／failed checks がない
- requested changes と未解決 review thread がない

一つでも満たさなければマージせず、状態を解消してから再検証する。

## 6. Merge と反映確認を行う

1. マージまでがゴールなら、既定で squash merge する。別方式が明示されている場合だけ変更する。
2. 可能なら expected head SHA を指定できる GitHub mutation を使う。`gh` では `--match-head-commit <sha>` を使う。
3. merge 成功後、PR が `merged` になったことと merge commit SHA を取得する。
4. `git fetch origin master` を実行し、merge commit が `origin/master` に含まれることを確認する。
5. remote branch を削除した場合も、local branch や worktree を破壊的に削除しない。
6. `master` が別 worktree で checkout 済みなら無理に switch せず、`origin/master` で反映を検証する。

## 停止条件

- PR だけがゴール: PR URL と現在の checks 状態を報告して停止する。
- draft PR: ready 化または merge を依頼されるまで停止する。
- CI failure: fail した check と原因調査結果を報告し、修正後に本フローを再開する。
- release workflow failure: `/debug-release-ci`のfocused gateへ戻す。本スキルはversion、release notes、tagを作らない。
- conflict／requested changes／未解決 thread: 解消するまで停止する。

## 完了報告

PR URL、公開した head SHA、checks／review の結果、merge method、merge commit SHA、`origin/master` の検証結果、local branch の状態を簡潔に報告する。
