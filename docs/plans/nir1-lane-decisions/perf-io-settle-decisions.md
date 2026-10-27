# PERF-IO-SETTLE の判断記録（runtime performance gate の I/O の静定）

NIR-1 のレーンではなく、CI の性能 gate（`pnpm electron:perf:ci` →
`electron/scripts/performance-benchmark.mjs`）の頑健化の記録。mutation の前に判断を記録し、
実測の結果を末尾に追記する。閾値（`coldStartMs` ≤ 4000 ms）、gate の判定の規則、
ほかの指標と上限は変えない。

## 背景と根拠の数値

2026-10-23 から hosted runner で `coldStartMs` が頻繁に上限を超える。調査（失敗・成功 run の
artifact と job ログ）の結論は、製品の欠陥ではなく、計測と runner の I/O 圧力が重なること。

- 失敗 run でも workspace の open（22 span）と renderer の bootstrap は成功 run と同じ
  0.23〜0.41 s で終わり、最初の frame（rAF）だけが 4〜15 s 遅れる。GPU process が最初の
  GL context に応答した時刻に解放される。
- 直前の大量の書込み・削除の writeback が計測と重なる。PR CI は `pnpm install` →
  `playwright install-deps` → 116 MB の `tar -xf` の直後、Full の runtime part は
  `native.build` の後に `target/release` を削除し、約 10 s 後に計測する。
- 同じ job の数分後の診断の再実行は io full avg10 が 0.03／0.7 で、frame は boot +3 ms、
  coldStart は 1,851／1,408 ms で通った。

PR CI の open-evidence の行（重複を除いて 100 件）を、起動前の io full avg10 で分けた集計：

| 起動前の io full avg10 | 件数 | frame の遅れ > 100 ms | ready > 4000 ms |
|---|---|---|---|
| 0〜1 | 11 | 0 | 0 |
| 1〜2 | 2 | 0 | 0 |
| 2〜4 | 8 | 0 | 0 |
| 4〜7 | 19 | 11 | 0 |
| 7〜10 | 16 | 14 | 0 |
| 10〜15 | 22 | 16 | 1 |
| 15 以上 | 22 | 20 | 9 |

frame が遅れた 61 件の起動前の値の最小は 4.82、上限を超えた 10 件の最小は 10.27。
起動前の最大は 27.53、計測後の最大は 64.05。

## 判断

| ID | 日付 | 判断 | 信頼境界・不変条件 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-PIS-1 | 2026-10-28 | 計測の起動（各 attempt）の直前に、`sync` で dirty page を書き出し、`/proc/pressure/io` の `full avg10` が **2% 未満**になるまで **1 s ごと**に読む。待ちの上限は **60 s**（`sync` の時間を含む。起点は待ちの開始）。上限に達したら待つのをやめて計測する（`capped`）。定数は `RUNTIME_PERFORMANCE_IO_SETTLE_POLICY`（`Object.freeze`）で、flag と環境変数では変えられない。試験が値を固定する | 2% は、遅れが一度も出ていない区間（0〜4、21 件）の中で、遅れの最小 4.82 の半分未満。診断の再実行の 0.03／0.7 より上なので、静かな runner では届く。60 s は、avg10 が時定数 10 s の指数平均なので、stall が止まってから 64%（観測の最大）→ 2% に約 35 s（10·ln 32）、起動前の最大 27.5% → 2% に約 26 s かかることに `sync` の時間を足した上限。判定は `full`（全 task が I/O で止まった時間）で、`some` ではない。待ちは計測の前の PSI だけで決まり、metrics・budget・retry の結果を読まない。1 attempt の計測は 1 回で、待ちの結果で計測を選ばない（結果を選べない）。上限に達しても FAIL にせず、測って 4000 ms を超えれば従来どおり FAIL | 閾値を上げる（不可）。avg10 の代わりに `total` の差分（瞬間の stall 率）で判定する（遅れが無くなり待ちが短いが、調査の相関は avg10 で取ったので、今回は avg10。evidence に stall の合計を残し、後の調整の材料にする）。上限で FAIL にする（I/O の待ちの失敗で gate を止めない方針に反する） | 記録済み（実装前） |
| DR-PIS-2 | 2026-10-28 | 環境ごとの扱い：Linux かつ `CI` が `true`／`1` かつ io PSI が読めるときだけ `sync` と待ちを行う。それ以外は何もしないで `skipped` を記録する（理由 `platform`／`not-ci`／`pressure-unavailable`）。待ちの途中で PSI が読めなくなったら待ちをやめて `failed`（`pressure-unreadable-during-wait`）を記録し、計測する。手順の例外も `failed`（`settle-error`）を記録して計測する | 開発者の機械（`CI` 未設定）では `sync` も待ちもしない。macOS／Windows、古い kernel、`psi=0`、sandbox（読取の `EOPNOTSUPP` など）は待ちを飛ばす。GitHub Actions は `CI=true` を設定し、local-ci の Full part は supervisor が `process.env` を引き継ぐので両方の経路で有効。runtime の gate 自体が Linux（Xvfb）でだけ走る | 常に有効にして io が低ければ即座に進む（開発者の機械でも `sync` が走り、他の作業の I/O で最大 60 s 待つ） | 記録済み（実装前） |
| DR-PIS-3 | 2026-10-28 | io が低くても先に `sync` する。`sync` は子 process（`spawnSync("sync")`、timeout は上限と同じ 60 s、`SIGKILL`）で、結果（`completed`／`timed-out`／`failed`）と所要を記録する | `tar -xf` の直後は writeback が始まる前（dirty の期限 30 s）で、その瞬間の avg10 が低くても計測中に writeback が来る。`sync` はその書出しを計測の前に済ませる。`sync(2)` が D 状態の間は kill が効かないので、timeout は厳密な上限ではない（その時間は `sync.durationMs` に残る） | `sync` しない（writeback が計測に重なる経路が残る） | 記録済み（実装前） |
| DR-PIS-4 | 2026-10-28 | evidence は metrics の隣の `<metrics の名前>-io-settle.json`（PR CI は `.artifacts/electron-runtime-performance/runtime-metrics-io-settle.json`、Full は `.artifacts/local-ci/runs/<run>/runtime-metrics-io-settle.json`）。attempt ごとに `attempt`、`status`、`reason`、`policy`、`sync`（status、durationMs）、`ioFullAvg10`／`ioSomeAvg10`（start、end）、`ioFullStallMs`（待ちの間の full stall の合計）、`waitedMs`、`pollCount`、`capReached` を書く。`prepareRuntimePerformanceArtifacts` が古いファイルを消す。1 行の log を出し、上限に達したら warning（GitHub Actions では `::warning`） | `runtime-metrics.json`（budget の入力）には足さない。budget と retry の code は evidence を読まない（試験で固定）。書込みの失敗は warning だけで gate を変えない | `runtime-metrics.json` に足す（budget の入力の形が変わる） | 記録済み（実装前） |
| DR-PIS-5 | 2026-10-28 | 補助の再計測（`ready − frame` < 10 ms、workspace の open の trace が正常、計測時の io full が高い、の全部が揃ったら 1 回だけ再計測）は**足さない** | (1) 本命の待ちが原因（計測の前の writeback）を計測から外すので、再計測の条件の「計測時の io が高い」は、待ちが上限に達した場合にしか起きない。(2) open-evidence は「budget、retry、pass/fail に関わらない」設計で、`runtime-performance-retry.mjs` が `openEvidence` を読まないことを既存の試験が固定している。(3) 計測中の io は Electron 自身の起動の読込みでも上がる（成功 run でも 12.8→13.5 など）ので、「io が高い」は製品の起動の I/O の増加（回帰）でも満たされうる。`ready − frame` が小さいのも、最初の frame の前の main thread の処理が重くなる回帰と区別できない。(4) 2 回のうち良い方を採れる形は、再計測の確率の分だけ回帰を通す（結果を選べる） | 条件を全部固定して足す（上の (3)(4) が残る）。待ちが上限に達した（`capReached`）run の FAIL が続くなら、そのときに evidence を見て再検討する | 記録済み（実装前） |
| DR-PIS-6 | 2026-10-28 | `.github/workflows/` と `scripts/local-ci*.mjs` は変えない。両方の経路が同じ `performance-benchmark.mjs` を通るので、待ちは両方で効く：PR CI は `xvfb-run … pnpm electron:perf:ci`（`tar -xf` の直後）、Full の runtime part は `native.build`（support）→ `target/release` の削除（`cleanupNativeCargoTargetAfterTask`）→ `electron.typecheck`／`electron.build` → `runtime.benchmark`（`pnpm electron:perf:ci -- --output …`）。削除の metadata の書出しと build の出力は計測の前の `sync` と待ちが吸収する | 削除の順序（perf の後に削除）や `sync` を local-ci に入れると、receipt と part の契約に関わる runner の code が変わる。待ちは benchmark の中で完結するので不要 | local-ci の削除の後に `sync` を入れる。perf の後に削除する | 記録済み（実装前） |
| DR-PIS-7 | 2026-10-28 | `scripts/local-ci-registry.json` の `runtime.benchmark` の command timeout を 180,000 ms から 300,000 ms にする（180 s ＋ 2 attempt 分の待ちの上限 2 × 60 s）。性能の閾値ではなく、runner が command を打ち切る時間 | Full の runtime part の 1 attempt は 64〜82 s（4 run）、PR CI は 70〜87 s。再計測（gesture の long task。過去 121 job で 0 回）が起きると今でも 2 × 87 ≈ 174 s で 180 s に近く、待ちが 2 回とも上限に達すると約 294 s になる。待ちを足したことで command が timeout で落ちるのを防ぐ。PR CI の job の timeout（30 分）は足りている | 待ちの上限を attempt で共有する（再計測の経路で 234 s になり、やはり超える）。attempt 1 の前だけ待つ（attempt 2 の計測を静定しない） | 記録済み（実装前） |
