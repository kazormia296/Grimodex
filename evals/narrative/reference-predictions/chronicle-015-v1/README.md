# Chronicle 015 固定 JSON ドラフト

意味とスコープ（ミナが儀礼剣で捕虜を縛る縄だけを切る）は人手承認済みです。剣を拾うこと、火災、避難、出来事の完全性は対象外です。

- 正本: `evals/narrative/cases/chronicle-motif-boundary-v1.yaml` の `chronicle.micro.sword-recovered-015` / `scene-sword-use-recovered`
- 要件: `GDX-NARR-EVAL-001`、`GDX-NARR-EVIDENCE-001`、`GDX-NARR-SEMANTIC-001`
- `diagnosticOnly: true`。certification・モデル証拠ではありません。モデル dispatch は行わず、fixture-only の canonical send injection だけを検証します。
- EVAL の入力データは Gold と分離します。raw response に `semanticKey` / `proposalGate` を含めません。
- `sourceRef`、`clusterRef`、`observationRefs` は runtime ID 専用のプレースホルダーです。後続 runner では欠落・余分な参照、引用不一致を fail-closed で bind してください。
- `src/features/narrative-extraction/eval/chronicle015Reference.test.ts` で、correct は観測1／hypothesis1／proposal1、wrong-meaning は同じ件数だが legacy scorer の観測結果 PASS と意図 semantic FAIL/HOLD を分離、invalid-duration は parse failure 1・synthesis 0 として検証済みです。persistenceEvidence は `not-instrumented; proposal-planning-only runner` であり、実DB Applyの実測ではありません。
- `intendedVerdict` と `semanticRequirement` は人手承認済みの期待値であり、モデル証拠や legacy scorer の意味判定ではありません。wrong-meaning の legacy scorer PASS は characterization lock です。将来 scorer が FAIL になってこのテストが失敗するのは意図的な既知挙動であり、scorer 修正時に明示的に更新します。この fixture lane では scorer の採点やテストの throw を変更しません。
- parser の受理可否と、意図した semantic verdict は、現在の legacy scorer 結果とは別です。これは credential-free fixture 証跡であり、モデル証拠ではありません。完全性や不在については主張しません。
