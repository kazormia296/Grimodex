# G-04：英語 query への bge の instruction prefix の効果（2026-11-01、read-only、測定に数えない）

外部 Research のレポート（`../research-report-20261101.md`。第三者 AI の生成で、事実は Fable が抜き取りで検証した）が「prefix を付けていないなら設定の問題」と述べた点を、G-04 で確かめた。製品の英語モデル（bge-small-en-v1.5）は query／document とも prefix なし（`grimodex-semantic/src/spec.rs:159-160`。gate 0.51 は prefix なしで較正）。bge の FAQ は「短い query→長い passage では instruction を推奨」（v1.5 では instruction なしでも検索能力が改善されている）。製品・fixture・harness は変えていない。

## 方法
`g04-probe.mjs` と同じ（製品と同じ int8 ONNX、CLS、L2。golden で再現性確認済み）。query は `g04-query` の本文。instruction は "Represent this sentence for searching relevant passages: "（query 側だけ。文書側は付けない）。

## 結果（質問との cosine）

| 文書 | prefix なし（現状） | instruction あり | 差 |
|---|---|---|---|
| g04-control（採用された Raw） | 0.8083 | 0.7837 | −0.0246 |
| g04-rv-match（余分に入った） | 0.4925 | 0.4601 | −0.0324 |
| g04-rv-unknown | 0.4390 | 0.4104 | −0.0286 |
| g04-rv-unresolved | 0.4271 | 0.3967 | −0.0304 |
| g04-lio-market（Gold 2） | 0.4248 | 0.3965 | −0.0283 |
| g04-rv-alt | 0.3923 | 0.3580 | −0.0343 |
| g04-rv-holder | 0.3697 | 0.3380 | −0.0317 |
| g04-lio-landing（Gold 3） | 0.3597 | 0.3351 | −0.0247 |
| IR: control（採用された） | 0.6614 | 0.6267 | −0.0347 |
| IR: lio-landing（採用されなかった） | 0.5559 | 0.5326 | −0.0233 |

## 読み
- **この case では、instruction を付けると全文書の cosine が 0.02〜0.035 下がった。順位はほぼ変わらず**、Gold の 2 場面（lio-market、lio-landing）は 5 位・8 位のまま、lio-landing の IR 文は floor 0.66 から離れた（差が 0.10→0.13）。rv-match は gate 0.51 からさらに離れた（相対救済の条件〔0.46 以上〕は 0.4601 で境界）。
- したがって、G-04 の失敗は **prefix の不使用が原因ではない**。H5（疑問文→陳述文の非対称に対する prefix の効果）は、この 1 case では支持されない。
- 限界：1 case、英語、8 場面、query は疑問文。散文の query、実コーパス、日本語（既に prefix あり）は測っていない。prefix を採用するなら、gate 0.51 と IR floor 0.66 の再較正が要る（閾値の変更。ユーザーの確認が要る）。
