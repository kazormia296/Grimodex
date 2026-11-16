# ユーザーの回答の記録：9 回目の S4 の検出力の取り直しで見つかった欠け 11 件の扱い（2026-11-16）

- 経路：Claude Code の AskUserQuestion（1 問）
- 背景：作業範囲の確認（`7a03eaf9`）の条件「S3 や検出力で設計の前提が崩れたら、止まって伺う」に当たったため、伺った。
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/detection-run/`。候補は `6430b75b`（harness の bytes は `f5dd39ea` と同じ）。

## 質問の要旨

- K6/7 の新しい変異 83 件のうち 11 件が、どの試験も落とさなかった。
  - core 5 件：`K67-N-e1-ticket-null`、`K67-N-e3-requal`、`K67-N-g-key-k64`、`K67-N-g-key-trace`、`K67-N-g-category-stamp`
  - v3 6 件：`K67V3-U-id-not-in-revision`、`K67V3-U-no-endpoint-text`、`K67V3-U-hash-both`、`K67V3-U-edge-unresolved`、`K67V3-X-pageonly-fields`、`K67V3-X-opt-needle-entities`
- 原因は規則の誤りではなく、規則を破る入力を試験が持っていないこと。
- ほかの 5 組（SP-N、K6/4、K6/5＋C7、K6/6）は、期待の写し直しを除いて、すべて検出された。

## 回答

**「試験を足して、検出力を取り直す (Recommended)」**

- 足すのは、11 件を検出する試験だけ。規則の file、閾値、契約は変えない。
- DR 追記 4 の申し送り（`MAINTENANCE_QUIESCE_*`・`RETRY_DISPATCH_GRACE_MS` を `HARNESS_CONSTANTS` へ移す）も、ここで済ませる。
- その後、6 組すべてを取り直す。
- 取り直しで欠けが残れば、また伺う。
