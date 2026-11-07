# 旧 S4b（b7d74950）の失効と、S4b' の運用条件の記録（2026-10-31）

**ユーザーの確認ではない**。integrator（Claude）の運用記録。ユーザーの確認は `user-confirmation-2026-10-31-refreeze.md`（`bd835621`）。

## 1. 失効

- 旧 S4b `b7d7495034ee693e82b9a6e55bbcbfd433215012`（観測前の freeze record の SHA-256 `748032ce…`）は、2026-10-31 に**失効**した。理由は `parity-1` の読取で分かった harness の欠陥（DR-CP4-T-1〜T-5）を直すための、ユーザー確認済みの凍結のやり直し。
- 新しい観測前の commit（S4b'）：`9f52e7da37b84603424d0b7e6ecee8e019d1c7c9`（branch `claude/cp4-s4-refreeze`。freeze record は同じ path `evals/nir1-graph/observation-prep-freeze.v1.json`）。失効の commit は `294ee35f`（旧 record の削除）。
- 旧 S4b の下で行った試行は `attempts/sp-p4-1.json`（④ passed）と `attempts/parity-1.json`（⑤ incomplete-blocked）。どちらも証拠として残し、S4b' の下で取り直す。S4b' の結果の判定に使わない。Graph arm を含む run は、旧 S4b の下では一度も走らせていない。

## 2. 契約が閉じない穴と運用条件

独立 reviewer（S4 再凍結の確認、go-with-conditions、P2-1）と builder が報告したとおり、契約（`admission.mjs`、`contract.mjs`）は失効の一覧を持たず、**旧 S4b と、失効の commit `294ee35f` を含まない旧い候補（例：旧 master `6f5c9c4a`、S5 の旧候補 `5ce12211`）の組は、admission を今も通る**（一時 clone で確かめた）。契約・harness を足せば再び凍結のやり直しになるので、運用で閉じる：

1. 正式の run（④ SP-P4、⑤ parity／Gold／negative、trace）は `--prep-commit 9f52e7da37b84603424d0b7e6ecee8e019d1c7c9` と、`294ee35f` を祖先に持つ候補（merge commit で master に入った後の commit）だけで行う。
2. 旧 S4b `b7d74950` を `s4Commit` に持つ試行・受領書は、S6 の集計と S7 の判定に**入れない**（`selectReceiptsForAggregation` の結線の条件に加える。SP-N12 の条件と同じ場所）。
3. 試行の台帳（`.artifacts/cp4/attempts/`）の key は S4 の commit を含むので、S4b' の下の SP-P4 の試行の上限（2）は数え直しになる。旧 `sp-p4-1` の passed を ⑤ の前提に流用しない。
4. ⑤ の正式の run は `--keep-test-worktree <候補の worktree>` を必須とする（付け忘れると K6/2 の判定になる。凍結のやり直しでも変わらない）。

## 3. 観測の後の欠陥

Graph arm の観測の後に見つかる harness の欠陥は、今回の確認の範囲に含まれない。見つかれば、ユーザーに改めて確認する。
