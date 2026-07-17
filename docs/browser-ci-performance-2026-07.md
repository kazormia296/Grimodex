# Browser / Storybook CI performance measurement (2026-07)

## 結論

- Browser と Storybook は独立した CI job とし、並行実行する。
- Vitest の worker 数は固定せず、4 vCPU runner 上の自動値を維持する。
- `browser.fileParallelism` は既定の有効状態を維持する。
- Browser の 2 shard 化は採用しない。
- retry は 0 のままとし、失敗を再実行で隠さない。
- 各 CI job は wall time、CPU、process-tree peak RSS、test/file 数、失敗名を JSON artifact として14日保持する。

直接 worker 数を固定する前に、個別suite、job分割、file parallelism、worker数、shardingを順に計測した。採用構成は「2 job分割 + Vitest自動worker」であり、「Playwright並列化を未計測のまま導入」したものではない。

## 計測条件

- GitHub Actions `ubuntu-latest`: 4 available CPUs / 約16 GiB RAM
- Node.js 20.20.2
- pnpm 10.33.0
- Vitest 4.1.9
- Playwright 1.60.0 / Chromium
- Browser: 38 files / 146 tests
- Storybook: 2 files / 8 tests
- retry: 0
- 各候補はfresh runnerで3回。共通候補は独立した2回のmatrixで計6回実行した。
- wall timeはwrapperを含むtest command、CPUはGNU time、RSS/PSSは100 ms間隔のprocess-tree sample。
- PSS取得は比較用matrixだけで有効にした。通常CIでは計測オーバーヘッドを避け、RSSを記録する。

証跡:

- [第1比較matrix（30/30 jobs success）](https://github.com/kazormia296/Grimodex/actions/runs/29595806888)
- [第2比較matrix（36/36 jobs success）](https://github.com/kazormia296/Grimodex/actions/runs/29596606317)
- [split CI 第1回](https://github.com/kazormia296/Grimodex/actions/runs/29595806683)
- [split CI 第2回](https://github.com/kazormia296/Grimodex/actions/runs/29596608665)

## 分割前baseline

直近6回のcombined jobをActions APIから集計した。全6回成功。

| 指標             | 中央値 |     範囲 |
| ---------------- | -----: | -------: |
| Browser step     | 32.5 s |  28-34 s |
| Storybook step   | 11.5 s |   9-12 s |
| combined job全体 | 91.0 s | 79-118 s |

対象run: `29591745011`, `29591056767`, `29589863424`, `29473552659`, `29473062165`, `29472427132`。

## Vitest worker / file parallelism

下表は修正後matrixの3 fresh runs。wall p90は3回中の最大値。PSSは共有ページを按分したprocess-tree合計で、候補間比較にはRSS合計より適する。

| Browser候補           | wall median | wall p90 | CPU median | peak PSS median | failure | 判定                            |
| --------------------- | ----------: | -------: | ---------: | --------------: | ------: | ------------------------------- |
| auto                  |     39.48 s |  39.83 s |    62.94 s |        2.62 GiB |     0/6 | 採用                            |
| fileParallelism=false |     48.18 s |  49.33 s |    61.59 s |        2.16 GiB |     0/3 | 遅いため不採用                  |
| maxWorkers=1          |     47.29 s |  48.14 s |    61.89 s |        2.23 GiB |     0/6 | 遅いため不採用                  |
| maxWorkers=2          |     38.66 s |  39.89 s |    60.98 s |        2.73 GiB |     0/6 | median差2.1%、p90/RAMはauto優位 |
| maxWorkers=3          |     39.77 s |  40.46 s |    63.93 s |        2.76 GiB |     0/6 | autoより優位性なし              |
| maxWorkers=4          |     39.80 s |  40.03 s |    62.95 s |        2.64 GiB |     0/6 | autoより優位性なし              |

第1matrixでもauto 34.23 s、明示3 workers 33.37 sで差は2.5%に留まり、p90とRSSはautoが良かった。runner世代やhost負荷が変わっても追従できる自動値を、1秒未満のmedian差で固定値へ置き換える根拠はない。

Storybookはauto 13.48 s、1 worker 13.51 s、2 workers 13.93 sで、worker固定による改善はなかった。

## 2 shard候補

- 各反復で `1/2` と `2/2` は19 filesずつ。
- unionは38 files、overlap 0、missing 0、extra 0。
- test-only critical path中央値は24.97 s、runner時間合計中央値は49.06 s。
- setup込み2 shard jobsのcritical path中央値は81 s、runner時間合計中央値は152 s。
- Storybook jobを加えた3 job構成はcritical path 81 s、runner時間合計約218 s。
- paired shard failureは0/6。

2 job構成の実測critical path 84-86 sに対し、3 job化で得られる改善は約5秒だけで、runner時間は約66秒増える。setup重複とflake surfaceの増加に見合わないため不採用とした。

## combined jobと2 job分割

同一commitのcombined実験3回はjob全体が99 s / 109 s / 117 s（中央値109 s）、test stepが48 s / 59 s / 58 s（中央値58 s）だった。

split CIは次の結果だった。

| run           | Browser job | Storybook job | critical path | runner合計 | failure |
| ------------- | ----------: | ------------: | ------------: | ---------: | ------: |
| `29595806683` |        84 s |          68 s |          84 s |      152 s |     0/2 |
| `29596608665` |        86 s |          66 s |          86 s |      152 s |     0/2 |

現時点のsplit中央値は85 s。過去baseline中央値91 sに対して6.6%短縮し、同一commitのcombined実験中央値109 sに対して22.0%短縮した。一方、runner合計はcombined中央値109 sから152 sへ39.4%増える。

この変更ではPR feedbackのcritical path短縮を優先し、runner消費増を明記したうえで2 job分割を採用する。BrowserとStorybookの責務・失敗箇所も別checkとして明確になる。

## Flaky判定

- 2つの比較matrixは合計66/66 jobs成功。
- combined jobが2 commandsを含むため、test commandは合計69/69成功。
- 共通候補は各6回、追加したfile-parallelism-offは3回、retry 0で成功。
- selected auto構成の標準split CIはBrowser 2/2、Storybook 2/2成功。

試行内で同一commit/configの成功・失敗が混在した候補はなく、観測flaky率は0%。将来のCIでも各jobのJSON artifactに失敗とresource値を残す。

## 再計測

```bash
pnpm benchmark:browser-ci -- --suite browser --runs 3 --output .artifacts/browser-ci/browser.json
pnpm benchmark:browser-ci -- --suite storybook --runs 3 --output .artifacts/browser-ci/storybook.json
```

詳細なPSS比較が必要な一時測定だけ `--collect-pss` を付ける。通常CIではworker数を固定せず、runner仕様、test files、flaky率のいずれかが変わった時点で再計測する。
