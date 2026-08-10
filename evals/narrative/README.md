# Narrative Extraction 評価データ

このディレクトリは、Narrative Extraction の意味品質を測るための、バージョン付き評価データの正本です。最初の suite は Chronicle Vertical Slice の micro corpus です。

## Gold の扱い

`cases/chronicle-micro-v1.yaml` の `expected` は、人間がレビューした Human Gold です。イベントタイトルなどの表層文字列を一致させるのではなく、次の意味軸を比較します。

- Event Detection
- Actuality
- Attribution
- Narrative Frame
- Evidence
- Clustering
- Significance
- Proposal Gate

本文はすべてこの評価用に作成した合成テキストです。Gold はモデル出力から自動生成しません。Gold を変更する場合は、ケース本文、期待値、critical violation、要件への影響を人間が一緒にレビューします。

現行の legacy Chronicle 出力は、exact quote、actuality、attribution などを持たないため、旧経路の baseline を採取する用途には使えても、新しい Narrative Extraction 経路の認証には使えません。Production prompt、schema、parser を通した結果だけが認証対象です。

## ファイル

- `manifest.yaml`: suite、要件、件数、release gate の正本
- `schemas/case-v1.schema.json`: 個々の case の JSON Schema
- `cases/chronicle-micro-v1.yaml`: 14件の Chronicle micro case

ケースは `schemaVersion: 1` を持ち、`scope`、固定 locale/timezone/time、corpus coverage、documents、Human Gold、critical violation class を自己完結して保持します。同じ case の実行は、他 case の状態や artifact を共有してはいけません。

## Evidence と Coverage

Evidence は `{ documentId, quote }` だけを Gold とし、モデル由来の位置情報は使用しません。`quote` は参照先 document の `text` に完全一致する必要があります。位置解決は製品側の canonical resolver が行います。

`coverage.mode: partial` では、`omittedDocumentIds` に未取得 document を明示します。部分 corpus の結果から「ほかにイベントは存在しない」と断定してはいけません。

## 初期 corpus の狙い

micro corpus は、実際の出来事、計画、噂、阻止された試み、夢、仮定、回想、複数 Scene の重複言及、非イベント、紛らわしい引用、否定、帰属の反証、partial coverage、重要度の選別を含みます。

この14件は評価カーネルと最初の baseline を成立させるための最小セットです。作品単位の一般化や release 判定には、chapter/full-work/mutation case と独立 holdout を追加します。
