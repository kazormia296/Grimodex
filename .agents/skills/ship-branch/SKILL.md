---
name: ship-branch
description: >
  Grimodex の clean な commit 済みブランチを、依頼された push、PR、merge の段階まで
  進め、候補 HEAD と検証証跡を照合する。実装変更の commit 作成、version 更新、Release 公開は含めない。
---

# Ship Branch

現在の作業ブランチを `push → PR → gate確認 → merge → remote base検証 → master Full` のうち、依頼された段階まで進める。マージまでがゴールなら、通常のPRでは merge 後の master の Full の dispatch（§8）まで含む。base branch へ直接 push しない。失敗・pending・競合・未解決レビュー・HEAD 不一致がある状態ではマージしない。通常のPRの2つの例外（master の取込みだけの head、docs-only PR）は §2.10 に従う。

merge のために遅れた branch を安全に同期する作業は含む（方法は §2.3）。新たな実装修正とその completion commit は
実装／修正 skill が担当し、候補が変われば証跡を取り直す。

merge 前の証跡は PR の種類で分かれる。規則の正本は [GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001) で、本スキルはその手順を担当する。
本文の「手順N」と「§N」は節 N（`## N.`）を、「§N.M」はその節の項目 M を指す。

- 通常のPR（既定。以下 通常path）: rebase 済みの候補の canonical Quick と、同じ head の `ci.yml` checks でマージする。canonical Full は通常のPRの merge 条件ではなく、merge 後に master の head で走らせる（§8）。例外として、master の取込みだけの head（§2.10 の例外1）と docs-only PR（§2.10 の例外2）は、§2.10 の条件で候補 head の `ci.yml` の完了を待たずに merge できる。どちらも release PR には使わない。
- release PR（`package.json` の `version` を変える PR。`/bump-version` が作るものを含む。以下 release path。判定は §1.9）: 従来どおり complete な hosted Full と直後の verify を要求する。

## 1. ゴールと前提を確認する

1. 依頼が push のみ、PR 作成まで、マージまでのどれかを依頼文から確定する。マージまで明示されている場合、そのゴールをマージ権限として扱い、green 後に聞き直さない。
2. `git branch --show-current` で detached HEAD、`master`、`main` ではないことを確認する。
3. `git status --short` が clean であることを確認する。未コミット変更があれば停止し、変更内容を保護したまま適切な実装／修正スキルへ渡す。`git add -A` は使わない。
4. GitHub 認証は `AGENTS.md` の sandbox 手順に従って確認する。
5. `git fetch origin master` 後、`git log origin/master..HEAD --oneline` に公開対象 commit があることを確認する。
6. `git rev-parse HEAD` を記録し、この SHA を push と merge の期待値にする。
7. push 前に同じ head branch の open PR を検索し、PR の base、head SHA、draft、auto-merge 状態を確認する。
8. 既存 PR で auto-merge が有効な場合、push のみまたは PR 作成だけがゴールなら push せず停止する。マージまでがゴールなら、push 前に auto-merge を無効化して明示的な HEAD 固定マージへ切り替え、無効化を確認できなければ停止する。
9. 通常のPRか release PR かを決める。作り方ではなく内容で決め、`package.json` の `version` を変える PR（`/bump-version` が作るものを含む）を release PR、それ以外を通常のPRとする。
   `git diff origin/master...HEAD -- package.json` の差分に `"version"` の行があるかで確かめ、迷う場合は release PR として release path に倒す。
   release PR でない通常のPRが §2.10 の例外1・例外2 に当たるかは、§2.10 の判定で決める。

`master`／`main` に公開対象 commit がある場合、base へ直接 push せず作業ブランチへ退避する。安全な branch 名を依頼内容から決められない場合だけユーザーへ確認する。

push のみでは手順2の PR／merge 用 Quick／Full を開始せず、手順3の remote HEAD 確認で完了する。
PR 作成までなら、該当する Quick gate と手順4までで完了し、手順5以降の merge 用 gate へ進まない。

## 2. canonical CI gateを固定する

通常の PR／`master` push では `ci.yml` の checks が自動で走るが、canonical Quick／Full receipt の代わりにはならない。
canonical Quick／Full は `canonical-ci.yml` の `workflow_dispatch`（`profile`、`candidate_base`、`candidate_head`）で hosted 実行でき、
Full は hosted でだけ実行する。dispatch する ref の HEAD は `candidate_head` と一致していなければならないため、
branch から dispatch する hosted の Quick／Full は手順3で push した branch の remote HEAD が `candidate_head` と一致することを確認してから dispatch する。
master の Full（§8）は `--ref master` で dispatch し、`candidate_head` に master の HEAD を渡す。

1. 高リスク作業では、merge（release PR ではexpensive Fullも）より前に high-effort review と candidate-untouched independent
   acceptance review を収束させ、P2+ findingを解消する。acceptance reviewerはread-onlyで候補を編集しない。
   focused gatesを通過してcandidateをfreezeした後、QuickまたはFull完了後のacceptanceはcandidateが不変であることだけを確認し、
   candidate変更がない限り意味のレビューを開き直さない。
2. Fullの前（release PRのFullと、merge後のmasterのFull）にgeneric resource-isolation preflightを記録する。competing heavy runがなく（no competing heavy run）、enough writable capacity on actual
   workspace/build-cache/temp filesystemsがあり、root/home pressureとtemp quotaを別々に確認することを要件とする。
   any fixed capacity/quota threshold（GB、percentage、inode、その他numericを含む）、host-specific cache deletion list、deletion automationは使わない。
   thresholdsはrisk/workload/filesystem stateから導出し、hardcodeしない。このpreflightはread-onlyであり、must not
   auto-delete artifacts, kill other jobs, or rewrite temp paths。competing jobはcoordination stopであり、kill authorityではない。
   hosted Fullでは、各part jobのFull admissionがfresh VM上でworkspace/build-cache/temp、memory、pressureを観測し、
   危険な配置やpressureを拒否する。dispatchする側は、同じref（masterまたはrelease PRのbranch）で実行中のcanonical Fullがないことをread-onlyで確認してからdispatchする。
3. 通常のPRでQuickを取る場合（CIが許可されているとき。PR作成だけがゴールの場合も含む）は、Quickの前に`git fetch origin master`を実行し、
   current `origin/master`がcandidate HEADの祖先（rebase済み）であることを`git merge-base --is-ancestor origin/master HEAD`で確認する。
   ローカルのQuickは祖先関係を検証しない（hostedの`canonical-ci.yml`は検証する）。祖先でなければ、branchを同期してレビュー対象を取り直し、
   cleanなcommit済みHEADで最初のstageからやり直す。条件は「`origin/master`がHEADの祖先であること」で、同期の方法は問わない。
   - 未pushのbranchは`origin/master`へrebaseする。
   - push済みのbranchをrebaseするとforce pushが必要になる。§3.4のとおり、ユーザーがforce pushを明示した場合に限り、
     リモートの現在のheadを期待値にした`git push --force-with-lease=<branch>:<リモートの現在のhead SHA> origin <branch>`で更新する。
   - force pushが明示されていないpush済みのbranchは、`origin/master`をbranchへmergeして取り込む。通常のPRはsquash mergeなので、branch上のmerge commitは残らない。
4. PR作成だけがゴールの場合も、mergeまでがゴールの場合も、PR／releaseの証跡が依頼範囲に含まれ、CIが許可されている場合に限り、focused検証後のcleanなcommit済みHEADで
   候補base／headを一度だけ解決し、同じ値で次を実行してcompleteなQuick receiptを直後に確認する。CI明示除外の作業ではQuickを開始せず、
   候補commitを保持してmerge／release readinessを主張しない。候補変更後は旧receiptを再利用しない。
   上記のPR／release／CI条件を満たす場合だけ、次の固定値でQuickと直後のverifyを実行する。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
   pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"
   ```

   同じQuickをhostedで行う場合は、手順3でpushしたbranchのremote HEADが`candidate_head`と一致することを確認してから、
   同じ固定値で次をdispatchする。hosted Quickは3つのpart job（`quick-1`〜`quick-3`。選択されたLight commandを直列のまま3つのVMに分ける）と
   `quick-aggregate`で実行し、`quick-aggregate`がpartをまとめて1つのreceiptにし、partの和が分割前の選択と一致することを確かめ、直後のverifyまで実行する。
   dispatchしたrunの`headSha`が`candidate_head`と一致し、part jobと`quick-aggregate`のすべてが成功したrunだけをcompleteなQuick receiptとする。
   失敗したjobだけを再実行しない（集約が前のattemptのpartを読めず落ちる）。再実行が要るときは全jobを再実行するか、dispatchし直す。

   ```bash
   gh workflow run canonical-ci.yml --ref "$(git branch --show-current)" -f profile=quick -f candidate_base="$candidate_base" -f candidate_head="$candidate_head"
   ```

5. 通常のPRのmerge証跡は、上記のcompleteなQuick receipt（`candidate_base`が`candidate_head`と`origin/master`の両方の祖先であるもの。確認は§6）と、同じheadの通常PR checks（`ci.yml`）の成功である。
   その祖先条件を満たさないQuick（PR作成だけがゴールのときに祖先確認なしで取ったQuickなど）は、候補が変わっていなくてもmerge証跡にせず、
   branchを同期して§2.3から取り直す。
   canonical Fullは通常のPRのmerge条件ではなく、通常のPRのためにFullをdispatchしない。通常のPRではmerge直前にcurrent baseが`candidate_base`と一致することを要求せず、
   `approved_merge_base`も使わない。Quickの後に`origin/master`が進んでも、GitHubが衝突なしでmergeableと判定し、PR HEADが`candidate_head`と
   一致していれば、rebaseとQuickのやり直しは不要。衝突がある、または候補を変える必要がある場合だけ、branchを同期（§2.3）して
   祖先確認からやり直す（候補base／headとQuick receiptを取り直す）。通常のPRのmergeまでが依頼されていてもCIが明示的に除外されている場合は、
   Quickとmergeを開始せず、merge readinessを主張しない。
   同じheadの`ci.yml`の成功には、§2.10の2つの例外がある。
6. release PRでmergeまでがゴールでCIが許可されている場合だけ、Fullを要求する。初回Fullの前提として`git fetch origin master`後のcurrent `origin/master`がcandidate HEADの
   祖先であることを確認する。branchが遅れていれば安全に更新してレビュー対象を取り直し、cleanなcommit済みHEADで最初のstageから
   やり直す。この前提を満たした後、shell-localの不変な`candidate_base`／`candidate_head`をそれぞれ
   `origin/master^{commit}`／`HEAD^{commit}`から一度だけ解決し、再代入せず同じ展開済み入力文字列をFullとそのreceiptの全verifyに渡す。
   短縮refや別の記録値へ切り替えない。

   release PRのmergeまでが依頼されていてもCIが明示的に除外されている場合はFullとmergeを開始せず、merge readinessを主張しない。
   FullはGitHub-hostedの`canonical-ci.yml`でだけ実行する。Full admissionは標準のGitHub-hosted job以外を拒否するため、
   ローカル実行のFullはmerge証跡にならない。上記のrelease／CI条件を満たす場合だけ、手順3でpushしたbranchのremote HEADが
   `candidate_head`と一致することを確認し、次の固定値でhosted Fullをdispatchして、Fullと直後のverifyを`full-aggregate`まで実行させる。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   gh workflow run canonical-ci.yml --ref "$(git branch --show-current)" -f profile=full -f candidate_base="$candidate_base" -f candidate_head="$candidate_head"
   ```

   dispatchしたrunの`headSha`が`candidate_head`と一致することを確認する。各part jobは同じtupleで担当partを実行し、
   `full-aggregate` jobが全partを集約してreceiptを作り、同じtupleで次の2つを実行する。
   `pnpm ci:local:full -- --aggregate --base "$candidate_base" --head "$candidate_head"`
   `pnpm ci:local:verify -- full --base "$candidate_base" --head "$candidate_head"`
   全part jobと`full-aggregate`が成功したrunだけをcompleteなFull receiptとする。失敗したrunは失敗jobだけでなく全jobを再実行する。

7. candidate freeze時に、ledgerへ`resolvedBaseSha`、`resolvedHeadSha`、`currentHeadSha`、tree、clean状態、receipt directory、
   completenessのtupleを一度（once）だけ記録する。後続のQuick／Full receiptは同じtupleをbind／referenceし、pushとmergeの状態遷移では
   expected-headを使い、treeの再計測やremote merge treeとの二重比較を要求しない。
8. release pathでは、candidateをfreezeしてFull receiptを得た後に`origin/master`が進んだ場合は、原則としてreceiptを無効化してやり直す。
   ただしcandidate HEAD／PR diffが不変で、upstream deltaがeditorial docs/ADR-only、かつexecutable、build、dependency、CI、policy、
   schema、manifest、generated-contractの内容もratified decision／acceptance meaningも変えていないことを確認できる場合だけ、
   狭いupstream-base exceptionを適用できる。この場合はexceptionと比例したstatic／focused checksを記録し、旧receiptを元の
   `candidate_base`／`candidate_head`でだけ再verifyし、新baseに束縛されたreceiptとは扱わない。曖昧さまたはcandidate HEADの変更が
   あればreceiptを無効化し、Full-from-stage-1 + verifyをやり直す。`--from`によるpartial runと`--dry-run`は診断用であり、merge証跡にしない。
9. command、toolchain、依存、host capabilityの不足、失敗、candidate不一致はgate failureとして
   停止する。通常のPR checks（`ci.yml`）のgreen、hosted PR checksが無いこと、`no checks reported`をcanonical Quick（release PRではFull）の代替にしない。
10. 通常のPRには、同じheadの`ci.yml`の成功を求めない例外が2つある（例外1は成功を以前のheadから持ち越し、例外2は待たない）。規則の正本は
    [GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001)。どちらもrelease PRには使わない。completeなQuick receipt
    （祖先確認と直後のverifyを含む）、review gate、required checks、masterの赤の確認、`--match-head-commit`付きのmergeは緩めない。
    判定のどれかが外れた場合、または取込みの結果に候補の変更が要った場合は例外を使わず、§2.5のとおり候補headで`ci.yml`の成功を取り直す。
    この項が、2つの例外での`ci.yml`の結論の扱いの唯一の置き場である（冒頭、§5、§6、停止条件、完了報告はこの項を参照する）。

    `ci.yml`のrunはSHAで絞って読む。`gh run list --workflow ci.yml --event pull_request --commit "$sha" --json databaseId,status,conclusion,attempt`の
    各runについて、`status`がcompletedでなければpending、completedなら`conclusion`で見る。
    - 成功: 1件以上あり、全部がcompletedかつ`conclusion`が`success`。`--jq 'length > 0 and all(.[]; .status == "completed" and .conclusion == "success")'`が`true`を出す。
      0件は成功ではない（候補headではpendingとして扱う）。
    - 例外1の候補head: completedで`conclusion`が`success`でないrunが1件でもあればmergeしない。pendingだけなら待たずにmergeできる。
    - 例外2の候補head: completedで`conclusion`が`failure`のrunは、docsの変更と関係ないと確かめた場合だけmergeできる。`failure`以外で`success`でない結論
      （`cancelled`、`timed_out`、`startup_failure`、`action_required`など）は`ci.yml`を取り直し、新しいattemptを同じ規則で扱う。pendingだけなら待たずにmergeできる。
    - docsの変更と関係ないことの材料は、ログを読んだうえで次のどれかが成り立つこと: 同じ失敗がmasterの最新のpushの`ci.yml`にもある、
      再実行で通る。変更したpathを読む所が`git grep`で見つからないことは材料にならない（docs-onlyの定義が既にそれを保証するため）。確かめた材料は完了報告に書く。確かめられなければmergeしない。

    - 例外1（masterの取込みだけのhead）: 取込みの前の、PRの変更を含む最後のhead`ci_head`で、通常の`ci.yml`（pull_request）が上の成功である。
      その後の`candidate_head`は、`ci_head`に`origin/master`をmergeで取り込んだだけである（rebaseとforce pushでは使えない）。
      `ci.yml`のconcurrency（`ci-pr-<番号>`、cancel-in-progress）は、新しいheadをpushすると走っているrunを取り消し、取り消されたrunは成功の根拠にならない。
      取込みをpushする前に、PRのheadが`ci_head`であることと、`ci_head`の`ci.yml`が上の成功であることを`ci_head`のSHAで絞って確かめて`ci_head`を記録し、
      完了を待ってから取り込む。判定は次のとおりで、(a)〜(c)のどれかが不成立ならこの例外は使えない。

      ```bash
      ci_head="<ci.ymlが成功したheadのSHA>"
      (
        set -o pipefail
        export LC_ALL=C
        no() { echo "merge-in-only: no: $1"; exit 1; }
        git fetch origin master || no "fetchが失敗"
        candidate_head="$(git rev-parse 'HEAD^{commit}')" || no "HEADを解決できない"
        [ -n "$ci_head" ] && [ -n "$candidate_head" ] || no "SHAが空"
        ci_head="$(git rev-parse --verify --quiet "$ci_head^{commit}")" || no "ci_headをcommitに解決できない"
        [ "$ci_head" != "$candidate_head" ] || no "ci_headが候補と同じ（取込みが無い）"
        base0="$(git merge-base "$ci_head" origin/master)" && [ -n "$base0" ] || no "merge-baseを求められない（base0が空）"
        # (a) 取込みだけである
        git merge-base --is-ancestor "$ci_head" "$candidate_head" || no "ci_headが候補の祖先でない"
        extra="$(git rev-list --no-merges "$ci_head..$candidate_head" ^origin/master)" || no "rev-listが失敗"
        [ -z "$extra" ] || no "取込み以外のcommitがある: $(echo $extra)"
        # (b) 取込みのmerge commit（masterにないもの）に手編集（競合解決）が無い
        merges="$(git rev-list --merges "$ci_head..$candidate_head" ^origin/master)" || no "rev-listが失敗"
        for m in $merges; do
          tree="$(git merge-tree --write-tree "$m^1" "$m^2")" && [ "$tree" = "$(git rev-parse "$m^{tree}")" ] || no "手編集あり: $m"
        done
        # (c) PRの変更ファイルと取り込んだmasterの変更ファイルが交わらない
        pr_files="$(git -c core.quotePath=false diff --name-only --no-renames "$base0" "$ci_head" | LC_ALL=C sort)" || no "diffが失敗（PR側）"
        master_files="$(git -c core.quotePath=false diff --name-only --no-renames "$base0" origin/master | LC_ALL=C sort)" || no "diffが失敗（master側）"
        overlap="$(LC_ALL=C comm -12 <(printf '%s\n' "$pr_files") <(printf '%s\n' "$master_files"))" || no "commが失敗"
        [ -z "$overlap" ] || no "変更ファイルが交わる: $(echo $overlap)"
        echo "merge-in-only: ok"
      )
      ```

      出力がちょうど`merge-in-only: ok`の1行のときだけ成立で、空の出力、ほかの出力、commandの失敗は全て不成立である（fail-closed）。
      各commandのexitを確かめ、`LC_ALL=C`でlocaleに依らず並びを固定している。(b)は`git merge-tree --write-tree`がexit 0で、出力のtreeが取込みのmerge commitのtreeと一致することを見る。
      `git diff-tree --cc`や`git show --cc`は、片方の親を採る解決を出さないので手編集の判定に使わない。(c)の`--no-renames`はrenameの両方の名前を数える。
      `candidate_head`では、completeなQuick receiptに加えて、ローカルのNode 22で`pnpm -s verify:quality`が成功している必要がある
      （Quickは`verify:quality`を含まず、PRの変更と取り込んだ変更が別ファイルの間で噛み合うdigestやcatalogの崩れを拾えないため）。
      `candidate_head`の`ci.yml`は、上の「例外1の候補head」で扱う。
    - 例外2（docs-only PR）: docs配下のMarkdownだけを変え、運用の規則の文書と、docsの外のコードや試験がpathを名指しで読む文書は変えないPRである。
      差分は`git -c core.quotePath=false diff --name-only --no-renames origin/master...HEAD`で見る。空ならdocs-onlyではない。
      `--no-renames`でrenameは両方の名前を数える。差分の全パスが、次の3つを全て満たす。
      1. `^docs/.+\.md$`に一致する。
      2. 運用の規則の文書である次の8ファイルに当たらない: `docs/local-ci-runner.md`、`docs/DEVELOPMENT_SETUP.md`、`docs/communication-style-guide.md`、
         `docs/AI経路検証.md`、`docs/plans/nir1-continuation-2026-10.md`、`docs/plans/nir1-l6-l9-execution-plan.md`、
         `docs/plans/nir1-post-b-execution-plan.md`、`docs/plans/narrative-ir-nir1-implementation-plan.md`
      3. docsの外のファイルに、そのpathと、そのpathの上位directoryのうち3階層以上のもの（`docs/a/b/c.md`なら`docs/a/b`。`docs/plans`のような2階層は調べない）が
         文字列として現れない（リポジトリのrootから、HEADと`origin/master`の両方のtreeを`git grep -qF`で調べる）。
         docsの外のコードや試験がpathを名指しで読む文書、またはdirectoryを名指しして中を読む文書（名指しした文書の隣のREADME.mdなど）は、`ci.yml`の試験が文言やhashで束縛するため除く。
         例は、`release-workflows.test.mjs`が読み、`ci.yml`のrelease試験でしか走らない`docs/user-guide/ja/Install-and-update.md`である。
         部品から組み立てるpath、2階層のdirectoryの一括読込みは文字列として現れず、この確認では拾えない。その取りこぼしはmerge後のmasterのpushの`ci.yml`で見つかる（§8の冒頭）。

      ```bash
      (
        set -o pipefail
        export LC_ALL=C
        no() { echo "docs-only: no: $1"; exit 1; }
        cd "$(git rev-parse --show-toplevel)" || no "リポジトリのrootへ移れない"
        git fetch origin master || no "fetchが失敗"
        excluded=(
          docs/local-ci-runner.md
          docs/DEVELOPMENT_SETUP.md
          docs/communication-style-guide.md
          docs/AI経路検証.md
          docs/plans/nir1-continuation-2026-10.md
          docs/plans/nir1-l6-l9-execution-plan.md
          docs/plans/nir1-post-b-execution-plan.md
          docs/plans/narrative-ir-nir1-implementation-plan.md
        )
        changed="$(git -c core.quotePath=false diff --name-only --no-renames origin/master...HEAD)" || no "diffが失敗"
        [ -n "$changed" ] || no "差分が空"
        while IFS= read -r p; do
          [[ "$p" =~ ^docs/.+\.md$ ]] || no "docs/配下の.md以外: $p"
          for e in "${excluded[@]}"; do [ "$p" != "$e" ] || no "運用の規則の文書: $p"; done
          d="$p"
          while :; do
            git -c core.quotePath=false grep -qF -e "$d" HEAD origin/master -- ':!docs/'
            [ $? -eq 1 ] || no "docsの外が名指しする、または確かめられない: $d"
            d="${d%/*}"
            [[ "$d" == */*/* ]] || break
          done
        done <<< "$changed"
        echo "docs-only: ok"
      )
      ```

      出力がちょうど`docs-only: ok`の1行のときだけ成立で、空の出力、ほかの出力、commandの失敗は全て不成立である（fail-closed）。
      release PRの判定（§1.9。`package.json`の`version`）に当たるPRは、docs-onlyにならない。名前が似ているが、release pathの
      editorial docs/ADR-only exception（§2.8）とは別で、混ぜない。
      条件は、completeなQuick receipt、ローカルのNode 22での`pnpm -s verify:quality`の成功、review gateである。
      `candidate_head`の`ci.yml`は、上の「例外2の候補head」で扱う。
      mergeの後にmasterのFullをdispatchしない（§8の冒頭）。かわりに、そのmerge commitのmasterのpushの`ci.yml`のrun idを完了報告に書いて見届けを引き継ぎ、
      success以外で終われば§8.5の赤として扱う。

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

required check が設定されていない場合も、同じ head の通常 PR checks（`ci.yml`）の成功（pending や failure がない）と、
手順2のcompleteなQuick receiptが有効であることを確認してから次へ進む。release PR では、これに加えて
手順2のcompleteなhosted Full receipt（同じtupleの`full-aggregate`成功）が有効であることを確認する。
`no checks reported`だけを根拠にマージしない。

例外1・例外2（§2.10）では、候補 head の `ci.yml` の扱いは §2.10 に従う（pending の `ci.yml` は待たない。success でない結論の扱いは、例外ごとに §2.10 が決める）。
required checks、手順2のQuick receipt、review の確認は同じである。本節5の「マージしない」は、§2.10 が merge を認める場合に限って、その確認で解消する。

## 6. Merge 直前に再検証する

次を一つの snapshot として取り直す。

- 最初に `git fetch origin master` を実行する。release path ではその後でbaseを比較・分類する。
- PR が open かつ ready
- base が意図した `master`
- head branch が意図した branch
- head SHA が push 前に記録してレビューした local SHA と一致
- mergeable で競合がない
- 設定されている全required checksがsuccess
- 同じ head の通常 PR checks（`ci.yml`）が成功している
- pending／failed checks がない
- requested changes と未解決 review thread がない
- master の Full が赤でない（判定は §8.5。run の結論ではなく attempt の結論で見るので、全 job を再実行している間も、直前の attempt が赤なら赤のままである）。
  赤ならその修正または revert 以外の PR を merge しない（§8.6）。

通常path（通常のPR）では、さらに次を確認する。

- 手順2で固定した`candidate_base`／`candidate_head`のcompleteなQuick receiptがある。ローカルのQuickは、直後の
  `pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"`が成功している。hosted Quickは
  dispatchしたrunの`headSha`が`candidate_head`と一致し、`quick-aggregate`のverifyまで（part jobもすべて）成功している。
- そのreceiptの`candidate_base`が`candidate_head`と`origin/master`の両方の祖先である。上の`git fetch origin master`の後に
  `git merge-base --is-ancestor "$candidate_base" "$candidate_head"`と`git merge-base --is-ancestor "$candidate_base" origin/master`の両方が成功する
  （`candidate_base`は、そのQuickの直前に`git fetch origin master`で取った`origin/master`のはずで、その後に`origin/master`が進んでいても祖先のままである。鮮度は問わない）。
  hostedのQuickは前者をjob内で確認するが、ローカルのQuickはどちらも確認しない。branch上のcommitのようにmasterにないcommitを`candidate_base`にしたQuickは、
  `candidate_head`の祖先であってもPRの差分の一部しか対象に選ばないので、後者で拒否する。
  どちらかが成功しないQuick receipt（PR作成だけがゴールのときに祖先確認なしで取ったQuickなど）は、候補が変わっていなくてもmerge証跡にしない。
  branchを同期（§2.3）して、§2.3の祖先確認からQuickを取り直す。
- current fetched baseが`candidate_base`と一致することは要求せず、`approved_merge_base`も使わない。
  Quickの後に`origin/master`が進んでいても、mergeableで衝突がなくPR HEADが`candidate_head`のままなら、rebaseとQuickのやり直しは不要。
  衝突がある、または候補を変える必要があるときだけ、branchを同期（§2.3）して§2.3の祖先確認からやり直す。
- 例外1または例外2（§2.10）を使う場合は、上の共通部の「同じ head の通常 PR checks（`ci.yml`）が成功している」と「pending／failed checks がない」のうち
  `ci.yml` に関する部分だけを、次で置き換える。required checks、master の赤の確認、requested changes と未解決 review thread の確認は置き換えない
  （required checks が設定されていて success でなければ GitHub が merge を拒否する。例外でも回避しない）。
  - 例外1: §2.10 の (a)〜(c) が `candidate_head` で全て成り立ち（`merge-in-only: ok`）、`ci_head` の `ci.yml` が成功している。`candidate_head` の Quick と、
    Node 22 のローカルの `pnpm -s verify:quality` が成功している。`candidate_head` の `ci.yml` は §2.10 の「例外1の候補head」で扱う。
  - 例外2: §2.10 の docs-only の判定が `candidate_head` で成り立つ（`docs-only: ok`）。`candidate_head` の Quick と、Node 22 のローカルの `pnpm -s verify:quality` が成功している。
    `candidate_head` の `ci.yml` は §2.10 の「例外2の候補head」で扱う。

release path（release PR）では、上の通常path固有の確認の代わりに次を確認する。

- 初回Fullで固定した`candidate_base`／`candidate_head`は再解決・再代入せず、exactly oneの`approved_merge_base` commitを記録する。例外なしの場合はcurrent fetched baseが`candidate_base`と
  一致することを確認して`approved_merge_base`に採用し、exception pathでは狭いdocs/ADR-only exceptionを承認した後だけcurrent baseを
  `approved_merge_base`に採用する。
- 例外なしの場合は、current fetched baseが`candidate_base`と一致し、candidate head SHAがPR HEADと一致し、初回Fullと同じpinでdispatchした
  hosted Full runの`full-aggregate` jobで`pnpm ci:local:verify -- full --base "$candidate_base" --head "$candidate_head"`が成功している。
- upstream baseがreceipt後に動いたexception pathでは、candidate HEAD／PR diff不変・editorial docs/ADR-only・executable／build／
  dependency／CI／policy／schema／manifest／generated-contractとratified decision／acceptance meaningに変更なしを記録し、旧receiptを
  同じ元の`candidate_base`／`candidate_head`に対して再verifyする。旧receiptを新baseに対する証跡とは扱わず、newer upstream deltaは別に分類する。
  曖昧さまたはcandidate変更ならreceiptを無効化してFull-from-stage-1 + verifyをやり直す。

一つでも満たさなければマージせず、状態を解消してから再検証する。

## 7. Merge と反映確認を行う

1. マージまでがゴールなら、既定で squash merge する。明示されたnon-squash方式は、before mergeにmethod-specific
   actual-base/post-merge verification procedureがdefined and approvedであることを確認する。未定義・未承認ならstopし、
   squash用first-parent ruleを流用しない。このスキルは一般のnon-squash verification logicを追加しない。
2. 可能なら expected head SHA を指定できる GitHub mutation を使う。`gh` では `gh pr merge --squash --match-head-commit "$candidate_head"` のように
   `--match-head-commit <sha>` を使う。通常pathもrelease pathも同じである。
3. merge 成功後、PR が `merged` になったことと merge commit SHA を取得する。
4. `git fetch origin master` を実行し、merge commit が `origin/master` に含まれることを確認する。
5. 通常pathでは、squash merge commitのfirst parent（`<merge-sha>^1`）が`candidate_base`と違っても失敗にしない。報告に記録してよい。
   release pathのsquash mergeの場合だけ、実際のsquash merge commitのfirst parent（`<merge-sha>^1`）を`approved_merge_base`と一度だけ比較する。
   parent mismatchならdo not report verified successとし、newly added base deltaを分類して必要なexception/revalidation pathを実施する。
   merge may have occurredだが、acceptance evidence is not valid until resolved。expected headの一致とmerge commitの`origin/master`への
   包含を確認できない場合も成功扱いにしない。non-squash方式ではdo not reuse the squash first-parent rule（squash用first-parent
   ruleを流用しない）。1で承認した方式固有手順以外の一般的なnon-squash verification logicは追加しない。routineなremote merge tree比較は行わない。
6. remote branch を削除した場合も、local branch や worktree を破壊的に削除しない。
7. `master` が別 worktree で checkout 済みなら無理に switch せず、`origin/master` で反映を検証する。

## 8. merge 後に master の Full を走らせ、赤は優先して直す

通常のPRをmergeした場合に実行する（マージまでがゴールの通常のPRでは依頼範囲に含まれる）。canonical Fullは通常のPRのmerge条件ではなく、
merge後に運用で補う証跡である。release PRはmerge前にcompleteなhosted Fullを通しているため、master のFullを重ねてdispatchしなくてよい
（release tag用のFullは、`/bump-version` がmerge後のrelease commit自身に対して要求する）。
docs-only PR（§2.10の例外2）をmergeした場合は、masterへのpushで`ci.yml`が走るため、本節1〜4のmasterのFullをdispatchしない。
かわりに、そのmerge commitのmasterのpushで走った`ci.yml`のrunを、`gh run list --workflow ci.yml --event push --branch master --commit <merge-sha> --json databaseId,status,conclusion,attempt`で特定し、
run idを完了報告に書く。見届けは、終わるまで待てる担当ならこの担当、待てない担当（短命のsubagentなど）なら呼び出し元（integratorまたは依頼したユーザー）に引き継ぐ。
そのrunがsuccess以外（failure、cancelled、timed outなど）で終わったら、masterの赤として本節5〜6に従う。
その赤は、そのrunの再実行の成功、より新しいmasterのpushの`ci.yml`の成功、または原因の修正かrevertが`origin/master`に入ったときに解ける。
無関係なflakeの例外とその記録の要件は、本節5と同じである。
本節5〜6の赤の判定と対応は、docs-only PRの後も他のPRのmergeに今のまま適用する。

1. §7の反映確認の後、`git fetch origin master` を実行する。dispatch の `candidate_base` 入力（下の `master_base`）には、直前にcompleteなFull
   （全part jobと`full-aggregate`が成功）を通した master の commit を使う。`gh run list --workflow canonical-ci.yml --branch master --status success` のrunを新しい順に見て、
   `gh run view <run-id> --json jobs` のjob名が`full-<part>`と`full-aggregate`のrunを探し、そのrunの`headSha`を使う。分からなければ
   merge commit のfirst parent（`<merge-sha>^1`）を使う。
2. master のcanonical Fullの状況をread-onlyで確認する。`gh run list --workflow canonical-ci.yml --branch master --event workflow_dispatch --limit 20 --json databaseId,attempt,headSha,status,conclusion,createdAt`のrunのうち、
   `gh run view <run-id> --json jobs` のjob名が`full-<part>`のものがFullである。queuedのrunはjobsがまだ無く、job名ではFullと判別できないことがある。
   Fullでないと確かめられないrunは、Fullとして扱う。`status`と`conclusion`は最後のattempt（`attempt`）のものである。
   - `headSha`が最新の`origin/master`と一致するFullが実行中・queued（全jobの再実行中を含む）・成功のいずれかなら、最新のmaster HEADはすでに覆われているのでdispatchしない
     （本節4のとおり`Validate canonical selection`で止まったrunは、Fullとして走っていないので覆っていない）。
     失敗・cancelled・timed outで終わったrunは覆っていないので、§8.5の判定と§8.6の対応に従う。
   - 別のheadのFullが実行中・queuedなら、今回はdispatchしない。終わった後に最新の master HEAD で1本だけdispatchする（複数のmergeを1本のFullに合流させる）。
     その1本を出すのは、終わるまで待てる担当ならこの担当、待てない担当（短命のsubagentなど）なら呼び出し元（integratorまたは依頼したユーザー）である。
     待てない場合は、完了報告に「masterのFullが実行中のため未dispatch。終了後に最新のmaster HEADで1本のdispatchが必要」と書いて引き継ぎ、dispatch済みとは報告しない。
     引き継ぎの前に次のmergeがあれば、その担当が本節の手順で最新のmaster HEADに対する1本をdispatchする。
     引き継いだ呼び出し元も、dispatchの前にこの項で最新のmaster HEADが覆われているかを確かめる。
3. 実行中のFullがなく、最新のmaster HEADも覆われていなければ、§2.2のresource-isolation preflightを記録した後、次の固定値でhosted Fullをdispatchする。

   ```bash
   master_base="$(git rev-parse '<1で決めたcommit>^{commit}')"
   master_head="$(git rev-parse 'origin/master^{commit}')"
   gh workflow run canonical-ci.yml --ref master -f profile=full -f candidate_base="$master_base" -f candidate_head="$master_head"
   ```

   dispatchしたrunが一覧に現れたら、`gh run list --workflow canonical-ci.yml --branch master --event workflow_dispatch --limit 5 --json databaseId,headSha,status,createdAt`で
   今回のrunを特定してrun idを記録し、その`headSha`が`master_head`と一致することを確認する。dispatch時点のmasterの先頭が`master_head`と違うrunは、
   `Validate canonical selection`（`candidate_head`と`GITHUB_SHA`の一致確認）で全part jobが失敗する。このrunは検証で止まっただけで、masterのFullの結果に
   数えない（緑でも赤でもない）。全jobを再実行しても同じ入力で同じく失敗するので再実行せず、`git fetch origin master`で`master_head`を取り直して
   dispatchし直す。次のmergeをこのFullの完了まで待たせない。
   dispatchしたrunの完了を見届け、赤なら本節6を始めるのは、終わるまで待てる担当ならこの担当、待てない担当（短命のsubagentなど）なら呼び出し元（integratorまたは依頼したユーザー）である。
   待てない場合は、記録したrun idを完了報告に書いて引き継ぐ。

4. 全part jobと`full-aggregate`が成功したrunだけをcompleteなFull receiptとする。失敗したrunは失敗jobだけでなく全jobを再実行する。
   ただし、失敗が`Validate canonical selection`のstepだけのrun（本節3）は、masterのFullの失敗に数えず再実行もしない（`gh run view <run-id> --json jobs`で失敗したstepを確かめる）。
   ローカルのFullは証跡にならない。
5. master のFullが赤かどうかは、runの結論ではなくattemptの結論で判定する。全jobを再実行するとrunの`attempt`が増え、再実行が終わるまで一覧の`conclusion`は空になる。
   再実行中のrunを「完了していない」として飛ばすと、赤のrunを見落としてmergeが通ってしまう。
   - §8.2の一覧のFull（本節4のとおり、`Validate canonical selection`のstepだけで失敗したrunは除く）を`createdAt`の新しい順に見て、
     結論の出たattemptを持つ最初のrunの、最後に結論が出たattemptの結論で判定する。
   - `status`が完了のrunは、一覧の`conclusion`が最後のattemptの結論である。`attempt`が2以上で`status`が実行中・queuedのrun（全jobを再実行中）は、
     一覧の`conclusion`が空なので、直前のattemptの結論を`gh run view <run-id> --attempt <直前のattempt番号> --json attempt,status,conclusion`
     （`gh api repos/{owner}/{repo}/actions/runs/<run-id>/attempts/<直前のattempt番号>`でもよい）で確かめて判定する。
     `attempt`が1で実行中・queuedのrunは、結論の出たattemptがないので飛ばして、次に新しいrunを見る。
   - 判定がsuccess以外（失敗・cancelled・timed outなど）なら赤である。全jobを再実行している間も赤のままで、再実行中であることを赤でない根拠にしない。
   - 赤が解けるのは、次のどちらかのときだけである。上の判定がcompleteな成功（全part jobと`full-aggregate`が成功）に変わったとき
     （そのrunの再実行の成功も、より新しいmasterのFullの成功も含む）。または、原因の修正かrevertが`origin/master`に入ったとき。
   - 例外は、無関係なflakeと確かめ、そのrun idと根拠を、mergeする担当が確認できる場所に記録した赤である。全jobを再実行している間は、他のPRのmergeを止めない。
     記録を確認できない赤は、flakeとして扱わない。再実行が失敗で終わったら例外は終わり、通常の赤として扱う。
6. master のFullが赤になったら、他の作業より優先して対応する。次のmergeの前に、全jobの再実行で再現するか、どのmergeが持ち込んだかを切り分け、
   修正またはrevertを他のPRより先にmergeする。その修正またはrevertのmergeが済むまで、それ以外のPRはmergeしない（§6）。
   無関係なflakeと確かめたものは、記録して全jobを再実行する（本節5の例外）。
   赤を見つけた担当が、その修正またはrevertを担当する指示を受けていない場合（merge権限しか持たない担当など）は、mergeを止めて呼び出し元へ報告する。
   他のレーンのPRをrevertするかどうかは、呼び出し元が判断する。

## 停止条件

- PR だけがゴール: PR URL と現在の checks 状態を報告して停止する。
- draft PR: ready 化または merge を依頼されるまで停止する。
- local CI／CI failure: failしたstageまたはcheckと原因調査結果を報告し、修正後に本フローを再開する。ただし例外1・例外2の候補 head の `ci.yml` は §2.10 に従う。
- release workflow failure: `/debug-release-ci`のfocused gateへ戻す。本スキルはversion、release notes、tagを作らない。
- conflict／requested changes／未解決 thread: 解消するまで停止する。
- master の Full が未解決の赤（判定は§8.5）: その修正またはrevertだけを先にmergeし、それ以外のPRはmergeせず停止する（§8.6）。docs-only PR の merge 後の `ci.yml` の赤も同じである（§8.5）。

## 完了報告

PR URL、Quick／Full receiptの結果（通常のPRはQuickと同じheadのPR checks、release PRはFull）、hosted checks／review、merge method、`origin/master`への包含確認、
master Fullの扱い（dispatchしたrunのidとその見届け先、実行中のため未dispatchとその引き継ぎ先、判定済みの赤とその対応）、local branchの状態を簡潔に報告する。SHAは不一致があった場合またはユーザーが求めた場合だけ recite する。
§2.10の例外1・例外2を使った場合は、どちらを使ったか、判定の結果、ローカルの`pnpm -s verify:quality`の結果、候補 head の `ci.yml` の状態（完了を待たずにmergeしたか）も報告する。
例外2では、docsの変更と関係ないと確かめた失敗があればその材料と、merge commitのmasterのpushの`ci.yml`のrun idと見届け先（§8の冒頭）も報告する。
