# ユーザーの決定：s6r1 は HOLD と記録し、K6/6 を起案する（2026-11-07）

AskUserQuestion で 1 回、2 問。integrator（Claude Opus 5.5、セッション `session_01KiGRYYXuaF6K8SwFwj7DiN`）が問い、ユーザーが選んだ。これは起案の指示と選択で、契約の確認文ではない（K6/6 の確認は、起案・独立レビューの後に別に行う）。

## 前提（問いの時点で示した事実）

- 集計：`s6-aggregation-s6r1/`（contracts `7eca5693`）。harness の記録どおりの読みでは HOLD：Gold の定常状態の pool で 270 件中 163 件が欠落（許容 2）。163 件はすべて D=40 ms の窓内に親が Graph を受けた sample（`graph-ready`、joined、再検証 passed）で、子は出ていない。
- Opus の独立検査（read-only）：K6/4 の R1（各 sample の前に slot を `empty` にする）の下で `readyFresh` は構造的に false（`electron/native/grimodex-node/src/nir1_graph_eval/mod.rs:446-453`）。harness の `steadyStateInWindow`（`scripts/quality/nir1-graph-eval/join.mjs:113-120`）は `readyFresh` と stamp の一致を要るので、D の値に関わらず Gold の first-render は数えられない（s5r6 も `notReadyAtStart` 30/30）。D=10.84 ms では親が常に graph-late で follow-up が出たので表に出なかった。`stamp0-missing` は製品の状態（非 blocking の読取が None）。K6/2 の手順 3 の最終文（:695）と K6/5 の変える点 5・K6/5-P1（:92、:121）は文面だけではどちらの読みにも決まらない。s6r1 の受領書を読み直して合格にすることは、観測の後の定義の変更（K6/2:617、:620）に当たりうるので、どの道でも取り直しの run が要る。
- 品質判定（補助）：G-08/chronicle-index-unusable の 30 sample で、`index-ready` の再 query が `graph-ready`（edge 1）を出し、条件 5 の (a) が fail。edge は現世代の正当な path で、禁止 Scene・blocked 候補への寄与は 0。前回（s5r6）も同じ再 query は出ていたが Graph が graph-late だった。K6/4:52 の「子」は `graph-ready` で出す 1 回の再 query で、`index-ready` の再 query を含まない。

## 問 1（s6r1 の扱い）

選択肢：(1) HOLD と記録して新版を起案（推奨）、(2) K6/5 の文面どおりと認めて直す、(3) HOLD を受け入れて止める。

**回答：「HOLD と記録して新版を起案（推奨）」**

選択肢 (1) の説明（問いの文面のまま）：s6r1 は HOLD のまま、構造上の理由を開示して記録します。そのうえで、最初の表示の数え方（準備の句、鮮度の印の句、G-08 の取り直しの扱い）を明文にした新しい版（K6/6）を起案し、独立レビューの後に確認をお願いします。その後に harness の直し、7 回目の凍結、取り直しの正式 run を行います。手続きの瑕疵がいちばん少ない道です。

## 問 2（品質判定の G-08 の子）

選択肢：(1) 契約の「子」の定義にそろえる（推奨）、(2) 字義どおり不合格のまま。

**回答：「契約の「子」の定義にそろえる（推奨）」**

選択肢 (1) の説明（問いの文面のまま）：品質判定の事前登録を新しい版にし、Index が戻った通知の取り直しは「使えない間」の判定に含めません。その代わり、その取り直しに禁止された場面が混ざらないことは、別に検査します。今回の不合格は、開示して記録に残します。

## この決定から決まること

1. s6r1 の S6 の規則が指す先は **HOLD** として記録する（受領書の読み直しで合格にしない）。構造上の理由（R1 の下の `readyFresh`、D=40 ms で子が出ないこと）を S6 の README と S7 に開示する。
2. K6/6（`nir1-final-request-eval-proposal/6` の `graph-eval-procedure`）を起案する。範囲は、定常状態の first-render の数え方（K6/2:695 の準備の句と鮮度の印の句の R1 の下での扱い、K6/5-P1 との関係）と、それに伴って直す箇所だけ。D・Hybrid p95 の上限・T_late・W_f・T_show・1%・失効の読みは変えない。鮮度の印の句の扱いは緩和に当たりうるので、起案者は選ばず、選択肢として示す。
3. 品質判定の事前登録を新しい版にし、`index-ready` の再 query を chronicle-index-unusable の判定から外し、その再 query の禁止寄与 0 を別の検査にする。
4. K6/6 の確認・凍結の後に、harness の直し（S2 追補・S3 の独立レビュー・S4 の 7 回目）と取り直しの正式 run を行う。s6r1 の受領書は K6/6 の判定に使わない。
