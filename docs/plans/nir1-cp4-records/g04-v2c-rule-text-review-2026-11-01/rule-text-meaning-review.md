# G-04 v2 の規則文の改訂は意味を変えていないか（独立期待値レビュアーによる確認）

- 対象：worktree `claude-g04-v2c` の commit `7635e880`（基点は `8187fbfc`）。読んだのは `git diff 8187fbfc 7635e880 -- manifest.v1.json README.md schema.v1.json` と、`git show 7635e880:evals/nir1-graph/freeze.v2.json`（写しは同じ dir の `freeze.v2@7635e880.json`）
- 突き合わせに使ったもの
  - ユーザーの確認 `user-confirmation-2026-11-01-g04-v2c-build.md`（contracts の `a7027915` から取り出し、sha256 `1de09724…` が freeze の記録と一致した）
  - 設計 A（`7635e880` の `docs/plans/nir1-g04-fixture-v2-design-draft.md`）の §3.2、§4.6、§5.3、付録 A
  - B1 の独立コードレビュー（contracts の `f2ebdd98` の README と review-b1.md）。読んだのは結論と該当行だけで、判定は自分で行った
- 開示：設計 A の付録 A の表 A.2 には、Gold の run の IR 採否の回数（graph arm の `followUp.parent.irSceneIds` から数えた値）が載っている。I5 の事実を確かめるためにこの表を読んだ。Graph の DTO、frame、受領書そのものは読んでいない

## 結論：(c) 直す点がある（文だけ）。意味の変更は無く、ユーザーへの追加の確認は要らない

## 1. 意味は変わっていないか → 変わっていない

基点の同じ節と 1 行ずつ比べた。

- **manifest `preconditions.definitions`**
  - 6 つの id と scope、`check` が比べる対象（観測した R と `arms.raw`、IR floor と shared slot、CB-4 の判定）、`source` は、基点と同じ文である
  - 変わったのは 3 か所の列挙だけである
    - `raw-membership.check`：「the two controls of a supplementable case」→「the controls of a supplementable case (two, or the single control of G-04)」。件数の列挙で、比べる対象（`arms.raw.sceneIds` と一致すること）は同じ
    - `ir-supplement-admission.appliesTo`：「G-04 … and G-05」→「G-05」
    - `cb4-inputs.appliesTo`：G-04 base を足した
  - どれも定義節（「a case that declares an ir-only Scene」「Variants that declare an appended Graph-only Scene」）から導ける列挙である
- **変わっていないもの**：`notEvaluated`、`declaration`、`variantScope`、`addedSceneScope`、`closedSet` は diff に出ない
- **`irSupplementedCoverage`**
  - `dependsOn` と `consequence` は同じ
  - `cases` は [G-05] になった
  - `admissionProbe` と `probeOption` は事実の更新である（判定は 3 で述べる）
- **README**
  - 前提条件の表（:87-96）で変わったのは「当てはまる variant」の列と、`raw-membership` の件数（「（G-04 は 1 件）」）だけである
  - :109、:139、:173-174、:188-189、:216 も列挙を繰り返すだけである
  - :105「前提条件は、観測の後に足さず、外さず、読み替えない」は基点と同じ文である
  - :107 には参照の 1 文が足されただけである
- **G-04 v2 が `ir-supplement-admission` を宣言しなくなったこと**：基点の時点ですでにあった道（`holdVersusBlocked`「a blocked variant can only be measured by a new fixture version after a new independent expectation review」、README:107）に従った新しい版の結果である。宣言は validator が fixture の構造から導く（contract.mjs:1633-1655）。同じ版の中で前提条件を外したのではないので、`closedSet` に反しない

## 2. 列挙ではない 2 つの文 → 弱めていない。ユーザーの確認の内側に収まり、追加の確認は要らない

- **2 つの文の中身**
  - manifest の `holdVersusBlocked` は、承認した 2 文を先頭にそのまま残した。足したのは「A fixture version made after a runtime observation is treated as frozen only with the user's confirmation, its postObservationRevisions entry … and a new independent expectation review; the earlier version and its result are kept.」の 1 文である（freeze.v2 の `appendOnly` も承認した長さ 331 を束縛している）
  - README:274-276 は 3 つの書き換えである
    - :274 は「観測の前に限り」→「観測の前は」
    - :275 は観測の後の版を固定済みとして扱う条件を足した
    - :276 は「この版」→「その版の bytes」
- **`closedSet` と README:105 との関係**：前提条件には触れていない。基点で前提条件のない道（新しい版と新しいレビュー）だったところに、ユーザーの確認と `postObservationRevisions` の記録という要件を足している。その道に限っては、手続きを**厳しくしている**
- **基点の README:265-266 との関係**：基点の文は観測の後の固定し直しを閉じていた。新しい文はそれを条件つきで開くので、こちらに対しては緩和である
- **緩和でも追加の確認が要らない理由**
  1. ユーザーは質問 2 で「README:265-266、`graphRuntimeObservedBeforeFreeze`」を名指しして確認した（確認の記録:13）
  2. 提示した設計 C §9 U1 は、設計 A §5.3 をこの確認に含めると書いていた。§5.3 は「v2 はこの規則自体を観測の後に改訂する」と書き、文案もほぼ同じものを示していた。manifest の補足（:191）と合わせることも書いていた
  3. 新しい規則は、観測の後の版ごとにユーザーの確認を要件にしている。このため、この規則を使ってユーザーを経ずに版を作ることはできない
- **それでも確認の記録に残すべき事実**：質問 2 の括弧には「当てはまる case の列挙だけ直す」と書いてあったが、README:265-266 の改訂は列挙ではない。観測の後の固定し直しを、条件つきで許す規則の改訂である。integrator の DR か作業記録にこの区別を明記することを勧める（ユーザーの再確認までは要らない）

## 3. I5：`admissionProbe`／`irSupplementAdmissionProbe` を `run` にした読み方 → このままでは不正確（直す点）

- **G-04 v2 について**：ir-only が無いので、IR の admission の probe は要らない。凍結の前に当てたのは Raw の予測の再 probe 1 回である（`irSupplementAdmissionProbe.reason` の (1)）。これは IR の admission の probe ではない
- **G-05（IR補完済みの区分の唯一の case）について**
  - G-05 の bytes は v1 の freeze が固定したもので、その前に probe はしていない（`probeOption`「It was not run for the version-1 freeze」）
  - 0.7531 は設計 A 付録 A の校正 probe の値である。この probe は G-05 の runtime の観測（付録 A の表 A.2、§4.6）の**後**に、予測が当たるかを確かめるために当てたもので、測定にも admission の事前確認にも数えない
- **今の文の問題**
  - `probeOption` と README:188 は「Before the version-2 freeze a model-only probe was run … and earlier a calibration probe that also scored the G-05 ir-only IR」と書く。freeze の reason も「校正 probe（測定に数えない）」と書く
  - どちらも、その probe が観測の後に当てたものであること、G-05 の凍結より後であることを書いていない
  - このため、`irSupplementedCoverage.admissionProbe: "run"` は「IR補完済みの区分の admission を凍結の前に probe した」と読める
- **直し方（I5）**：区分の field としては `not-run` のままにするのが事実に近い。`run` を残すなら、少なくとも次の文を `probeOption`、README:188、freeze の reason に足す
  > 「The IR-supplemented class (G-05) had no admission probe before the freeze that fixed its bytes (version 1). Its ir-only IR (g05-xan-watch, 0.7531) was scored only by a calibration probe run after G-05 had been observed (design A appendix A); it counts neither as a measurement nor as a pre-freeze admission check. The probe run before the version-2 freeze checked only the Raw prediction of G-04 version 2, which has no ir-only Scene.」
  - README の和文の案：「IR補完済みの区分（G-05）は、その bytes を固定した v1 の freeze の前に admission の probe をしていない。0.7531 は観測の後に当てた校正 probe（設計 A 付録 A）の値で、測定にも凍結前の確認にも数えない。v2 の freeze の前の probe は G-04 v2 の Raw の予測だけ（v2 に ir-only は無い）。」

## 4. (iii)：「その版の bytes」の誤読を消す文（提案。直すのは実装担当）

- **今の文（README:276）**：「凍結の前に Graph runtime がその版の bytes を観測した場合は、その版を固定済みとして扱わない。」
- **誤読の中身**：「凍結」がどの freeze を指すかが書かれていない。G-02 などの v1 の bytes は v2 の freeze の前に観測されている。そのため、次の 2 つのどちらにも読める
  - v2 の freeze の時点では固定済みでない
  - v2 の freeze で新たに固定された
- **:276 を置き換える案**
  > 「fixture の各版は、その版の bytes を最初に束縛した freeze で固定される。その freeze より前に Graph runtime がその版の bytes を観測した場合は、その版を固定済みとして扱わない。G-04 以外の case は `freeze.v1.json` が観測の前に固定した版で、`freeze.v2.json` は同じ sha256 を引き継いで束縛するだけである（v2 の freeze が新たに固定したのではない。固定の後の観測は固定を取り消さない）。G-04 v2 は `freeze.v2.json` が最初に束縛した版で、その前に Graph runtime を通していない。」
- **:274 の案**：「観測の前は」だけだと、観測の後に同じ版の file をそのまま変えてよいかが書かれていない。誤読を消すために、規則を明示して厳しくする
  > 「変える必要があれば、観測の前は独立期待値レビューと freeze をやり直す。観測の後は、束縛した fixture を同じ版のまま変えず、次の行の手続きで新しい版を作る。manifest・README・schema は、その freeze が `changesAfterApproval` で宣言した範囲だけを変える。」
- **冒頭の状態の文の案**：「G-04 以外の fixture は v1 の freeze と同じ bytes である」を、「G-04 以外の fixture は、v1 の freeze が観測の前に固定した bytes のままで、v2 の freeze はその sha256 を引き継ぐ」に改める

## 5. 旧 `pendingReview` の位置（`ruleTextReview`）について

- `pendingReview` は `ruleTextReview`（freeze.v2:717）に置き換わり、validator はこの key を読まない（`git grep` で確かめた）。記録だけの欄で、機械の門ではない
- **(i)**：B1 のコードレビューは contracts の `f2ebdd98` に入っている。`record.contractsCommit: null` はこの値で埋められる
- **(ii)**：確認の範囲の 3 は、「独立期待値レビューで確かめる」ことを求めている。この review は独立期待値レビュアーによる意味の確認なので、それに当たる。`ruleTextReview` か DR に、この review の記録（path と sha256）を足すことを勧める

## 6. 読んではいけないもの

- contracts の gold／traces／parity／negatives／sp-p4／s6／s7／lapse、`.artifacts/cp4`、Graph の DTO・frame・受領書は開いていない
- 例外として上の開示のとおり、設計 A 付録 A の IR 採否の回数（受領書から集計された値）を読んだ
- repo には何も書いていない
