# ユーザーの確認の記録：案 1 の契約案の前に、先に診断 run で原因を決める（2026-11-02）

この file は、ユーザーが AskUserQuestion の回答として行った**確認**を原文のまま残す。`user-confirmation-2026-11-02-lapse-plan1-identity-narrowing.md`（`814f5dc8`。「案1で進めてください」）の後に、案 1 の調査の結果が出て、前提が変わったために改めて尋ねた回答。

## 提示した事実（回答の直前）

- 案 1 の調査（read-only。コードと受領書で確認。調査の記録は scratchpad の `lapse-lane/survey/`）：
  1. 案 1 が効くのは最大 7 件（登録の拒否 3、query の時点の stale 4）。child の合流の無効化 4 件は `ReadIdentity` と無関係。案 1 が完全に効いても 4/201＝2.0% が残り、HOLD は解けない。
  2. 前提（登録の拒否と stale の原因は identity の drift）は、owner の counter（`prepareFailures`＝3、`driftAtQuery`＝4。ほかの query では増分ゼロ）で裏づけられた。どの commit が drift を起こしたかは特定できない。7 件は通知の約 406〜411 ms 後の通常の時刻に始まる。
  3. 案 1 は、今は大きな失敗（loud）で止まる場面を「黙った欠落」に変える危険がある（別 process の生 SQL、B 自身の派生 table の seal 外の変更、feed を通らない writer、未処理 feed の溢れによる「available なのに空」の誤った空結果）。契約案で塞ぐ必要がある。
  4. 登録の判定だけを絞っても失効が query に移るだけ（保存した identity が query の基準）。同じ worker の中の検証のやり直しは、メモリの一方向の封印（scratch seal）のため難しい。
  5. LP-A1 で救われる 8 件は通知の約 4 ms 後に始まる（ほかは約 407 ms 後）。その時間帯の drift の率は未測定。
- 質問と選択肢：「次の進め方」。「先に診断 run で原因を決める (推奨)」「案 1 の契約案を起案する」「LP-A1 の効果を先に測る」。

## 確認した内容

- 日時：2026-11-02（JST）。経路：Claude Code のセッションの AskUserQuestion（1 問、選択肢 3 つ）。
- **回答（原文）：「先に診断 run で原因を決める (推奨)」**。

## 確認の範囲（integrator の読み）

1. 診断 run（dev 専用の merge しない枝 `claude/cp4-lp-diag`。LP-A1 取り込み済み。DR-CP4-LPD-1）を走らせてから、案 1 の要否と、もっと小さな直し（上流の background の commit を query の間だけずらす、など）を決める。案 1 の契約案の起案は、診断の結果の後に再判断する。
2. 前回の確認（`user-confirmation-2026-11-02-lapse-diag-hold-discuss-direction.md`、`8529e5b3`）で見送った診断 run を、この回答で走らせてよいと読む。**ただし走らせる時期は決まっていない**（選択肢の説明は、時期を後で決めることと、マシンを使わない時間帯を前提にしていた）。時期をユーザーに確認するまで、cargo の重い build と Electron の dev run は始めない。
3. 診断 run は正式の測定に数えない。結果は integrator だけが見る。閾値・Gold・失効の読み・窓外率の読みの変更、防御の緩和、契約の改訂は、この回答の範囲に含まれない。
