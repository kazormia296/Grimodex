# ユーザーの回答の記録：9 回目の正式 run の V-10 の判定値と、過去の退避の扱い（2026-11-17 夜）

- 経路：Claude Code の AskUserQuestion（2 回、計 6 問のうち 2 問）。PR #935（chat IR S1-A）の merge（master `01dd6821`）の後に、統合者（grimodex-bb）が伺った。
- 資料：`/home/grimodex/fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/formal-run-prep/run9-prep.md` §3-H、`/home/grimodex/fusion-eval-data/handoff/artifacts-backup-review-2026-11-17.md` §5・§6。
- 9 回目の正式 run の開始（時期と候補）は、この 2 問とは別に伺う（ユーザーの指示）。

## V-10 の予防の確認の判定値

- 事実：s7r2 は「全 variant で `readBack.maintenance.running` が 0、seal の `maintenanceRuns` の合計が 100 未満、`freshnessSettles[].settle` が 5 s 以内（`quiet:false` なら 1 s 以内）」で 13/13 が ok。run9-prep の初版は「`waitedMs` 約 1 s 以内」と書いていて、s7r2 と同じではなかった。
- 回答：**「s7r2 と同じ 5 s／1 s (Recommended)」**。settle は 5 s 以内、notquiet なら 1 s 以内。満たさない variant があれば、測定に入らずに伺う（変更なし）。

## 過去の退避（`~/worktree-artifacts-backup-20261105` 255 GiB、`-20261112` 4 GiB）

- 事実：約 87%（222 GiB）は、run ごとに `user-data/models/` へ複製された埋め込み model（ruri-v3-30m、bge-small-en-v15）。正本は `~/.cache/gdx-nir1/grimodex-product-6x99bC/user-data/models/`。2026-11-12 に「残すか判断してください」と伝えて未決だった。
- 回答：**「model の複製だけ消す (Recommended)」**。記録・DB・build は残す。
- 実行の条件（資料 §5 案 A）：(0) 正本の `models/` を `fusion-eval-data/` の下へ写して `sha256sum` で照合する、(1) 各 dir から抜き取った複製の onnx を再ハッシュして正本と照合する、(2) 消すのは `.../user-data/models` の path だけで、Node の `fs.rmSync` を使う（シェルの `rm` は使わない）、(3) 1 つの dir で試して `du` と run-report が無傷なことを確かめてから全体を消す、(4) 参照している process が無いことを確かめる。結果は記録に残す。
