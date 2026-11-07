# NIR-1 L0 の Raw だけの測り直し：JA sparse（2026-11-03）

設計 `docs/plans/related-scenes-ja-sparse-design-draft.md`（master `39ac13c8`、§5.3・§8.2 の A・§9.3）が求める「Raw の経路の変更の別の記録」。凍結物（`evals/nir1-retrieval/` の manifest・corpus・freeze）は変えていない。**正式な測定ではない**（各 1 回、ホストは静かでない）。

## 実行

- runner：`node scripts/local-ci-xvfb.mjs node scripts/quality/run-nir1-retrieval.mjs --mode raw`。標準 build の受領書（`scripts/quality/nir1-retrieval/standard-build.mjs`）つき、本番の ONNX（`ruri-v3-30m`、`bge-small-en-v15` の `model_int8.onnx`）、Xvfb（Wayland／D-Bus／proxy の変数を除き `ELECTRON_OZONE_PLATFORM_HINT=x11`、`TMPDIR=/tmp/gr5`）。
- 3 run（いずれも clean な worktree）：
  - `base-cbf33077.receipt.json`：master `cbf3307739db9310e2e1d65d947a811591fd77f2`（基準）。
  - `cand-eb12fb49.receipt.json`：`eb12fb497fd5d86a6877e22b1c9da8dfcdb7765f`（実装＋matcher の memo。独立レビューの直しの前）。
  - `final-f5dd9ce9.receipt.json`：`f5dd9ce9d30e33ae529499c81047a77ab7f0eef2`（直しの後）。PR #782 の merge した head `53a9d7f4` との差は master の取込み（#780 の docs、#781 の tree の修正と予算）だけで、`src/features/related-scenes`・`src/features/codex`・`src/lib`・`semanticRecall.ts`・`electron`・`src-tauri` に差は無い。
- 各 file の sha256 は `SHA256SUMS`。

## 結果

- 3 run とも `status: baseline-complete`、errors 0、warm 720/720。
- **24 query すべてで、結果の場面・並び・点数（小数 6 桁）・抜粋が基準と一致**（cand、final とも）。品質も同じ：全体 recall@8 0.910／nDCG@8 0.896、ja 0.819／0.835、en 1.000／0.957。設計 §5.2 の見込み（L0 の corpus には Codex が無く、Raw の顔ぶれ・並び・点数は変わらない）と合う。
- warm の時間（ms。各 360 sample）：

| run | ja p50 | ja p95 | en p50 | en p95 | 全体 p95（B） |
|---|---|---|---|---|---|
| base `cbf33077` | 21.0 | 198.8 | 20.6 | 29.4 | 63.1 |
| cand `eb12fb49` | 20.4 | 206.6 | 21.5 | 63.3 | 73.9 |
| final `f5dd9ce9` | 21.7 | 216.8 | 22.1 | 30.9 | 70.4 |

- 読み（integrator）：en の経路のコードは変えていないのに cand の en p95 が 29.4→63.3 に動いたので、この程度の揺れはホストの負荷（並行して別セッションの vitest と headless Chromium、レビューの vitest が動いていた）で起きる。L0 の corpus には Codex が無く、追加の計算は JSON の読み取りと seed の抽出（合成で 1 ms 未満）だけ。ja の時間の差は揺れと読むが、各 1 回なので断定しない。L0 の凍結時の B（54.2 ms）とも環境が違う。Raw の時間の判定は正式な測定に委ねる。
- 確かめていないこと：Codex を登録した状態での Raw-ready の増分（L0 の corpus に Codex が無い）、実際の小説での効果。
