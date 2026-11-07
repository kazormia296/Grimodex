# NIR-1 最終 request 評価の契約提案 proposal/5（draft）: Graph の評価の手順の最初の表示の窓 D を 40 ms にする（K6/4 の D の行だけの改訂）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること

- CP-4 の Graph の評価で、最初の表示の窓 D を 10.84 ms から 40 ms（製品の今の値。DR-IRW-1・2、#802）に変えてよいか。窓内に数える側が広がり、親と子の IR の締切も広がるので、**合格基準の緩和**である（問 1 でユーザーが形を選んだ。この draft の確認で確定する）。
- **未確定（U-1。問 2 の聞き直し）**: CP-4 の品質の条件のうち Hybrid p95 の上限を 94.2 ms（B=54.2 ms ＋ 新しい D 40 ms。緩和）にするか、65.04 ms（今の値）のままにするか。問 2 は誤った前提で選ばれたので、integrator が訂正を添えて聞き直す。
- **未確定（U-2。問 T）**: D を 40 ms にすると、graph-late の親で公開から通知までに許される時間が 89.16 ms から 60 ms に縮む。T_late を 100 ms のままにするか広げるか。
- それ以外の K6/4 の規則（W_f 100 ms、T_show 2 s、1%、F1〜F7、X1〜X13、R1〜R8、受入れ、候補の限定）の文面は変えない。受入れと候補の限定には、D に連動する狭める項目（「変える点」の 6、K6/5-N1〜N4、K6/5-P1）を足す。

**この版（改訂 2）はユーザーの確認に出さない。** U-1 と U-2 の答えで改訂 3 を作り、未確定の書き方を消した bytes を確認に出す。

## 冒頭の開示（緩和であることと、ユーザーの選択）

- **D を広げることは、窓内に数える側を広げる＝合格基準の緩和である**。D は次の 4 か所で効く（「変える点」の 2）。(1) 窓内の判定 `t_raw_ready + D`（K6/2 の手順の 5〔705 行〕、(b) の規則の 2〔716 行〕）: 最初の表示の窓内（K6/4 の表示の可用性の一方）と (b) の窓内に数える query が広がる。(2) 親の IR の締切: 製品の IR の窓は同じ定数（`irw-decisions.md:13`）なので 40 ms に広がり、IR の timeoutRate 1%（K6/2:620、:706 の手順の 6）を満たしやすくなる。(3) 子の IR の deadline（子の Raw-ready ＋ D。K6/4 の技術点 3）が広がり、F6 を満たしやすくなる。(4) graph-late の親は Raw-ready ＋ D で公開し（K6/4:119）、F3 は通知を親の公開の後に求めるので、T_late（`t_notice − t_raw_ready ≤ 100 ms`）のうち公開の後に残る時間が 100 − 10.84 = 89.16 ms から 100 − 40 = 60 ms に縮む。**(1)〜(3) は緩和、(4) はこの区間についての厳格化**で、「どれも緩和」ではない（(4) の扱いは U-2）。
- **ユーザーは、問 1 について、これが緩和に当たることを了解した上でこの形を選んだ**（2026-11-07。AskUserQuestion で 1 回。記録は `claude/nir1-contracts` の `docs/plans/nir1-cp4-records/irw3-procedure-draft-2026-11-07.md` 末尾の「ユーザーの決定」）。問 1 の回答は「新しい契約を起案（正規）」で、D の行だけを変えた新しい draftRef を起案し、レビューと承認を経て台帳に記録する。**この選択は起案の指示で、この draft の確認ではない**（K6/4 の 2026-10-25「K6/2 は A で」と同じ扱い）。
- **問 2 は未確定として扱う（前提の訂正）**: 問 2 は「p95 は CP-4 の正式の合否に入らず、手順外の補助の記録 QV-1 だけが使う」という前提で示され（手順の起案 §1.2 (c)、§5 の Q2）、ユーザーは「94.2 ms」を「補助記録 QV-1 の上限の緩和」として選んだ。しかし /4 の行の本文には p95 の上限がある: K6/2 の 620 行（Acceptance implications の Positive）の「P の Hybrid p95 は 65.04 ms 以下」は、K6/4 の批准 6 の (i) として確認済みで（620 行の末尾の Lane unlocked だけが (ii)）、続行計画も CP-4 の品質の条件に「Hybrid p95 ≤ 65.04 ms」を数える（`nir1-continuation-2026-10.md:10`）。QV-1 は、この条件を受領書に後から当てる記録（DR-CP4-QV-1。`cp4-decisions.md:1338`）である。前提が違うので、問 2 の答えをこの draft の値とせず、両案の帰結を「未確定の点」の U-1 に並べた。integrator が訂正を添えて聞き直し、その答えで改訂 3 を確定する。
- **DR-IRW との関係**: DR-IRW-1・2（`docs/plans/nir1-lane-decisions/irw-decisions.md:24-25`。ユーザーの 2026-11-05 の回答「変えていいです」）は、製品の定数 `RELATED_SCENES_IR_EXTRA_WAIT_MS` を 40 ms の固定値にし、Graph の最初の表示の窓も同じ定数で 40 ms に広げた（#802、`a7e96946`）。DR-IRW-3（同 :26）は、この変更が K6/4 の「最初の表示の D=10.84 ms は変えない」と L0 の P の固定値「D=10.84 ms、上限 65.04 ms」を上書きすると記録したが、確認台帳（`nir1-l6-l9-execution-plan.md`）には反映されていない（:257 の K6/4 の行と :536 の P の固定値は 10.84 ms／65.04 ms のまま）。また `irw-decisions.md:31` は、CP-4 の手順（`GRAPH_EVAL_D_MS = 10.84`、`k64-procedure.v1.json`）を変えず、取り直すには手順の新しい版が要るとした。K6/4 は D の変更を K6/4 の名で行うことを許さず（批准 9。K6/4:36）、窓を広げる変更は新しい draftRef でだけ行う（変える点 16。K6/4:110）。**この draft は、DR-IRW の製品の決定を `graph-eval-procedure` の契約に取り込むための、その新しい draftRef である**。D の値（40 ms）は DR-IRW-1 が製品のために選んだ値で、この draft は値を選び直さない。

## 未確定の点（改訂 3 で確定する）

### U-1: Hybrid p95 の上限（問 2 の聞き直し）

対象の文: K6/2:620 の Positive の「P の Hybrid p95 は 65.04 ms 以下」（/4 の (i)）。母集団の読みは「変える点」の 4 に書いた（どちらの案でも同じ）。

| 案 | 上限 | 性質 | 本文への入り方 | 帰結 |
| -- | ---- | ---- | -------------- | ---- |
| U-1a | 94.2 ms（B=54.2 ms ＋ D=40 ms） | **緩和**（確認済みの 65.04 ms より 29.16 ms 緩い） | 「変える点」の 4 を置き、批准 3 と 4 の (4) に入れる | 上限の式 B+D に新しい D が入り、製品が許された待ち（最大 40 ms）を使っても上限との整合が保たれる。s5r6 の値（R+IR arm 55.30 ms、Graph arm 31.50 ms。`cp4-decisions.md:1350`）に、D の拡大が 1 call に足しうる最大 29.16 ms を足した最悪の見積り（R+IR arm 84.46 ms、Graph arm 60.66 ms）でも上限の内（推測。G-case の D=40 ms の p95 は未測定）。台帳 :536 の P の固定値（上限 65.04 ms）との食い違いが CP-4 の側にも生じ、注が要る |
| U-1b | 65.04 ms（今の値） | 変えない（緩和でない） | 「変える点」の 4 は母集団の読みだけになり、上限の値を置き換えない。批准 3 と 4 の (4) を外す | P の行・台帳 :536 と同じ値のまま。ただし 65.04 ms は D=10.84 ms の式の値で、製品が 40 ms まで待つ候補には厳しい側の値になる。上と同じ最悪の見積りでは R+IR arm 84.46 ms が上限を超え、Graph arm 60.66 ms は 4.38 ms の余裕（推測）。graph-late の親は Raw-ready ＋ D で公開する（K6/4:119）ので、graph-late が 5% を超えて残れば Graph arm の p95 は Raw-ready の p95 ＋ 40 ms 前後になる（推測）。品質の条件で HOLD になりうる |

- どちらを選んでも、QV-1 の code は B を D から逆算しない形に直す（D=40 ms からの逆算は B=200 ms、上限 240 ms で、どちらの案とも違う）。
- 観測の後に上限を広げるには新しい draftRef が要るので、改訂 3 の確認の前に決める。

### U-2: T_late（問 T）

- 事実: T_late は `t_notice − t_raw_ready ≤ 100 ms`（K6/4 の判断 3。K6/4:65）。F3 は、親の公開（`t_pub_p`）の後に受けた最初の通知を求める（K6/4:141）。graph-late の親は Raw-ready ＋ D で公開し（K6/4:119）、cache への投入（＝通知の契機）は宣言が `unused` になった後だけ（同。`nir1_graph_product.rs:888-946`）。したがって graph-late の親では `t_notice ≥ t_raw_ready + D` で、公開の後に残る時間は T_late − D。
- 計算: /4（D=10.84 ms）では 100 − 10.84 = **89.16 ms**、/5（D=40 ms）では 100 − 40 = **60 ms**（29.16 ms 縮む）。
- 観測（D=10.84 ms。dev fixture）: H5 の q1（`t_notice − t_raw_ready`）は p50 17.0／19.4 ms、max 57.3 ms（K6/4:65、:123）。H5 の「親の結果の返却から通知まで」は p50 5.5／7.8 ms（K6/4:290）。RS-JOIN の後の q1 は p50 16.6／16.3 ms、max 18.0／29.1 ms（K6/4:124）。
- 読み（推測）: 通知の時刻は「Native で親の Graph の結果がそろう時刻」と「公開（宣言）の時刻」の遅い方に、通知の遅れを足したものになる（K6/4:119 の仕組みの読み）。(a) 結果が公開の後にそろう sample では、q1 は D に依らない。(b) 結果は公開の前に Native でそろったが、renderer への到着が締切を過ぎて graph-late になった sample では、q1 ≈ D ＋ 通知の遅れで、D とともに延びる。H5 の p50 の「返却から通知まで 5.5／7.8 ms」は (b) の形が多かったことを示す。D=40 ms では (b) の多くは窓内（first-render）に移るが、残れば q1 は約 29.16 ms 延びる。**最悪の換算**（観測の q1 がすべて (b) で、公開の後の遅れがそのまま残るとする）: H5 の max 57.3 ms → 57.3 − 10.84 + 40 = **86.46 ms**（100 ms の内、余裕 13.54 ms）、H5 の p50 17.0／19.4 ms → 46.16／48.56 ms、RS-JOIN の後の max 29.1 ms → 58.26 ms。最悪の換算でも、H5 の 60 sample と RS-JOIN の後の 60 sample のうち T_late を超えるものは記録の分布の上では 0 件（max が 100 ms の内）。G-case と D=40 ms の候補での q1 は未測定。
- 選択肢:

| 案 | T_late | 公開の後に残る時間 | 性質 | 帰結 |
| -- | ------ | ------------------ | ---- | ---- |
| U-2a | 100 ms のまま（文面を変えない） | 60 ms | 公開の後の区間については**厳格化**。Raw-ready から通知までの上限（100 ms）は変わらない | 上の最悪の換算でも観測の max（86.46 ms）は内側。新しい数値を作らない。後から狭めるのは K6/4 の変える点 16 で許されるが、広げるには新しい draftRef が要る（K6/4:110） |
| U-2b | **129.16 ms**（= D ＋ 89.16 ms。公開の後の時間を /4 と同じに保つ） | 89.16 ms | **緩和**（T_late を 29.16 ms 広げる。K6/4 の判断 3 の値の変更で、「変える点」に 1 行足し、批准 4 に入れる） | D から導いた新しい数値になる（K6/4 は判断 2 の代案 (a) 2×D を「D から導いた新しい数値」として採らなかった。K6/4:64）。Raw-ready から 129 ms 後の通知まで follow-up に数える |
| U-2c | 起点を親の公開にする: `t_notice − t_pub_p ≤ 89.16 ms` | 89.16 ms | **緩和**（graph-late の親では U-2b と同じ。起点を変える） | K6/4 の判断 3 は起点を Raw-ready にした理由（遅い begin は P の側の事象）を書いており（K6/4:65）、起点の変更はその理由の改訂になる。F3・X3・K6/4-N7 の文面も変わる |

- 起案者の見立て: U-2a は新しい数値を作らず、Raw-ready からの上限が変わらず、最悪の換算でも観測は内側に収まる。U-2b・U-2c は /4 と同じ余裕を保つが緩和で、新しい数値か起点の変更を伴う。**推奨は置かず、ユーザーが選ぶ**（U-2a を選んでも「変える点」の行は増えない。U-2b・U-2c を選べば改訂 3 で「変える点」の 8 を足す）。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする（改訂 3 で U-1・U-2 の答えに合わせて 3 と 4 を確定する）。

1. 行の内容: /5 の行は、/4 の行（K6/2 の `graph-eval-procedure` の本文の全文に /4 の「変える点」の 1〜18 を当てたもの。K6/4 の「引き継ぐもの」の 1）に、この draft の「変える点」の 1〜7 を当てたものとする。表にない /4 の行の記述は変えない。
2. D の値（「変える点」の 1〜3）: 最初の表示の D を 40 ms の固定値とし、D を参照する規則（窓内の判定、親と子の IR の締切、F3 の公開の時刻ほか）は文面を変えずに 40 ms で読む。
3. Hybrid p95（「変える点」の 4）: 母集団の読みを明記する。上限は U-1 の答え（U-1a なら 94.2 ms〔B=54.2 ms ＋ D=40 ms。B は D から逆算しない〕、U-1b なら 65.04 ms のまま）。どちらでも P の評価（`evals/nir1-retrieval/manifest.json`、`scripts/quality/nir1-retrieval`）と P の行の値は変えない。
4. 合格基準の緩和に当たるもの: (1) 窓内の判定の D の 10.84 → 40 ms（最初の表示の窓内と (b) の窓内を広げる）、(2) 親の IR の締切の 10.84 → 40 ms（IR の timeoutRate 1% を満たしやすくする）、(3) 子の IR の deadline の 10.84 → 40 ms、(4) U-1a を選んだ場合の Hybrid p95 の上限の 65.04 → 94.2 ms、(5) U-2b か U-2c を選んだ場合の T_late の公開の後の時間の保持。U-2a を選んだ場合は、graph-late の親で公開の後に残る時間が 89.16 → 60 ms に縮む（厳格化）ことも、D の変更の帰結として開示する。ほかの物差し（1%、W_f 100 ms、T_show 2 s、lease 100 ms、失効率の定義）は変えない。
5. 候補の限定の追加（「変える点」の 6。狭める防御）: /5 の行は、製品の最初の表示の D が 40 ms の候補にだけ当てる。K6/4 の批准 5 の (a)〜(c) の限定はそのまま。
6. 効力（K6/4 の批准 6 と同じ 2 段）: (i) は /5 の行のうち (ii) 以外のすべてで、この承認で確認される。(ii) は K6/2 の 614 行の Delta、620 行の末尾の Lane unlocked、621 行の受入れへの影響に /4 と /5 の読み替えを当てたもので、事前の確認にとどまる。
7. 事前登録の凍結（「変える点」の 7）: K6/2 の「事前登録の凍結」の 1〜7 の「この file」をこの draft の bytes と読む。/5 で判定する CP-4 の run と条件の判定に使う診断は、/5 の凍結の後に始めたものに限る。
8. 変えないもの: 「前書き」の「変えないもの」。
9. 許さないもの: この確認そのものによる製品のコードの変更。/5 の後に D の値を変えること（広げるのも狭めるのも新しい draftRef でだけ行う）。P の評価の manifest・harness・P の行の値の変更。Gold、G-case の fixture と setup（seed の pin を含む）、凍結済みの trace の file の変更。新しい authority・保存先・送信先・製品の入口（G-01 相当の診断 run の admission の変更を含む。下の「本文に入れないもの」）。Graph の公開（PUB-G）と Session C-1 の承認。条件の成立の判定そのもの。/4 の行と /5 の行を、結果を見て選び分けること（「引き継ぐもの」の 2）。依存する契約と、K6/2・K6/3 のほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）と `nir1-l6-l9-contract-proposal/7` の行は確認しない。

注記（批准の対象ではない）: 2026-11-07 のユーザーの回答（問 1〜3、問 5）は起案の指示と選択で、確認文ではない。問 2 の回答は誤った前提で示されたので、この draft の値の根拠にしない（U-1）。「変える点」の 2、3、5〜7 の書き分け、候補の限定の追加、P の行を変えない読み、U-2 の論点は、起案者が integrator の指示（D の行と、それに連動して値が決まる箇所だけを変える）と独立レビューを受けて置いたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/5` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行、K6/4 の行と同じ。理由は「確認文」） |
| 版 | 改訂 2（2026-11-07）。下の「改訂の履歴」 |
| 起案日と基点 | 2026-11-07。製品 repo は origin/master `1822b192`（#823）で確かめた（`git show 1822b192:<path>`）。契約の bytes は `claude/nir1-contracts`（`f974121d`〜`9dbb94fb`）の worktree で読んだ。K6/4 の SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3` と K6/2 の `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` は、`1822b192` と contracts の両方で再計算し、台帳（l6-l9:193、:135）の値と一致した。以下「K6/4:n」「K6/2:n」はそれぞれの draft の行、「l6-l9」は `1822b192` の `docs/plans/nir1-l6-l9-execution-plan.md` の行 |
| baseline | `nir1-final-request-eval-proposal/4#graph-eval-procedure`（2026-10-26 Session B5 で批准 6 の (i) を確認済み。l6-l9:187-197、:257。凍結は `claude/nir1-contracts` の `5dea38af`。contracts の `docs/plans/nir1-cp4-records/k64-freeze-record.md`） |
| 前提 | 製品の最初の表示の D は 40 ms（`src/features/related-scenes/relatedScenesConfig.ts:13` の `RELATED_SCENES_IR_EXTRA_WAIT_MS = 40`。#802 `a7e96946`。DR-IRW-1・2）。IR の窓と Graph の最初の表示の合流の窓は同じ定数（`irw-decisions.md:13`、DR-IRW-2）。CP-4 の手順は今も D=10.84 ms に結び付いている（`scripts/quality/nir1-graph-eval/constants.mjs:10`、`procedure/k64-procedure.v1.json`。`irw-decisions.md:31`） |
| 変えないもの | K6/4 の「変えないもの」（K6/4:53）のうち、「最初の表示の D=10.84 ms の値」を「変える点」の 1 で、「P の B=54.2 ms、上限 65.04 ms（B+D）」を「変える点」の 4 で読み替え、ほかはすべてそのまま（Graph の result lease 100 ms、K1／proposal/7 の上限、T=2144.7 ms、「既に完了した query へ遅い Graph の結果を混ぜず、次の query で使う」、合流が 1 回だけ公開する不変条件、IR の timeoutRate 1%、失効率の物差し 1%、分母を pool すること、HOLD の既定、事前登録の凍結の規則、試験専用の入口の規則、`graph-ready` の再 query を P・IR・(a)・(b) の分母に入れないこと、DP-H・DD-1・K6/3 の規則、D-final の Graph の待ち 4 s）。W_f 100 ms、T_show 2 s、F1〜F7、X1〜X13、R1〜R8、K6/4-P1〜P3、K6/4-N1〜N40、技術点 1〜3、批准 5 の候補の限定、批准 12 の製品の変更の要件の文面。T_late 100 ms の文面（U-2 の答えで改訂 3 が確定する）。K6/2 と K6/4 の bytes |

### 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | 最初の起案（contracts `9dbb94fb`） |
| 改訂 2 | 2026-11-07 | Opus の敵対的レビュー（P1×1、P2×7、P3×6）を反映。(1) 問 1 だけをユーザーの了解つきの選択とし、問 2 は誤った前提の選択なので未確定にして、94.2／65.04 ms の両案の帰結を U-1 に並べた。(2) D を 40 ms で読んだ効果に、親の IR の締切（IR の timeoutRate を満たしやすくする緩和）と、graph-late の親で公開の後に残る T_late の時間が 89.16 → 60 ms に縮むこと（厳格化）を足し、T_late の選択肢を U-2 に数値で置いた。(3) 「受入れと候補の限定は一字も変えない」を「文面は変えず、狭める項目を足す」に直した。(4) p95 の母集団を K6/2:694・:706・:707・:620 から G-case の CP-4 の run と読み、両 arm・arm ごとの pool・nearest-rank を「変える点」の 4 に書いた。(5) 手順のファイルの v2 に B と p95 の上限を入れ、QV がそこを読む形を harness の表に書いた。(6) 候補の限定の照合を admission の定数と祖先の照合にし、`followup.mjs:496-498`（窓の不一致は ratification12、null は照合しない）を変更の表に足した。(7) 台帳 :536 の注に食い違いが残ることを書いた。(8) C7 の根拠に K6/2:617 と :702 を足した。(9) `keep_click` は DB に書かないこと（irw3 の追記）に更新した。(10) 確かめられなかったことの 1 と 5 を解いた。(11) K6/4:163・:263 を「変える点」の 2 に足した。(12) l6-l9:257 の /4 の行への注の案と、proposal/7 は台帳の注で足りることを書いた |

## 引き継ぐもの

1. /4 の行の内容を baseline とし、この draft の「変える点」の表を当てたものを /5 の行の内容とする。表にない記述は変えない。番号は「/5 の変える点 n」と呼び、/4 の「変える点」の n とは別である。
2. /4 の行との関係: /5 の確認の後、CP-4 の可用性と品質の判定（批准 6 の (i)）は /5 の行で行う。/4 の行は確認の履歴として残し、台帳の行（l6-l9:257）と /4 の凍結（`5dea38af`）は消さない。/4 の下で取った receipt（s5r4〜s5r6 の正式 run ほか）は、その時点の候補の記録として有効なまま（DR-IRW-3 の「過去の測定の記録は、その時点の候補の記録としてそのまま有効」と同じ）で、/5 の判定には使わない。**/5 の確認の後は /4 の行で新しい判定をしない**（製品の D が 40 ms の今の master の候補は /4 の D と合わない。/4 と /5 を結果を見て選び分けることを防ぐ。批准 9）。条件の成立の後に (ii) の改めての確認を求めるのは /5 の行で、/4 の行には求めない。
3. 事前登録: /4 の凍結の記録は消さずに残す。/5 の凍結は別の新しい commit で行う。K6/2 の 157 行（事前登録の凍結の 4）に従い、/4 の凍結の後にこの起案者が見た観測と、それを見た後に選んだ規則を書く。見た観測: CP-4 の正式 run s5r6 の記録（contracts `a22080bd`）と DR-CP4-QV-1 の結果（R+IR arm 55.30 ms、Graph arm 31.50 ms。`cp4-decisions.md:1350`）、D=40 ms の dev の診断 run 1・2 が集計の段の `[precheck]` で止まったこと（手順の起案 §1.1）、dev の run 3〜6 の Chronicle の停止（contracts `diag-lpd-2026-11-02/chronicle-late-publish-2026-11-07.md`）、DR-IRW の PD 評価（`irw-decisions.md:15-17`）。**D=40 ms の値は DR-IRW-1 が製品のために選んだ値で、この起案者は観測を見て値を選んでいない。ただし、それを CP-4 に当てる判断（問 1）、p95 の上限（U-1）、T_late の扱い（U-2）は、上の観測を見た後に選ばれる**。どの観測も /5 の判定に使える診断ではなく、予告として扱う。
4. K6/2、K6/3、K6/4 の確認の記録と注（l6-l9:175-197、:257、:271-280）は消さない。

## 変える点（/4 の行との関係）

次の表の文だけを置き換える（または読み替える）。表にない記述は変えない。**1、2 は /4 の行より弱い読み**（緩和。批准 4 の (1)〜(3)）。**4 は U-1a なら弱い読み、U-1b なら母集団の読みの明記だけ**。2 のうち F3 の公開の時刻は、U-2a なら公開の後の区間について強い読み（厳格化）になる。3 と 5 は 1 に伴う読み、6 は狭める防御、7 は事前登録の扱いである。**文面（数値）を置き換えるのは 1 と、U-1a の場合の 4 の数値だけで、ほかは文面を変えずに読みを定める**。

| n | 箇所（/4 の行） | 旧（要旨） | 新 | 理由 |
| - | --------------- | ---------- | -- | ---- |
| 1 | D の値を述べる箇所: K6/4:53（「変えないもの」の先頭）、K6/4:8、:18、:184 の「10.84 ms」、K6/2:613（Baseline）の「D=10.84 ms（`min(100ms, 0.20*B)`）」のうち、この行の窓としての D | 最初の表示の D=10.84 ms（`relatedScenesConfig.ts:7`）。D は P の式 `min(100ms, 0.20*B)` の値 | 最初の表示の D=40 ms（`relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS`。DR-IRW-1・2、#802 `a7e96946`）。**D は固定値で、P の式からは導かない**。K6/4:8、:18、:184 の「10.84 ms」は 40 ms と読む | 製品の窓に合わせる。DR-IRW-1 の値をそのまま使う（緩和。批准 4 の (1)） |
| 2 | D を参照する規則（文面は変えず、値が 40 ms になる）: K6/2:619（(b) の cache 由来の窓内 `t_raw_ready + D`）、:694（D の窓の起点）、:705（手順の 5。窓内の判定と `graph-late`）、:706（手順の 6。IR の timeoutRate。製品の IR の締切は同じ D）、:716（(b) の規則の 2）、:717（窓外率「D の窓に届いたか」）、K6/2:620 の Positive の「IR の timeoutRate は … 1% 以下」。K6/4:22・:52（first-render の窓内）、:53（子の IR の deadline「子の Raw-ready + D」）、:80（技術点 3）、:99（変える点 5）、:109（変える点 15 の「D の窓内か follow-up の成功」）、:111（変える点 17 の親の D と子の IR の `t_raw_ready_c + D`）、:119（graph-late の親は Raw-ready ＋ D で公開）と :141（F3 の `t_pub_p` の後の通知）、:144（F6）、:163（遅れた Graph を親の表示に混ぜたら FAIL）、:167（表示の可用性）、:175〜:177（批准 12 の「親とほかの契機は D のまま」、(5) 子の IR の deadline、試験）、K6/4-P2（:227）、N1（:232）、N30（:261）、N32（:263）、N39（:270） | D=10.84 ms で判定する | 同じ文を D=40 ms で判定する。W_f（100 ms）≥ D（40 ms）なので、変える点 17 の「子の Graph の成分は W_f、子の IR は D」の関係と、製品の合流の前提（Graph の窓 ≥ IR の締切。`irw-decisions.md:13`、:25）は保たれる | 1 に連動。効果は 4 つ（冒頭の開示）: (1) first-render と (b) の窓内が広がる、(2) 親の IR の締切が広がり IR の timeoutRate を満たしやすくなる、(3) 子の IR の deadline が広がり F6 を満たしやすく X5 の子の IR の timeout が減る、の 3 つは緩和（批准 4 の (1)〜(3)）。(4) graph-late の親の公開が Raw-ready ＋ 40 ms になり、T_late のうち公開の後に残る時間が 89.16 → 60 ms に縮む（U-2a なら厳格化。U-2） |
| 3 | D を変えない・広げないと述べる箇所: K6/2:609（「D を広げるのは閾値の緩和にあたり、この行の外で、別の確認を要する」）、:614（Delta の「D … は変えない」）、:617（In-scope attacks「D を黙って広げるか、別の D で測ること」）、:618（Out-of-scope「D の変更（この行の外）」）、:619（「D は変えない」）、:620（Negative「D を変える」）、:621（受入れへの影響「D … は変えない」）、:633（「D を広げることは、どの案にも含めない」）。K6/4:18・:32（「D の値は最初の表示に残す」）、:36（批准 9「最初の表示の D の値の変更」）、:184（「D の値は変えない」）、:210（Acceptance implications「最初の表示の D の値 … は変えない」） | D=10.84 ms を変えない | 文面は変えない。D は 1 の 40 ms と読む。**/5 による 10.84 → 40 ms は、K6/2:609・:633 のいう「別の確認」と、K6/4 の変える点 16（K6/4:110）のいう「新しい draftRef」にあたる**。確認の対象として名指すので K6/2:617 の「黙って」に当たらず、K6/4 の名で行うのではないので K6/4:36 にも当たらない。/5 の後に D を変える（広げる・狭める）ことは、これらの文のとおり許さない（新しい draftRef が要る。批准 9） | 1 の変更を、変えない側の規則と両立させる |
| 4 | Hybrid p95: K6/2:620（Acceptance implications の Positive）の「P の Hybrid p95 は 65.04 ms 以下で、receipt に D2a の mode と restricted の再認可の内訳がある」、K6/4:53 の「P の B=54.2 ms、上限 65.04 ms（B+D）」、K6/4:210 の「P の Hybrid p95 … は変えない」、K6/2:613 の「Hybrid p95 の上限 65.04 ms（B+D）」 | CP-4 の受入れで Hybrid p95 を 65.04 ms（B=54.2 ms ＋ P の式の D=10.84 ms）と比べる。母集団は文面に無い | **母集団の読み（U-1 のどちらでも）**: K6/2:620 の「P の Hybrid p95」は、CP-4 の G-case の run（K6/2:694 の手順の 2〔case と arm ごとに warm-up 5 回の後に 30 回、R+IR と R+IR+Graph を AB／BA で交互、起点 `t_fetch`、終点 `t_return`〕、:706・:707〔timeoutRate と再 query の扱い〕、:620〔receipt に D2a の mode を書く〕）の値と読む。p95 は `t_return − t_fetch` の nearest-rank の p95 で、measured の全 variant を **arm ごとに pool** し、**R+IR arm と R+IR+Graph arm の両方**が上限以下のときだけ満たすとする。failed な call は落とさない。`graph-ready` の子は分母に入れない（:707）。**上限**: U-1a なら **94.2 ms（B=54.2 ms ＋ 1 の D=40 ms）** と読み、K6/4:210 の「P の Hybrid p95 は変えない」は測ることと式（B+D）と母集団を変えないと読む。U-1b なら 65.04 ms のまま。どちらでも B は確認済みの 54.2 ms で、D から逆算しない。K6/2:613 と K6/4:53 の P の固定契約の記述は、P の評価（`evals/nir1-retrieval/manifest.json` の `performance.warm`、`scripts/quality/nir1-retrieval`）の値として読み、/5 はそれを変えない（P の 24 件の評価と過去の receipt は P の式の D=10.84 ms・上限 65.04 ms のまま） | 母集団は確認済みの文の読みの明記（DR-CP4-QV-1 の事前登録の読みと同じ）。上限は U-1 の答え（U-1a は D に連動する緩和。批准 4 の (4)） |
| 5 | 導出・観測・事実・選択肢の記述で D と比べている箇所（文面は変えない）: K6/4:17（「一覧はその 10.84 ms 後に出る」）、:19、:22 の (3)(4)、:63〜:66（判断 1〜4 の導出と代案。「2×D = 21.68 ms」「565.04 ms」を含む）、:70、:80 の根拠、:118〜:127（「事実」）、:181〜:182、:216（「D は P の固定契約の一部」）、:285、:290 | /4 の起案の時点の D=10.84 ms と比べた記述 | /4 の起案の時点の D=10.84 ms との比較（履歴）として読み、規則として読まない。W_f・T_show の値とその導出は変えない（T_late は U-2）。「D′ の下では first-render は構造上 HOLD」（:17〜:22、:63）は D=10.84 ms での観測で、D=40 ms では親が D の内に Graph を受ける sample が出うる（DR-IRW-2「Graph が最初の表示に入る機会が増える」）。その sample は K6/4-P2 で first-render の窓内に数え、子は出ない（規則は変えない） | 1 に伴う読み。観測を書き換えない |
| 6 | 候補の限定（K6/4:32 の批准 5 の末尾への追加） | （なし） | /5 の行は、製品の最初の表示の D が 40 ms の候補にだけ当てる。**run の前に admission で照合する**: 候補の commit が `a7e96946` を祖先に含み、候補の `src/features/related-scenes/relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 で、手順のファイルの D が契約の D と一致すること。合わなければ run を始めず `[precheck]` にする（K6/4 の行の D とも合わないので、そちらでも判定しない）。**sample ごとの照合**: 親の合流に渡した窓の値（`timing` の `graphWindowMs`）が D と一致すること。値が無い（null）sample は照合できたとせず、/5 の判定を `[precheck]` にする（K6/4 の N30 の照合〔`followup.mjs:496-498`〕は、不一致を ratification12〔K6/2 の文のまま扱う〕に入れ、null なら照合しないので、そのままでは足りない） | 契約の D と製品の D の食い違いで測ることを防ぐ（狭める防御） |
| 7 | 事前登録の凍結と効力の時点: K6/4:34（批准 7）、:108（変える点 14）、:317（凍結の順序） | 「この file」は K6/4 の bytes。receipt の先頭に /4 の凍結の commit と SHA-256 | 「この file」は /5 の bytes。/5 で判定する CP-4 の run と条件の判定に使う診断は、/5 の凍結の後に始めたものに限り、receipt の先頭に /5 の凍結の commit と SHA-256 を書く（/5 の行は /4 の bytes の上に立つので、/4 の凍結の commit と SHA-256 も併せて書く）。/5 の凍結の前の観測（「引き継ぐもの」の 3）は予告で、/5 の判定に使わない | /4 の変える点 14 と同じ形 |

## 本文に入れないもの（手順の側で扱うもの）と理由

| 事項 | 本文に入れるか | 理由（/4 の行の構成から） |
| ---- | -------------- | ------------------------- |
| C7（Chronicle の Index が使えない begin を trace の対応から外し、K6/2 の規則 3 の (i) の `i-chronicle-stop` として数える。手順の起案 §1.3、ユーザーの決定 問 3） | **入れない**。S2 追補 #14 と S3 の独立レビュー、S4 の 6 回目の凍結で扱う | 数え方は /4 の行の本文がすでに定めている: K6/2:717 の規則 3 の (i)（「開始時に Chronicle の Index が使えず（同じ query の IR の outcome が `index-unavailable`）」）、:718 の規則 4 の失効の区分（「Graph の outcome の名前によらない」）、:719〜:720（「`cancelled`〔3 の (i) の Chronicle の停止によるものを除く。それは失効に入る〕」）、規則 8 の記録（「(i) は B の seal によるものと Chronicle の停止によるものに分ける」）、K6/4 の変える点 15（K6/4:109。follow-up の失敗の区分で「Chronicle の停止」は「失効」）。さらに K6/2:617 の In-scope attacks は「Chronicle の停止で融合の規則により Graph が止まった query を、Graph の outcome の名前（`cancelled`、`not-requested` など）を理由に、その他に入れるか、**run の無効にすること**」を攻撃とする。今の S2 の TP-1（「M < N は整列の失敗」。`observation-prep.v1.json:282`）は、この形の begin があると run を無効にするので、この攻撃の形に当たる。C7 は harness を確認済みの文に合わせる改訂で、K6/2:620 の Negative の「観測の後に定義を変える」には当たらない（定義〔規則 3・4・8〕は変えず、凍結済みの trace の file も作り直さない。K6/2:702 が作り直しを許すのは不備のときだけで、C7 は trace の file に触れない）。/4 の行は Native の begin の記録と trace の begin の一対一の対応を定めていない。/4 の行の防御（K6/2:619 の「手順、trace、基準を CP-4 の観測の前に固定し、独立 reviewer のレビューを受ける」、K6/4:209 の「分類器は Negative の合成の記録で検出力を示してから使う」）は、C7 にもそのまま当たる。C7 は T_late・W_f・T_show・F1〜F7・X1〜X13・R1／R4 の待ちを広げない（K6/4 の変える点 16 の列挙に触れない） |
| G-01 相当（PUB-G #16 の決定 (C)。G-01 の凍結素材での end-to-end を診断の run として同じ凍結に同梱する。ユーザーの決定 問 5） | **入れない**。S2 追補 #14 と S4 の 6 回目の凍結で、CP-4 の判定に数えない診断として扱う | /4 の行の判定は G-case の可用性と品質だけで、判定に数えない診断の run を定めない。click の `keep_click` は DB に書かない（メモリだけ。DB への接触は read tx だけ。irw3 の起案の追記〔contracts `b1ca2282`、`irw3-procedure-draft-2026-11-07.md:266-271`〕）ので、保存範囲の拡大には当たらない。残る委任の外は admission の変更（新しい purpose か凍結素材を許す経路。新しい authority の候補）で、K6/4 の批准 9 は新しい authority を K6/4 の確認で許さず、/5 もそれを保つ（批准 9）。したがって /5 の確認は G-01 相当の admission の変更を許可せず、S2 追補 #14 の確認で扱う。G-01 相当の run は CP-4 の判定の session と分け（`countsInCaseJudgement: false`）、K6/4 の R4（sample の間に別の query を起こさない）に触れない |
| QV-1 の code の直し（`deriveLatencyPolicy` が B を D から逆算するので、D=40 ms では上限が 240 ms になる） | **入れない**。harness の実装で直す | 本文が定めるのは上限の値と B（「変える点」の 4）だけで、code の形は定めない。ただし防御として、B と上限は手順のファイルの v2 に入れて凍結し、QV がそこを読む（下の harness の表） |
| `BOUNDARY_TOLERANCE_MS`（0.01 ms）の注記 | 入れない | S2 の `registeredForReview` の注記で、本文の値ではない |

## threat model（/4 の行への加算）

合格基準の緩和なので、確認されるまで draft とする。この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（製品のコードを変えず、評価の値と読みだけを変える）。

- In-scope attacks（加える）: 17. 契約の D（40 ms）と違う D で測る、または手順のファイル・harness の D が契約の D と違う。18. 製品の D が 40 ms でない候補に /5 の行を当てる、または親の合流の窓の値が記録されていない sample を照合できたとする（「変える点」の 6）。19. /5 の凍結の前に取った receipt（/4 の下の receipt を含む）を /5 の判定に使う、または /4 と /5 の行を結果を見て選び分ける。20. Hybrid p95 の上限を、P の評価の 65.04 ms と U-1 で確定した値のどちらで比べるかを結果を見て選ぶ、B を D から逆算して上限を変える（D=40 ms からの逆算は B=200 ms、上限 240 ms になる）、または母集団（arm ごとの pool、両 arm）を結果を見て選ぶ。
- Mandatory defenses（加える）: 「変える点」の 6 と 7。手順のファイルの D、B、Hybrid p95 の上限は、観測の前に /5 の凍結と手順のファイルの新しい版（v2）で固定し、独立 reviewer のレビューを受ける。品質の判定（QV）は、上限と B を v2 から読み、constants の契約の値と一致しなければ `[precheck]` にする。
- Acceptance implications（読み替え）: K6/4:210 の「品質の条件、IR の timeoutRate、P の Hybrid p95、最初の表示の D の値、失効率の物差しは変えない」は、/5 の後は「変える点」の 1 と 4 の値で読む（D は 40 ms、Hybrid p95 の上限は U-1 の答え）。ほかは変えない。

## 受入れ（/4 の行への加算）

番号は K6/4 と衝突しないよう `K6/5-` を付ける。CP-4 の分類器と品質の判定は、合成の記録で次を期待どおりに分けることを、観測の前に示して記録する（K6/4:209 と同じ。前回の検出力の記録は contracts `docs/plans/nir1-cp4-records/k64-synthetic-detection-record.md`）。

- K6/5-N1: 手順のファイルの D が 40 ms でない receipt（In-scope attack の 17）。
- K6/5-N2: 候補の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 でない、`a7e96946` を祖先に含まない、親の合流に渡した窓の値が 40 ms でない、またはその値が null の receipt を /5 の行で判定した（18。`[precheck]`）。
- K6/5-N3: receipt の先頭に /5 の凍結の commit と SHA-256 が無い、または /5 の凍結の前に始めた run の receipt（19）。
- K6/5-N4: Hybrid p95 を U-1 で確定した上限以外（65.04 ms、94.2 ms のうち選ばなかった方、240 ms ほか）と比べた判定、B を 54.2 ms 以外の値で求めた判定、または片方の arm だけで判定した receipt（20）。
- K6/5-P1: D=40 ms の窓内に親が Graph を受けた sample を first-render の窓内に数え、子を出さない（K6/4-P2 を 40 ms で読んだもの。「変える点」の 5）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 の手順（S2 追補 #14、S3、S4 の 6 回目の凍結） | 手順のファイルの新しい版（D=40 ms、B、Hybrid p95 の上限、/5 の draftRef と SHA-256）、harness の変更（下の表）、C7 と G-01 相当（手順の側）、/5 の凍結の head の receipt への記録、K6/5-N1〜N4 と C7 の合成の記録による検出力の記録の取り直し |
| P の評価（`nir1-retrieval`） | 影響しない（「変える点」の 4）。P の評価を D=40 ms に合わせるかは、この draft の外（台帳 l6-l9:536 の P の固定値の個別の確認） |
| DR-IRW（製品） | 影響しない。/5 は製品の値を契約に取り込むだけ |
| PUB-G／Session C-1 | 開示の項目（K6/4 の「UX と製品の意味」）の D は 40 ms で読む。PUB-G の承認は置き換えない |
| DD-1、DP-H、K6/3 | 影響しない |

### この draft が確認されたときに変わる harness の file（実装はしない。製品 repo の `1822b192` の行）

| file | 変わる中身 | pin |
| ---- | ---------- | --- |
| `scripts/quality/nir1-graph-eval/constants.mjs` | `:10` の `GRAPH_EVAL_D_MS` を 40 にし、`:9` の注記（「D = min(100 ms, 0.20 * B) … never recomputed」）を「/5 と DR-IRW-1 の固定値。式から導かない」に直す。契約の B（54.2 ms）と Hybrid p95 の上限（U-1 の値）の定数を足す。U-2b なら `K64_T_LATE_MS` を 129.16 に（U-2c なら起点の変更で、followup の照合も変わる）。`:56-65` の `K64_FREEZE` は残し（trace の file と S2 が K6/4 を束縛する）、/5 の凍結の descriptor（path、sha256、draftRef `nir1-final-request-eval-proposal/5`、contractId、confirmedCommit、freezeCommit）を足す。`:341` の `[precheck]` の文は値を読むだけ | `g4-b1-freeze-v2-constants` ほか（pin のし直し） |
| `scripts/quality/nir1-graph-eval/procedure-file.mjs` | `:126-131` の `contract` の照合先（`K64_FREEZE` の draftRef・sha256）を /5 の descriptor にする。`values` の key（`:62-68`）に `bMs` と `hybridP95LimitMs` を足し、constants の契約の値と一致を求める（schema の版を上げる。`TOP_KEYS` は `:53-61` で固定）。注記（`:3-5`、`:21`、`:45`）の「K6/4」を /5 の行に直す。`values.dMs` の照合（`:64`）は constants を読むので値は自動で 40 | `HARNESS_FILES` に入る（持つ pin は実装の時に `harnessPinOf` で確かめる） |
| `scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-3.json` → `k64-procedure.v2.json`（新規。v1・draft-2 は残す） | `contract` を /5（draftRef、contractId、SHA-256）、`values.dMs` を 40、`values.bMs` を 54.2、`values.hybridP95LimitMs` を U-1 の値、`review` を S3 の記録に | S4 の `boundFiles` |
| `scripts/quality/nir1-graph-eval/frozen-k64-admission.mjs` | `:46` の `FORMAL_PROCEDURE_VERSION` を `"v2"` に。`:237` の凍結の head の読取に /5 の head を足す | pin のし直し |
| `scripts/quality/nir1-graph-eval/admission.mjs` | `:466-500` の `readK64FreezeHead` と `:834-836` の `head.k64` の照合に、/5 の凍結の head を足す（または descriptor を受ける形を /5 にも使う）。「変える点」の 6 の照合（候補の commit が `a7e96946` を祖先に含むこと、候補の `relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 であること）を足す | `s4-rehearsal-admission`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/followup.mjs` | `:496-498` の親の窓の照合: /5 の下では、不一致を ratification12 ではなく `[precheck]`（/5 の判定をしない）にし、`graphWindowMs` が null の sample も照合できたとしない。U-2b・U-2c なら T_late の照合（F3） | `v4-followup-cancelled-match`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/receipt.mjs` | `:402-411` は `K64_FREEZE.freezeCommit` の receipt だけを通す。「変える点」の 7 で receipt の先頭に /5 の凍結を書くので、/5 の head を検査する形に変わる見込み（手順の起案 §2.1 は bytes を変えずに済むかを未確認とした） | `t14-k64-freeze`（変えるなら pin のし直し） |
| `scripts/quality/nir1-graph-eval/frozen-diagnostics.mjs:920`、`:960`、`diagnostic-runner.mjs:402` | `head.k64` の扱いに /5 の head を足す | 実装の時に確かめる |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs:68-93` の `deriveLatencyPolicy`、`quality-verdict-cli.mjs:37-38`（`PROCEDURE_FILE` が v1 の path）・`:242`・`:253`・`:402`・`:438` | B を D から逆算せず、手順のファイル v2 の `bMs` と `hybridP95LimitMs` を読み、constants の契約の値と一致を確かめる。手順のファイルを v2 に | pin の外（DR-CP4-QV-1）。値は v2（S4 が束縛）から読むので、上限は凍結の内にある |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `:80-83` の契約の期待値に /5 を足す（`:2886-2889` の trace の照合は K6/4 の bytes のままにする）、`:393` の `PROCEDURE_V1`、`:1548-1549` の placeholder（`k64-procedure-v1-commit`／`-sha256`）を v2 に、`SOURCE_PINS` | 凍結の検査そのもの |
| `evals/nir1-graph/observation-prep.v1.json`（S2 追補 #14） | `contracts` に /5（draftRef、contractId、path、SHA-256、confirmedCommit、freezeCommit）を足す。`k64Procedure`（v2、`values.dMs` 40、`bMs`、`hybridP95LimitMs`、`valueReasons.dMs` の「P の固定契約で K6/4 の変えないもの」を /5 の理由に）、`userConfirmations` に /5、`registeredForReview` の `BOUNDARY_TOLERANCE_MS` の注記（`:366-372`） | S4 が束縛 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | S4 の 6 回目の凍結（`boundFiles` の sha256） | — |
| `evals/quality-manifest.yaml:706` | `k64-procedure.v2.json` を足す | — |
| `scripts/quality/nir1-graph-eval/hook-check.mjs:38-40` | 注記だけ（10.840000000596048） | 診断用 |
| 試験（constants・procedure-file・frozen-k64-admission・admission・followup・receipt・quality-verdict、K6/5-N1〜N4 の合成の例） | 追加・更新 | 試験は pin の対象外 |
| 変えないもの | `evals/nir1-graph/trace-editing.v1.json`・`trace-browsing.v1.json`。`observation-prep.mjs:2886-2889` は trace の `contract.k64.sha256` を `CONTRACTS.k64`（K6/4 の bytes）と比べるので、`CONTRACTS.k64` を K6/4 のまま残し /5 を別の key で足せば、trace の束縛はそのまま有効（trace が引く K6/4 の変える点 15、R8、変える点 12 は /5 で変わらない）。`observation-prep-author-declaration.v1.json` の K6/4 の読み（宣言を作り直すなら /5 を足す） | — |

## 確かめられなかったこと

1. `nir1-l6-l9-contract-proposal/7`（確認済み）の 31 行は窓外率を「最終 request の窓（D=10.84 ms。K6/2）」と説明する。用語の説明で、窓の値の正本は `graph-eval-procedure` の行なので、台帳の注で足りる（下の注の案）。/5 は proposal/7 の行を確認も変更もしない。
2. 台帳 l6-l9:437、:536、:768、:781 の P の固定値（D=10.84 ms、上限 65.04 ms）と、製品の D 40 ms・DR-IRW-3 の上書きの食い違い。/5 は P の行を変えないので解かない（P の評価を D=40 ms に合わせるなら個別の確認が要る。:536）。
3. `receipt.mjs` の bytes を変えずに /5 の凍結の head を receipt に書けるか（pin `t14-k64-freeze`）。
4. D=40 ms で親が D の内に Graph を受ける sample の頻度、graph-late の親の q1（U-2 の (b) の形が残る割合）、両 arm の Hybrid p95（G-case でも trace でも未測定）。U-1・U-2 の見積りは D=10.84 ms の dev fixture と s5r6 の値からの推測である。
5. 改訂 2 の再レビューはまだない。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（2026-10-25 の緩和の後。l6-l9:307）に従い、`nir1-final-request-eval-proposal/5` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。構造化質問なら、質問の文が draftRef、contractId、この draft の SHA-256 を名指し、ちょうど 1 つの `draftRef#contractId` を示す。承認の効力は批准 6 の 2 段で、(i) は確認、(ii) は事前の確認である。依存する契約と、ほかの contractId の行は確認されない。
- **確認に出すのは改訂 3 だけ**。改訂 2 は U-1・U-2 が未確定なので確認に出さない。integrator は U-1（問 2 の前提の訂正を添える）と U-2 をユーザーに聞き、その答えで改訂 3 の「変える点」と批准 3・4 を確定し、未確定の書き方と選ばれなかった案の帰結を開示の記述に改めてから、改訂 3 の SHA-256 を示して確認を求める。改訂 3 の確認の後に違う選択をするには、新しい draftRef で起案する。
- 確認の質問の文には、(1) 緩和の項目（窓内の判定・親と子の IR の締切の D 10.84 → 40 ms、U-1a なら Hybrid p95 の上限 65.04 → 94.2 ms、U-2b・U-2c なら T_late の変更）、(2) U-2a なら graph-late の親で公開の後の時間が縮む厳格化、(3) P の評価の値は変えないこと、(4) C7 と G-01 相当は /5 に含めず手順の側で扱うこと、を書く。
- 2026-11-07 のユーザーの回答（問 1〜3、問 5）、U-1・U-2 への回答、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。CP-4 は AGENTS.md の NIR-1 の残レーンに入っておらず、技術判断の事前委任も無い（手順の起案 §3）。

### 確認までの手順（前例どおり）

1. 起案（初版）と独立レビュー（Opus の敵対的レビュー。済み）→ 改訂 2（この file）。
2. U-1・U-2 をユーザーに聞く（integrator）。答えで改訂 3 を作る。改訂 3 の差分が大きければ、もう一度独立レビュー（read-only。この draft と、K6/4・K6/2 の引いた行、`irw-decisions.md` を渡し、起案者の結論は渡さない）。改訂 3 の SHA-256 を確定する。
3. ユーザーの確認（上の形）。
4. 確認の記録: `claude/nir1-contracts` に確認の記録（前例 `docs/plans/nir1-cp4-records/user-confirmation-2026-11-04-scope-default-contract.md` の形。質問と回答の逐語、日付、draftRef#contractId、SHA-256）を commit する。続行計画（`docs/plans/nir1-continuation-2026-10.md`）の §10 に節を足す（§10.7 Session B5 の形）。
5. 台帳の更新（master への PR）: draft を確認された版から byte 同一で `docs/plans/nir1-final-request-eval-proposal-5-draft.md` に取り込み（`git show <commit>:<path>` の出力をそのまま置く）、`sha256sum` の一致を確かめ、下の補足・行・注を足す。「Status: draft／未確認」の行は bytes を変えないために残す。
6. contracts の凍結: S2 追補 #14 の S4（6 回目）の前、かつ /5 で判定する最初の run の前に、確認された bytes を `claude/nir1-contracts` の `docs/plans/nir1-final-request-eval-proposal-5-draft.md` に commit して push し、K6/2 の「事前登録の凍結」の 1〜7 の記録（`k64-freeze-record.md` と同じ形の `k65-freeze-record.md`。凍結の commit、file の SHA-256、`git ls-remote`、push の時刻、remote 側の時刻〔repository activity と PushEvent〕）を作る。凍結の後、`claude/nir1-contracts` は fast-forward だけで進める。
7. その後に、harness の実装、S2 追補 #14、S3、S4 の 6 回目の凍結、正式 run（手順の起案 §4）。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足（l6-l9:187-197 の Session B5、:211 以降の X1/3 と同じ形）の見出し: 「2026-11-xx補足（K6/5）」。受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256、確認の記録の commit。「経緯」に DR-IRW-1〜3（製品の D の 40 ms、2026-11-05）、`irw-decisions.md:31`（手順の新しい版が要る）、2026-11-07 のユーザーの選択（問 1）、問 2 の前提の訂正と U-1・U-2 の回答を書く。表の行 ID は `K6/5-1`（Session の名前を持たない確認の記録の前例。X1/3-1、SDEF/1-1）。「承認の範囲と効力」と「K6/5 が許さないもの」（批准 9）の段落を足す。
- 確認台帳の行の案（l6-l9:257 の /4 の行の下に足す。/4 の行は消さない。〔 〕は改訂 3 で U-1・U-2 の答えに置き換える）:

| contractId | draftRef | confirmedRef | confirmedScope | 備考 |
| ---------- | -------- | ------------ | -------------- | ---- |
| `graph-eval-procedure` | `nir1-final-request-eval-proposal/5` | `nir1-final-request-eval-proposal/5#graph-eval-procedure`（批准6の(i)についてだけ。(ii)は `preConfirmationRef` で、効力の根拠にしない） | K6/5の範囲: draft冒頭の「ユーザーが批准すること」の1〜9の全項目（この一覧が範囲の正本で、台帳は別の列挙を持たない）。/5の行の内容は、/4の行（K6/2の `graph-eval-procedure` の本文の全文に/4の「変える点」の1〜18を当てたもの）に、/5の「変える点」の1〜7を当てたもの。最初の表示のDを40 ms（DR-IRW-1・2の製品の固定値。Pの式から導かない）とし、Dを参照する規則（窓内の判定、親と子のIRの締切、graph-lateの親の公開の時刻ほか）は文面を変えずに40 msで読む。CP-4の受入れ（K6/2の620行）のHybrid p95は、G-caseのCP-4のrunのR+IR armとR+IR+Graph armをarmごとにpoolしたnearest-rankのp95で、両armが上限〔94.2 ms（B=54.2 ms＋D=40 ms。BはDから逆算しない）／65.04 ms〕以下。T_lateは〔100 msのまま（graph-lateの親で公開の後に残る時間は60 ms）／129.16 ms／公開を起点に89.16 ms〕。**合格基準の緩和**: Dの10.84→40 ms（窓内、親と子のIRの締切）〔、Hybrid p95の上限の65.04→94.2 ms〕〔、T_lateの変更〕。/5の行は製品のDが40 msの候補にだけ当てる（「変える点」の6）。W_f 100 ms、T_show 2 s、1%、F1〜F7、X1〜X13、R1〜R8、受入れ、批准5の候補の限定は/4のまま。Pの評価（`nir1-retrieval` のmanifestとharness）とPの行の値、C7とG-01相当（手順の側）、依存する契約、`nir1-final-request-packing-eval`、`g01-eval-revision`、proposal/7の行は確認しない | (i)は確認済みで、記録の時点からCP-4の可用性と品質の判定に使う（/4の行に替わる。/4の行と、/4の下のreceiptは履歴として残し、/4の行で新しい判定はしない）。(ii)は/4の行と同じく、条件の成立、診断とreceiptの照合、改めての確認の後にだけ効く。/5の凍結（`claude/nir1-contracts` へのcommitとpush、K6/2の「事前登録の凍結」の1〜7の記録）の前に始めたrunは/5の判定に使わない。この確認は、Graphの製品公開、local送信の公開、activation UIの公開、新しいauthority・保存先・送信先・製品の入口を許可しない |

  （実際の台帳の行は l6-l9:257 と同じ 10 列（lane、startStatus、blockers、英文の記録の列を含む）で書く。英文の記録の列の案: `confirmedRef=nir1-final-request-eval-proposal/5#graph-eval-procedure` (ratification 6 (i) only); `preConfirmationRef` for ratification 6 (ii); confirmed <date> by <form>; chosen option verbatim; draft `docs/plans/nir1-final-request-eval-proposal-5-draft.md` at commit `<commit>`, SHA-256 `<sha256>`; this independently ratifies only this row; the /4 row above is kept as confirmation history and is not used for new determinations; the user's 2026-11-07 choices and the answers to U-1/U-2 were drafting instructions and are not a confirmation。lane は「CP-4、PUB-G（Session C-1 の開示の項目）」、startStatus は /4 と同じく `condition-not-met`（(ii) について）。）

- 台帳の注の案:
  - l6-l9:257 の /4 の行の備考の末尾に「2026-11-xx 追記（K6/5）: /5 の確認の後、CP-4 の判定は /5 の行で行い、この行で新しい判定はしない（/4 と /5 を結果を見て選び分けることを防ぐ）。この行の下で取った receipt は、その時点の候補の記録として残る」。
  - l6-l9:275 の 2026-10-26 の注（K6/4）の下に「2026-11-xx の注（K6/5 `nir1-final-request-eval-proposal/5#graph-eval-procedure`。上の注は消さず、読み替えを足す）: K6/5 の確認により、/4 の行は K6/5 の「変える点」の 1〜7 を当てて読む。(1) 最初の表示の D は 40 ms の固定値（DR-IRW-1・2）で、P の式から導かない。D を参照する規則（K6/2 の 619、694、705、706、716、717 行、/4 の F3・F6、変える点 15・17、技術点 3、批准 12 ほか）は文面を変えずに 40 ms で読む。(2) 「D を変えない・広げない」の文（K6/2 の 609、614、617〜621、633 行、/4 の批准 5・9 ほか）は D=40 ms について読み、/5 の 10.84 → 40 ms はその「別の確認」と「新しい draftRef」にあたる。(3) K6/2 の 620 行の Hybrid p95 は G-case の CP-4 の run の両 arm を arm ごとに pool した nearest-rank の p95 で、上限は〔U-1 の値〕。P の評価の値は変えない。(4) T_late は〔U-2 の答え〕。(5) /4 の『事実』と導出の D との比較は /4 の起案の時点の 10.84 ms との比較として読む。**緩和は〔確定した項目〕**」。
  - l6-l9:280 の注（K6/2 の条件付きの 2 行の『`confirmedRef` を持たない』は /4 の (i) に当てない）の下に「2026-11-xx の注（K6/5）: 同じ読みを /5 の行の (i) にも当てる。/5 の行の一部だけの `confirmedRef` は /4 の行と同じ形」。
  - l6-l9:536 の P の固定値の段落の下に「2026-11-xx の注（K6/5）: `graph-eval-procedure`（K6/5）の CP-4 の判定では、最初の表示の D は 40 ms、Hybrid p95 の上限は〔U-1 の値〕。**これは P の値の変更ではない**: P の評価（`nir1-retrieval`）の B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms はこの確認で変わらない。製品の D 40 ms（DR-IRW-1・2）とこの段落の D=10.84 ms の食い違い（DR-IRW-3 の上書きが台帳に反映されていないこと）は、この注の後も残る。解くには P の固定値の個別の確認が要る」。
  - proposal/7 の行（`graph-limited-binding`）の備考に「2026-11-xx の注: proposal/7 の 31 行の『D=10.84 ms。K6/2』は窓外率の用語の説明で、窓の値の正本は `graph-eval-procedure` の行（K6/5 の後は 40 ms）。この注は proposal/7 の行の確認を変えない」を足す（用語の説明なので注で足り、proposal/7 の新しい draftRef は要らない）。
- lane snapshot の CP-4 の行（l6-l9:606）に、K6/5 の確認と、/5 の凍結・S2 追補 #14・S4 の 6 回目の凍結が未実施であることを追記する。
- 確認されなければ、CP-4 は /4 の行のままで、D=40 ms の候補では手順が `[precheck]` で止まる（`irw-decisions.md:31`）。別の案は /6 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行、K6/4 の行と同じ）。

- 理由: (1) この差分は、/4 の行の D の値と、それに連動する Hybrid p95 の上限・T_late の扱いの改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認（台帳の Confirmation protocol）。

承認の例（改訂 3 に対して。固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-final-request-eval-proposal/5 for contractId graph-eval-procedure.
