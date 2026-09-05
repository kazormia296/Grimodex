# Chronicle 015 固定 JSON ドラフト

意味とスコープ（ミナが儀礼剣で捕虜を縛る縄だけを切る）は承認済みですが、人手レビュー待ちです。剣を拾うこと、火災、避難、出来事の完全性は対象外です。

- 正本: `evals/narrative/cases/chronicle-motif-boundary-v1.yaml` の `chronicle.micro.sword-recovered-015` / `scene-sword-use-recovered`
- 要件: `GDX-NARR-EVAL-001`、`GDX-NARR-EVIDENCE-001`、`GDX-NARR-SEMANTIC-001`
- `diagnosticOnly: true`。認証・certification・モデル証拠ではありません。現在の scorer は `NOT RUN` です。
- EVAL の入力データは Gold と分離します。raw response に `semanticKey` / `proposalGate` を含めません。
- `sourceRef`、`clusterRef`、`observationRefs` は runtime ID 専用のプレースホルダーです。後続 runner では欠落・余分な参照、引用不一致を fail-closed で bind してください。
- parser の受理可否と、意図した semantic verdict は、現在の scorer 結果（未実行）とは別です。完全性や不在については主張しません。
