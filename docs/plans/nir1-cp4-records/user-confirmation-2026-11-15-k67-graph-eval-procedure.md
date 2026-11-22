# ユーザーの確認の記録：契約 nir1-final-request-eval-proposal/7#graph-eval-procedure（2026-11-15）

## 確認の対象

- file：`docs/plans/nir1-final-request-eval-proposal-7-draft.md`（contracts `08b168c9562ff13c314a77f2d03b8a4550774d7f`、改訂 5）
- SHA-256：`7b8f81c71a2d7edca9dbef8bdfb7c81120d3873346289b156fc92fdc1d40424d`
  - この commit の時点の file で取り直し、一致を確かめた。
- baseline：`nir1-final-request-eval-proposal/6#graph-eval-procedure`（K6/6、凍結 `56fb4fad`）
  - 行は置き換えない。/7 の「変える点」を当てて読む。

### 経緯

1. PR-3 の方針の決定（2026-11-15：数え方だけを統一、stamp の key を消す、(ii-b) を同時に）
2. 調査と初版（contracts の外。`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/`）
3. 点検（critic）と改訂 1
4. Opus の独立レビュー 1
5. 起案前の選択（`5bbd6ebb`）
6. 改訂 2
7. 確認の前の非判定の dev の試作。dev 枝 `claude/dev-k67-iib`（push していない）、記録 `proto/README.md`
8. 改訂 3
9. Opus の独立レビュー 2。選択のその 1 を問い直した（`f628efb2`。A′ の説明が不正確だったための訂正）
10. 改訂 4、R-13 の追加（改訂 5）
11. Opus の最終確認前の読み（「出してよい」）

## 質問・選択肢・回答（原文）

### 質問

AskUserQuestion で、台帳の Confirmation protocol の形で伺った。

「K6/7（draftRef nir1-final-request-eval-proposal/7、contractId graph-eval-procedure、SHA-256 7b8f81c71a2d7edca9dbef8bdfb7c81120d3873346289b156fc92fdc1d40424d、contracts 08b168c9）を、この版のとおり承認しますか？
1. 製品から親の鮮度 stamp を消します（PR-3）。first-render は stamp を使わず、全 sample を ②（worker の drift 検査、返却時の再検証、宣言 used、合流）で数えます。診断の stamp 4 key と record の freshnessStamp は消し、時刻も残しません。閾値、Gold、pool、D、p95 の上限、T_late、手順 v2 は変えず、新しい閾値も置きません。
2. 合格基準の緩和は 5 つです。R-8：stamp が読めなかった親を ② で数える（11/7 に選ばなかった数え方）。R-9：stamp の記録が無い親も ② で数える。R-10：stale だった親を worker が答えて合流させうる（DR-CQD-8 の窓は registration の preflight 以降に狭める）。R-12：窓内判定から stamp の一致の条件を外す（R1 の下では集合は変わらない）。R-13：下の 4。
3. 検査を 1 つ削ります。FR-8 の「stale で合流した記録は記録の誤りとして止める」で、代わりの検査はありません。
4. 窓外の query は理由で区分し、過半数で主な理由を決めた後、「鮮度」なら「その他」と読みます。失効、設定の不備、「なし」（伺って止まる）は残り、「条件成立」の枝は使われなくなります。ただし K6/6 の数え方と比べると、「なし」で止まっていた trace が「この行は使わない」になる組が 1 つあります（R-13。過去 24 件で 0 件）。前回「緩む面なし」とした説明は、この点で不正確でした。
5. (ii-b)：② の結果を評価 build の Native の記録に出し、欠ければ止めます（数える集合は変わりません）。評価 feature 限定の hook を owner の外の related_scenes/graph.rs と nir1_graph_product.rs に入れ、許可リストに足すことの許可を含みます。
6. 私が決めた点（厳しい側）：(ii-b) の記録が無い・形が違う sample、合流した親で drift が clear でない記録、returned が true でない記録は、記録の誤りとして止めます。寄与の記録が欠けた親は欠落（1% の許容の内）です。s6r1・s7r1・s7r2 は判定に使わず、次の S4 の凍結の後の正式 run で取り直します。
7. 窓内に合流して表示に寄与した親が条件を 1 つでも欠けば、品質は FAIL です（1% の許容は効きません）。
8. この版は、観測と PR-3 の調査の後に起案しました。確認の後の予行が落ちれば、/8 と再確認になります。公開や PUB-G の承認ではありません。R5 の記録の扱いは別に伺います。」

### 選択肢と回答

- 選択肢：承認する（推奨）／承認しない（K6/6 のまま。PR-3 では stamp を消せない）
- **回答：「承認する (Recommended)」**
- 日時：2026-11-15T14:08Z ごろ（23:08 JST ごろ）。回答の直後に読んだ時計の値。
- 経路：Claude Code の AskUserQuestion。

## 読みの根拠と範囲

- **確認したもの**：上の SHA-256 の draft を、contractId `graph-eval-procedure` の `nir1-final-request-eval-proposal/7` として確認した。範囲の正本は、draft の「確認の扱い」と「変える点」1〜8 である。
- **緩和の開示**：合格基準の緩和 5 つ（R-8・R-9・R-10・R-12・R-13）と、検査の削除（FR-8 の stale）は、質問の文で示した上での確認である。
  - R-13 は、選択の段の問い直しで「緩む面なし」と説明した点を訂正して伺った。
- **範囲に含まれないもの**
  - 製品の公開（`PRODUCT_GRAPH_PUBLISHED` は false のまま）と、PUB-G の承認。
  - 次の S4（9 回目）の失効と再凍結の手順。前例どおり個別に伺う（PR-3 の質問の Q5）。
  - R5 の照合の記録の再利用か取り直しか（Q9。変えた閉包の file の一覧の後に伺う）。
  - not-evaluable の受領書の拡張の保存範囲（Q6）。
  - PUB-G #15（Q7）。
- **凍結**：この file を置く commit を、K6/7 の凍結の commit とする（K6/6 と同じ扱い）。凍結の後、`claude/nir1-contracts` は fast-forward だけで進め、K6/7 の bytes は変えない。凍結の記録は `k67-freeze-record.md`。
