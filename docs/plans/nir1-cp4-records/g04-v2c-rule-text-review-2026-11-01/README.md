# G-04 fixture v2（案 C）の規則文の意味の独立期待値レビュー（2026-11-01）

**ユーザーの確認ではない**。独立期待値レビュアー（別の agent、Opus、read-only。fixture v2 の期待値レビューと同じ担当）による、規則文の改訂の意味の判定。ユーザーへの約束「規則文の改訂は列挙の更新として進め、独立期待値レビューでも『意味が変わっていないか』を確かめる」（`user-confirmation-2026-11-01-g04-v2c-build.md`、`a7027915`）に対応する。対象は worktree `claude-g04-v2c` の `7635e880`（基点 `8187fbfc`）の manifest・README・schema・freeze.v2.json。

- **(c) 文だけ直す点がある。規則文の意味は変わっておらず、ユーザーへの追加の確認は要らない**（reviewer の判断。integrator も同意）。
- 意味の変更なし：manifest の前提条件 6 種の id・scope・check が比べる対象・source は同じ。`notEvaluated`・`variantScope`・`addedSceneScope`・`closedSet` は diff に出ない。変わったのは当てはまる case の列挙 3 か所だけで、どれも変わっていない定義節から導ける。README:105「前提条件は、観測の後に足さず、外さず、読み替えない」は同じ文のまま。
- 列挙ではない 2 つの文（`holdVersusBlocked` の追加文、README:274-276）：基点の README:265-266 が閉じていた観測後の固定し直しを、**条件つきで開く**緩和。ただしユーザーの質問 2 が README:265-266 を名指しして確認していること、設計 A §5.3 に同じ趣旨の文案があること、新しい規則が観測後の版ごとに**ユーザーの確認を要件にする**こと、から追加の確認は要らないと判断。質問 2 の括弧は「列挙だけ」と書いていたので、**DR に「README:265-266 の改訂は列挙ではなく規則の改訂」と明記する**ことを reviewer が勧めた。
- 直す点：(1) `admissionProbe`／`irSupplementAdmissionProbe` を `run` にした読みは不正確。G-05 の IR の probe は観測の後の校正で、v1 の freeze の前には probe していない（v2 の freeze の前に当てたのは G-04 v2 の Raw の予測だけ）。`not-run` に戻し、probeOption・README・freeze の reason に事実を足す。(2) README:274-276 の「その版の bytes」の誤読（G-02 などの v1 の bytes が v2 の freeze で固定済みと読める）を、reviewer の提案の文に置き換える。(3) `ruleTextReview` の `contractsCommit` に B1 のコードレビューの commit（`f2ebdd98`）を入れ、この review を独立期待値レビューとして記録に足す。
- 読んではいけないものは開いていない。例外：I5 の事実の確認のために、設計 A 付録 A の表を読んだ（この表には G-05 の IR の採否の回数が載っている。判定には使っていない）。
- `rule-text-meaning-review.md` が本体。
