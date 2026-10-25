# NIR-1 最終 request 評価の契約提案 proposal/3（draft）: DD-1 の接続の試みの分類と、版の番号の読み替え

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

要約: (1) 確認するもの — K6/2 の DD-1 の接続の試みの分類に、NC-1 の下で毎回起きる 3 種の試み（(a) LS-1 への接続、(b) blackhole された辞書の要求、(c) datagram を送らない IPv6 の UDP connect）を型つきで期待された通信に加え、DP-H の置換版に伴って版の番号を読み替える（`nir1-final-request-packing-eval` の 1 文）。(2) ユーザーが決める点は 5 つ（「判断を求める点」の表）。(3) 最も重い開示: この確認は K6/2 の文面より**弱い読み（合格基準の緩和。批准 5）**で、(c) は K6 の出典の原則（期待された通信の出典は K3 の確認済みの開示に限る）の**唯一の例外**である（判断を求める点 5、変える点 15）。(4) 読む順序の案: 「判断を求める点」（判断 5 は「型の定義」の (c) も）→「ユーザーが批准すること」→「変える点」の表（特に 1〜5、14、15）→「threat model」の Out-of-scope attacks →ほかは必要に応じて。

## ユーザーが批准すること

末尾の確認文 1 文で批准するのは、次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、「前書き」「範囲」「確認後の記録」の台帳の `confirmedScope` はこの一覧を指すだけで、別の列挙を持たない。一覧にないものは批准しない。数値と根拠は各節に 1 回だけ書き、ここには再掲しない。判断が要る値と選択は「判断を求める点」にまとめた。

1. 加えるもの: K6/2 の DD-1 の「接続の試みの分類」の期待された通信に、次の 3 項目を、この draft の「型の定義」の型と起点つきで加える。(a) Chromium（default session）から LS-1（Main の process が持つ `127.0.0.1` の blackhole の listener）への接続、(b) blackhole された辞書の要求の試み（(a)(b) は K3/3〔`nir1-d2a-activation-proposal/3#caller-profile-egress`。確認済み〕が「続く通信」に加えた 2 項目）、(c) datagram を送らない IPv6 の到達性の確認の UDP connect（Chromium の host resolver と network quality estimator が起こす。K3/3 の「開示に無かったこと」の 5 が開示の材料に挙げ、DA-2 と DA-2b の restricted の試走が「packet 0 なので一覧外の通信にあたらない」と読んだもの。DR-DA2-44、DR-DA2B-R10）。**(c) は K3 の確認済みの「続く通信」の一覧の外にある**（K3/3 は変える点 9 の 2 項目のほかは開示の材料にするだけとし〔K3/3 の 346 行〕、DR-DA2-44 も続く通信に加えなかった）。K6/2 は期待された通信の出典を K3 の確認済みの開示に限る（119 行、284 行の後半）ので、(c) はこの確認によって K6 だけで期待された通信に加える**唯一の例外**である（「変える点」の 15）。
2. 加え方の制約: (a) は (b) の要求を運ぶ接続としてだけ期待された通信になり、(b) の要求の一部として数える（別の件にしない）。(b) の要求を運ばない LS-1 への接続、型に合わない接続や UDP connect、件数・時刻・記録の規則を満たさないものは、従来どおり「それ以外」に入れる（「件数の規則」「分類の順序」）。**DP-1 の証跡にする DD-1 の run は、NC-1 を当てた起動（起動の env に `ELECTRON_RENDERER_URL` がない起動）に限る**。NC-1 を当てない run は記録して分類するが、DP-1 の証跡にしない（K6/2 より厳しい側の追加）。
3. LS-1 の port（この draft では `L` と書く）の同定: run の net log と、harness が取る OS の socket 表の snapshot（この draft が DD-1 に足す観測。読取だけで接続しない）の両方で同定する。同定できない run には (a) を当てない（「LS-1 の port の同定」）。
4. 件数・時刻・記録の規則:
   - (b) の要求 1 件が運ぶ LS-1 への接続は 1 本ちょうど（M_a = 1）。
   - (b) の要求の件数の上限 N_b は診断の run の観測から観測の前に DD-1 の freeze 記録に書き、**3 を超えてはならない**。(c) の件数の上限 N_c も同じく書き、**2 を超えてはならない**。(b) の URL の集合は K3/3 の型の部分集合、(c) の宛先の集合は `{[2001:4860:4860::8888]:443}` の部分集合に限る。
   - 時刻の許容幅 ε は **100 ms 以下**。
   - 環境側の記録は、L への接続の local の port と、(c) の宛先への packet の数を持たなければならない。net log の capture の mode は `--net-log-capture-mode=Everything`（または SOCKS5 の段の event、`byte_count`、`TCP_CONNECT` の `local_address` を同じく記録する mode）でなければならない。満たさない run には (a) と (c) を当てない。Everything の net log は socket の bytes と cookie も含みうるので、評価の evidence の directory（`.artifacts/` の下。commit せず公開しない）にだけ置き、receipt には要約（event の名前、件数、port、時刻、file の sha256）だけを載せる。
   - 診断の run の長さ（`diagLengthMs`）、ε、capture の mode、(b) の URL の集合、(c) の宛先の集合は、観測の前に DD-1 の freeze 記録に書く。
   - 診断の run で、N_b の最大値が 3 を超える、N_c の最大値が 2 を超える、M_a = 1 が崩れる、挨拶の書込みの event が現れない、のどれかなら、DD-1 は `[precheck]` で止まり K6 の新しい draftRef を求める。
   - 観測の後に変えてよいのは、件数と型を**狭める方向だけ**で、診断の記録、独立期待値 reviewer のレビュー、**新しい版の freeze 記録**を要する（同じ版の freeze 記録を書き直すと、K6/2 の 253 行末尾の「variant を束縛する freeze 記録の commit が、その材料で Native を実行したどの run の commit よりも前」の検査で、その版の variant が実行できなくなるため。新しい版には K6/2 の版の規則〔新しい材料だけで作る、前の版の freeze 記録を引く〕がそのまま当たる）。N_b や N_c を広げる、URL や宛先の集合を広げる、ε を広げる、port の同定や記録の条件を外す、`diagLengthMs` を超える run を証跡にする、のどれも新しい draftRef でしかできない。
5. これが合格基準の緩和に当たること: K6/2 の 284 行の文（「loopback の接続の試み〔…を除く〕は、一覧に項目がないので、すべてそれ以外」）と 277 行の「接続の試み…の全件」を文面どおりに読めば、NC-1 を含む build の DD-1 の run は、LS-1 への接続と IPv6 の UDP connect が毎回記録されるので、DP-1 を PASS にできない。別の読み方もありうる（K6/2 の 119 行と 279 行は、K3 が確認で一覧を変えれば期待された通信も合わせるとし、284 行の理由句「一覧に項目がないので」は K3/3 の後は成り立たない。(c) は packet を出さない socket の操作で接続の試みにあたらないとする DA-2 の読みもある）。/3 は型を明示してこの曖昧さを除く。加えて (c) は、期待された通信の出典を K3 の確認済みの開示に限る K6/2 の原則（119 行、284 行の後半）からの逸脱で、K3 の確認を経ずに K6 の確認だけで加える唯一の例外である。文面どおりの読みに比べれば、上の型に合う試みに限って run を証跡にしてよいとする**弱い読み**であり、弱める範囲は批准 1〜4 の型と件数に限る。残る誤分類の余地は threat model の Out-of-scope attacks と「未確認と未検証」に書く。
6. 版の番号の読み替え（「変える点」の 14）: DP-H の版1 が失効した場合（現に失効している。DR-DPH-70）、DP-H の置換版を「版2」、DD-1 が足す版を「版3」と読む。K6/2 で DD-1 の版を指す「版2」（253、297、417、439 行を含む、本文のすべての箇所）と、DP-H の fixture を指す「版1」（246、253、258、288、297、325、417、465、472、499、515、781 行を含む、本文のすべての箇所）はこの読み替えに従い、材料の除外の規則は失効した版1・置換版・DD-1 の版のすべてを対象にする。範囲は命名と引く先の読み替えだけで、版の規則そのもの（観測前の固定、新しい材料だけで作ること、前の版の freeze 記録の commit と file の sha256 を引くこと、引く先の一致を実行の条件とすること、「版3以降も同じ規則」）は変えない。
7. 変えないもの: /2 のほかの全部（「前書き」の「変えないもの」の列挙）。loopback を記録と分類から外さない（/2 が禁じたまま）。recorder への接続の規則、AI の送信先の規則、`github.com` の分類の限界、意味モデルのない初回起動の状態、P の Gold と固定値、事前登録の凍結の規則、失効率の物差し、AI 使用ポリシーを書かない setup は変えない。
8. 許さないもの: DD-1 の実装と実行そのもの、DP-H の置換版の作成そのもの、NC-1 の挙動の変更、新しい authority・保存先・送信先・製品の入口・評価専用の入口、Graph と local 送信の公開、Session C-2 の承認。依存する契約（K3/3 を含む）と、K6/2 の条件付きの 2 行（`g01-eval-revision`、`graph-eval-procedure`）は確認しない。
9. threat model と受入れ（GDX-PRECHECK-001 の明示の確認の対象）: 「threat model」の節の 6 要素（Trusted actors、Untrusted actors、In-scope attacks の 1〜13、Out-of-scope attacks の 1〜7、Mandatory defenses、Acceptance implications）、「受入れ」の節（receipt に加えるもの、K6/3-P1〜P3、K6/3-N1〜N30）、「変える点」の 1〜15、「引き継ぐもの」の節。

注記（批准の対象ではない）: 2026-10-25 にユーザーが選んだ (A)（「Aで」）は、この draft を起案する指示で、確認文ではない。この起案は選択肢の逐語の質問文を見ておらず、integrator の伝聞による。(c) と版の番号の読み替え（6）は、integrator がレビューの指摘と DP-H の置換版の必要（別 lane）から加えた項目で、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/3` |
| contractId | `nir1-final-request-packing-eval`（K6/2 と同じ。選んだ理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `7af0be93`（#707）。この draft の行番号（K6/2 の本文、`electron/main`、`electron/scripts`、`scripts/quality`、`src-tauri/crates`、台帳 `docs/plans/nir1-l6-l9-execution-plan.md`、続行計画）は `7af0be93` で確かめた。K6/2 の bytes の SHA-256 は `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8`、K3/3 は `e5362f3e40e662781d57c46d20db617aded3c7d4cf72912c0d27991b0dbded11` で、どちらも台帳の値と一致することを再計算して確かめた |
| 確認済み baseline | `nir1-final-request-eval-proposal/2#nir1-final-request-packing-eval`（K6/2。2026-10-17 の Session B1 で確認。commit `af643a93`）。台帳の 2026-10-23 の注記（K6/2 の「確認後の記録」への DI-1a の注記。台帳 558 行）を含む。K6/2 の bytes は変えない（この draft は別のファイル） |
| 前提 | K3/3 は 2026-10-18 の Session B3 で確認され（台帳 187 行）、NC-1／LS-1 は #683 で master にある（`electron/main/rendererContainment*.ts`）。K3/3 の引き継ぎ H4 は、K6/2 の分類が (a)(b) と両立するかを K6 の確認者の判断に残し、台帳の lane snapshot（544 行）と続行計画（§4 の 154 行、§10.5 の 494 行、§11 の 510 行）は DD-1 をその判断まで着手しないとしている。DD-1 の harness（評価の Electron の起動と接続の試みの記録・分類）は `7af0be93` に無い（未実装。`scripts/quality/nir1-packing/final-request/` は DP-H の scorer と receipt で、接続の試みを扱わない）。DP-H の版1 は Native に観測されて frozen にできない（freeze 記録の `status` は `pending-review`。DR-DPH-70） |
| 版の呼び方 | 「変える点」の 14 の読み替えの後、DD-1 が足す版を「DD-1 の版」、その fixture と freeze 記録を「DD-1 の fixture」「DD-1 の freeze 記録」と書く（DP-H の版1 が失効した今の状態では版3） |
| 確認を求めるもの | 冒頭の「ユーザーが批准すること」の 1〜9（範囲の正本。ここに別の列挙を置かない） |
| 変えないもの | K6/2 のほかの全部。P の Gold（12 task、保持 100%、禁止情報 0、prose 非回帰）、P-12 の slot と 0→1、P の固定値（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）、既存の 24 件、G-01 の v1、G-02〜G-08、IR の floor、K1 の値と規則、Packing の 2 MiB と 512 items、AttemptBinding の 64 KiB、事前登録の凍結の規則、失効率の物差し（1%）、AI 使用ポリシーを書かない setup、recorder への接続の規則（run の全体で 1 本）、AI の送信先の規則、Chromium の network stack を通らない試みの規則と `github.com` の限界、意味モデルのない初回起動の状態、既存の型（spellchecker の辞書ファイルの取得の型を含む）、版の規則（命名と引く先を除く）。新しい authority・保存先・送信先・製品の入口は加えない |

## 判断を求める点

確認の前にユーザーの判断が要る点。推奨のまま確認文を打てば推奨が確認され、推奨と違う選択は新しい draftRef で起案する。用語: M_a = (b) の要求 1 件が運ぶ L への接続の本数（1）、N_b・N_c = 1 run の (b)・(c) の件数の上限、ε = 環境側の記録と net log の時刻の許容幅、`diagLengthMs` = 診断の run の長さの上限（定義は批准 4 と「件数の規則」）。

| # | 論点 | 推奨 | 代案 | 批准の番号 |
| - | ---- | ---- | ---- | ---------- |
| 1 | N_b の上限 | 3（DD-1 の長さの run での再試行が未検証で、値の根拠は薄い） | 1 に固定する（厳しいが、再試行が起きれば DD-1 が再び構造的に通らない）。freeze 記録だけに委ねる（上限なし）。どちらを選んでも、(b) の再試行は (c) の側にも響く: IPv6 の到達性の確認の UDP connect は cache が切れた後の最初の名前解決の source に帰属するので、再試行の connect job の解決が起点になりうる（(c) の起点の (iii) で受けるが、N_c ≤ 2 を超えれば `[precheck]`）。再試行が起きる環境では、N_b と N_c の両方の上限を見直す新しい draftRef が要りうる | 4 |
| 2 | DP-1 の証跡にする DD-1 の run | NC-1 を当てた起動（`ELECTRON_RENDERER_URL` なし）に限る（K6/2 より厳しい追加） | NC-1 のない起動も証跡にする | 2 |
| 3 | 版の番号 | DP-H の置換版を版2、DD-1 の版を版3 と読む（確認済みの文言の読み替え） | DD-1 の版を版2 のまま置き、置換版に別の名前を付ける。なお integrator によれば、PR #709（DP-H S0、open）は版2 を置換版としてすでに実装している（DR-DPH-83、86。この起案では PR を読んでいない） | 6 |
| 4 | net log の capture の mode | `--net-log-capture-mode=Everything`（SOCKS5 の段の event、`byte_count`、`local_address` を確かめたのはこの mode だけ）。socket の bytes と cookie を含みうるので、net log は `.artifacts/` の下にだけ置き、receipt には要約だけを載せる | 同じ項目を記録する別の mode（確かめていない） | 4 |
| 5 | 第 3 の期待された通信 (c) | datagram を送らない IPv6 の UDP connect を、宛先・起点・packet 0・件数（N_c ≤ 2）の型つきで加える | 加えない（NC-1 の全 run に「それ以外」が出て DD-1 は構造的に通らない）。DA-2 の読み（接続の試みにあたらない）を文で採る（記録の全件の規則〔277 行〕を狭める読みになる）。**K3/4 で「続く通信」に加える**（K6/2 の 284 行が定める経路で、出典の原則を守れる）。推奨が K3/4 を採らない理由（最終判断はユーザー）: (c) は datagram を送らず、利用者に開示する「続く通信」の実体がない。K3 の開示の文言に載せると、外へ通信するかのような誤った説明になる。K3 の確認は PUB-G の開示の文言にも結びつき、DD-1 の評価の都合で開示を変えることになる。そのかわり (c) は K6 の出典の原則からの唯一の例外になる（「変える点」の 15） | 1、4、5、9 |

## 引き継ぐもの（K6/2 の 147 行の規則による）

K6/2 の「確認の扱い」（147 行）は、同じ contractId の後続の draftRef が確認されると先行の行を全体として supersede し、後続は先行の行から引き継ぐもの（作った版、receipt、失敗の記録、事前登録の規則）を本文に書くとする。/3 が確認されたときの `nir1-final-request-packing-eval` の内容は「K6/2 の全文に、下の『変える点』の表を当てたもの」で、次を引き継ぐ。

1. K6/2 の下で作った DP-H の記録は、/3 の行の下でも /2 の下で作った記録として、その状態のまま有効とし、それらの `draftRef` の欄は `/2` のまま読む: fixture 版1（`evals/nir1-packing/final-request.v1.json`、SHA-256 `0d277e0cc00dc42f61ad583b7bb59a6b2f9f038a2932684d9bc823ac8dc9ac49`、`7af0be93` での最後の commit は `01238cfc`〔#677〕）、その freeze 記録 `evals/nir1-packing/final-request.freeze.v1.json`（SHA-256 `0bc52f5e8e5b97842e800ceecb943dc97f7ab1cd5adde5cf765f0347b1f50dd7`、最後の commit は `bf69e2f0`〔#689〕。`draftRef` は `nir1-final-request-eval-proposal/2`、`status` は `pending-review`。Native が freeze の前に材料を観測したので置換版が要る。観測の失敗の記録は `docs/plans/nir1-lane-decisions/dp-h-decisions.md` の DR-DPH-70 と DR-DPH-67 で、DR-DPH-69、71、72 はレビューの修正）、expectation review の記録。DP-H の receipt は `7af0be93` の repo に無い（DR-DPH-67 で evidence は HOLD。integrator によれば残ったのは hold の記録だけで、この起案では確かめていない）。版1 は「変える点」の 14 の読み替えの下で「失効した版1」で、置換版（版2）が `supersedes` として引く。版1 の失効の状態を変えず、frozen にしない。
2. DP-H は /3 の差分のうち「変える点」の 14（置換版を版2 と呼ぶこと、`supersedes` で版1 を引くこと、作者と reviewer を分けること、材料の除外）だけに従い、置換版（版2）とその receipt を含めて、名乗る draftRef は `nir1-final-request-eval-proposal/2` のまま作る。確認の後、K6/2 の行は全体として supersede されるが、新しい DP-H の記録は /2 を名乗る（supersede された行の draftRef を名乗る記録が、後続の行の規則〔14〕に従って作られる構図になる。台帳の注記で開示する）。validator の `DRAFT_REF`（`scripts/quality/nir1-packing/final-request/receipt.mjs:30`、704、`contract.mjs:1053`、1306）は DP-H の記録については変えない。**DD-1 の版（版3）の fixture と freeze 記録と、DD-1 の receipt から `nir1-final-request-eval-proposal/3` を名乗る**。それを受け付ける validator の変更（DD-1 の記録だけ /3 を受ける）は DD-1 の lane の実装で、この draft は書かない。
3. K6/2 の事前登録の凍結の規則（条件付きの 2 行。`claude/nir1-contracts` の `e49d0758` と /2 の凍結）は、別の contractId の行の規則で、この draft の対象外。そのまま残る。
4. K6/2 の確認の記録（2026-10-17、台帳 191 行）と、台帳の 2026-10-23 の注記（558 行）、2026-10-17 の読み方の注（206 行）は消さない。

前例は `nir1-l6-l9-contract-proposal/7`（確認済みの /6 の値を、同じ contractId の新しい draftRef で改訂し、/6 の確認を履歴として残した）。台帳の行の置き方（先行の行を残して後続の行を並べる）は K3/3 の行（186・187 行）に倣う。K3/3 は K3/2 を置き換えない加算で、/3 は K6/2 の規則による supersede なので、形は同じでない。

## 変える点（K6/2 との関係）

次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。**1〜4 と 15 は /2 の文面より弱い読み**（批准 5。15 は出典の原則の唯一の例外）、5 と 2 の後半は狭める防御、6〜13 は具体化か開示、14 は命名と引く先の読み替え（批准 6）である。以下、この表の行は「/3 の変える点 n」と呼び、K6/2 本文の「/1 からの差分」の #n とは別の番号である。

| n | 箇所（K6/2 の行） | /2 の文 | /3 の文 | 理由 |
| - | ---------------- | ------- | ------- | ---- |
| 1 | 「接続の試みの分類（DD-1）」の前置きの一覧（279 行） | 期待された通信は、K3 の確認済みの開示の「続く通信」の一覧（起案時点の K3/2 では、license の確認、更新の確認と download、意味モデルの download、IME 辞書の download、spellchecker の辞書ファイルの取得）の項目への試みのうち、記録から型と起点を確かめられたものだけ | 一覧に (a) LS-1 への接続、(b) blackhole された辞書の要求の試み、(c) datagram を送らない IPv6 の到達性の確認の UDP connect を加える（(c) は K3 の一覧の外の項目として加える。変える点 15）。型と起点はこの draft の「型の定義」による。ほかの項目の型と起点は /2 のまま | (a)(b) は K3/3 の「変える点」9。(c) は K3/3 の「開示に無かったこと」の 5 と DR-DA2-44。/2 の K3/2 への前提の 6（119 行）は一覧を K3 の確認に合わせるとするが、/2 の 284 行の文（/3 の変える点 3 が置き換えるもの）、URL による型の照合（280 行）、記録の全件の規則（277 行）がこれらを扱えないので、文で定める |
| 2 | 同じ前置きの対応づけ（279 行） | 環境側の記録の件のうち、net log の期待された通信の要求に対応するもの（同じ host で、要求の開始以後）は、その要求の一部として数え、別の件にしない | 加えて、環境側の記録の LS-1 への接続のうち、「型の定義」の (a) に合い、net log の (b) の要求に「件数の規則」のとおり対応するものは、その (b) の要求の一部として数え、別の件にしない。**(b) の要求には、環境側の記録の DNS の問合せを対応づけない**（`redirector.gvt1.com` などの問合せは /2 の DNS だけの件の規則で「それ以外」のまま。防御を狭める側） | LS-1 への接続は環境側の記録では `127.0.0.1:L` にしか見えず、「同じ host」で対応づけられない。SOCKS5 の下で Chromium は辞書の host を引かない（事実の測定） |
| 3 | 「期待された通信は…」の loopback の文（284 行） | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本を除く）は、一覧に項目がないので、すべてそれ以外に入れる | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本と、/3 の変える点 2 で (b) の要求の一部として数えた LS-1 への接続を除く）は、一覧に項目がないので、すべてそれ以外に入れる | 除くのは変える点 2 に当たる接続だけ。L への接続でも変える点 2 に当たらないものは、それ以外のまま |
| 4 | 「Chromium の network stack を通る試み」の後（280 行の次） | （なし） | 新しい項「NC-1 の下の LS-1 への接続、辞書の要求、IPv6 の到達性の確認（(a)(b)(c)）」を置き、この draft の「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」を本文とする | 型を URL でなく net log の `proxy_info`、socket の段、UDP の event で定義するため |
| 5 | 「観測の後に型を足せるのは…」（285 行） | 型を足せるのは同じ帰属の証拠があるときだけ。足すときは失敗の記録を残し、独立期待値 reviewer の確認のうえ新しい版の freeze 記録で足す | (a)(b)(c) の型、URL と宛先の集合、終わり方の集合、N_b、N_c、M_a、`diagLengthMs`、ε、挨拶の長さ、event の指定、capture の mode、port の同定の方法には 285 行の規則を当てない。観測の後に変えてよいのは狭める方向だけで、診断の run の記録、独立期待値 reviewer のレビュー、新しい版の freeze 記録（253 行の版の規則がそのまま当たる。同じ版の書き直しは 253 行末尾の commit の順序の検査で落ちるので行わない）を要し、変える前の run は DP-1 の証跡にしない。広げる変更は新しい draftRef でだけ行う（批准 4） | 285 行の「同じ帰属の証拠」は件数や時刻の幅に当てはまらず、観測の後に結果に合わせて広げる余地を残さないため（狭める防御。/2 より厳しい） |
| 6 | 「接続の試みの記録」（277 行） | 記録は Chromium の net log、遮断の環境側の記録、IPC の trace から書く。記録の仕組みが動いた印も書く | 加えて、LS-1 の port の同定のための OS の socket 表の snapshot（s1、s2）と、その印（取得の時刻と成否）を書く。印のない run は記録を取っていない run として扱う。net log は批准 4 の capture の mode で取り、環境側の記録は L への接続の local の port と (c) の宛先への packet の数を持つ | 「LS-1 の port の同定」の (L2) と批准 4 |
| 7 | Trusted actors（229 行） | DD-1 の接続の試みの記録（net log、遮断の環境側の記録、IPC の trace の観測器） | threat model の Trusted actors の加算 | threat model |
| 8 | In-scope attacks の「DD-1 の外への通信」（248 行） | （下の各項は無い） | threat model の In-scope attacks の 1〜13 を加える | 緩和の悪用を拒否する |
| 9 | Out-of-scope attacks（249 行） | （LS-1 と (c) の残余は無い） | threat model の Out-of-scope attacks の 1〜7 を残余として加え、Session C-2 の提示に添える | 誤分類の余地を開示する |
| 10 | Acceptance implications（288 行） | DD-1 の各 run の receipt の項目と、「DP-1 の証跡にする run では期待された通信でない試みが 0 件」 | receipt の項目に「receipt に加えるもの」を足し、「受入れ」の K6/3-P1〜P3、K6/3-N1〜N30 を加える。DP-1 の証跡にする run を NC-1 を当てた起動で `diagLengthMs` 以内の run に限る。「期待された通信でない試みが 0 件」は変えない | 受入れ |
| 11 | 失効（310 行） | 外への通信の遮断と接続の試みの記録の方法（…）、期待された通信の型と起点（版2の freeze 記録） | 記録の方法に「LS-1 の port の同定の方法（OS の socket 表の snapshot の取り方と browser process の同定の規則）、net log の capture の mode、環境側の記録の local の port と packet の数の取り方」を、DD-1 の freeze 記録の内容に「(b) の URL の集合、(c) の宛先の集合、終わり方の集合、N_b、N_c、`diagLengthMs`、ε、挨拶の長さ、event の名前と params の指定、診断の run の記録」を加える。「版2の freeze 記録」は変える点 14 で「DD-1 の freeze 記録」と読む | NC-1 の実装の変更は /2 の「候補の head と tree」で失効する（足さない） |
| 12 | 「選択肢と推奨」の表（507 行の行の後） | （LS-1 の論点は無い） | この draft の「選択肢と推奨」の 6 行を加える | 選択の記録 |
| 13 | 「確認後の記録」の DD-1 の TASK（781 行） | 外への通信の遮断と接続の試みの記録・分類を写す | 加えて「確認後の記録」の DD-1 の TASK の項を写す | 実装は DD-1 の lane |
| 14 | 版の命名（253 行の「fixture の版と freeze 記録」、297 行の保存先、417 行と 439 行の「case ごとの材料と測る時期」、材料の除外を定める 246・288・465・472 行と、本文で DP-H の fixture を「版1」、DD-1 の版を「版2」と呼ぶすべての箇所） | DP-H の fixture は版1、DD-1 で足す variant は版2 に置き、版2 の freeze 記録は版1 の freeze 記録の commit と版1 の file の sha256 を引く。DD-1 の harness は版1 の file の sha256 が版1 の freeze 記録と一致しなければ実行しない。版3以降も同じ規則に従う（253 行）。DP-H の版1と、DD-1 で足す版2は別の file にする（297 行）。DD-1 で加える variant の材料は、DP-H のどの variant にも使っていない新しい材料で作り、版2に置く（439 行）。DI-1a の試験は P の版1・版2と CP-0 の G-case の材料を使わない（246、465、472 行） | DP-H の版1 が失効した場合（frozen にならないまま観測された場合）、DP-H の置換版を「版2」、DD-1 が足す版を「版3」と読む。**K6/2 で DP-H の fixture を指す「版1」は置換版（版2）と読み、DD-1 の版を指す「版2」は版3 と読む**（253 行の「版1の variant の DP-H の receipt を…再採点」、258・515 行の「DP-H の版1の正例 variant／版1の期待値」を含む）。**材料の除外（246、288、439、465、472 行）は、失効した版1・置換版・DD-1 の版のすべてを対象にする**。版N+1 が版N の freeze 記録の commit と file の sha256 を引く規則、DD-1 の harness が引く先の一致を実行の条件とする規則、「版3以降も同じ規則」は、DD-1 の版（版3）が**置換版（版2）の freeze 記録**を引く形でそのまま当てる。置換版は、失効した版1 の fixture と freeze 記録の sha256 と、freeze 記録の最後の commit を `supersedes` として引き、版1 の材料（logical ID と text）を再利用せず、新しい材料だけで作る。置換版の fixture の作者と独立期待値 reviewer は、版1 の作者・実装者とも、置換版の contract／gate の実装者とも別で、Native の出力を見ていない者とする。版1 が失効していなければ、/2 の番号のまま読む | 253 行の規則は版1 が frozen になる前提で書かれ、HOLD になった版の置換は文面の外にある。「版3以降も同じ規則」は相対の規則と読めるが、DD-1 を版3 にすることを許す文ではない。DP-H の fixture を指す「版1」を写さないと、除外の対象から置換版の材料が外れ、DR-DPH-70 と同じ失敗を許す |
| 15 | 期待された通信の出典を述べる K6/2 のすべての箇所（119 行の「出典は K3 の確認済みの開示と台帳で、harness の都合で足さない」、248 行の In-scope attack の後半、249 行の括弧、279 行の前置き、284 行の後半の「一覧に加えて新しい draftRef で確認されるまで DP-1 を PASS にしない…ユーザーの判断は K3 側で得る」を含む） | 期待された通信は K3 の確認済みの「続く通信」の一覧の項目に限り、一覧にない製品の通信は K3 側の確認を経るまで DP-1 を PASS にしない | 出典の原則は変えない。ただし (c) は K3 の一覧の外にあり、この K6 の確認によって期待された通信に加える**唯一の例外**とする（型・起点・packet 0・件数の規則つき）。ほかの一覧の外の試みは、引き続き K3 側の確認を経るまで DP-1 を PASS にしない | (c) は K3/3 の 346 行で開示の材料にとどまり、DR-DA2-44 も続く通信に加えなかった。K3/4 で加える代案は「判断を求める点」の 5 |

## 事実

コードは `7af0be93` で確かめた。既存の記録は master にある測定の記録、新しい測定は「確認前の測定」の項のとおりで、記録にないものは「未検証」と書く。

- LS-1 の実装: `net.createServer` を `127.0.0.1`、port 0（ephemeral）で listen する（`electron/main/rendererContainmentListener.ts:30`、114）。受けた socket は `resume()` で読み捨て、`data` の listener を付けず、書き込まない（:95-96）。同時 256 を超える接続は受けた直後に破棄し、1 接続の保持は 5 秒以下（:25、28、82-90）。start は 1 回だけで再 bind しない（:63-66）。製品のコードは listener を閉じない。port は orchestrator が `buildProxyConfig(listenerPort)` で default session の `setProxy` に渡すだけで（`electron/main/rendererContainmentStartup.ts:300`、310）、file や log には書かない（固定コードの出力は port を含まない。`nc1-decisions.md` の DR-NC1-4）。
- bypass は `<-loopback>` だけで（`electron/main/rendererContainment.ts:43-50`、66-80）、NC-1 の下では default session の要求は、loopback の宛先（recorder の socket、旧 local provider の既定の port を含む）も含めてすべて L へ向かう。環境側の記録には、その宛先でなく `127.0.0.1:L` への接続が現れる。
- Main の process の listener: `electron/main` と `electron/preload` の試験でない file で `.listen(` か `createServer` を持つのは `rendererContainmentListener.ts` だけ（K3/3 の Negative (31) の静的な検査も `.listen(` を NC-1 の listener の file に限る。DR-NC1-2）。N-API で Main の process に載る Rust 側は、`src-tauri/crates` と `electron/native` の `TcpListener`／`UdpSocket` の使用が試験のコードだけだった（`grimodex-ai/src/lib.rs` の 5121 行からの `mod tests`、`*_tests.rs`、`tests.rs`、`tests/`。`7af0be93` を検索。`mcp-server` など Main の process に載らないものは見ていない）。
- NC-1 の適用: `shouldRegisterAppProtocol()` が true の起動だけ（`electron/main/index.ts:244-246`。非 packaged で `ELECTRON_RENDERER_URL` がある起動は除く。`electron/main/devRendererUrl.ts:61-66`）。
- NC-1 の自己確認（`rendererContainmentStartup.ts:147-187`）は、`resolveHost` 3 件（sentinel と EXCLUDE していない IP literal 2 件）と `resolveProxy` 3 件（`https://turn.attacker.invalid:443/` などの固定の URL）を起動の前に行う。製品の `resolveHost` の呼出しはここだけ（`electron/main` を検索）。自己確認は net log に host 解決の event を残す。IPv6 の到達性の確認の UDP connect は、cache が切れた後の最初の名前解決の source に帰属し、測定では 1 件目が自己確認の sentinel の解決と読める source に付いたが、これは解決の先着の順序に依る（下の測定の 6。推定）。
- updater: 非 packaged では無効で（`electron/main/updater.ts:89-97`）、electron-updater の singleton にも触れない（:198-205）。K3/3 が書く updater の session の辞書の要求は、その session が最初の request で作られるので（K3/3 の「開示に無かったこと」の 1）、DD-1 では起きない見込み（コードの読取による）。macOS の electron-updater の loopback listener（K3/3 の影響表 8）も DD-1 の範囲外。
- 既存の記録（`docs/plans/nir1-lane-decisions/nc1-g-open/nc1-order-product-nc1-{none,ip,localhost}.json`。製品の orchestrator を `index.ts` と同じ順序で呼ぶ scratch main で、`initBackend` を呼ばない。Linux、Electron 43.8.3、窓の作成後 9 秒の観測〔`electron/scripts/webrtc-block-probe-order-main.cjs:87`、152〕）: 15 回すべてで、辞書の要求 1 件、`proxy_info` が `SOCKS5 127.0.0.1:<port>`、net error -120、blackhole の listener への接続 1 本、`Dictionaries/` 空。**DD-1 の条件（env の proxy なし）に合うのは `none` の 5 回だけ**で、`ip`／`localhost` の 10 回は env に `http_proxy`／`https_proxy` を置いている（`electron/scripts/webrtc-block-probe-order.mjs:116-118`）。probe は URL の query を削って記録し（52 行）、`gvt1.com` の要求だけを数える。記録に LS-1 の port は無く、`proxy_info` の port が LS-1 の port であることはコードからの推定だった。挨拶の長さは、K3/3 の `al0-dict.json` の `proxyHeads` が `"..."`（印字不能の 3 文字に置換。`electron/scripts/webrtc-block-probe.mjs:511`）で、3 byte と読める（値は未記録。Electron 43.5.0、probe の listener）。
- DA-2 と DA-2b の restricted の試走（DR-DA2-44、DR-DA2B-R10。非 packaged、Linux、Electron 43.8.3）は、全 launch で LS-1 への接続 1 回（lo の TCP の SYN と `proxy_info`）、辞書の要求 1 件（取得 0）、net log の `HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK` と `[2001:4860:4860::8888]:443` への `UDP_CONNECT` を記録し、dummy の interface にその宛先の packet が 1 つも出なかったことを確かめた。DR-DA2-44 は (c) にあたるものを「packet を出さない socket の操作」として続く通信に加えない読みとし、その読みを integrator の確認の対象にした。
- 確認前の測定（2026-10-25、この起案で実施。記録は commit していない）: 上の scratch main を `product-nc1` で、env の proxy なし、Wayland／D-Bus の変数を外し、`ELECTRON_OZONE_PLATFORM_HINT=x11`、`scripts/local-ci-xvfb.mjs` 経由（host の namespace）で、`--log-net-log` と `--net-log-capture-mode=Everything` を付けて走らせた（Linux、Electron 43.8.3。cargo の build は使っていない）。run2（窓の作成後 60 秒）と run3（9 秒。最初の 9 秒の run1 は記録の script の版が残っていないので、process の型の主張には使わず、同じ条件で取り直した）は、記録の script の版（`drive.mjs`、SHA-256 `4144bb26970739d4700247153b4f7a4c5381c5089957347ec4b224f855281d46`）が同じ。net log の事実（1〜4、6）は run1〜run3 のすべてで、process の事実（5）は run2 と run3 で成り立った。
  1. net log の URL の要求は辞書の 1 件だけ（`GET https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`、query なし）。60 秒の run2 でも再試行はなかった。`URL_REQUEST_START_JOB` の `initiator` は `not an origin`（browser process 起点）、`REQUEST_ALIVE` の `traffic_annotation` は `117649486` だった（run1〜run3。この値が spellcheck の annotation かは確かめていない）。
  2. 要求の source（`URL_REQUEST`）から、`source_dependency` の鎖で `HTTP_STREAM_JOB_CONTROLLER`（`PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST` の `proxy_info` が `SOCKS5 127.0.0.1:L`、`HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED` の `proxy_chain` が `[socks5://127.0.0.1:L]`）、`HTTP_STREAM_JOB`（`TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET`、`SOCKET_POOL_BOUND_TO_CONNECT_JOB`）、`SSL_CONNECT_JOB`（`SOCKS_CONNECT_JOB_CONNECT`、`TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT` の `address` が `127.0.0.1:L`）、`SOCKET` へ結べた。鎖は向きが混ざるので、推移的閉包は両向きで辿る必要があった。**要求と socket を結ぶ event（`SOCKET_POOL_BOUND_TO_CONNECT_JOB` と `HTTP_STREAM_JOB_BOUND_TO_REQUEST`）は、どちらも接続の失敗の時点（挨拶の約 5 秒後）にだけ現れ**、`SSL_CONNECT_JOB` の始まりには要求への `source_dependency` がなかった。
  3. `SOCKET` の source に `TCP_CONNECT`（終わりの params に `local_address` と `remote_address` = `127.0.0.1:L`）、`SOCKS5_CONNECT`、`SOCKS5_GREET_WRITE`（`SOCKET_BYTES_SENT` が 3 byte、`BQEA` = `05 01 00`）、`SOCKS5_GREET_READ`（受信 0 byte、`SOCKS_UNEXPECTEDLY_CLOSED_DURING_GREETING`、net error -120）があり、`SOCKS5_HANDSHAKE_WRITE` はなかった。挨拶の書込みから切断まで 5001〜5002 ms（run1〜run3。LS-1 の保持 5 秒）。net log の constants には `SOCKS5_HANDSHAKE_WRITE`、`SOCKS5_HANDSHAKE_READ` などの名前もある。listener 側で取った接続の時刻と net log の `TCP_CONNECT` の時刻の差は 1 ms だった（run1〜run3。net log の `timeTickOffset` で epoch に直した）。
  4. run の net log の `proxy_info` の値は `SOCKS5 127.0.0.1:L` の 1 つだけで、event の params に自己確認の URL は現れなかった。
  5. 実行中に 2 回（窓の読込の後と終了の 1 秒前）読んだ `/proc/net/tcp` と各 process の `/proc/<pid>/fd` の照合で、loopback の LISTEN の socket は 1 つだけ（`127.0.0.1:L`）で、持ち主は `--type=` のない electron の process（browser process）だった。起動した process は wrapper の node（`local-ci-xvfb.mjs`）で、Main はその子だった。ほかの electron の process は `--type=zygote`（3 つ）、`utility`、`renderer`、`gpu-process` を持っていた。blackhole の listener への接続は run の全体で 1 本、`Dictionaries/` は空。
  6. 各 run に `[2001:4860:4860::8888]:443` への `UDP_CONNECT` が 2 件あった。1 件目の UDP の socket の `SOCKET_ALIVE` は `NETWORK_SERVICE_HOST_RESOLVER` の source（`HOST_RESOLVER_MANAGER_REQUEST` の host が `127.0.0.1:0`、`HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK` を持つ。同じ時刻に `~NOTFOUND:0` の解決が 2 件あり、自己確認の sentinel と IP literal 2 件の解決と読める〔推定〕）を指し、2 件目は `NETWORK_QUALITY_ESTIMATOR` の source（辞書の要求の失敗の時点）を指した。どちらも `UDP_CONNECT` は net error -109 で終わり（この機の namespace に IPv6 の経路がない。DR-DA2-44 の環境では `ipv6_available:true`）、UDP の送信の event（net log の constants にある `UDP_BYTES_SENT` と `UDP_SEND_ERROR`）はなかった。`HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK` は、UDP connect を伴った 2 つの source では `cached:false`、ほかの解決（自己確認の IP literal の解決と、辞書の connect job〔`SSL_CONNECT_JOB`〕の `127.0.0.1:L` の解決）では `cached:true` だった。run2 では辞書の connect job の解決が自己確認の解決の一部より先に記録された（1 ms 以内）。約 5 秒後の network quality estimator の確認は `cached:false` で、cache の有効期間は 5 秒より短いと読める（推定）。環境側の packet の記録はこの測定では取っていない。
  これは scratch main（窓は stub の `index.html`、`initBackend` なし）の観測で、実アプリの起動、DD-1 の環境、ほかの capture の mode では確かめていない。記録は `/tmp/claude-1000/-home-grimodex-Grimodex/e058cd87-f0dd-4fda-a736-3cc2d01d5042/scratchpad/k6probe/run{1,2,3}/`（この session の scratchpad。repo の外で、後から参照できる保証はない）。
- /2 の既存の観測手段で足りない点: net log は Chromium がどの port へ向かったかを示すが、その port を持つのが Main の LS-1 であることは示さない。/2 は起動に proxy を置かないこと（env と起動引数の記録）を求めるので、`SOCKS5 127.0.0.1:L` の出所が NC-1 の `setProxy` だけであることはコードから推定できるが、記録では確かめられない。そこで、OS の socket 表の snapshot を 1 種だけ足す。
- DP-H の版1: `evals/nir1-packing/final-request.freeze.v1.json` は `draftRef` が `/2`、`status` が `pending-review` で、note は「Native が freeze の前に材料を観測したので、この形では freeze できず、新しい材料と別の作者の置換 fixture が要る」とする（DR-DPH-70）。

## 設計

### 型の定義

(b) blackhole された辞書の要求の試み（Chromium の network stack を通る。起点は default session の spellchecker）。net log の 1 つの URL の要求で、次をすべて満たすもの。

1. method が GET で、upload（request の body）がなく、`URL_REQUEST_START_JOB` の `initiator` が `not an origin`（browser process 起点。renderer の文書や worker が起こした要求は origin を持つ）である（測定の 1）。
2. URL が、DD-1 の freeze 記録に書いた exact な URL の集合のどれかと一致する（scheme・host・path・query を含めて完全一致）。集合は、K3/3 の型（`redirector.gvt1.com` の `/edgedl/chrome/dict/` の下の `.bdic`）に合う URL だけからなり、診断の run で観測した URL を書く（推奨の初期値は `https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` の 1 件）。K3/3 の型より狭い（file 名を固定する）。
3. その要求に属する `proxy_info` が、すべて `SOCKS5 127.0.0.1:L`（L は下の「LS-1 の port の同定」で同定した port）で、ほかの値を含まない。default session だけが NC-1 の `setProxy` を受けるので、これが default session の要求であることの記録上の根拠になる（session の名前は net log に現れない。コードによる帰属）。
4. 終わり方が、DD-1 の freeze 記録に書いた net error の集合のどれかである（測定では -120。LS-1 が接続を 5 秒保持した後に出る）。redirect の連鎖がなく、応答の body を受けていない。**終わりの event がないまま process の終了で打ち切られた要求（未完の要求）は (b) にならず**、その要求が運んだ L への接続も (a) にならない（測定の 2 のとおり、要求と socket を結ぶ event は失敗の時点にしか出ないので、未完の要求の socket はどの要求にも束縛されない）。その run は DP-1 の証跡にならない。
5. run の終わりに、profile の `Dictionaries/` に file がない（取得 0。/2 の「外へ到達していない証跡」と同じ確認）。
6. URL と request header に fixture の材料の文字列がない（/2 の規則。これに当たれば製品の送信の FAIL で、(b) にしない）。

(a) Chromium（default session）から LS-1 への接続（起点は (b) の要求を処理する Chromium の network stack）。環境側の記録の 1 本の TCP の接続の試みで、次をすべて満たすもの。

1. 接続先が `127.0.0.1:L`。
2. net log の対応: ある (b) の要求の source から `source_dependency` の鎖を両向きに辿った推移的閉包（URL の要求 → stream job controller → stream job → connect job → socket。名前は事実の測定の 2 のとおり）に属する `SOCKET` の source があり、その `TCP_CONNECT` の `remote_address` が `127.0.0.1:L` である。socket pool では接続の job が同じ group の別の要求に割り当て直されうるので、要求への帰属は、その socket を使った stream job が束縛された要求（`SOCKET_POOL_BOUND_TO_CONNECT_JOB` と `HTTP_STREAM_JOB_BOUND_TO_REQUEST`）で決め、どの要求にも束縛されないか、2 つ以上に束縛される socket は (a) にしない。
3. 時刻と port の照合（必須）: 環境側の記録の接続の時刻が、対応する `TCP_CONNECT` の始まりから終わりまでの区間の ±ε に入る（ε は観測の前に DD-1 の freeze 記録に書き、100 ms 以下。測定の差は 1 ms）。net log の `TCP_CONNECT` の `local_address` の port と、環境側の記録の接続の local の port が一致する。環境側の記録が local の port を持たない run、capture の mode が `local_address` を記録しない run には (a) を当てない。
4. 内容は SOCKS5 の挨拶だけ（積極的な証拠を求める）: その `SOCKET` の source に、DD-1 の freeze 記録に書いた挨拶の書込みの event（測定では `SOCKS5_GREET_WRITE`）と、それに属する送信の `byte_count` があり、byte 数が freeze 記録に書いた挨拶の長さ（測定では 3）以下で、host 名を運ぶ handshake の書込みの event（測定の名前は `SOCKS5_HANDSHAKE_WRITE`）がなく、挨拶への応答の読取が 0 byte で終わる。挨拶の書込みの event か `byte_count` がない接続は、event の不在だけで挨拶だけとは読まず (a) にしない。環境側の記録が接続ごとの byte 数も持つなら、client から L への byte 数が同じ長さ以下で、L から client への byte 数が 0 であることも求める。
5. 起点が Chromium の network stack であることは、2 の net log との対応で示す。net log に対応のない L への接続は、起点を確かめられないので (a) にしない。

(a) は (b) の要求の一部として数える（批准 2）。(b) の要求を運ばない L への接続（ほかの URL の要求、net log に対応のない接続）は (a) にしない。

(c) datagram を送らない IPv6 の到達性の確認の UDP connect（Chromium の network stack。起点は host resolver の IPv6 の到達性の確認と network quality estimator）。net log の 1 つの `UDP_SOCKET` の source の `UDP_CONNECT` で、次をすべて満たすもの。

1. 宛先が、DD-1 の freeze 記録に書いた exact な宛先の集合のどれかと一致する。集合は `{[2001:4860:4860::8888]:443}`（測定と DR-DA2-44 で観測した宛先）の部分集合に限り、それを超える追加は新しい draftRef でだけ行う。
2. その `UDP_SOCKET` の source とその親の `UDP_CLIENT_SOCKET` の source に、UDP の送信の event（`UDP_BYTES_SENT` と `UDP_SEND_ERROR`。この draft で固定する。datagram を送らない run では観測できないので、診断の run で確かめる対象にしない）がない。3 の packet 0 がこれを裏付ける。
3. **環境側の記録が、その run でその宛先への packet が 0 であることを示す**（積極的な証拠）。環境側の記録の方法が宛先ごとの packet の数を持たない run には (c) を当てない。
4. 起点: 親の `UDP_CLIENT_SOCKET` の `SOCKET_ALIVE` の `source_dependency` が、`HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK`（`cached:false`）を持つ次のどれかの source を指す。(i) `NETWORK_SERVICE_HOST_RESOLVER` の source（NC-1 の自己確認の `resolveHost` が起こすもの。測定では host が `127.0.0.1:0`）、(ii) `NETWORK_QUALITY_ESTIMATOR` の source、(iii) (b) の要求の鎖（(a) の 2 の推移的閉包）に属する connect job の解決の source（到達性の確認は、cache が切れた後の最初の解決に付くので、解決の先着の順序や (b) の再試行で起点がここに移りうる）。宛先と packet 0 の条件は (i)〜(iii) で同じ。ほかの source（URL の要求、renderer、WebRTC など）から出た UDP connect は (c) にしない。
5. 件数: 1 つの Electron の process の run で (c) は N_c 件以下（N_c は診断の run の最大値で、2 以下。測定では各 run 2 件）。

(c) 以外の UDP connect、datagram を送った UDP、宛先が集合の外の UDP、packet の記録がない UDP は、それ以外に入れる。

### LS-1 の port の同定

run ごとに、次の (L1)〜(L4) をすべて満たす port L を、その run の LS-1 の port とする。満たす L がない run には (a) を当てない（下の「分類の順序」の 2）。

- (L1) net log: その run の net log の `SOCKS5` の `proxy_info`（と `proxy_chain`）が、すべて同じ `127.0.0.1:L` を指す。自己確認の結果の event が net log に現れる場合も、それを含めて同じ L である。
- (L2) OS の socket 表の snapshot: harness が、NC-1 の起動の完了の後（最初の窓の読込みの後。LS-1 の listen は ready の後数 ms で、窓より前）で測る request（start の IPC）より前に 1 回（s1）と、Electron の process を終える直前に 1 回（s2）、Main が持つ TCP の LISTEN の socket を読む。s1 と s2 の両方で、Main が `127.0.0.1:L` を LISTEN している。
  - Main（browser process）の同定: harness が起動した process とその子孫のうち、実行 file が測る build の Electron の binary で、cmdline に `--type=` がない process がちょうど 1 つあるとき、それを Main とする。起動した process が wrapper（`scripts/local-ci-xvfb.mjs` の node、`unshare` など）でも、その pid を Main とみなさない。ちょうど 1 つでなければ snapshot は失敗とする。
  - 推奨の読み方: Main の `/proc/<Main の pid>/net/tcp`（Main の network namespace の表）の LISTEN（state `0A`）の行の inode と、`/proc/<Main の pid>/fd` の socket の inode の照合。LS-1 は `127.0.0.1` だけで listen するので IPv4 の表だけを照合に使うが、`/proc/<Main の pid>/net/tcp6` も読み、Main が持つ loopback（`::1`、`::ffff:127.0.0.1`）の LISTEN を (L3) の集合に入れる。file の読取だけで、subprocess を起動せず、どの port にも接続しない。方法と版は receipt に書く。
- (L3) s1 と s2 の両方で、Main の loopback の LISTEN の socket（IPv4 と IPv6。N-API で載る Rust を含む Main の process の全体）から harness が所有する port（CDP など。/2 の freeze 記録の一覧）を除いた集合が、ちょうど {L} である。
- (L4) L が、harness が所有する port の一覧、recorder の socket の port、DD-1 の freeze 記録の AI の送信先の一覧（旧 provider の既定の接続先を含む）のどれとも一致しない。一致したら、環境の偶然の衝突として、その run を harness の隔離の不備で無効にし、測り直す。

LS-1 は start が 1 回だけで再 bind せず、製品のコードから閉じないので、s1 と s2 で同じ L を Main が持てば、L は `setProxy` の時点の port と同じと読む（コードによる推定）。snapshot が取れなかった run（印がない run）は、記録を取っていない run として /2 のとおり無効にする。snapshot は取れたが (L1)〜(L3) のどれかが成り立たない run は、(a) を当てず、loopback の接続を /2 のとおり分類する（その run は DP-1 の証跡にならない）。stderr に NC-1 の固定コード（`NC-*`）が出た run は、その事実を receipt に書き、(a)(b)(c) を当てず、DP-1 の証跡にしない。

### 件数の規則

- M_a = 1: (b) の要求 1 件が対応を持つ L への接続は、ちょうど 1 本（net log の `SOCKET` と環境側の記録の接続が 1 対 1）。2 本目以降は (a) にしない。根拠は既存の記録の `none` の 5 回と確認前の測定の 3 回（どれも要求 1 件、接続 1 本。scratch main）。
- 環境側と net log の過不足: 同じ run で、環境側の記録の `127.0.0.1:L` への接続の数が、net log の `127.0.0.1:L` への `TCP_CONNECT` の数より少なければ、記録の不備として、その run を記録を取っていない run と同じに無効にする。多ければ、対応のない接続は (a) にせず、それ以外に入れる。
- N_b と N_c: 1 つの Electron の process の run（/2 の run の区切り。起動から終了まで）の (b) の要求は N_b 件以下、(c) は N_c 件以下。どちらも、DD-1 の harness が fixture の材料を含まない診断の run（/2 の「観測前の固定」が認める診断 case。DD-1 と同じ build の作り方、起動の方法、環境、capture の mode）で観測した最大値とし、観測の前に DD-1 の freeze 記録に、診断の run の記録とともに書き、独立期待値 reviewer のレビューを受ける。診断の run は 5 回以上で、最短の run と、`diagLengthMs` の長さの run を含める。**N_b の上限は 3、N_c の上限は 2**（批准 4）。上限の変更は新しい draftRef でだけ行う。診断の最大値が上限を超えたら `[precheck]` で止まる。推奨の見込みは N_b が 1、N_c が 2（測定。60 秒まで再試行なし）。超えた (b) の要求と運んだ L への接続、超えた (c) は、それ以外に入れる。
- run の長さ: DD-1 の run は、辞書の要求の開始から、LS-1 の保持（5 秒以下）の後に要求が freeze 記録の net error で終わるまで、Electron の process を終えない（引き継ぎ D1）。最短の run の長さはこれを満たすように選ぶ。
- `diagLengthMs`: 診断の run の長さ（Electron の process の起動から終了まで）の最大値。DD-1 の freeze 記録に書く。DD-1 の run（評価 build と参照 build）が `diagLengthMs` を超えたら、(b) と (c) の件数にかかわらず（0 件でも）、その run を DP-1 の証跡にしない（測り直すなら `diagLengthMs` 以内の run で）。harness は観測の前に、DD-1 で予定する最も長い run を覆う値を選ぶ。
- (b) の要求や (c) が 0 件の run は、それだけで無効にも FAIL にもしない（期待された通信は起きることを求めない。/2 と同じ）。

### 分類の順序

/2 の分類の順序（まず net log の各要求、次に対応しない環境側の記録の件）に、次を挟む。

1. どの run にも（NC-1 の適用と L の同定に依らず）、`proxy_info` が SOCKS5 か PROXY の要求の接続先を、環境側の記録（proxy の address しか見えない）でなく net log の URL の host と port で判定する。URL が AI の送信先（`ai-settings.json` の endpoint〔recorder を含む〕、旧 external／local の provider の既定の接続先）なら、/2 の規則で製品の送信の FAIL にする。fixture の材料が URL か request header にある要求も同じく FAIL にする。
2. NC-1 の適用の確認: 起動の env に `ELECTRON_RENDERER_URL` がなく、stderr に `NC-*` がなく、L を同定でき、run が `diagLengthMs` 以内で、批准 4 の記録の条件を満たす run だけに 3〜5 を当てる。ほかの run は /2 のまま分類して記録し、DP-1 の証跡にしない（批准 2）。
3. net log の要求を (b) の型で判定し、N_b を当てる。(b) に合わない辞書の形の要求は、/2 の既存の辞書の型で分類する（/2 の型は変えない）。ただし、その要求が L へ接続していれば、その接続は (a) にならない（4）。
4. 環境側の記録の `127.0.0.1:L` への接続を、(b) の要求に M_a、ε、port の照合で対応づけ、(a) に合うものをその要求の一部として数える。残りは /3 の変える点 3 の文でそれ以外に入れる。
5. net log の `UDP_CONNECT` を (c) の型で判定し、N_c を当てる。残りはそれ以外に入れる。
6. 自己確認の event のうち、host 解決と proxy の解決そのものは、接続の試みでも wire の DNS でもないので分類しない。それが起こした UDP connect は 5 で分類し、DNS の問合せを伴えば /2 のまま分類する。
7. ほかは /2 のまま（recorder への接続の規則は、3〜5 より先に当てる /2 の順序を変えない）。

## threat model（GDX-PRECHECK-001）

security-sensitive な分類の緩和なので、確認されるまで draft とする（批准 9 で明示の確認を求める）。K6/2 の threat model（229、230、248、249 行と Mandatory defenses）への加算で、ほかは変えない。

- Trusted actors（加える）: OS の socket 表の snapshot の読取（harness が行い、読取だけで接続しない。結果は Main の pid、実行 file、LISTEN の port の組だけを receipt に書く）。LS-1（製品の Main の一部。K3/3 の確認済みの設計どおり、返事をせず、受けた bytes を捨てる。この評価は LS-1 の挙動を net log の SOCKS5 の段と環境側の記録でだけ確かめる）。環境側の記録の packet の数（(c) の積極的な証拠）。置換版の fixture の作者と独立期待値 reviewer（「変える点」の 14 の分離を満たす者）。Main、OS、backend の侵害は /2 と同じく範囲外。
- Untrusted actors（/2 のとおりで、次を加える）: run の中で L に接続しうる、Chromium 以外の client（Native の client、Main の `globalThis.fetch`、harness と test の基盤の process）を、起点を確かめるまで信頼しない。Chromium の network stack を経由しても、(b) でない URL の要求と、(c) の起点でない UDP connect は信頼しない。
- In-scope attacks（加える）:
  1. L への接続を、port の一致だけで (a) に数える（net log の (b) の要求との対応を見ない）。Native の回帰や harness の接続が L に向かっても、期待された通信に見える。
  2. (b) でない要求（Main が default session で `net.fetch` を使う回帰、renderer 由来の要求、別の file 名の `.bdic`）を運ぶ L への接続を (a) に数える。
  3. L を、harness の設定、Chromium の起動引数、net log だけ、または Main に入れた hook から同定し、Main が実際にその port を LISTEN していることを確かめない。別の process の port（harness の port、利用者の local の SOCKS5 の server）を LS-1 と取り違え、host 名が渡りうる接続を期待された通信にする。
  4. Main 以外の process（wrapper の node、`unshare`、Xvfb、`--type=` を持つ子の process）を Main とみなして snapshot を読む。
  5. Main が持つ別の loopback の listener（CDP、将来の listener）への接続を LS-1 への接続として数える。
  6. M_a を超える接続や N_b・N_c を超える試みを数え、`diagLengthMs` を超える run を証跡にし、または観測の後に N_b、N_c、URL や宛先の集合、ε、event の指定を結果に合わせて広げる。
  7. 環境側の記録の欠け（net log より接続が少ない）を、対応づけの成功として扱う。local の port や byte 数を持たない記録の方法や capture の mode を選んで照合を黙って外す、時刻の幅を観測の後に決める、ε を 100 ms より広げる。
  8. host 名を運ぶ SOCKS5 の handshake がある接続、LS-1 が応答した接続、挨拶の書込みの event か `byte_count` がない接続、未完の要求の接続を、挨拶だけの接続として数える。
  9. proxy を経由した AI の送信先や fixture の材料の要求を、環境側の記録が proxy の address しか示さないことを理由に、(a) か loopback の一般の件として扱い、製品の送信の FAIL を逃す（L を同定できない run を含む）。
  10. loopback を記録と分類から外して L への接続を消す、L を harness が所有する port の一覧に入れて除く（/2 が禁じたまま）、`ELECTRON_RENDERER_URL` を置いて NC-1 を外した run を DP-1 の証跡にする。
  11. 版の番号の読み替えを使って、観測済みの材料を新しい版に持ち込む（版1 や置換版の logical ID や text を後の版で再利用する、frozen でない版1 や置換版を材料の除外の対象から外す）、または置換版の作者・reviewer を版1 や gate の実装者と兼ねる。
  12. datagram を送った UDP、宛先が集合の外の UDP、(c) の起点でない source（renderer の WebRTC など）から出た UDP、packet の記録のない UDP を (c) に数える。packet の数を持たない環境側の記録の方法を選んで (c) の証拠を外す。
  13. renderer が default session で (b) と同じ URL を GET し、(b) として数えさせる（`initiator` の条件で拒否する）。
- Out-of-scope attacks（残余として加え、Session C-2 の提示に添える）:
  1. (a) の内容の確認は、net log の SOCKS5 の段の event と `byte_count`、LS-1 のコード（返事をしない）に依る。環境側の記録が byte 数を持たない場合、wire の上の bytes そのものは確かめない。
  2. (b) が default session の要求であることは、`proxy_info` が NC-1 の proxy であることからの帰属（default session だけが `setProxy` を受けるコード）で、net log が session を名指すわけではない。
  3. net log の接続と環境側の記録の接続の 1 対 1 は、local の port と時刻（±ε）の照合で、同じ local の port を同じ時刻に別の client が使うことは OS の規則で起きない見込み（推定）。
  4. NC-1 の下では、Chromium の network stack を経由する送信（default session の要求）はすべて L へ向かい、recorder にも旧 local provider にも届かない。その検出は net log の完全さ（すべての要求と URL が載ること）に依り、K6/2 の「recorder への接続」の規則（recorder が受けた接続を数える）はこの経路を見ない。
  5. NC-1 そのものの有効性（renderer の外向き通信が塞がること、辞書の要求が `setProxy` の後に出ること）は DD-1 で評価しない（K3/3 の G-open と G-pub の範囲）。DD-1 の run で辞書の要求が L を経由せずに現れても、/2 の辞書の型で分類し、その事実を receipt に書いて NC-1 の lane に申し送るだけで、この行の FAIL にしない。
  6. (c) は Chromium が固定の宛先へ行う UDP の connect で、宛先の address は名前や fixture の材料を運ばない。起点 (i) は source の型（`NETWORK_SERVICE_HOST_RESOLVER`）だけを条件にし、自己確認から出たこと（測定では host が `127.0.0.1:0`）は条件でなく測定値である。宛先が固定で packet 0 なので、残る危険は小さい。datagram を送らないことは net log の送信の event の不在と環境側の packet 0 で確かめるが、IPv6 の経路がある環境で Chromium の版が挙動を変えれば packet が出うる（その場合は (c) にならず、それ以外になる）。(c) を加えること自体が、記録の全件を求める K6/2 の 277 行に対する緩和であり、期待された通信の出典を K3 の確認済みの開示に限る K6/2 の原則（119 行、284 行の後半）からの逸脱である（K3 の確認を経ない唯一の例外。「変える点」の 15）。
  7. (b) の起点が spellchecker であることは、`initiator` が `not an origin`（browser process 起点）であることまでしか確かめない。`traffic_annotation`（測定では `117649486`）が spellcheck のものかは確かめていないので条件に入れない。browser process の別の機能が同じ URL を GET する回帰は区別できないが、URL は固定で、blackhole へ向くので、漏れうる量は要求の件数と時刻だけで小さい。
- Mandatory defenses（加える）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」の全部と、「変える点」の 14 の材料と作者の規則。harness は run の間に L へ接続しない（snapshot は file の読取で行う）。批准 4 の値（N_b ≤ 3、N_c ≤ 2、ε ≤ 100 ms、capture の mode、環境側の記録の local の port と packet の数）と、URL と宛先の集合、終わり方の集合、`diagLengthMs`、挨拶の長さ、event の指定、port の同定の方法は観測の前に DD-1 の freeze 記録に書き、独立期待値 reviewer のレビューを受ける。観測の後の変更は狭める方向だけで、新しい版の freeze 記録で行う。(c) の宛先は `{[2001:4860:4860::8888]:443}` の部分集合、(b) の URL は K3/3 の型の部分集合に限る。Everything の net log は `.artifacts/` の下にだけ置き、receipt には要約だけを載せる。DD-1 の harness の分類器は、「受入れ」の Negative の合成の記録で検出力を示してから使う。材料の検査は、過去の全版（frozen でない版を含む）の材料を対象にする。
- Acceptance implications: 「受入れ」の節。品質閾値（保持 100%、禁止情報 0、prose 非回帰、P-12 の 0→1）と「DP-1 の証跡にする run では期待された通信でない試みが 0 件」は変えない。変わるのは、(a)(b)(c) に合う試みが「期待された通信」に入ること、DP-1 の証跡にする run を NC-1 を当てた起動で `diagLengthMs` 以内の run に限ること、版の番号と引く先の読み替えだけ。
- owner／lifecycle: この draft は新しい外への通信、subprocess、背景の処理、async の lifecycle を加えない。足す観測（snapshot）は、DD-1 の harness が run ごとに 2 回行う同期の file の読取で、再試行しない。失敗は「印のない run」として無効になり、待ちを作らない。LS-1 の lifecycle は K3/3 と NC-1 の lane（DR-NC1-16）のまま。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| 2 項目の扱い（ユーザーが (A) を選んだ論点） | (A) K6 の /3 で、型と起点つきで期待された通信に加える（この draft） | freeze 記録に書くだけで足りるとする: /2 の 284 行と URL による照合（280 行）の文面と合わず、確認されていない読みで run を証跡にすることになる。loopback を記録と分類から外す: /2 が禁じている。L を harness が所有する port に入れる: 製品の listener で、対応づけなしに除くことになる |
| IPv6 の UDP connect | (c) として型つきで加える（判断を求める点 5。K6 の出典の原則の唯一の例外） | K3/4 で「続く通信」に加える: 出典の原則を守れるが、(c) には利用者に開示する通信の実体がなく、開示の文言を誤らせ、PUB-G の開示にも結びつく（最終判断はユーザー）。加えない: NC-1 の全 run に「それ以外」が出て DD-1 が構造的に通らない。DA-2 の読み（接続の試みにあたらない）を文で採る: 277 行の「全件」の記録の規則を狭める読みで、宛先・起点・packet 0 の型がなくなる |
| NC-1 のない起動 | DP-1 の証跡にする run を NC-1 を当てた起動に限る | NC-1 のない起動（`ELECTRON_RENDERER_URL`）も証跡にする: packaged の製品と違う構成を測り、dev server への loopback の接続が増え、緩和の当て先が曖昧になる |
| port の同定 | net log（既存）と OS の socket 表の snapshot（追加の観測 1 種） | net log だけ: Main が port を持つことを記録で確かめられない。Main に hook を入れて port を読む: 評価専用の入口が Main に増える。listener の port を file や log に出す: 製品の変更で、この draft の範囲（NC-1 の挙動を変えない）を超える |
| 件数と記録 | M_a = 1、N_b ≤ 3、N_c ≤ 2、ε ≤ 100 ms、local の port と packet の数と capture の mode を必須、観測の後は狭める方向だけ | N_b = 1 に固定: より厳しいが、実アプリと DD-1 の長さでの再試行は未検証で、起きれば DD-1 が再び構造的に通らず /4 が要る。freeze 記録だけに委ねる（上限なし）: 繰り返す試みの回帰を診断の結果に合わせて受け入れうる。照合を「記録にあれば」にする: 記録の方法の選択だけで照合が外れる。/2 は `github.com` で試みの数に上限を置く案を採らなかった（DNS の問合せの数が resolver に依るため）が、(b)(c) は net log の event の単位で数え、観測の範囲では決定的だった |
| 版の番号 | DP-H の置換版を版2、DD-1 の版を版3 と読み、版の規則はそのまま当てる | DD-1 の版を版2 のまま置き、置換版を別の名前（版1b など）にする: 253 行の「版N+1 は版N を引く」の鎖から置換版が外れ、DD-1 の版が引く先が失効した版1 になる。版3以降の相対の規則で黙って読む: 確認済みの文言（「DD-1 で足す版2」）から逸脱する |

## 受入れ（DD-1 の分類）

番号は K6/2 と K3 の (n) と衝突しないよう `K6/3-` を付ける。DD-1 の harness の分類器は、合成の記録（実 run の記録を複製して接続や event を書き加え、または取り除いたもの。K3/3 の `ll-synthetic-leaks` と同じ考え方）で、Negative のそれぞれを期待どおりに分けることを、DD-1 の freeze の前に示して記録する。

receipt に加えるもの（各 run）: NC-1 の適用（env の `ELECTRON_RENDERER_URL` の有無、stderr の `NC-*` の有無）、net log の capture の mode、Main の pid と実行 file とその同定、snapshot s1 と s2（時刻、Main の loopback の LISTEN の port の一覧、方法と版）、同定した L（または同定できなかった理由）、(b) の要求の一覧（URL、開始の時刻、`proxy_info`、終わり方）、(a) の接続の一覧（環境側の時刻と local の port、対応する net log の `SOCKET` と (b) の要求、挨拶の event と `byte_count`）、(c) の一覧（宛先、起点の source の型、送信の event の有無、環境側の packet の数）、N_b・N_c・M_a・`diagLengthMs` に対する件数と run の長さ、対応づけの過不足、run が使う版と、その版が引く freeze 記録の commit と sha256。

Positive:

- K6/3-P1: NC-1 を当てた run で、L を (L1)〜(L4) で同定でき、(b) の要求が 1 件（freeze 記録の URL、GET、upload なし、`proxy_info` が `SOCKS5 127.0.0.1:L`、freeze 記録の net error、`Dictionaries/` が空）、それに対応する L への接続が 1 本（挨拶の書込みの event と `byte_count` あり、handshake の書込みなし、ε と port の照合が合う）、(c) が N_c 件以下（宛先が集合の中、送信の event なし、環境側の packet 0、起点が (c) の型の定義 4 の (i)〜(iii) のどれか）。(a)(b)(c) は期待された通信として件数と接続先と起点を receipt に書くだけで、その run を無効にも FAIL にもしない。
- K6/3-P2: NC-1 を当てた run で (b)、L への接続、(c) がどれも 0。期待された通信なしとして扱い、それだけで無効にしない。
- K6/3-P3: 辞書の要求が未完のまま process の終了で打ち切られた run を、分類器が「(b) にも (a) にもならず、その run を DP-1 の証跡にしない」と正しく扱う（未完の run は証跡から外す）。

Negative（どれも、その試みを期待された通信にしない。それ以外の内訳〔製品の FAIL、無効、台帳の不備〕は /2 の規則のまま）:

- K6/3-N1: net log に対応のない L への接続（Chromium 以外の client、harness の接続）。
- K6/3-N2: (b) でない URL の要求（Main の `net.fetch` の default session の要求、別の file 名の `.bdic`、query つき、`rr*.gvt1.com` など）を運ぶ L への接続。
- K6/3-N3: 1 件の (b) の要求に対応する 2 本目の L への接続（M_a の超過）。
- K6/3-N4: N_b を超えた (b) の要求と、それが運んだ接続。
- K6/3-N5: snapshot で Main が L を LISTEN していない、s1 と s2 で L が違う、Main の loopback の LISTEN に harness の一覧にない別の port がある、net log の `SOCKS5` の `proxy_info` に 2 つ以上の port がある。(a) を当てない。
- K6/3-N6: snapshot の印がない run、Main をちょうど 1 つに同定できない run（記録を取っていない run として無効）。
- K6/3-N7: host 名を運ぶ SOCKS5 の handshake の書込みがある接続、挨拶への応答の読取が bytes を受けた接続、`byte_count` が挨拶の長さを超えるか L からの byte がある接続。
- K6/3-N8: 辞書の形の要求の `proxy_info` が別の loopback の port か `PROXY` を指し、その port への接続を伴うもの（その接続はそれ以外）。
- K6/3-N9: `Dictionaries/` に file がある run（(b) にしない。/2 の「外へ到達した証跡」でもある）。
- K6/3-N10: L が harness の port、recorder の port、AI の送信先の一覧と一致する run（harness の隔離の不備として無効、測り直す）。
- K6/3-N11: (b) の URL か request header に fixture の材料の文字列がある要求（/2 のとおり製品の送信の FAIL。(b) の判定より先）。
- K6/3-N12: 環境側の記録の L への接続が net log の `TCP_CONNECT` より少ない run（記録の不備として無効）。
- K6/3-N13: harness が run の間に L へ接続した run（harness の隔離の不備として無効）。
- K6/3-N14: 観測の後に、狭める方向でない変更（N_b、N_c、URL や宛先の集合、ε、終わり方、event の指定、port の同定の方法を広げる）か、診断の記録・独立期待値 reviewer のレビュー・新しい版の freeze 記録のない変更（同じ版の freeze 記録の書き直しを含む）をした receipt（DP-1 の証跡にしない）。
- K6/3-N15: 環境側の記録の `redirector.gvt1.com` の DNS の問合せ（(b) の一部にしない。/2 の DNS だけの件の規則で、それ以外のまま）。
- K6/3-N16: 合成の記録で、(b) の要求に対応する `SOCKET` の source から SOCKS5 の段の event（挨拶の書込みと `byte_count` を含む）を取り除いたもの（挨拶の積極的な証拠がないので (a) にしない）。
- K6/3-N17: URL が AI の送信先（recorder の endpoint、旧 local provider の既定の port）で、`proxy_info` が `SOCKS5 127.0.0.1:L` の要求（proxy を経由した AI の送信先への試みとして製品の送信の FAIL。L を同定できない run でも同じ）。
- K6/3-N18: `diagLengthMs` を超えた run（(b)(c) の件数にかかわらず DP-1 の証跡にしない）。
- K6/3-N19: `ELECTRON_RENDERER_URL` のある run（(a)(b)(c) を当てず、DP-1 の証跡にしない）。
- K6/3-N20: 版の規則の違反（DD-1 の版が置換版の freeze 記録以外を引く、引く先の commit か file の sha256 が一致しない、置換版が失効した版1 を `supersedes` で引かない、DD-1 の版か置換版の材料が過去のどれかの版〔frozen でない版1 と置換版を含む〕の logical ID か text と重なる）。harness は実行しない（/2 の 253 行の扱いと同じ）。
- K6/3-N21: stderr に `NC-*` が出た run（(a)(b)(c) を当てず、DP-1 の証跡にしない）。
- K6/3-N22: 合成の記録で、wrapper の node か `--type=` を持つ process を Main とみなした snapshot（Main の同定の失敗として扱う）。
- K6/3-N23: 未完の辞書の要求と、それに束縛されない L への接続（(a)(b) にしない。P3 の対）。
- K6/3-N24: datagram を送った UDP connect（送信の event があるか、環境側の packet が 1 以上）。
- K6/3-N25: 宛先が (c) の集合の外の UDP connect。
- K6/3-N26: 起点が (c) の型の定義 4 の (i)〜(iii) のどれでもない UDP connect（(b) の要求の鎖に属さない URL の要求や connect job、renderer の WebRTC などから出たもの。`cached:false` の到達性の確認を持たない UDP connect を含む）。
- K6/3-N27: N_c を超えた (c)。
- K6/3-N28: 環境側の記録が宛先ごとの packet の数を持たない run の UDP connect（(c) を当てない）。
- K6/3-N29: 環境側の記録が local の port を持たない run、capture の mode が `local_address` か `byte_count` を記録しない run、環境側の時刻が ±ε に入らない接続、local の port が一致しない接続、ε が 100 ms を超える freeze 記録（(a) を当てない）。
- K6/3-N30: `initiator` が origin を持つ（renderer の文書や worker が起こした）辞書の URL の要求（(b) にしない）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| DD-1 | 分類器、snapshot と browser process の同定、対応づけ（両向きの推移的閉包、ε、port の照合）、(c) の判定（packet の数の記録を含む）、診断の run と N_b・N_c・`diagLengthMs`、合成の記録による検出力、receipt の欄、DD-1 の版（版3）が置換版の freeze 記録を引く検査、過去の全版の材料を避ける検査、DD-1 の記録を /3 で受ける validator を実装する。H4 による着手の保留は、この draft の確認で解ける（確認されなければ保留のまま） |
| DP-H | 置換版を版2 として作る前提になる（別 lane の実装）。置換版は K6/3 の確認の後に置き、draftRef は /2 のまま（「引き継ぐもの」の 1、2） |
| PUB-L（Session C-2 の提示） | Out-of-scope attacks の 1〜7 と、DD-1 の (a)(b)(c) の件数を開示に添える |
| NC-1／DA-1／CP-2b（K3/3） | 影響しない。DD-1 で辞書の要求が L を経由しなかった run は事実として申し送る（判定は K3/3 の G-open と G-pub） |
| CP-4、`g01-eval-revision`、`graph-eval-procedure` | 影響しない |

## 未確認と未検証

- 実アプリの起動（`initBackend` と製品の窓を含む）、DD-1 の環境の長さ（60 秒を超える run）での辞書の要求と IPv6 の到達性の確認の再試行と、N_b と N_c の値。DD-1 の環境の locale での辞書の URL。
- `--net-log-capture-mode=Everything` 以外の mode で、SOCKS5 の段の event、`SOCKET_BYTES_SENT` の byte 数、`TCP_CONNECT` の `local_address` が載るか。
- UDP の送信の event は名前（`UDP_BYTES_SENT`、`UDP_SEND_ERROR`）を constants で確かめただけで、実際に送信がある run の記録は見ていない。IPv6 の経路がある環境（DR-DA2-44 の `ipv6_available:true`）での `UDP_CONNECT` の終わり方。1 件目の UDP の起点の host 解決が自己確認の sentinel の解決であること（同じ時刻の 3 件の解決からの推定）。到達性の確認の起点の先着の順序（どの解決が cache の切れた後の最初になるか）と、cache の有効期間（5 秒より短いと読めるのは推定）。
- `drive.mjs` の snapshot の `perPidSame`（wrapper の pid の `/proc/<pid>/net/tcp` と、測る側の `/proc/net/tcp` の比較）は 6 回とも false だった。2 回の読取の間の socket の変化によると読めるが、確かめていない。
- 環境側の記録が接続ごとの local の port、byte 数、宛先ごとの packet の数を持てるか（DD-1 の harness の記録の方法に依る。DA-2 は dummy の interface と lo の記録で packet を数えた）。
- 確認前の測定は scratch main の 3 回で、記録は commit していない。DD-1 の診断の run で取り直す。
- DD-1 の環境で `/proc/<Main の pid>/net/tcp` と `/proc/<Main の pid>/fd` が読めること（測定では同じ user の process として `/proc/net/tcp` と各 process の `fd` が読めた。`/proc/<Main の pid>/net/tcp` を Main の pid で読む形は試していない）。同じ OS ユーザーの別の process が、Main が持つ `127.0.0.1:L` を同時に bind できないこと（推定）。
- updater の session が非 packaged で作られないこと（コードの読取と、測定の run で辞書の要求が 1 件だったことだけ）。
- Linux 以外での DD-1（K6/2 は OS を固定していない。この draft の snapshot の推奨の方法は Linux のもの。ほかの OS では同等の読取の方法を DD-1 の harness が定め、版を receipt に書く。方法がなければ (a) を当てない）。

## 引き継ぎ（DD-1 と DP-H の lane への申し送り。この確認の条件ではない）

- D1 診断の run を最初に取る: fixture の材料を含まない材料で、DD-1 と同じ build、起動、環境、capture の mode で、最短の run と `diagLengthMs` の run を含めて 5 回以上取り、(b) の URL の集合、終わり方、(c) の宛先（`{[2001:4860:4860::8888]:443}` の部分集合）、event の名前と params（UDP の送信の event の名前はこの draft で固定）、挨拶の長さ、N_b、N_c を観測し、DD-1 の freeze 記録に書く。**DD-1 の run（診断の run を含む）は、辞書の要求の開始から 5 秒以上（LS-1 の保持の後に -120 で終わるまで）Electron の process を終えない長さにする**。批准 4 の止める条件（N_b > 3、N_c > 2、M_a ≠ 1、挨拶の書込みの event が現れない）のどれかなら、型を広げずに `[precheck]` で止め、K6 の新しい draftRef を求める。
- D2 snapshot と browser process の同定: Linux では `/proc/<Main の pid>/net/tcp`、`tcp6`、`fd` の読取（subprocess なし）を推奨。CDP などの harness の port を DD-1 の freeze 記録の一覧に書き、(L3) で使う。
- D3 起動: DP-1 の証跡にする run は `ELECTRON_RENDERER_URL` を置かない（NC-1 を当てる）起動に限る（批准 2）。置いた run は記録と分類だけを行う。
- D4 合成の記録: K6/3-N1〜N30 を検出することを、分類器の試験で固定する。
- D5 辞書の要求が L を経由しなかった run、`NC-*` が出た run は、NC-1 の lane（DA-1／CP-2b）へ事実を渡す。
- D6 validator: DD-1 の版（版3）と DD-1 の receipt だけ `nir1-final-request-eval-proposal/3` を受け、DP-H の記録（版1、置換版、それらの receipt）は /2 のまま照合する（「引き継ぐもの」の 1、2）。
- D7 DP-H の置換版: K6/3 が確認されるまで置換 fixture は置かない運用とする（integrator の運用）。置くときは「変える点」の 14 の `supersedes`、新しい材料、作者と reviewer の分離に従う。
- D8 環境側の記録: L への接続の local の port と、(c) の宛先への packet の数を取れる方法（DA-2 の dummy の interface と lo の記録など）を選ぶ。取れなければ (a)(c) を当てられず、DD-1 は証跡を作れない。

## 確認の扱い

- 確認は末尾の「確認文」の 1 文で行う（台帳の Confirmation protocol。`draftRef` と 1 つの `contractId` を名指す 1 文）。1 文で確認されるのはこの contractId の行の、冒頭の 1〜9 だけで、依存する契約（K3/3 を含む）と K6/2 の条件付きの 2 行は確認されない。推奨と違う選択（「判断を求める点」）は新しい draftRef で起案する。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答、2026-10-25 の「Aで」は、確認として扱わない。
- 確認されたら、K6/2 の 147 行の規則で /3 の行が K6/2 の行を全体として supersede する。内容は「引き継ぐもの」のとおりで、K6/2 の確認の記録と行は消さない。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の取り込みの表（K3/3 の B3-1 の表と同じ形）: 受信の日時、確認された版（commit）、取り込んだ draft の SHA-256、確認文の逐語を、新しい補足の段落と表の行（例: `| B4-1 | nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval（K6/3。K6/2 と同じ contractId の新しい draftRef） | [nir1-final-request-eval-proposal-3-draft.md](nir1-final-request-eval-proposal-3-draft.md) | <SHA-256> |`）に書く。「1 文の範囲」の段落（この文は draft 冒頭の 1〜9 だけを批准する。範囲の正本はその一覧）と、「K6/3 が許さないもの」の段落（批准 8 と、DD-1 の実装と実行、DP-H の置換版の作成、DD-1 の DP-1 の PASS、PUB-L はこの確認で行っていないこと）を足す。
- 確認台帳の行: K6/2 の行（191 行）を残し、その下に行を足す。列は 191 行と同じ（contractId、draftRef、confirmedRef、confirmedScope、remainingDelta、affectedLanes、startStatus、blockedReason、unblockingEvidence）。
  - draftRef `nir1-final-request-eval-proposal/3`、confirmedRef `nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval`。
  - confirmedScope 案: 「K6/3 の範囲: draft 冒頭の『ユーザーが批准すること』の 1〜9 の全項目（この一覧が範囲の正本で、台帳は別の列挙を持たない）。DD-1 の『接続の試みの分類』に、(a) Chromium（default session）から LS-1 への接続、(b) blackhole された辞書の要求の試み、(c) datagram を送らない IPv6 の到達性の確認の UDP connect を、型と起点つきで期待された通信として加える（(a) は (b) を運ぶ接続に限る。M_a = 1、N_b ≤ 3、N_c ≤ 2、ε ≤ 100 ms、local の port と packet の数と capture の mode は必須、観測の後は狭める方向だけ。LS-1 の port は net log と OS の socket 表の snapshot で同定する。DP-1 の証跡にする run は NC-1 を当てた起動で `diagLengthMs` 以内に限る）。DP-H の版1 が失効した場合、置換版を版2、DD-1 の版を版3 と読む（命名と引く先だけ。材料の除外は全版）。(c) は K3 の一覧の外で、K6 の出典の原則の唯一の例外。threat model の 6 要素と受入れを含む。**K6/2 の文面より弱い読み**（『変える点』の 1〜4 と 15）。K6/2 のほかの全部は変えず、/3 が引き継ぐ（DP-H の記録は /2 のまま）。`g01-eval-revision`、`graph-eval-procedure`、K3/3 を含む依存する契約は確認しない」。
  - remainingDelta: 「none — 差分は確認済み。DD-1 の harness の実装（分類器、snapshot、対応づけ、(c) の判定、診断の run と N_b・N_c、合成の記録、版の検査、/3 を受ける validator）と受入れは DD-1 に、置換版の作成は DP-H に残る」。
  - affectedLanes: 「DP-H（置換版の命名）、DD-1、PUB-L（Session C-2 の提示）」。
  - startStatus: 「ready-after-normal-dependencies（K6/2 の行のまま）」。
  - blockedReason: 「none — explicit user confirmation recorded. DD-1 の H4 による保留は解け、DP-H は置換版を置ける。DD-1 と PUB-L は K6/2 の行と同じ通常の依存が要る」。
  - unblockingEvidence（191 行と同じく最後の列に確認の証跡を置く）: confirmedRef、exact statement、確認の日時（JST）、draft の commit と SHA-256、「this independently ratifies only this row; per K6/2's own rule (line 147) it supersedes the K6/2 row as a whole, with content equal to K6/2 plus the /3 delta; the K6/2 ref is kept as history」。
- 台帳の注記: K6/2 の 2026-10-17 の注（206 行）の下に、/3 の「変える点」の 1〜15 を読み替えとして足し、1〜4 と 15 が K6/2 の文面より弱い読みであること、14 が版の命名と引く先の読み替えであること、15 が出典の原則の唯一の例外であること、DP-H の新しい記録が /2 を名乗る構図（「引き継ぐもの」の 2）を書く（先の注は消さない）。K3/3 の行（187 行）の備考「DD-1 は K6 の確認者への照会まで着手を保留する」と lane snapshot の DD-1 の行（544 行）に、H4 が `nir1-final-request-eval-proposal/3` の確認で解けたことを注記する（K3/3 の bytes と行の確認範囲は変えない）。lane snapshot の DP-H の行（545 行）に、置換版を版2 として置けることを注記する。DR-DA2-44 が integrator の確認の対象とした IPv6 の分類が、DD-1 については (c) で定まったことを注記する。
- 続行計画（`docs/plans/nir1-continuation-2026-10.md`）: §1 に「Aで」（2026-10-25）の逐語と出所を記録する。§4 のレーン表の DD-1 の行（154 行）と §10.5 の表の DD-1 の行（494 行）の保留の注記、§11 の H4 の項（510 行）を解決済みにし、確認の記録を §10 に足す。
- DD-1 と DP-H の TASK（K6/2 の「確認後の記録」の DP-H と DD-1 の TASK の項に足す）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」、receipt に加えるもの、K6/3-P1〜P3 と K6/3-N1〜N30、「変える点」の 14 の版の規則、引き継ぎの D1〜D8 を写す。
- 確認されなければ、DD-1 は H4 の保留のまま着手せず、DP-H の置換版も置かない。別の案を選ぶ場合は /4 で起案する。

## 確認文

contractId の選択: **`nir1-final-request-packing-eval`**（K6/2 と同じ）。

- 理由: (1) この差分は、K6/2 が確認した `nir1-final-request-packing-eval` の行の一部（DD-1 の接続の試みの分類と、版の命名）を読み替える改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) 前例は `nir1-l6-l9-contract-proposal/7`（確認済みの /6 の値を同じ contractId の新しい draftRef で改訂し、/6 の確認を履歴として残した形）。K6/2 の 147 行の規則により /3 は K6/2 の行を全体として supersede し、引き継ぐものは本文の「引き継ぐもの」に書いた。(4) 確認は contractId ごとの 1 文（台帳の Confirmation protocol）。

確認は次の 1 文で行う（空白を含め一字違わない。ユーザー自身が打ったときだけ有効）。

- I confirm draftRef nir1-final-request-eval-proposal/3 for contractId nir1-final-request-packing-eval.
