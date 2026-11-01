# G-04 fixture v2（案 C）の凍結前の再 probe（2026-11-01）

**ユーザーの確認ではない**。integrator の実行記録。手順は設計文書（`claude/g04-fixture-v2-design` `700ff053`）の §3.4 と、ユーザーの確認 `user-confirmation-2026-11-01-g04-v2c-build.md`（`a7027915`）の質問 1。

## 固定したもの（測定の前）

- 道具：以前に承認された `/tmp/onnxprobe`（`@huggingface/transformers` 4.3.2、`onnxruntime-node` 1.30.0、Node v24.18.0）。model sha256 `4f183171…8e44b`、tokenizer sha256 `d241a60d…5c66` は元の probe と同じ（出力に記録）。
- script：`probe-v2c.mjs` sha256 `cd1fd43271882a7c897699094f268d2ec94ff714c1d961fc397c7a174101ca87`。**確認済みの `probe.mjs`（`8fcc9010…`、contracts `6224915f`）との差は 165 行目の 1 行だけ**：構造の条件 `irOnlyCount === 1 && controlCount === 1` → `irOnlyCount === 0 && controlCount === 1`（v2 は ir-only が 0 件）。合否の条件（δ＝0.03 の `T_CONTROL`＝0.54、`T_OTHER`＝0.43、golden の最小 0.995）と判定の部分は同一。`diff` と独立確認（別の agent、script を実行せず `sha256sum`／`diff`／`cmp` と全文の読みで確認。差分が 1 行に限られ、波及なし、値に関係なく止まる経路は構造条件の 2 つ以外に無い、と報告）。
- 対象の bytes：`g04-scope-exact-unknown.v2.json` sha256 `ec5455a991a423e57994c0968fb9ee75cf20acadf6452d5e829216d80a5dbde3`（このディレクトリの `g04-scope-exact-unknown.v2.candidate-bytes.json` と同じ bytes）。probe が読むのは `query`、`scenes`（role・本文・readingOrder）、`qualifiedIr` だけ。**この 3 つの field を後で変えるなら、再 probe は 1 回きりの規則に反するので、止めてユーザーに戻る**。ほかの field（期待値、説明文など）の変更は probe の対象外。
- 判定の規則（測定の前に固定）：golden が条件を満たし、control の Raw が 0.54 以上、control 以外の 7 Scene の Raw がすべて 0.43 以下なら合格。値の一致は求めない。1 つでも外れたら止めてユーザーに戻る。候補の選び直し、δ の変更、probe の当て直しはしない。

## 結果（`v2c-probe-out.json`、`v2c-probe-run.log`）

- 実行は 1 回だけ（`v2c-probe-started.txt` の時刻）。再実行・当て直しはしていない。
- golden：n=7、平均 0.99747、最小 0.99688（条件 0.995 以上）。
- control の Raw：0.8083（≥0.54）。control 以外の 7 Scene の Raw：rv-unknown 0.4293（余裕 0.0007）、rv-unresolved 0.4271（0.0029）、lio-market 0.4248（0.0052）、rv-alt 0.3923（0.0377）、rv-match 0.3908（0.0392）、rv-holder 0.3697（0.0603）、lio-landing 0.3597（0.0703）。すべて ≤0.43。
- control の IR：0.6614（条件にしない）。ir-only の IR 行は無い。
- **`allPass=true`、`failing=[]`、`stopRequired=false`**。**合格**。値は候補の測定（`g04-v2-candidates-2026-11-01/`）の #4（0.3908）と #7（0.4293）と一致した。

## 限界（開示）

- model-only の予測で、測定に数えない。sparse（FTS5）と RRF の順位は再現しない（語彙の検査は validator に任せる）。
- rv-unknown の余裕は 0.0007、rv-unresolved は 0.0029、lio-market は 0.0052 と薄い。δ（0.03）は独立の case での probe と保存値のずれ（最大 0.0150）の約 2 倍の値で、成り立つことの保証ではない（runtime の前提条件 `raw-membership` の確認は測定で行う）。
