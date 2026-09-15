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

## 2. ローカルCI gateを固定する

1. 高リスク作業では、expensive Fullより前に high-effort review と candidate-untouched independent
   acceptance review を収束させ、P2+ findingを解消する。acceptance reviewerはread-onlyで候補を編集しない。
   focused gatesを通過してcandidateをfreezeした後、Full完了後のacceptanceはcandidateが不変であることだけを確認し、
   candidate変更がない限り意味のレビューを開き直さない。
2. Fullの前にgeneric resource-isolation preflightを記録する。competing heavy runがなく（no competing heavy run）、enough writable capacity on actual
   workspace/build-cache/temp filesystemsがあり、root/home pressureとtemp quotaを別々に確認することを要件とする。
   any fixed capacity/quota threshold（GB、percentage、inode、その他numericを含む）、host-specific cache deletion list、deletion automationは使わない。
   thresholdsはrisk/workload/filesystem stateから導出し、hardcodeしない。このpreflightはread-onlyであり、must not
   auto-delete artifacts, kill other jobs, or rewrite temp paths。competing jobはcoordination stopであり、kill authorityではない。
3. PR作成だけがゴールの場合も、cleanなcommit済みHEADで次を実行し、completeなQuick receiptを確認する。

   ```bash
   pnpm ci:local:quick -- --base origin/master --head HEAD
   pnpm ci:local:verify -- quick --base origin/master --head HEAD
   ```

4. mergeまでがゴールの場合、初回Fullの前提として`git fetch origin master`後のcurrent `origin/master`がcandidate HEADの
   祖先であることを確認する。branchが遅れていれば安全に更新してレビュー対象を取り直し、cleanなcommit済みHEADで最初のstageから
   やり直す。この前提を満たした後、shell-localの不変な`candidate_base`／`candidate_head`をそれぞれ
   `origin/master^{commit}`／`HEAD^{commit}`から一度だけ解決し、再代入せず同じ展開済み入力文字列をFullとそのreceiptの全verifyに渡す。
   短縮refや別の記録値へ切り替えない。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   pnpm ci:local:full -- --base "$candidate_base" --head "$candidate_head"
   pnpm ci:local:verify -- full --base "$candidate_base" --head "$candidate_head"
   ```

5. candidate freeze時に、ledgerへ`resolvedBaseSha`、`resolvedHeadSha`、`currentHeadSha`、tree、clean状態、receipt directory、
   completenessのtupleを一度（once）だけ記録する。後続のFull receiptは同じtupleをbind／referenceし、pushとmergeの状態遷移では
   expected-headを使い、treeの再計測やremote merge treeとの二重比較を要求しない。
6. candidateをfreezeしてFull receiptを得た後に`origin/master`が進んだ場合は、原則としてreceiptを無効化してやり直す。
   ただしcandidate HEAD／PR diffが不変で、upstream deltaがeditorial docs/ADR-only、かつexecutable、build、dependency、CI、policy、
   schema、manifest、generated-contractの内容もratified decision／acceptance meaningも変えていないことを確認できる場合だけ、
   狭いupstream-base exceptionを適用できる。この場合はexceptionと比例したstatic／focused checksを記録し、旧receiptを元の
   `candidate_base`／`candidate_head`でだけ再verifyし、新baseに束縛されたreceiptとは扱わない。曖昧さまたはcandidate HEADの変更が
   あればreceiptを無効化し、Full-from-stage-1 + verifyをやり直す。`--from`によるpartial runと`--dry-run`は診断用であり、merge証跡にしない。
7. command、toolchain、依存、host capabilityの不足、失敗、candidate不一致はgate failureとして
   停止する。hosted PR checksが無いことや`no checks reported`をローカルFullの代替にしない。

## 3. Branch を push する

1. `git push -u origin <current-branch>` で現在の branch だけを push する。
2. ゴールに push が含まれている場合、同じ操作を再確認しない。
3. push mutationには記録したcandidate head SHAをexpected headとして渡せる場合は指定し、push後にremote branchのHEADが
   expected headと一致することを確認する。
4. force push、base branch push、wildcard refspec は、ユーザーが明示しない限り使用しない。

## 4. PR を作成または再利用する

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

## 5. CI とレビュー gate を待つ

1. required checks と通常 checks の状態を取得する。
2. check がまだ登録されていない場合、即座に green と扱わない。PR workflow の有無と branch protection を確認し、非同期に再取得する。
3. 実行中は長時間 blocking せず、定期的に状態を取得して進捗を共有する。
4. PR の HEAD が記録したexpected head SHAから変わった場合、新しいSHAを自動採用せず停止する。変更commitをlocalに取得して
   明示的にレビュー・検証・commit状態を確認した後、本フローを新しいSHAで最初からやり直す。
5. fail、cancelled、timed out があればマージしない。失敗 job とログを特定し、一般のPR CIは`/debug-issue`へ、Electron release workflow／tag build／署名／publishの失敗はversionを変更せず`/debug-release-ci`へ渡す。
6. review decision、requested changes、未解決 inline thread、保留中の必須 reviewerを確認し、P2+ findingが残っていないことを確認する。

チェックが本当に設定されていない repository では、required check が存在しないことと、
手順2のcompleteなローカルFull receiptが有効であることを確認してから次へ進む。
`no checks reported`だけを根拠にマージしない。

## 6. Merge 直前に再検証する

次を一つの snapshot として取り直す。

- 最初に `git fetch origin master` を実行し、その後でbaseを比較・分類する。初回Fullで固定した`candidate_base`／`candidate_head`
  は再解決・再代入せず、exactly oneの`approved_merge_base` commitを記録する。通常pathではcurrent fetched baseが`candidate_base`と
  一致することを確認して`approved_merge_base`に採用し、exception pathでは狭いdocs/ADR-only exceptionを承認した後だけcurrent baseを
  `approved_merge_base`に採用する。
- PR が open かつ ready
- base が意図した `master`
- head branch が意図した branch
- head SHA が push 前に記録してレビューした local SHA と一致
- mergeable で競合がない
- 通常pathでは、current fetched baseが`candidate_base`と一致し、candidate head SHAがPR HEADと一致し、初回Fullと同じpinを再利用した
  `pnpm ci:local:verify -- full --base "$candidate_base" --head "$candidate_head"`が成功している。
- upstream baseがreceipt後に動いたexception pathでは、candidate HEAD／PR diff不変・editorial docs/ADR-only・executable／build／
  dependency／CI／policy／schema／manifest／generated-contractとratified decision／acceptance meaningに変更なしを記録し、旧receiptを
  同じ元の`candidate_base`／`candidate_head`に対して再verifyする。旧receiptを新baseに対する証跡とは扱わず、newer upstream deltaは別に分類する。
  曖昧さまたはcandidate変更ならreceiptを無効化してFull-from-stage-1 + verifyをやり直す。
- 設定されている全required checksがsuccess
- pending／failed checks がない
- requested changes と未解決 review thread がない

一つでも満たさなければマージせず、状態を解消してから再検証する。

## 7. Merge と反映確認を行う

1. マージまでがゴールなら、既定で squash merge する。明示されたnon-squash方式は、before mergeにmethod-specific
   actual-base/post-merge verification procedureがdefined and approvedであることを確認する。未定義・未承認ならstopし、
   squash用first-parent ruleを流用しない。このスキルは一般のnon-squash verification logicを追加しない。
2. 可能なら expected head SHA を指定できる GitHub mutation を使う。`gh` では `--match-head-commit <sha>` を使う。
3. merge 成功後、PR が `merged` になったことと merge commit SHA を取得する。
4. `git fetch origin master` を実行し、merge commit が `origin/master` に含まれることを確認する。
5. squash mergeの場合だけ、実際のsquash merge commitのfirst parent（`<merge-sha>^1`）を`approved_merge_base`と一度だけ比較する。
   parent mismatchならdo not report verified successとし、newly added base deltaを分類して必要なexception/revalidation pathを実施する。
   merge may have occurredだが、acceptance evidence is not valid until resolved。expected headの一致とmerge commitの`origin/master`への
   包含を確認できない場合も成功扱いにしない。non-squash方式ではdo not reuse the squash first-parent rule（squash用first-parent
   ruleを流用しない）。1で承認した方式固有手順以外の一般的なnon-squash verification logicは追加しない。routineなremote merge tree比較は行わない。
6. remote branch を削除した場合も、local branch や worktree を破壊的に削除しない。
7. `master` が別 worktree で checkout 済みなら無理に switch せず、`origin/master` で反映を検証する。

## 停止条件

- PR だけがゴール: PR URL と現在の checks 状態を報告して停止する。
- draft PR: ready 化または merge を依頼されるまで停止する。
- local CI／CI failure: failしたstageまたはcheckと原因調査結果を報告し、修正後に本フローを再開する。
- release workflow failure: `/debug-release-ci`のfocused gateへ戻す。本スキルはversion、release notes、tagを作らない。
- conflict／requested changes／未解決 thread: 解消するまで停止する。

## 完了報告

PR URL、Quick／Full receiptの結果、hosted checks／review、merge method、`origin/master`への包含確認、local branchの状態を
簡潔に報告する。SHAは不一致があった場合またはユーザーが求めた場合だけ recite する。
