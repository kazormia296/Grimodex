# ユーザーの確認の記録：契約 nir1-scene-scope-default-proposal/1#scope-storage-authority（2026-11-04）

## 確認の対象
- file：`docs/plans/nir1-fusion-records/scope-default-b-design-2026-11-04/contract-draft-v1.md`（contracts `112970dd`）
- SHA-256：`fa9cc9c784971e6a65f40b62a42f7aac84955912f2f55d5cca52cf3a7da17ede`
- baseline：`nir1-l6-l9-contract-proposal/3#scope-storage-authority`（`docs/plans/nir1-l6-l9-execution-plan.md:229`、:296-305、:859-877）。X1/1・X1/3・K2/4 の行は置き換えず加算。
- 経緯：案 B（`2cddfb14`）、U1〜U3（`fd06db06`）、設計 rev2（独立レビュー Opus・最終確認 Fable）。

## 質問・選択肢・回答（原文）
「契約の draft「nir1-scene-scope-default-proposal/1#scope-storage-authority」（contract-draft-v1.md、SHA-256 fa9cc9c784971e6a65f40b62a42f7aac84955912f2f55d5cca52cf3a7da17ede）を、この内容で確認して実装に進めますか？（既定の変更の履歴を残すこと＝保存範囲の追加も含む。公開・閾値・Gold の変更は含まない）」
- 選択肢：確認して実装に進む (推奨)／履歴は残さないで確認／まだ確認しない
- **回答：「確認して実装に進む (推奨)」**
- 続く返答（自由記述）：**「続けて」**
- 日時：2026-11-04（JST）。経路：AskUserQuestion と通常の返答。

## 読みの根拠と範囲
- 上の SHA-256 の draft を契約として確認した（新しい保存先〔project の Scope の既定の表〕と、既定の変更の履歴〔変更前後の値・時刻・request の識別子、本文なし〕の保存を含む）。
- 実装に進む：PR を分け、独立レビューと CI を経て merge まで（通常の PR の手順）。確認台帳（`docs/plans/nir1-l6-l9-execution-plan.md`）への行の追加は実装の最初の PR に入れる。
- 含まないもの（draft の Status と §5）：Graph・local 送信・activation UI の公開、閾値・Gold・評価の規則・凍結済みの trace の変更、新しい送信先、§5 の範囲外の項目。
