# NIR-1 最終 request 評価の契約提案 proposal/5（draft）: Graph の評価の手順の最初の表示の窓 D を 40 ms にする（K6/4 の D の行と、それに連動する Hybrid p95 の上限の改訂）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること（3 行）

- CP-4 の Graph の評価で、最初の表示の窓 D を 10.84 ms から 40 ms（製品の今の値。DR-IRW-1・2、#802）に変え、あわせて CP-4 の品質の条件の Hybrid p95 の上限を 65.04 ms から 94.2 ms（B=54.2 ms ＋ D=40 ms）に変えてよいか。
- どちらも**合格基準の緩和**である（一覧は「緩和の一覧」の R-1〜R-5）。ユーザーは 2026-11-07 に、緩和に当たることを了解した上で、この 2 つを選んだ（起案の指示で、確認ではない）。T_late は 100 ms のまま変えない（ユーザーの再確認）。
- それ以外の K6/4 の規則（W_f 100 ms、T_late 100 ms、T_show 2 s、1%、F1〜F7、X1〜X13、R1〜R8、受入れ、候補の限定）の文面は変えない。受入れと候補の限定には、D に連動する狭める項目（「変える点」の 6、K6/5-N1〜N4、K6/5-P1）を足す。

## 冒頭の開示（緩和であることと、ユーザーの選択）

- **D を広げることは、窓内に数える側を広げる＝合格基準の緩和である**。D は、窓内の判定 `t_raw_ready + D`（K6/2 の手順の 5〔705 行〕、(b) の規則の 2〔716 行〕）、親の IR の締切（製品の IR の窓は同じ定数。`irw-decisions.md:13`）、子の IR の deadline（K6/4 の技術点 3）、graph-late の親の公開の時刻（Raw-ready ＋ D。K6/4:119）、「D の後の Graph を表示に混ぜた」の違反の境界（K6/4:163、K6/4-N1、N29）に効く。
- **D を 40 ms にしても T_late の合否が変わるのは通知の遅れ δ が 60 ms を超える場合だけである**（仕組みはコードで確かめた。分布は D=10.84 ms の観測からの推測）。q1 = `t_notice − t_raw_ready` は Raw-ready から測る（`followup.mjs:559-561`）。通知は cache への格納の直後に出る（`nir1_graph_product.rs:982-1015` の deliver、`:1034-1075` の finish(Unused) → store_late_cache → notify_ready）。格納は宣言＝親の公開の後に限られ（K6/4:119）、graph-late の親の公開は Raw-ready ＋ D（`nir1RelatedScenesGraphJoin.ts:223-226`、`:279`）。したがって **q1 ≈ max(Graph の renderer への到着, D) ＋ δ**。(a) Graph が renderer に 40 ms より後に届く親では q1 は D に依らない。(b) Graph が Native で早くそろい、renderer への到着だけが締切を過ぎた親では q1 ≈ D ＋ δ で、D=40 ms では約 29 ms 上がる（H5 の q1 の p50 17.0／19.4 ms が約 45〜48 ms に）。H5 の δ（「親の結果の返却から通知まで」）は p50 5.5／7.8 ms、p90 13.8／11.7 ms、**max 43.7／26.5 ms**（`cp4-decisions.md:487`。K6/4:290）で、(b) の最悪は 40 ＋ 43.7 = **83.7 ms**。q1 ≤ 100 ms から q1 ＞ 100 ms への反転は δ ＞ 60 ms のときだけ起き、観測の δ の最大はその内にある。**q1 の分布は上がり、100 ms までの余裕は観測の最悪で約 16 ms になる**。T_late は D に連動する値ではなく、この draft は T_late を変えない（U-2）。
- **ユーザーは、次の 2 つを、どちらも緩和に当たることを了解した上で選び、T_late は変えないことを選んだ**（2026-11-07。AskUserQuestion で計 3 回。質問と回答の逐語の要旨は `claude/nir1-contracts` の `docs/plans/nir1-cp4-records/irw3-procedure-draft-2026-11-07.md` の末尾の「ユーザーの決定」〔問 1〕と「追記：U-1・U-2 の質問と回答」〔commit `f026d1f1`〕・「U-2 の再確認」〔commit `fdf1159d`〕）。
  - 問 1（D の当て方）: 「新しい契約を起案（正規）」。D の行だけを変えた新しい draftRef を起案し、レビューと承認を経て台帳に記録する。
  - U-1（Hybrid p95 の上限）: **94.2 ms**。最初の問い（問 2）は「p95 は手順外の補助の記録 QV-1 だけが使う」という誤った説明で示された。integrator は、p95 が K6/2:620 の確認済みの正式な合格条件（/4 の行の (i)）であり、94.2 ms にすると緩和になること、母集団が G-case の CP-4 の run の両 arm であること、最悪の見積り（R+IR arm 84.46 ms、Graph arm 60.66 ms）を伝えて訂正つきで聞き直し、ユーザーは 94.2 ms を選んだ。
  - U-2（T_late）: **100 ms のまま（訂正した説明の後の再確認）**。最初の問いは「D を 40 ms にすると T_late の Graph 側の余裕が 89 ms から 60 ms に縮む」という誤った説明で示され、回答は「129.16 ms に広げる」だった。再レビューで説明の誤り（上の段落）が分かり、integrator が訂正した説明（129.16 ms は D からの帰結ではなく Graph の遅れの許容を 29 ms 広げる独立の緩和）で聞き直し、ユーザーは「100 ms のまま」を選んだ。
  - **これらの選択は起案の指示で、この draft の確認ではない**（K6/4 の 2026-10-25「K6/2 は A で」と同じ扱い）。
- **問 1 の「D の行だけ」と実際の変更の関係**: この draft が変える値は D と Hybrid p95 の上限の 2 つである。p95 の上限は式 B+D で D を含み、製品は戻りの時刻を最大 D まで待つ（IR の窓、graph-late の親の公開）ので D に連動すると言えるが、**R-4（p95）の根拠は問 1 ではなく U-1 の回答**である。
- **DR-IRW との関係**: DR-IRW-1・2（`docs/plans/nir1-lane-decisions/irw-decisions.md:24-25`。ユーザーの 2026-11-05 の回答「変えていいです」）は、製品の定数 `RELATED_SCENES_IR_EXTRA_WAIT_MS` を 40 ms の固定値にし、Graph の最初の表示の窓も同じ定数で 40 ms に広げた（#802、`a7e96946`）。DR-IRW-3（同 :26）は、この変更が K6/4 の「最初の表示の D=10.84 ms は変えない」と L0 の P の固定値「D=10.84 ms、上限 65.04 ms」を上書きすると記録したが、確認台帳（`nir1-l6-l9-execution-plan.md`）には反映されていない（:257 の K6/4 の行と :536 の P の固定値は 10.84 ms／65.04 ms のまま）。また `irw-decisions.md:31` は、CP-4 の手順（`GRAPH_EVAL_D_MS = 10.84`、`k64-procedure.v1.json`）を変えず、取り直すには手順の新しい版が要るとした。K6/4 は D の変更を K6/4 の名で行うことを許さず（批准 9。K6/4:36）、窓を広げる変更は新しい draftRef でだけ行う（変える点 16。K6/4:110）。**この draft は、DR-IRW の製品の決定を `graph-eval-procedure` の契約に取り込むための、その新しい draftRef である**。D の値（40 ms）は DR-IRW-1 が製品のために選んだ値で、この draft は値を選び直さない。

## 緩和の一覧

/4 の行より弱い読みになるのは次の 5 つで、ほかの物差し（1%、W_f 100 ms、T_late 100 ms、T_show 2 s、lease 100 ms、失効率の定義）は変えない。

| # | 緩和 | 旧 → 新 | 効く規則・判定 | 根拠 | 「変える点」 |
| - | ---- | ------- | -------------- | ---- | ------------ |
| R-1 | 窓内の判定の D | 10.84 → 40 ms | 最初の表示の窓内（K6/4 の表示の可用性の一方）、(b) の窓内（K6/2:705、:716、:717） | 問 1（製品の D に合わせる） | 1、2 |
| R-2 | 親の IR の締切 | 10.84 → 40 ms | **製品の既定（#802）の効果を契約が引き受ける**もので、harness の判定の値は動かない。IR の outcome は製品の completion から読み（`run-sample.mjs:231-235`、`k64-record.mjs:546-548`）、締切は製品の定数（`nir1RelatedScenesGraphJoin.ts:107-109`、`Deadline.ts:43`）で、#802 の候補ではすでに 40 ms。harness は IR の timeoutRate 1% を判定せず開示だけにする（`availability.mjs:478-487`）。効果: IR の timeoutRate が下がり、X11（親の IR が timeout か unavailable。K6/4:159）も減って表示の可用性が上がる方向に効く | 問 1 | 2 |
| R-3 | 子の IR の deadline | 10.84 → 40 ms | 製品の既定（#802）の効果を契約が引き受ける面（子の IR の締切は製品の同じ定数）と、harness の照合の境界が動く面がある。`followup.mjs:694-701` は子の IR の到着が `t_raw_ready_c + D` を超えると `child-ir-deadline-beyond-d`（ratification12）にするので、その境界が 40 ms に動く。効果: F6（K6/4:144）を満たしやすく、X5 の子の IR の timeout が減る | 問 1 | 2 |
| R-4 | Hybrid p95 の上限 | 65.04 → 94.2 ms | CP-4 の品質の条件（K6/2:620 の Positive） | U-1 | 4 |
| R-5 | 「D の後の Graph を表示に混ぜた」の違反の境界 | Raw-ready ＋ 10.84 → ＋ 40 ms | K6/4:163 と K6/4-N1（親の表示に D の後の Graph が混ざったら FAIL）、N29 の関連の判定（`k64-record.mjs:246-266` の `lateGraphShown(…, GRAPH_EVAL_D_MS)`、`trace-record.mjs:1098-1122`）、QV の品質の条件「禁止寄与 0」の (b)（`quality-verdict-cli.mjs:410`）。D を上げると違反の境界が後ろへ動き、10.84〜40 ms に届いて表示に入った Graph は違反でなくなる（緩む） | 問 1 | 2 |

- 見積り（推測。D=40 ms の G-case の値は未測定）: R-4 は、s5r6 の値（R+IR arm 55.30 ms、Graph arm 31.50 ms。`cp4-decisions.md:1350`）に D の拡大が 1 call に足しうる最大 29.16 ms を足しても R+IR arm 84.46 ms・Graph arm 60.66 ms で上限の内。65.04 ms のままなら R+IR arm が超えうる。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。

1. 行の内容: /5 の行は、/4 の行（K6/2 の `graph-eval-procedure` の本文の全文に /4 の「変える点」の 1〜18 を当てたもの。K6/4 の「引き継ぐもの」の 1）に、この draft の「変える点」の 1〜7 を当てたものとする。表にない /4 の行の記述は変えない。
2. D の値（「変える点」の 1〜3）: 最初の表示の D を 40 ms の固定値とし、D を参照する規則（窓内の判定、親と子の IR の締切、graph-late の親の公開の時刻ほか）は文面を変えずに 40 ms で読む。
3. Hybrid p95（「変える点」の 4）: CP-4 の受入れ（K6/2 の 620 行の Positive）の Hybrid p95 を、G-case の CP-4 の run の R+IR arm と R+IR+Graph arm を arm ごとに pool した nearest-rank の p95 と読み、両 arm が 94.2 ms（B=54.2 ms ＋ D=40 ms）以下のときだけ満たすとする。B は確認済みの 54.2 ms のまま、D から逆算しない。P の評価（`evals/nir1-retrieval/manifest.json`、`scripts/quality/nir1-retrieval`）と P の行の値は変えない。
4. T_late は変えない: K6/4 の判断 3 の `t_notice − t_raw_ready ≤ 100 ms` のまま（冒頭の開示の 2 つ目の段落）。
5. 緩和の一覧（R-1〜R-5）と、これらが合格基準の緩和に当たること。
6. 候補の限定の追加（「変える点」の 6。狭める防御）: /5 の行は、製品の最初の表示の D が 40 ms の候補にだけ当てる。K6/4 の批准 5 の (a)〜(c) の限定はそのまま。
7. 効力（K6/4 の批准 6 と同じ 2 段）: (i) は /5 の行のうち (ii) 以外のすべてで、この承認で確認される。(ii) は K6/2 の 614 行の Delta、620 行の末尾の Lane unlocked、621 行の受入れへの影響に /4 と /5 の読み替えを当てたもので、事前の確認にとどまる。事前登録の凍結（「変える点」の 7）: K6/2 の「事前登録の凍結」の 1〜7 の「この file」をこの draft の bytes と読む。/5 で判定する CP-4 の run と条件の判定に使う診断は、/5 の凍結の後に始めたものに限る。
8. 変えないもの: 「前書き」の「変えないもの」。
9. 許さないもの: この確認そのものによる製品のコードの変更。/5 の後に D の値を変えること（広げるのも狭めるのも新しい draftRef でだけ行う）。/5 の後に Hybrid p95 の上限を変えること（K6/4 の変える点 16〔K6/4:110〕は p95 を観測の後に狭めてよい値に列挙していないので、広げるのも狭めるのも新しい draftRef でだけ行う）。T_late の扱いは K6/4 のまま（観測の後に狭めるのは変える点 16 の手続きで、広げるのは新しい draftRef で）。P の評価の manifest・harness・P の行の値の変更。Gold、G-case の fixture と setup（seed の pin を含む）、凍結済みの trace の file の変更。新しい authority・保存先・送信先・製品の入口（G-01 相当の診断 run の admission の変更を含む。下の「本文に入れないもの」）。Graph の公開（PUB-G）と Session C-1 の承認。条件の成立の判定そのもの。/4 の行と /5 の行を、結果を見て選び分けること（「引き継ぐもの」の 2）。依存する契約と、K6/2・K6/3 のほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）と `nir1-l6-l9-contract-proposal/7` の行は確認しない。

注記（批准の対象ではない）: 2026-11-07 のユーザーの回答（問 1、U-1、U-2 とその再確認、問 3、問 5）は起案の指示と選択で、確認文ではない。誤った説明の下で得た最初の問 2 の回答（「94.2 ms」）と最初の U-2 の回答（「129.16 ms に広げる」）は値の根拠にせず、訂正した説明の後の回答（U-1 は 94.2 ms、U-2 は 100 ms のまま）を根拠にした。「変える点」の 2、3、5〜7 の書き分け、候補の限定の追加、P の行を変えない読みは、起案者が integrator の指示（D の行と、それに連動して値が決まる箇所だけを変える）と独立レビューを受けて置いたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/5` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行、K6/4 の行と同じ。理由は「確認文」） |
| 版 | 改訂 5（2026-11-07）。下の「改訂の履歴」 |
| 起案日と基点 | 2026-11-07。製品 repo は origin/master `1822b192`（#823）で確かめた（`git show 1822b192:<path>`）。契約の bytes は `claude/nir1-contracts`（`f974121d`〜`fdf1159d`）の worktree で読んだ。K6/4 の SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3` と K6/2 の `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` は、`1822b192` と contracts の両方で再計算し、台帳（l6-l9:193、:135）の値と一致した。以下「K6/4:n」「K6/2:n」はそれぞれの draft の行、「l6-l9」は `1822b192` の `docs/plans/nir1-l6-l9-execution-plan.md` の行 |
| baseline | `nir1-final-request-eval-proposal/4#graph-eval-procedure`（2026-10-26 Session B5 で批准 6 の (i) を確認済み。l6-l9:187-197、:257。凍結は `claude/nir1-contracts` の `5dea38af`。contracts の `docs/plans/nir1-cp4-records/k64-freeze-record.md`） |
| 前提 | 製品の最初の表示の D は 40 ms（`src/features/related-scenes/relatedScenesConfig.ts:13` の `RELATED_SCENES_IR_EXTRA_WAIT_MS = 40`。#802 `a7e96946`。DR-IRW-1・2）。IR の窓と Graph の最初の表示の合流の窓は同じ定数（`irw-decisions.md:13`、DR-IRW-2）。CP-4 の手順は今も D=10.84 ms に結び付いている（`scripts/quality/nir1-graph-eval/constants.mjs:10`、`procedure/k64-procedure.v1.json`、`scripts/quality/nir1-graph/observation-prep.mjs:409-414`。`irw-decisions.md:31`） |
| 変えないもの | K6/4 の「変えないもの」（K6/4:53）のうち、「最初の表示の D=10.84 ms の値」を「変える点」の 1 で、「P の B=54.2 ms、上限 65.04 ms（B+D）」を「変える点」の 4 で読み替え、ほかはすべてそのまま（Graph の result lease 100 ms、K1／proposal/7 の上限、T=2144.7 ms、「既に完了した query へ遅い Graph の結果を混ぜず、次の query で使う」、合流が 1 回だけ公開する不変条件、IR の timeoutRate 1%、失効率の物差し 1%、分母を pool すること、HOLD の既定、事前登録の凍結の規則、試験専用の入口の規則、`graph-ready` の再 query を P・IR・(a)・(b) の分母に入れないこと、DP-H・DD-1・K6/3 の規則、D-final の Graph の待ち 4 s）。W_f 100 ms、T_late 100 ms、T_show 2 s、F1〜F7、X1〜X13、R1〜R8、K6/4-P1〜P3、K6/4-N1〜N40、技術点 1〜3、批准 5 の候補の限定、批准 12 の製品の変更の要件の文面と値。K6/2 と K6/4 の bytes |

### 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | 最初の起案（contracts `9dbb94fb`） |
| 改訂 2 | 2026-11-07 | Opus の敵対的レビュー（P1×1、P2×7、P3×6）を反映（contracts `10cb2569`）。問 2 を未確定に戻して両案の帰結を並べた、D=40 ms の効果の開示、p95 の母集団の読み、v2 に B と上限、候補の限定の照合、C7 の根拠の追加 ほか |
| 改訂 3 | 2026-11-07 | ユーザーの U-1（94.2 ms）・U-2（T_late 129.16 ms）の回答を確定として入れ、「緩和の一覧」R-1〜R-5 と「変える点」の 8（T_late）を置いた（contracts `20e178e6`） |
| 改訂 4 | 2026-11-07 | Opus の再レビュー（P1×1、P2×3、P3×4）とユーザーの U-2 の再確認を反映。(1) 改訂 2・3 の「T_late を 100 ms のままにすると公開の後の余裕が 89.16 → 60 ms に縮む（厳格化）」は仕組みと合わなかった（graph-late の親の q1 は Graph の到着で決まり、D の影響を受けない）。訂正した説明でユーザーが聞き直しに「100 ms のまま」と答えたので、「変える点」の 8 と R-5、K6/5-N5・P2、In-scope attack の 21 を削り、T_late は K6/4 のまま 100 ms と明記した。冒頭の開示の「厳格化」の記述を、「D を 40 ms にしても T_late の許容は締まらない」に直した。(2) R-4 の根拠は問 1 ではなく U-1 だと明記した。(3) harness の表に `observation-prep.mjs:409-414` の `K64_VALUES` と `:3022-3027` の照合を足した。(4) U-1・U-2 の逐語の参照先を irw3 の追記（`f026d1f1`・`fdf1159d`）にした。(5) 批准 9 の「p95 を狭めるのは変える点 16 の手続きで」を、p95 は変える点 16 に列挙されていないので新しい draftRef でだけ変える、に直した。(6) R-2 に X11 が減って表示の可用性が上がる効果を書いた。(7) 「余裕を保つ」理屈の記述を削った。irw3 の 4 か所の訂正注の指し先も直した |
| 改訂 5 | 2026-11-07 | Fable の最終 pass（P1×1、P2×3、P3×4）を反映。(1) T_late の説明を、コードで確かめた仕組み（q1 ≈ max(Graph の renderer への到着, D) ＋ δ）に直し、Native で早くそろった親では q1 が約 29 ms 上がること、H5 の δ の p90・max（`cp4-decisions.md:487`）、反転は δ ＞ 60 ms のときだけで 100 ms までの余裕は観測の最悪で約 16 ms であることを書いた。(2) 緩和の一覧に R-5（「D の後の Graph を表示に混ぜた」の違反の境界。K6/4:163、N1、N29、禁止寄与の (b)）を足し、台帳の行の「X1〜X13 … は /4 のまま」を直した。(3) R-2・R-3 を、製品の既定（#802）の効果を契約が引き受ける面と harness の判定の境界が動く面に書き分けた。(4) p95 の母集団を「blocked でない variant」「failed があれば fail」に直した。(5) v2 から読むには QV の入力の構造の変更が要ることを書いた。(6) 台帳の注の (1) に N1／:163 を名指した |

## 引き継ぐもの

1. /4 の行の内容を baseline とし、この draft の「変える点」の表を当てたものを /5 の行の内容とする。表にない記述は変えない。番号は「/5 の変える点 n」と呼び、/4 の「変える点」の n とは別である。
2. /4 の行との関係: /5 の確認の後、CP-4 の可用性と品質の判定（批准 7 の (i)）は /5 の行で行う。/4 の行は確認の履歴として残し、台帳の行（l6-l9:257）と /4 の凍結（`5dea38af`）は消さない。/4 の下で取った receipt（s5r4〜s5r6 の正式 run ほか）は、その時点の候補の記録として有効なまま（DR-IRW-3 の「過去の測定の記録は、その時点の候補の記録としてそのまま有効」と同じ）で、/5 の判定には使わない。**/5 の確認の後は /4 の行で新しい判定をしない**（製品の D が 40 ms の今の master の候補は /4 の D と合わない。/4 と /5 を結果を見て選び分けることを防ぐ。批准 9）。条件の成立の後に (ii) の改めての確認を求めるのは /5 の行で、/4 の行には求めない。
3. 事前登録: /4 の凍結の記録は消さずに残す。/5 の凍結は別の新しい commit で行う。K6/2 の 157 行（事前登録の凍結の 4）に従い、/4 の凍結の後にこの起案者が見た観測と、それを見た後に選んだ規則を書く。見た観測: CP-4 の正式 run s5r6 の記録（contracts `a22080bd`）と DR-CP4-QV-1 の結果（R+IR arm 55.30 ms、Graph arm 31.50 ms。`cp4-decisions.md:1350`）、D=40 ms の dev の診断 run 1・2 が集計の段の `[precheck]` で止まったこと（手順の起案 §1.1）、dev の run 3〜6 の Chronicle の停止（contracts `diag-lpd-2026-11-02/chronicle-late-publish-2026-11-07.md`）、DR-IRW の PD 評価（`irw-decisions.md:15-17`）、K6/4 に記録された H5 と RS-JOIN の q1 の分布（K6/4:65、:123-124、:290）。**D=40 ms の値は DR-IRW-1 が製品のために選んだ値で、この起案者は観測を見て値を選んでいない。ただし、それを CP-4 に当てる判断（問 1）、Hybrid p95 の上限（U-1）、T_late を変えないこと（U-2）は、上の観測を見た後に選ばれた**。どの観測も /5 の判定に使える診断ではなく、予告として扱う。
4. K6/2、K6/3、K6/4 の確認の記録と注（l6-l9:175-197、:257、:271-280）は消さない。

## 変える点（/4 の行との関係）

次の表の文だけを置き換える（または読み替える）。表にない記述は変えない。**1、2、4 は /4 の行より弱い読み**（緩和。「緩和の一覧」の R-1〜R-5）。3 と 5 は 1 に伴う読み、6 は狭める防御、7 は事前登録の扱いである。**文面（数値）を置き換えるのは 1 と 4 の数値だけで、ほかは文面を変えずに読みを定める**。

| n | 箇所（/4 の行） | 旧（要旨） | 新 | 理由 |
| - | --------------- | ---------- | -- | ---- |
| 1 | D の値を述べる箇所: K6/4:53（「変えないもの」の先頭）、K6/4:8、:18、:184 の「10.84 ms」、K6/2:613（Baseline）の「D=10.84 ms（`min(100ms, 0.20*B)`）」のうち、この行の窓としての D | 最初の表示の D=10.84 ms（`relatedScenesConfig.ts:7`）。D は P の式 `min(100ms, 0.20*B)` の値 | 最初の表示の D=40 ms（`relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS`。DR-IRW-1・2、#802 `a7e96946`）。**D は固定値で、P の式からは導かない**。K6/4:8、:18、:184 の「10.84 ms」は 40 ms と読む | 製品の窓に合わせる。DR-IRW-1 の値をそのまま使う（R-1。問 1） |
| 2 | D を参照する規則（文面は変えず、値が 40 ms になる）: K6/2:619（(b) の cache 由来の窓内 `t_raw_ready + D`）、:694（D の窓の起点）、:705（手順の 5。窓内の判定と `graph-late`）、:706（手順の 6。IR の timeoutRate。製品の IR の締切は同じ D）、:716（(b) の規則の 2）、:717（窓外率「D の窓に届いたか」）、K6/2:620 の Positive の「IR の timeoutRate は … 1% 以下」。K6/4:22・:52（first-render の窓内）、:53（子の IR の deadline「子の Raw-ready + D」）、:80（技術点 3）、:99（変える点 5）、:109（変える点 15 の「D の窓内か follow-up の成功」）、:111（変える点 17 の親の D と子の IR の `t_raw_ready_c + D`）、:119（graph-late の親は Raw-ready ＋ D で公開）と :141（F3 の `t_pub_p` の後の通知）、:144（F6）、:159（X11）、:163（遅れた Graph を親の表示に混ぜたら FAIL）、:167（表示の可用性）、:175〜:177（批准 12 の「親とほかの契機は D のまま」、(5) 子の IR の deadline、試験）、K6/4-P2（:227）、N1（:232）、N30（:261）、N32（:263）、N39（:270） | D=10.84 ms で判定する | 同じ文を D=40 ms で判定する。W_f（100 ms）≥ D（40 ms）なので、変える点 17 の「子の Graph の成分は W_f、子の IR は D」の関係と、製品の合流の前提（Graph の窓 ≥ IR の締切。`irw-decisions.md:13`、:25）は保たれる。F3 の「`t_pub_p` の後の通知」は graph-late の親で公開が Raw-ready ＋ 40 ms になるが、q1 は Raw-ready から測り、q1 ≈ max(Graph の renderer への到着, D) ＋ δ なので、T_late（100 ms）の合否が変わるのは δ ＞ 60 ms のときだけ（冒頭の開示） | 1 に連動。first-render と (b) の窓内（R-1）、親の IR の締切（R-2。製品の既定の効果を引き受ける。X11 も減る）、子の IR の deadline（R-3）、「D の後の Graph」の違反の境界（R-5）が広がる |
| 3 | D を変えない・広げないと述べる箇所: K6/2:609（「D を広げるのは閾値の緩和にあたり、この行の外で、別の確認を要する」）、:614（Delta の「D … は変えない」）、:617（In-scope attacks「D を黙って広げるか、別の D で測ること」）、:618（Out-of-scope「D の変更（この行の外）」）、:619（「D は変えない」）、:620（Negative「D を変える」）、:621（受入れへの影響「D … は変えない」）、:633（「D を広げることは、どの案にも含めない」）。K6/4:18・:32（「D の値は最初の表示に残す」）、:36（批准 9「最初の表示の D の値の変更」）、:184（「D の値は変えない」）、:210（Acceptance implications「最初の表示の D の値 … は変えない」） | D=10.84 ms を変えない | 文面は変えない。D は 1 の 40 ms と読む。**/5 による 10.84 → 40 ms は、K6/2:609・:633 のいう「別の確認」と、K6/4 の変える点 16（K6/4:110）のいう「新しい draftRef」にあたる**。確認の対象として名指すので K6/2:617 の「黙って」に当たらず、K6/4 の名で行うのではないので K6/4:36 にも当たらない。/5 の後に D を変える（広げる・狭める）ことは、これらの文のとおり許さない（新しい draftRef が要る。批准 9） | 1 の変更を、変えない側の規則と両立させる |
| 4 | Hybrid p95: K6/2:620（Acceptance implications の Positive）の「P の Hybrid p95 は 65.04 ms 以下で、receipt に D2a の mode と restricted の再認可の内訳がある」、K6/4:53 の「P の B=54.2 ms、上限 65.04 ms（B+D）」、K6/4:210 の「P の Hybrid p95 … は変えない」、K6/2:613 の「Hybrid p95 の上限 65.04 ms（B+D）」 | CP-4 の受入れで Hybrid p95 を 65.04 ms（B=54.2 ms ＋ P の式の D=10.84 ms）と比べる。母集団は文面に無い | **母集団**: K6/2:620 の「P の Hybrid p95」は、CP-4 の G-case の run（K6/2:694 の手順の 2〔case と arm ごとに warm-up 5 回の後に 30 回、R+IR と R+IR+Graph を AB／BA で交互、起点 `t_fetch`、終点 `t_return`〕、:706・:707〔timeoutRate と再 query の扱い〕、:620〔receipt に D2a の mode を書く〕）の値と読む。p95 は `t_return − t_fetch` の nearest-rank の p95 で、台帳で blocked でない variant（`quality-verdict.mjs:631` の `live`）の `measured` かつ `user-operation` の call（`:122-128`）を **arm ごとに pool** し、**R+IR arm と R+IR+Graph arm の両方**が上限以下のときだけ満たすとする。failed な call は落とさず、arm に failed が 1 件でもあれば p95 を出さず fail とする（`:169-193`）。`graph-ready` の子は分母に入れない（:707）。**上限**: **94.2 ms（B=54.2 ms ＋ 1 の D=40 ms）**。B は確認済みの 54.2 ms で、D から逆算しない。K6/4:210 の「P の Hybrid p95 は変えない」は、測ることと式（B+D）と母集団を変えないと読む。K6/2:613 と K6/4:53 の P の固定契約の記述は、P の評価（`evals/nir1-retrieval/manifest.json` の `performance.warm`、`scripts/quality/nir1-retrieval`）の値として読み、/5 はそれを変えない（P の 24 件の評価と過去の receipt は P の式の D=10.84 ms・上限 65.04 ms のまま） | ユーザーの選択（U-1）。式 B+D に 1 の D が入り、製品は戻りを最大 D まで待つ（D に連動）。母集団は確認済みの文の読みの明記（DR-CP4-QV-1 の事前登録の読みと同じ）。R-4 |
| 5 | 導出・観測・事実・選択肢の記述で D と比べている箇所（文面は変えない）: K6/4:17（「一覧はその 10.84 ms 後に出る」）、:19、:22 の (3)(4)、:63〜:66（判断 1〜4 の導出と代案。「2×D = 21.68 ms」「565.04 ms」を含む）、:70、:80 の根拠、:118〜:127（「事実」）、:181〜:182、:216（「D は P の固定契約の一部」）、:285、:290 | /4 の起案の時点の D=10.84 ms と比べた記述 | /4 の起案の時点の D=10.84 ms との比較（履歴）として読み、規則として読まない。W_f・T_late・T_show の値とその導出は変えない。「D′ の下では first-render は構造上 HOLD」（:17〜:22、:63）は D=10.84 ms での観測で、D=40 ms では親が D の内に Graph を受ける sample が出うる（DR-IRW-2「Graph が最初の表示に入る機会が増える」）。その sample は K6/4-P2 で first-render の窓内に数え、子は出ない（規則は変えない） | 1 に伴う読み。観測を書き換えない |
| 6 | 候補の限定（K6/4:32 の批准 5 の末尾への追加） | （なし） | /5 の行は、製品の最初の表示の D が 40 ms の候補にだけ当てる。**run の前に admission で照合する**: 候補の commit が `a7e96946` を祖先に含み、候補の `src/features/related-scenes/relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 で、手順のファイルの D が契約の D と一致すること。合わなければ run を始めず `[precheck]` にする（K6/4 の行の D とも合わないので、そちらでも判定しない）。**sample ごとの照合**: 親の合流に渡した窓の値（`timing` の `graphWindowMs`）が D と一致すること。値が無い（null）sample は照合できたとせず、/5 の判定を `[precheck]` にする（K6/4 の N30 の照合〔`followup.mjs:496-498`〕は、不一致を ratification12〔K6/2 の文のまま扱う〕に入れ、null なら照合しないので、そのままでは足りない） | 契約の D と製品の D の食い違いで測ることを防ぐ（狭める防御） |
| 7 | 事前登録の凍結と効力の時点: K6/4:34（批准 7）、:108（変える点 14）、:317（凍結の順序） | 「この file」は K6/4 の bytes。receipt の先頭に /4 の凍結の commit と SHA-256 | 「この file」は /5 の bytes。/5 で判定する CP-4 の run と条件の判定に使う診断は、/5 の凍結の後に始めたものに限り、receipt の先頭に /5 の凍結の commit と SHA-256 を書く（/5 の行は /4 の bytes の上に立つので、/4 の凍結の commit と SHA-256 も併せて書く）。/5 の凍結の前の観測（「引き継ぐもの」の 3）は予告で、/5 の判定に使わない | /4 の変える点 14 と同じ形 |

## 本文に入れないもの（手順の側で扱うもの）と理由

| 事項 | 本文に入れるか | 理由（/4 の行の構成から） |
| ---- | -------------- | ------------------------- |
| C7（Chronicle の Index が使えない begin を trace の対応から外し、K6/2 の規則 3 の (i) の `i-chronicle-stop` として数える。手順の起案 §1.3、ユーザーの決定 問 3） | **入れない**。S2 追補 #14 と S3 の独立レビュー、S4 の 6 回目の凍結で扱う | 数え方は /4 の行の本文がすでに定めている: K6/2:717 の規則 3 の (i)（「開始時に Chronicle の Index が使えず（同じ query の IR の outcome が `index-unavailable`）」）、:718 の規則 4 の失効の区分（「Graph の outcome の名前によらない」）、:719〜:720（「`cancelled`〔3 の (i) の Chronicle の停止によるものを除く。それは失効に入る〕」）、規則 8 の記録（「(i) は B の seal によるものと Chronicle の停止によるものに分ける」）、K6/4 の変える点 15（K6/4:109。follow-up の失敗の区分で「Chronicle の停止」は「失効」）。さらに K6/2:617 の In-scope attacks は「Chronicle の停止で融合の規則により Graph が止まった query を、Graph の outcome の名前（`cancelled`、`not-requested` など）を理由に、その他に入れるか、**run の無効にすること**」を攻撃とする。今の S2 の TP-1（「M < N は整列の失敗」。`observation-prep.v1.json:282`）は、この形の begin があると run を無効にするので、この攻撃の形に当たる。C7 は harness を確認済みの文に合わせる改訂で、K6/2:620 の Negative の「観測の後に定義を変える」には当たらない（定義〔規則 3・4・8〕は変えず、凍結済みの trace の file も作り直さない。K6/2:702 が作り直しを許すのは不備のときだけで、C7 は trace の file に触れない）。/4 の行は Native の begin の記録と trace の begin の一対一の対応を定めていない。/4 の行の防御（K6/2:619 の「手順、trace、基準を CP-4 の観測の前に固定し、独立 reviewer のレビューを受ける」、K6/4:209 の「分類器は Negative の合成の記録で検出力を示してから使う」）は、C7 にもそのまま当たる。C7 は T_late・W_f・T_show・F1〜F7・X1〜X13・R1／R4 の待ちを広げない（K6/4 の変える点 16 の列挙に触れない） |
| G-01 相当（PUB-G #16 の決定 (C)。G-01 の凍結素材での end-to-end を診断の run として同じ凍結に同梱する。ユーザーの決定 問 5） | **入れない**。S2 追補 #14 と S4 の 6 回目の凍結で、CP-4 の判定に数えない診断として扱う | /4 の行の判定は G-case の可用性と品質だけで、判定に数えない診断の run を定めない。click の `keep_click` は DB に書かない（メモリだけ。DB への接触は read tx だけ。irw3 の起案の追記〔contracts `b1ca2282`、`irw3-procedure-draft-2026-11-07.md:266-271`〕）ので、保存範囲の拡大には当たらない。残る委任の外は admission の変更（新しい purpose か凍結素材を許す経路。新しい authority の候補）で、K6/4 の批准 9 は新しい authority を K6/4 の確認で許さず、/5 もそれを保つ（批准 9）。したがって /5 の確認は G-01 相当の admission の変更を許可せず、S2 追補 #14 の確認で扱う。G-01 相当の run は CP-4 の判定の session と分け（`countsInCaseJudgement: false`）、K6/4 の R4（sample の間に別の query を起こさない）に触れない |
| QV-1 の code の直し（`deriveLatencyPolicy` が B を D から逆算するので、D=40 ms では上限が 240 ms になる） | **入れない**。harness の実装で直す | 本文が定めるのは上限の値と B（「変える点」の 4）だけで、code の形は定めない。ただし防御として、B と上限は手順のファイルの v2 に入れて凍結し、QV がそこを読む（下の harness の表）。今の code は manifest の式から B と上限を導く形（`quality-verdict.mjs:68-93`、cli `:242`・`:253`）なので、v2 から読むには入力の構造の変更が要る |
| `BOUNDARY_TOLERANCE_MS`（0.01 ms）の注記 | 入れない | S2 の `registeredForReview` の注記で、本文の値ではない |

## threat model（/4 の行への加算）

合格基準の緩和なので、確認されるまで draft とする。この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（製品のコードを変えず、評価の値と読みだけを変える）。

- In-scope attacks（加える）: 17. 契約の D（40 ms）と違う D で測る、または手順のファイル・harness の D が契約の D と違う。18. 製品の D が 40 ms でない候補に /5 の行を当てる、または親の合流の窓の値が記録されていない sample を照合できたとする（「変える点」の 6）。19. /5 の凍結の前に取った receipt（/4 の下の receipt を含む）を /5 の判定に使う、または /4 と /5 の行を結果を見て選び分ける。20. Hybrid p95 の上限を、P の評価の 65.04 ms と /5 の 94.2 ms のどちらで比べるかを結果を見て選ぶ、B を D から逆算して上限を変える（D=40 ms からの逆算は B=200 ms、上限 240 ms になる）、または母集団（arm ごとの pool、両 arm）を結果を見て選ぶ。
- Mandatory defenses（加える）: 「変える点」の 6 と 7。手順のファイルの D、B、Hybrid p95 の上限は、観測の前に /5 の凍結と手順のファイルの新しい版（v2）で固定し、独立 reviewer のレビューを受ける。品質の判定（QV）は、上限と B を v2 から読み、constants の契約の値と一致しなければ `[precheck]` にする。
- Acceptance implications（読み替え）: K6/4:210 の「品質の条件、IR の timeoutRate、P の Hybrid p95、最初の表示の D の値、失効率の物差しは変えない」は、/5 の後は「変える点」の 1 と 4 の値で読む（D は 40 ms、Hybrid p95 の上限は 94.2 ms）。ほかは変えない。

## 受入れ（/4 の行への加算）

番号は K6/4 と衝突しないよう `K6/5-` を付ける。CP-4 の分類器と品質の判定は、合成の記録で次を期待どおりに分けることを、観測の前に示して記録する（K6/4:209 と同じ。前回の検出力の記録は contracts `docs/plans/nir1-cp4-records/k64-synthetic-detection-record.md`）。

- K6/5-N1: 手順のファイルの D が 40 ms でない receipt（In-scope attack の 17）。
- K6/5-N2: 候補の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 でない、`a7e96946` を祖先に含まない、親の合流に渡した窓の値が 40 ms でない、またはその値が null の receipt を /5 の行で判定した（18。`[precheck]`）。
- K6/5-N3: receipt の先頭に /5 の凍結の commit と SHA-256 が無い、または /5 の凍結の前に始めた run の receipt（19）。
- K6/5-N4: Hybrid p95 を 94.2 ms 以外の上限（65.04 ms、240 ms ほか）と比べた判定、B を 54.2 ms 以外の値で求めた判定、または片方の arm だけで判定した receipt（20）。
- K6/5-P1: D=40 ms の窓内に親が Graph を受けた sample を first-render の窓内に数え、子を出さない（K6/4-P2 を 40 ms で読んだもの。「変える点」の 5）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 の手順（S2 追補 #14、S3、S4 の 6 回目の凍結） | 手順のファイルの新しい版（D=40 ms、B、Hybrid p95 の上限、/5 の draftRef と SHA-256。T_late は 100 ms のまま）、harness の変更（下の表）、C7 と G-01 相当（手順の側）、/5 の凍結の head の receipt への記録、K6/5-N1〜N4・P1 と C7 の合成の記録による検出力の記録の取り直し |
| P の評価（`nir1-retrieval`） | 影響しない（「変える点」の 4）。P の評価を D=40 ms に合わせるかは、この draft の外（台帳 l6-l9:536 の P の固定値の個別の確認） |
| DR-IRW（製品） | 影響しない。/5 は製品の値を契約に取り込むだけ |
| PUB-G／Session C-1 | 開示の項目（K6/4 の「UX と製品の意味」）の D は 40 ms で読む。PUB-G の承認は置き換えない |
| DD-1、DP-H、K6/3 | 影響しない |

### この draft が確認されたときに変わる harness の file（実装はしない。製品 repo の `1822b192` の行）

| file | 変わる中身 | pin |
| ---- | ---------- | --- |
| `scripts/quality/nir1-graph-eval/constants.mjs` | `:10` の `GRAPH_EVAL_D_MS` を 40 にし、`:9` の注記（「D = min(100 ms, 0.20 * B) … never recomputed」）を「/5 と DR-IRW-1 の固定値。式から導かない」に直す。契約の B（54.2 ms）と Hybrid p95 の上限（94.2 ms）の定数を足す。`:30` の `K64_T_LATE_MS`（100）は変えない。`:56-65` の `K64_FREEZE` は残し（trace の file と S2 が K6/4 を束縛する）、/5 の凍結の descriptor（path、sha256、draftRef `nir1-final-request-eval-proposal/5`、contractId、confirmedCommit、freezeCommit）を足す。`:341` の `[precheck]` の文は値を読むだけ | `g4-b1-freeze-v2-constants` ほか（pin のし直し） |
| `scripts/quality/nir1-graph-eval/procedure-file.mjs` | `:126-131` の `contract` の照合先（`K64_FREEZE` の draftRef・sha256）を /5 の descriptor にする。`values` の key（`:62-68`）に `bMs` と `hybridP95LimitMs` を足し、constants の契約の値と一致を求める（schema の版を上げる。`TOP_KEYS` は `:53-61` で固定）。`dMs`（`:64`）の照合は constants を読むので値は自動で 40、`tLateMs`（`:66`）は 100 のまま。注記（`:3-5`、`:21`、`:45`）の「K6/4」を /5 の行に直す | `HARNESS_FILES` に入る（持つ pin は実装の時に `harnessPinOf` で確かめる） |
| `scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-3.json` → `k64-procedure.v2.json`（新規。v1・draft-2 は残す） | `contract` を /5（draftRef、contractId、SHA-256）、`values.dMs` を 40、`values.bMs` を 54.2、`values.hybridP95LimitMs` を 94.2、`values.tLateMs` は 100 のまま、`review` を S3 の記録に | S4 の `boundFiles` |
| `scripts/quality/nir1-graph/observation-prep.mjs` | **`:409-414` の `K64_VALUES`**（`dMs: 10.84`、`wFMs: 100`、`tLateMs: 100`、`tShowMs: 2_000` を直書きし、`:3022-3027` で手順のファイルの `values` の key の集合と値の完全一致を照合する）の `dMs` を 40 にし、`bMs: 54.2` と `hybridP95LimitMs: 94.2` を足す（`tLateMs` は 100 のまま）。注記の「D from the P contract」を /5 に直す。`:80-83` の契約の期待値に /5 を足す（`:2886-2889` の trace の照合は K6/4 の bytes のままにする）、`:393` の `PROCEDURE_V1`、`:1548-1549` の placeholder（`k64-procedure-v1-commit`／`-sha256`）を v2 に、`SOURCE_PINS` | 凍結の検査そのもの |
| `scripts/quality/nir1-graph-eval/frozen-k64-admission.mjs` | `:46` の `FORMAL_PROCEDURE_VERSION` を `"v2"` に。`:237` の凍結の head の読取に /5 の head を足す | pin のし直し |
| `scripts/quality/nir1-graph-eval/admission.mjs` | `:466-500` の `readK64FreezeHead` と `:834-836` の `head.k64` の照合に、/5 の凍結の head を足す（または descriptor を受ける形を /5 にも使う）。「変える点」の 6 の照合（候補の commit が `a7e96946` を祖先に含むこと、候補の `relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS` が 40 であること）を足す | `s4-rehearsal-admission`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/followup.mjs` | `:496-498` の親の窓の照合: /5 の下では、不一致を ratification12 ではなく `[precheck]`（/5 の判定をしない）にし、`graphWindowMs` が null の sample も照合できたとしない。`:561` の T_late の照合は変えない | `v4-followup-cancelled-match`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/receipt.mjs` | `:402-411` は `K64_FREEZE.freezeCommit` の receipt だけを通す。「変える点」の 7 で receipt の先頭に /5 の凍結を書くので、/5 の head を検査する形に変わる見込み（手順の起案 §2.1 は bytes を変えずに済むかを未確認とした） | `t14-k64-freeze`（変えるなら pin のし直し） |
| `scripts/quality/nir1-graph-eval/frozen-diagnostics.mjs:920`、`:960`、`diagnostic-runner.mjs:402` | `head.k64` の扱いに /5 の head を足す | 実装の時に確かめる |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs:68-93` の `deriveLatencyPolicy`、`quality-verdict-cli.mjs:37-38`（`PROCEDURE_FILE` が v1 の path）・`:242`・`:253`・`:402`・`:438` | B を D から逆算せず、手順のファイル v2 の `bMs`（54.2）と `hybridP95LimitMs`（94.2）を読み、constants の契約の値と一致を確かめる。手順のファイルを v2 に | pin の外（DR-CP4-QV-1）。値は v2（S4 が束縛）から読むので、上限は凍結の内にある |
| `evals/nir1-graph/observation-prep.v1.json`（S2 追補 #14） | `contracts` に /5（draftRef、contractId、path、SHA-256、confirmedCommit、freezeCommit）を足す。`k64Procedure`（v2、`values.dMs` 40、`bMs`、`hybridP95LimitMs`、`valueReasons.dMs` の「P の固定契約で K6/4 の変えないもの」を /5 の理由に）、`userConfirmations` に /5、`registeredForReview` の `BOUNDARY_TOLERANCE_MS` の注記（`:366-372`） | S4 が束縛 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | S4 の 6 回目の凍結（`boundFiles` の sha256） | — |
| `evals/quality-manifest.yaml:706` | `k64-procedure.v2.json` を足す | — |
| `scripts/quality/nir1-graph-eval/hook-check.mjs:38-40` | 注記だけ（10.840000000596048） | 診断用 |
| 試験（constants・procedure-file・observation-prep・frozen-k64-admission・admission・followup・receipt・quality-verdict、K6/5-N1〜N4・P1 の合成の例） | 追加・更新 | 試験は pin の対象外 |
| 変えないもの | `evals/nir1-graph/trace-editing.v1.json`・`trace-browsing.v1.json`。`observation-prep.mjs:2886-2889` は trace の `contract.k64.sha256` を `CONTRACTS.k64`（K6/4 の bytes）と比べるので、`CONTRACTS.k64` を K6/4 のまま残し /5 を別の key で足せば、trace の束縛はそのまま有効（trace が引く K6/4 の変える点 15、R8、変える点 12 は /5 で変わらない）。`observation-prep-author-declaration.v1.json` の K6/4 の読み（宣言を作り直すなら /5 を足す）。T_late の定数と照合（`constants.mjs:30`、`followup.mjs:561`、`receipt.mjs:681-685`） | — |

## 確かめられなかったこと

1. `nir1-l6-l9-contract-proposal/7`（確認済み）の 31 行は窓外率を「最終 request の窓（D=10.84 ms。K6/2）」と説明する。用語の説明で、窓の値の正本は `graph-eval-procedure` の行なので、台帳の注で足りる（下の注の案）。/5 は proposal/7 の行を確認も変更もしない。
2. 台帳 l6-l9:437、:536、:768、:781 の P の固定値（D=10.84 ms、上限 65.04 ms）と、製品の D 40 ms・DR-IRW-3 の上書きの食い違い。/5 は P の行を変えないので解かない（P の評価を D=40 ms に合わせるなら個別の確認が要る。:536）。
3. `receipt.mjs` の bytes を変えずに /5 の凍結の head を receipt に書けるか（pin `t14-k64-freeze`）。
4. D=40 ms で親が D の内に Graph を受ける sample の頻度、graph-late の親の q1、両 arm の Hybrid p95（G-case でも trace でも未測定）。T_late の q1 の分布の上がり方（(b) の形の親の割合）は D=10.84 ms の観測からの推測で、「緩和の一覧」の見積りは D=10.84 ms の dev fixture と s5r6 の値からの推測である。
5. 改訂 4 の再レビューはまだない。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（2026-10-25 の緩和の後。l6-l9:307）に従い、`nir1-final-request-eval-proposal/5` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。構造化質問なら、質問の文が draftRef、contractId、この draft の SHA-256 を名指し、ちょうど 1 つの `draftRef#contractId` を示す。承認の効力は批准 7 の 2 段で、(i) は確認、(ii) は事前の確認である。依存する契約と、ほかの contractId の行は確認されない。推奨と違う選択は、新しい draftRef で起案する。
- 確認の質問の文には、(1) 緩和の一覧（R-1〜R-5: 窓内の D、親と子の IR の締切〔製品の既定の効果の引受けを含む〕、Hybrid p95 の上限 94.2 ms、「D の後の Graph」の違反の境界）、(2) T_late は 100 ms のまま変えないこと、(3) P の評価の値は変えないこと、(4) C7 と G-01 相当は /5 に含めず手順の側で扱うこと、を書く。
- 2026-11-07 のユーザーの回答（問 1、U-1、U-2 とその再確認、問 3、問 5）、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。CP-4 は AGENTS.md の NIR-1 の残レーンに入っておらず、技術判断の事前委任も無い（手順の起案 §3）。

### 確認までの手順（前例どおり）

1. 起案（初版）、独立レビュー（Opus の敵対的レビュー）、改訂 2、U-1・U-2 のユーザーの選択、改訂 3、再レビューと U-2 の再確認、改訂 4（この file）。
2. 改訂 4 の独立レビューの要否は integrator が決める（行う場合は read-only で、この draft と、K6/4・K6/2 の引いた行、`irw-decisions.md` を渡し、起案者の結論は渡さない）。確認に出す版の SHA-256 を確定する。
3. ユーザーの確認（上の形）。
4. 確認の記録: `claude/nir1-contracts` に確認の記録（前例 `docs/plans/nir1-cp4-records/user-confirmation-2026-11-04-scope-default-contract.md` の形。質問と回答の逐語、日付、draftRef#contractId、SHA-256）を commit する。続行計画（`docs/plans/nir1-continuation-2026-10.md`）の §10 に節を足す（§10.7 Session B5 の形）。
5. 台帳の更新（master への PR）: draft を確認された版から byte 同一で `docs/plans/nir1-final-request-eval-proposal-5-draft.md` に取り込み（`git show <commit>:<path>` の出力をそのまま置く）、`sha256sum` の一致を確かめ、下の補足・行・注を足す。「Status: draft／未確認」の行は bytes を変えないために残す。
6. contracts の凍結: S2 追補 #14 の S4（6 回目）の前、かつ /5 で判定する最初の run の前に、確認された bytes を `claude/nir1-contracts` の `docs/plans/nir1-final-request-eval-proposal-5-draft.md` に commit して push し、K6/2 の「事前登録の凍結」の 1〜7 の記録（`k64-freeze-record.md` と同じ形の `k65-freeze-record.md`。凍結の commit、file の SHA-256、`git ls-remote`、push の時刻、remote 側の時刻〔repository activity と PushEvent〕）を作る。凍結の後、`claude/nir1-contracts` は fast-forward だけで進める。
7. その後に、harness の実装、S2 追補 #14、S3、S4 の 6 回目の凍結、正式 run（手順の起案 §4）。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足（l6-l9:187-197 の Session B5、:211 以降の X1/3 と同じ形）の見出し: 「2026-11-xx補足（K6/5）」。受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256、確認の記録の commit。「経緯」に DR-IRW-1〜3（製品の D の 40 ms、2026-11-05）、`irw-decisions.md:31`（手順の新しい版が要る）、2026-11-07 のユーザーの選択（問 1、U-1、U-2 の再確認）と、訂正の経緯（最初の問 2 は「p95 は補助記録だけ」、最初の U-2 は「T_late の余裕が縮む」という誤った説明で示され、どちらも訂正して聞き直した。記録は contracts の irw3 の追記、`f026d1f1`・`fdf1159d`）を書く。表の行 ID は `K6/5-1`（Session の名前を持たない確認の記録の前例。X1/3-1、SDEF/1-1）。「承認の範囲と効力」と「K6/5 が許さないもの」（批准 9）の段落を足す。
- 確認台帳の行の案（l6-l9:257 の /4 の行の下に足す。/4 の行は消さない）:

| contractId | draftRef | confirmedRef | confirmedScope | 備考 |
| ---------- | -------- | ------------ | -------------- | ---- |
| `graph-eval-procedure` | `nir1-final-request-eval-proposal/5` | `nir1-final-request-eval-proposal/5#graph-eval-procedure`（批准7の(i)についてだけ。(ii)は `preConfirmationRef` で、効力の根拠にしない） | K6/5の範囲: draft冒頭の「ユーザーが批准すること」の1〜9の全項目（この一覧が範囲の正本で、台帳は別の列挙を持たない）。/5の行の内容は、/4の行（K6/2の `graph-eval-procedure` の本文の全文に/4の「変える点」の1〜18を当てたもの）に、/5の「変える点」の1〜7を当てたもの。最初の表示のDを40 ms（DR-IRW-1・2の製品の固定値。Pの式から導かない）とし、Dを参照する規則（窓内の判定、親と子のIRの締切、graph-lateの親の公開の時刻ほか）は文面を変えずに40 msで読む。CP-4の受入れ（K6/2の620行）のHybrid p95は、G-caseのCP-4のrunのR+IR armとR+IR+Graph armをarmごとにpoolしたnearest-rankのp95で、両armが94.2 ms（B=54.2 ms＋D=40 ms。BはDから逆算しない）以下。T_lateは100 msのまま（K6/4の判断3）。**合格基準の緩和（5つ）**: 窓内の判定のD、親のIRの締切（製品の既定の効果の引受け）、子のIRのdeadline（いずれも10.84→40 ms）、Hybrid p95の上限（65.04→94.2 ms）、「Dの後のGraphを表示に混ぜた」の違反の境界（K6/4:163、K6/4-N1、N29、禁止寄与の(b)。Raw-ready＋10.84→＋40 ms）。/5の行は製品のDが40 msの候補にだけ当てる（「変える点」の6）。W_f 100 ms、T_late 100 ms、T_show 2 s、1%、F1〜F7、X1〜X13、R1〜R8、受入れ、批准5の候補の限定の文面と値は/4のまま（Dを参照する項目〔F3の公開の時刻、F6、X11、K6/4:163、N1、N29、N30、N32、N39ほか〕はDを40 msで読む）。Pの評価（`nir1-retrieval` のmanifestとharness）とPの行の値、C7とG-01相当（手順の側）、依存する契約、`nir1-final-request-packing-eval`、`g01-eval-revision`、proposal/7の行は確認しない | (i)は確認済みで、記録の時点からCP-4の可用性と品質の判定に使う（/4の行に替わる。/4の行と、/4の下のreceiptは履歴として残し、/4の行で新しい判定はしない）。(ii)は/4の行と同じく、条件の成立、診断とreceiptの照合、改めての確認の後にだけ効く。/5の凍結（`claude/nir1-contracts` へのcommitとpush、K6/2の「事前登録の凍結」の1〜7の記録）の前に始めたrunは/5の判定に使わない。この確認は、Graphの製品公開、local送信の公開、activation UIの公開、新しいauthority・保存先・送信先・製品の入口を許可しない |

  （実際の台帳の行は l6-l9:257 と同じ 10 列（lane、startStatus、blockers、英文の記録の列を含む）で書く。英文の記録の列の案: `confirmedRef=nir1-final-request-eval-proposal/5#graph-eval-procedure` (ratification 7 (i) only); `preConfirmationRef` for ratification 7 (ii); confirmed <date> by <form>; chosen option verbatim; draft `docs/plans/nir1-final-request-eval-proposal-5-draft.md` at commit `<commit>`, SHA-256 `<sha256>`; this independently ratifies only this row; the /4 row above is kept as confirmation history and is not used for new determinations; the user's 2026-11-07 choices (question 1, U-1 and U-2 after corrected re-asks) were drafting instructions and are not a confirmation。lane は「CP-4、PUB-G（Session C-1 の開示の項目）」、startStatus は /4 と同じく `condition-not-met`（(ii) について）。）

- 台帳の注の案:
  - l6-l9:257 の /4 の行の備考の末尾に「2026-11-xx 追記（K6/5）: /5 の確認の後、CP-4 の判定は /5 の行で行い、この行で新しい判定はしない（/4 と /5 を結果を見て選び分けることを防ぐ）。この行の下で取った receipt は、その時点の候補の記録として残る」。
  - l6-l9:275 の 2026-10-26 の注（K6/4）の下に「2026-11-xx の注（K6/5 `nir1-final-request-eval-proposal/5#graph-eval-procedure`。上の注は消さず、読み替えを足す）: K6/5 の確認により、/4 の行は K6/5 の「変える点」の 1〜7 を当てて読む。(1) 最初の表示の D は 40 ms の固定値（DR-IRW-1・2）で、P の式から導かない。D を参照する規則（K6/2 の 619、694、705、706、716、717 行、/4 の F3・F6・X11、:163 と K6/4-N1・N29（「D の後の Graph を表示に混ぜた」）、変える点 15・17、技術点 3、批准 12 ほか）は文面を変えずに 40 ms で読む。(2) 「D を変えない・広げない」の文（K6/2 の 609、614、617〜621、633 行、/4 の批准 5・9 ほか）は D=40 ms について読み、/5 の 10.84 → 40 ms はその「別の確認」と「新しい draftRef」にあたる。(3) K6/2 の 620 行の Hybrid p95 は G-case の CP-4 の run の両 arm を arm ごとに pool した nearest-rank の p95 で、上限は 94.2 ms（B=54.2 ms＋D=40 ms）。P の評価の値は変えない。(4) T_late は 100 ms のまま。(5) /4 の『事実』と導出の D との比較は /4 の起案の時点の 10.84 ms との比較として読む。**緩和は 5 つ**（窓内の D、親の IR の締切、子の IR の deadline、Hybrid p95 の上限、「D の後の Graph」の違反の境界）」。
  - l6-l9:280 の注（K6/2 の条件付きの 2 行の『`confirmedRef` を持たない』は /4 の (i) に当てない）の下に「2026-11-xx の注（K6/5）: 同じ読みを /5 の行の (i) にも当てる。/5 の行の一部だけの `confirmedRef` は /4 の行と同じ形」。
  - l6-l9:536 の P の固定値の段落の下に「2026-11-xx の注（K6/5）: `graph-eval-procedure`（K6/5）の CP-4 の判定では、最初の表示の D は 40 ms、Hybrid p95 の上限は 94.2 ms。**これは P の値の変更ではない**: P の評価（`nir1-retrieval`）の B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms はこの確認で変わらない。製品の D 40 ms（DR-IRW-1・2）とこの段落の D=10.84 ms の食い違い（DR-IRW-3 の上書きが台帳に反映されていないこと）は、この注の後も残る。解くには P の固定値の個別の確認が要る」。
  - proposal/7 の行（`graph-limited-binding`）の備考に「2026-11-xx の注: proposal/7 の 31 行の『D=10.84 ms。K6/2』は窓外率の用語の説明で、窓の値の正本は `graph-eval-procedure` の行（K6/5 の後は 40 ms）。この注は proposal/7 の行の確認を変えない」を足す（用語の説明なので注で足り、proposal/7 の新しい draftRef は要らない）。
- lane snapshot の CP-4 の行（l6-l9:606）に、K6/5 の確認と、/5 の凍結・S2 追補 #14・S4 の 6 回目の凍結が未実施であることを追記する。
- 確認されなければ、CP-4 は /4 の行のままで、D=40 ms の候補では手順が `[precheck]` で止まる（`irw-decisions.md:31`）。別の案は /6 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行、K6/4 の行と同じ）。

- 理由: (1) この差分は、/4 の行の D の値と、それに連動する Hybrid p95 の上限の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認（台帳の Confirmation protocol）。

承認の例（固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-final-request-eval-proposal/5 for contractId graph-eval-procedure.
