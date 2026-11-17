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

## 9 回目の正式 run（s9r1）の開始（上の 2 問とは別に伺った）

- 事実：候補は master の先頭 `01dd6821`（#932 GDV/1、#933 envelope、#935 S1-A〔gate は閉じたまま〕を含む）。この候補で、凍結の照合（74 path・閉包 44・3 dir・freeze の 10 file）と admission・`assertObservationPrepFormal` を取り直し、すべて通った（`fusion-eval-data/.../run9-prep.md` の末尾の追記）。run の前の残り：K6/7 用の集計 script の改作、`v10-check.mjs` の再構成、`remote-time-record.json`、手順の再構成。窓の約 3 時間はほかの作業を止める案で、これは `ee391d50` の例外になる。
- 回答：**「準備だけして、開始は再度伺う」**（推奨は「整い次第すぐ」だった）。残りの準備を済ませ、整ったところで開始の時期をもう一度伺う。窓の間にほかの作業を止めるかどうか（`ee391d50` の例外）も、そのときに伺う。

## 開始（準備が整った後に、もう一度伺った）

- 事実：準備は `fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/formal-run-prep/run9/`（V-10 の判定 script は s7r2 の実物で 13/13 ok、K6/7 用の集計 script は試験 48 件が通過、手順は偽の runner で最後まで通した）。候補は `01dd6821`。
- 回答 1：**「今から始める (Recommended)」**。窓の間は、ほかの作業（cargo・build・Electron・Xvfb・fetch・vitest）を止める（`ee391d50` の例外として了承）。止まったら取り直さずに伺う。
- 回答 2：**「NG として伺う (Recommended)」**。setup の quiesce が待ち切れた後に harness が開き直して回復した場合、待ち切れた settle（settled:false）の記録が受領書に残る。V-10 の確認ではこれを NG として扱い、測定に入らずに伺う（判定 script の既定。全 entry を見る）。
