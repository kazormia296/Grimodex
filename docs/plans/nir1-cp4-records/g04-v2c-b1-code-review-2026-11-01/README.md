# G-04 fixture v2（案 C）の B1（DR、fixture、規則文、validator、試験）の独立コードレビュー（2026-11-01）

**ユーザーの確認ではない**。別の agent（Opus、read-only）による独立コードレビューの記録。対象は worktree `claude-g04-v2c`（branch `claude/g04-v2c-fixture`、基点 `8187fbfc`）の B1 の 8 commit（`cccb734e`〜`ae5de27e`）。

- 判定：**(b) 修正してから受入れ可**。P1 なし、P2×2、P3×6。fixture の bytes、期待値、閾値に触れる修正は要らない。
- 規則文の意味（ユーザーの確認の範囲 3）：id・scope・closedSet・notEvaluated・outcome 規則・observationPolicy は変わっていない（範囲の外を基点の bytes から計算し直して hash が一致）。直した列挙（manifest の `preconditions.definitions` の 3 か所）は、変わっていない定義節から導ける。README:274-276 と `holdVersusBlocked` の新しい文は、観測の後の版の扱い（ユーザーの確認、`postObservationRevisions` の記録、新しい独立期待値レビューを要件とし、前の版と結果を残す）を足すもので、列挙ではない。設計 A §5.3 とユーザーの質問 2（README:265-266）の内側。
- validator：一般的な迂回路になっていない（scratchpad の写しで 27 の変異、全部期待どおり。G-05 を書き換えて freeze を結び直しても落ちる。v1 の厳しさは弱まっていない）。
- 試験：G-05 に移した 4 試験は同じ性質を同じ強さで検査する。落ちる 8 件（`observation-prep.test` #31／#32〔`constants.mjs` の pin〕、`frozen-k64-plan.test` 6 件）は B1 の変更によるもので、S2 追補と宣言 addendum の新しい版で直る形（基点は 115/115・601/601）。
- 指摘 P2×2、P3×5 は B1 が直した（commit `7bd785fe`〜`7635e880`）。P3-6（`observation-prep.mjs` の freeze.v1 の直書き）は S2 validator の範囲なので B2a に渡した。
- `review-b1.md` sha256 `741c9e1f476e7b2883fa717ba350f6cabe0019d9034db5e6071106edb8d93e8c`。再現の script と出力は `repro/`（base の clone などの大きい作業 file は含めない）。
