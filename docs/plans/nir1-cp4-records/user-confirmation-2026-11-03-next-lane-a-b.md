# ユーザーの回答の記録：次の lane の選択（2026-11-03）

AskUserQuestion の回答を原文のまま残す。前の記録は `user-confirmation-2026-11-03-s7-ok-handoff-p3.md`（`94b6e04e`）。

## 提示した事実（質問の直前）

新しい integrator のセッション（引き継ぎ `handoff/nir1-handoff-20261103.md`）が §1 の確認を報告した：master の先頭は `cbf33077`（#779）、PR #780（DR-CP4-S6-3、docs だけ）は OPEN で `ci.yml` が実行中、重い処理は動いていない。CP-4 の正式な再測定は事前登録の規則を当てた結果 HOLD の条件に当たらないが、製品の公開は何も決まっていない（`PRODUCT_GRAPH_PUBLISHED` は false。PUB-G は Session C-1 の承認が要る）。候補として、A. JA の sparse の実装（設計は確認済み。着手時に設計の枝の push、短い別名の扱い〔(c)〕、Codex の種類を聞く）、B. PUB-G の前提の棚卸し（read-only。公開・有効化しない）、C. 融合の枠と Raw 偏重の議論（実装しない）、D. S2 の改版（S4 の 6 回目の凍結と再測定を伴う）を示し、推奨を「A の実装と B の read-only の並行」とした。

## 質問と選択肢

質問：「NIR-1 の次の lane はどれにしますか？（CP-4 の再測定は HOLD の条件に当たりませんでした。製品の公開は未決定で、PUB-G には別途あなたの承認が必要です）」

1. A 実装＋B 並行 (推奨)
2. B だけ（読むだけ）
3. C 融合の枠の議論
4. D S2 の改版

## 回答（原文）

**「A 実装＋B 並行 (推奨)」**

- 日時：2026-11-03（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲（integrator の読み）

1. **A**：JA の sparse の実装に着手する。設計（branch `claude/ja-sparse-design` `01c3604f`）の受入れと時期（CP-4 の後）は既に確認済み（`user-confirmation-2026-11-01-g04-c-redesign.md` の JA sparse の回答）。(a) 今の query に戻す、(b) CP-4 の harness は据え置き、(d) Codex の変更で取り直さない、は草稿の推奨のまま。**着手の前に、設計の枝の push、(c) 短い別名の扱い、Codex の種類を 1 回にまとめて確認する**（この回答はそれらを含まない）。
2. **B**：PUB-G の前提を read-only で棚卸しし、済み／残りの表と提案資料までにする。**PUB-G の承認、`PRODUCT_GRAPH_PUBLISHED` の変更、活性化 UI・開示の文言の承認は含まない**（Session C-1 の別の承認）。
3. 含まないもの：C と D、S4 の再凍結、再測定、閾値・Gold・融合の枠の変更、製品の公開。
