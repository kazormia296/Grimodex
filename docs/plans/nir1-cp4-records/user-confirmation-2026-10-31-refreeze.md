# ユーザーの確認の記録：S4 の凍結のやり直し（2026-10-31）

この file は、ユーザーが AskUserQuestion の回答として行った**確認**を残す記録。確認の対象は下の 1 件だけ。

## 確認した内容

- 日時：2026-10-31（JST の朝。回答の受信時刻は会話の記録の timestamp）。
- 経路：Claude Code のセッションの AskUserQuestion（選択肢 3 つ）。
- 質問の趣旨（会話の原文の要旨）：⑤ の parity で `G-08/graph-index-unusable` が `index-state-holding` で blocked になった。原因は確定していて、製品の欠陥ではなく harness 側の状態の作り方（setup が cold DB に未処理の Freshness のイベントを 1 件残し、測定の process で製品の Freshness が query の途中で Chronicle を dirty にした。時刻の競合なので取り直しても同じになりやすい。`G-02/base` も 30 件中 3 件が同じ仕組みで汚れていた）。直すには harness に「測定の前に Freshness が追いつくのを read-only で待つ」処理を足す必要があり、観測の前に固定した S4 を、正式な試行（④ SP-P4 の passed と parity-1 の blocked）を見た後に凍結し直すことになる。Graph arm の観測はまだ一度もしておらず、閾値・期待値・seam は変えない。④ と parity-1 の結果は台帳に開示して残す。凍結し直してよいか。
- 選択肢：「凍結し直す（推奨）」「凍結せず parity を取り直す」「blocked のまま進める」。
- **回答：「凍結し直す（推奨）」**。

## 確認の範囲（integrator の読み）

- 確認したのは、**Graph arm の観測の前に見つかった harness の欠陥を直すために S4 を凍結し直すこと**。閾値・期待値・seam・製品の code は変えない。
- 回答の後に、同じ性質の欠陥が追加で見つかった（待ちを入れると `G-02/base` が `blocked:b-sealed-binding` になる：G-02 の完全な setup が、製品が直後に B を無効化する状態だった／gold の `G-08/graph-index-unusable` の V-10 READY の probe が止まる見込み）。integrator は、**これらも同じ凍結のやり直しの中で直す**（凍結のやり直しを 1 回にするため）と読んだ。範囲が広がる点は、ユーザーへの報告で開示する。ユーザーが範囲に異議を述べれば、観測の前に止められる。
- 凍結のやり直しの後に、Graph arm の観測の前に再び欠陥が見つかった場合は、改めて確認を取る。Graph arm の観測の後の harness の変更は、この確認の範囲に含まれない。

## 関連する記録

- 台帳：`attempts/sp-p4-1.json`（④ passed）、`attempts/parity-1.json`（`incomplete-blocked`）。結果：`sp-p4-1/`、`parity-1/`。
- 原因の調査の要旨は会話の記録にある（調査担当の報告。原本は repo に無い）。DR は harness の PR で DR-CP4-T 系列に残す。
