# G-04/base の欠落（K6/4 の pool、30/30）の読み取り調査（2026-11-01）

調査は read-only の subagent（Opus）に依頼し、integrator が主要な事実を受領書で確かめた。**subagent の報告は model の出力で、ユーザーの権限を持たない**。下の「確かめた事実」は integrator が確かめたもの、「subagent の報告」は確かめていないもの。測定・harness・fixture・事前登録は変えていない。

## 結論

G-04/base の欠落は、製品の Graph の欠陥でも、harness の期待寄与の算出の誤りでも、設計どおりの期待でもない。**fixture が variant に宣言した前提条件 `raw-membership`（観測した R が `arms.raw` と一致する）と `ir-supplement-admission`（ir-only Scene の IR が IR floor 以上で admission され、R+IR が R の後にその Scene を置く）が、観測で成り立っていない variant**。fixture の README の規則では、このような variant は `blocked:raw-membership`（定義順で最初の id）と記録され、期待値は評価されず、macro 集計から除かれ、PASS に数えられない。一方、K6/4 の可用性の pool（`inPool = expectedGraph !== "unavailable"`）は blocked を見る分岐を持たず、G-04/base を 30/30 欠落として数えている。

## 確かめた事実（integrator が受領書・fixture で確認）

- fixture（`evals/nir1-graph/g04-scope-exact-unknown.v1.json`）の base variant の期待：`arms.raw = [g04-control]`（1 件）、`rPlusIr = [g04-control, g04-lio-landing]`（`irSupplementSceneId: g04-lio-landing`）。前提条件は `b-sealed-binding`、`maintenance-enabled`、`raw-membership`、`ir-supplement-admission`。
- 実測（`gold-s5r4-1/G-04_base`）：hybrid arm の R と最終の一覧はどちらも **2 件**（期待の Raw は 1 件）。graph arm の子の IR は 1 件（R の先頭と同じ Scene）で、最終の一覧は R の 2 件のまま。**期待された `g04-lio-landing` の追加は R+IR に入っていない**。子の辺は 0 件、`f6 observed` は空。
- fixture README（`evals/nir1-graph/README.md` の前提条件の節）：範囲が variant の前提条件が成り立たなければ `blocked:<id>` と記録し、期待値は評価せず、macro 集計から除き、PASS に数えない。前提条件は観測の後に足さず・外さず・読み替えない。blocked の variant を測るには fixture の新しい版と独立期待値レビューが要る。
- 旧 S4b' の下の Gold（`gold-s5r3-1`、候補 `0b1984dd`）でも同じ結果（G-04/base が 30/30 欠落）。

## subagent の報告（integrator は未確認）

- 子の辺 0 は「R+IR の Scene に付いた path 添付の辺」と「Graph-only の path の辺」の和（`renderer/cp4-k64-probe.tsx:118-125`）。期待された添付先の `g04-lio-landing` が一覧に無いので、添付はできない。
- 余分な Raw の Scene は `g04-rv-match` の可能性が高い（Raw の意味的な類似による推測）。`g04-lio-landing` の IR が IR floor に届いていない可能性（manifest の `admissionProbe: "not-run"`、凍結前に確かめていない）。
- 同じ形が 3 つの候補（`5ce12211`、`0b1984dd`、`86427ee5`）で再現している。
- 正式実行の期待寄与は resolver が fixture の path 添付を入れており（`frozen-k64-run.mjs:1900-1954`、`material-revision.mjs:165-170`）、false になったのは観測が空で照合する相手が無いため。G-02 との違いは「期待に含まれるか」ではなく「観測があるか」。
- pool の規則（`availability.mjs:240`、`observation-prep.v1.json:227`、K6/4 draft:133）は blocked を扱わない。K6/4 draft:207 の In-scope attacks の 5（分母から除く）と 10（pool を結果を見て選ぶ）は、後から除くことを攻撃として挙げている。
- 未確認：製品の Graph DTO の nodes／edges（bren→lio が適格か）、`g04-lio-landing` の IR の score と floor の関係、Raw の score。診断（read-only）で取れる。

## 事前登録の bytes を変えずに言えること／変えるなら要る手続き

- 変えずに言える：G-04/base は `blocked:raw-membership`（`ir-supplement-admission` も併記）であり、X5 の 30 件は Graph の欠陥の証拠ではなく、前提条件が成り立たない状態の上で測った値。可用性の pool の数え方（270 件中 30 件欠落、HOLD）は、現行の事前登録のままでは変わらない。
- 変えるなら要る手続き（どちらも**ユーザーの確認**が要る）：(α) README の blocked の規則を可用性の pool にも及ぼし、G-04/base を pool から外す（結果を見た後に pool を変える緩和。K6/4 draft:207 の攻撃 5・10 に当たりうる）。(β) G-04 の fixture の新しい版（Raw の予測と IR の改訂、独立期待値レビュー、再凍結、測定のやり直し）。閾値 1% と F6・X5 の定義は変えない前提。
- 確認が下りるまで、現行の規則どおり K6/4 の可用性は HOLD のまま。

## 次（integrator）

- read-only の診断（G-04/base の cold workspace で Graph DTO の nodes／edges、IR の admission〔`g04-lio-landing` の IR の score と floor〕、Raw の score を取る。測定に数えない）で、Graph 側に欠陥が無く不成立の原因が Raw／IR 側にあることを確かめる。診断は新しい実 Electron の起動を伴うので、ユーザーの確認が要るかを含めて計画する。
