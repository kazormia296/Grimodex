# ユーザーの確認の記録：契約 nir1-final-request-eval-proposal/5#graph-eval-procedure（2026-11-07）

## 確認の対象
- file：`docs/plans/nir1-final-request-eval-proposal-5-draft.md`（contracts `96c657cf`、改訂 5）
- SHA-256：`1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`
- baseline：`nir1-final-request-eval-proposal/4#graph-eval-procedure`（K6/4。行は置き換えず、/5 の「変える点」の 1〜7 を当てて読む）
- 経緯：起案（初版 `9dbb94fb`）→ Opus の敵対的レビュー → 改訂 2（`10cb2569`）→ U-1・U-2 の選択 → 改訂 3（`20e178e6`）→ 再レビューと U-2 の再確認 → 改訂 4（`be1fede3`）→ Fable の最終 pass（P1×1、P2×3、P3×4）→ 改訂 5（`96c657cf`）。
- 訂正の経緯：最初の問 2 は「p95 は補助記録だけ」、最初の U-2 は「T_late の余裕が縮む」という誤った説明で示し、どちらも訂正して聞き直した（記録は irw3 の手順の起案の追記、`f026d1f1`・`fdf1159d`）。

## 質問・選択肢・回答（原文）

### 1 回目（識別子を名指していない。確認としては扱わず、2 回目の前置きとして記録する）
「CP-4 の Graph の評価の新しい契約 K6/5 を承認しますか？ 中身は、最初の表示の窓 D を 10.84→40 ms に、Hybrid p95 の上限を 65.04→94.2 ms に変えることです。緩和は 5 つあります（窓内の D、親と子の IR の締切、p95 の上限、D の後の Graph の違反の境界）。T_late を 100 ms のままにすると、到着だけ遅れた親の通知の時間が約 29 ms 上がり、観測の最悪で 83.7 ms（余裕 約 16 ms）になります。」
- 選択肢：承認（T_late 100 ms）（推奨）／承認し T_late を広げる／D=40 の dev 測定を先に見る
- 回答：「承認（T_late 100 ms）（推奨）」
- 質問の前の本文で、変える値の表、緩和 5 つ、T_late の仕組み（q1 ≈ max(Graph の到着, D)＋δ、反転は δ＞60 ms のときだけ）、変えないもの（1%、W_f 100 ms、T_show 2 s、P の評価の値、Gold、fixture、製品のコード）、C7 と G-01 を手順の側で扱うこと、承認の後の順序を示した。

### 2 回目（確認。台帳の Confirmation protocol の形）
「台帳の規則で識別子を名指す必要があるので、確かめ直します。契約の draft「nir1-final-request-eval-proposal/5#graph-eval-procedure」（nir1-final-request-eval-proposal-5-draft.md、contracts 96c657cf、SHA-256 1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7）を、この内容で確認しますか？ 内容：D を 10.84→40 ms、Hybrid p95 の上限を 65.04→94.2 ms。合格基準の緩和 5 つ（窓内の D、親と子の IR の締切、p95 の上限、D の後の Graph の違反の境界）。T_late は 100 ms のまま。P の評価の値は変えない。Chronicle の停止の扱いと G-01 は /5 に含めず手順の側で扱う。」
- 選択肢：確認する（推奨）／まだ確認しない
- **回答：「確認する（推奨）」**
- 日時：2026-11-07（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲
- 上の SHA-256 の draft を、contractId `graph-eval-procedure` の `nir1-final-request-eval-proposal/5` として確認した（批准 7 の (i)。(ii) は `preConfirmationRef`）。範囲の正本は draft 冒頭の「ユーザーが批准すること」の 1〜9。
- 合格基準の緩和（R-1〜R-5）を含むことは、質問の文で示した上での確認である。
- 2026-11-07 のそれ以前の回答（問 1、U-1、U-2 とその再確認、問 3、問 5）は起案の指示で、確認ではない。
- 含まないもの：P の評価（`nir1-retrieval`）の固定値の変更、Gold・fixture・製品のコードの変更、T_late の変更、新しい送信先・保存先・authority、公開。
- 次の手順（draft の「確認までの手順」の 5〜7）：台帳の更新（master への PR。draft を byte 同一で取り込む）、contracts の凍結の記録（`k65-freeze-record.md`）、harness の実装、S2 追補 #14、S3、S4 の 6 回目の凍結、正式 run。
