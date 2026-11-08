# ユーザーの確認の記録：契約 nir1-final-request-eval-proposal/6#graph-eval-procedure（2026-11-08）

## 確認の対象
- file：`docs/plans/nir1-final-request-eval-proposal-6-draft.md`（contracts `324c804f`、改訂 3）
- SHA-256：`58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`（この commit の時点の file で取り直して一致を確かめた）
- baseline：`nir1-final-request-eval-proposal/5#graph-eval-procedure`（K6/5。行は置き換えず、/6 の「変える点」を当てて読む）
- 経緯：s6r1 の HOLD とユーザーの選択（`1e6ede44`）→ 初版（`02af2760`）→ Opus の独立レビュー → R-6 と鮮度の印の句のユーザーの選択（`e704f28f`）→ 改訂 1（`f2e0fe0f`）→ Sonnet の 4 観点のレビューと反証 → 改訂 2（`34a095f3`）→ Fable の最終 pass → 改訂 3（`324c804f`）→ 確認の前の非判定の dev の予行（予行 1・3・4・5。dev 枝 `claude/k66-harness-proto` の `d12b78e5`、記録 `docs/k66-dev-rehearsal-1.md`・`docs/k66-dev-rehearsal-2.md`。未 push）。
- 品質判定の事前登録 v2 の草稿（`docs/plans/nir1-cp4-records/quality-verdict-prereg-v2-draft.md`、SHA-256 `41520857e22d8ac1c591a3fc259142480d8e9717f53df6acae75f8d5b1212838`）は integrator が決めるもので、この確認の対象ではない。

## 質問・選択肢・回答（原文）

### 質問（AskUserQuestion。台帳の Confirmation protocol の形）
「K6/6 の確認です。draftRef「nir1-final-request-eval-proposal/6」、contractId「graph-eval-procedure」（nir1-final-request-eval-proposal/6#graph-eval-procedure、改訂 3、SHA-256 58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7）を、CP-4 の Graph の評価の手順として確認しますか？
(1) 緩める点：R-6（「測る前に準備済み」を「この sample のために準備が 1 回行われた」と読み替える）と R-7（鮮度の印が取れない stamp0-missing の親を ② を条件に数える）。数える親は品質 FAIL から測定へ移る。
(2) R-7 の実効：② は今の harness では合流した stamp0-missing の親を独立に落とさず、実効は unavailable を除くだけ。数える根拠はコードの読みで、印が取れない原因は混雑だけでなく transaction の中・commit の競合も含む。unavailable を除くのは安全上の差ではなく選択。
(3) 窓内に合流して Graph が表示に寄与した親が条件を 1 つでも欠くと、Scene の一覧が R+IR と同じでも品質は FAIL（1% の許容は効かない。unavailable と (c) の不一致の親も同じ）。ただし寄与の記録そのものが欠けた親は、欠落（1% の許容の内）に数える。
(4) 狭める点：FR-1〜FR-8、N-a〜N-d。
(5) D 40 ms、p95 の上限、T_late などの値、手順のファイル、follow-up の数え方は変えない。
(6) s6r1 は HOLD のまま。/6 の判定は /6 の凍結の後の run だけ。s6r1 に字義どおり当てると欠落 163。
(7) この改訂は s6r1 の結果を見た後に起案した。
(8) 確認の後の予行が落ちたら /7 と再確認。FR-7 を外す・緩めることはしない。
確認の前の非判定の予行（予行 5）：FR-7 と FR-1〜8 は 125/125、first-render 125、止める条件に当たらず。品質の予告の G-08/chronicle-index-unusable の FAIL は、予告の読みが品質判定 v2 の D3 を入れていなかったため（s6r1 と同じ形、precondition は保たれ、禁止された寄与は 0）で、文面は変えず、確認の後の harness の段で直します。」
- 選択肢：確認する（推奨）／鮮度の印の扱いを見直してから（再起案）／もう少し詳しく
- **回答：「確認する（推奨）」**
- 日時：2026-11-08（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲
- 上の SHA-256 の draft を、contractId `graph-eval-procedure` の `nir1-final-request-eval-proposal/6` として確認した（批准 7）。範囲の正本は draft 冒頭の「ユーザーが批准すること」の 1〜9。
- 合格基準の緩和（R-6・R-7）を含むことと、R-7 の実効（② は合流した親を独立に落とさない）は、質問の文で示した上での確認である。
- 質問の (3) の「寄与の記録そのものが欠けた親は欠落に数える」は、試作の harness のレビューで見つかった残余（`parentContributed` は宣言 `used` を要求する。K6/6 の字義どおり）の開示である。
- 2026-11-07 の回答（`1e6ede44`、`e704f28f`）は起案の指示と選択で、確認ではない。
- 含まないもの：(ii-b)（Native の ②-1・②-2 の記録）の着手、製品のコードの変更、D・p95 の上限・T_late・W_f・T_show・1%・手順のファイルの値の変更、Gold・G-case の fixture・凍結済みの trace の変更、新しい authority・保存先・送信先、公開。
- 予行 5 の G-08/chronicle-index-unusable の予告の FAIL の切り分け（Opus、read-only）：予告の読み（試作の `outcome.mjs` の `unavailableQuality`）が品質判定 v2 の D2・D3 を入れていなかった。凍結の index-state-holding は before-measurement と at-query だけを見る設計で、子は親の query の後に出る。s6r1 の同じ variant も precondition は保たれ（d2Probes 140 件すべて held）、子は index-ready・graph-ready。K6/6 の文面の改訂は要らない。D3 の (d)（Revision の解決）の実装は、S4 の凍結の前に harness の段で行う。
- 次の手順（draft の「確認までの手順」の 4〜7）：
  - この記録の commit を凍結の commit とし、凍結の記録（`k66-freeze-record.md`）を作る。
  - 台帳の更新（master への PR。draft を byte 同一で取り込む）。続行計画 §10 にも節を足す。
  - harness の実装、試験と検出力の記録。
  - 品質判定 v2 の確定・実装・独立のコードレビュー・push。
  - R1 の下の dev fixture での予行、S2 追補、S3 の独立レビュー、S4 の 7 回目の凍結、取り直しの正式 run。
