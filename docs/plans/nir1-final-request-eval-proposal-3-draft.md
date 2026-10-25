# NIR-1 最終 request 評価の契約提案 proposal/3（draft）: DD-1 の接続の試みの分類に、NC-1 が加えた 2 項目（LS-1 への接続と blackhole された辞書の要求）を型と起点つきで加える（あわせて、DP-H の置換版に伴う版の番号の読み替え）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## ユーザーが批准すること

末尾の確認文 1 文で批准するのは、次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、「前書き」「範囲」「確認後の記録」の台帳の `confirmedScope` はこの一覧を指すだけで、別の列挙を持たない。一覧にないものは批准しない。数値と根拠は各節に 1 回だけ書き、ここには再掲しない。

1. 加えるもの: K6/2 の DD-1 の「接続の試みの分類」の期待された通信に、K3/3（`nir1-d2a-activation-proposal/3#caller-profile-egress`。確認済み）が「続く通信」に加えた 2 項目を、この draft の「型の定義」の型と起点つきで加える。(a) Chromium（default session）から LS-1（Main の process が持つ `127.0.0.1` の blackhole の listener）への接続、(b) blackhole された辞書の要求の試み。
2. 加え方の制約: (a) は (b) の要求を運ぶ接続としてだけ期待された通信になり、(b) の要求の一部として数える（別の件にしない）。(b) の要求を運ばない LS-1 への接続、型に合わない接続、件数の規則を超える接続は、従来どおり「それ以外」に入れる（「件数の規則」「分類の順序」）。**DP-1 の証跡にする DD-1 の run は、NC-1 を当てた起動（起動の env に `ELECTRON_RENDERER_URL` がない起動）に限る**。NC-1 を当てない run は記録して分類するが、DP-1 の証跡にしない（K6/2 より厳しい側の追加）。
3. LS-1 の port（この draft では `L` と書く）の同定: run の net log と、harness が取る OS の socket 表の snapshot（この draft が DD-1 に足す唯一の観測。読取だけで接続しない）の両方で同定する。同定できない run には (a) を当てない（「LS-1 の port の同定」）。
4. 件数と時刻の規則: (b) の要求 1 件が運ぶ LS-1 への接続は 1 本ちょうど（M_a = 1）。(b) の要求の件数の上限 N_b は、診断の run の観測から観測の前に DD-1 の freeze 記録に書き、**3 を超えてはならない**（初期案。値の根拠は薄く「ユーザーに聞くべき点」に挙げる）。診断の run の最大値が 3 を超えるか、M_a = 1 が崩れたら、DD-1 は `[precheck]` で止まり K6 の新しい draftRef を求める。診断の run の長さ（`diagLengthMs`）、時刻の許容幅 ε、net log の capture の mode も観測の前に DD-1 の freeze 記録に書く。観測の後に変えてよいのは、件数と型を**狭める方向だけ**で（診断の記録、独立期待値 reviewer、新しい版の freeze 記録を要する）、N_b を広げる、URL の集合を広げる、port の同定の条件を外す、`diagLengthMs` を超える run の (b) を数える、のどれも新しい draftRef でしかできない。
5. これが合格基準の緩和に当たること: K6/2 の 284 行の文（「loopback の接続の試み〔…を除く〕は、一覧に項目がないので、すべてそれ以外」）を文面どおりに読めば、NC-1 を含む build の DD-1 の run は LS-1 への接続が毎回記録されるので、DP-1 を PASS にできない。別の読み方もありうる（K6/2 の 119 行と 279 行は、K3 が確認で一覧を変えれば期待された通信も合わせるとし、284 行の理由句「一覧に項目がないので」は K3/3 の後は成り立たない）。/3 は型を明示してこの曖昧さを除く。文面どおりの読みに比べれば、上の型に合う接続に限って run を証跡にしてよいとする**弱い読み**であり、弱める範囲は 1〜4 の型と件数に限る。残る誤分類の余地は threat model の Out-of-scope attacks と「未確認と未検証」に書く。
6. 版の番号の読み替え（「変える点」の 14）: DP-H の版1 が失効した場合（現に失効している。DR-DPH-70）、DP-H の置換版を「版2」、DD-1 が足す版を「版3」と読む。K6/2 の「DD-1 で足す版2」の記述（253、297、417、439 行のすべて）はこの読み替えに従う。範囲は命名と引く先の読み替えだけで、版の規則そのもの（観測前の固定、新しい材料だけで作ること、前の版の freeze 記録の commit と file の sha256 を引くこと、引く先の一致を実行の条件とすること、「版3以降も同じ規則」）は変えない。
7. 変えないもの: /2 のほかの全部（「前書き」の「変えないもの」の列挙）。loopback を記録と分類から外さない（/2 が禁じたまま）。recorder への接続の規則、AI の送信先の規則、`github.com` の分類の限界、意味モデルのない初回起動の状態、P の Gold と固定値、事前登録の凍結の規則、失効率の物差し、AI 使用ポリシーを書かない setup は変えない。
8. 許さないもの: DD-1 の実装と実行そのもの、DP-H の置換版の作成そのもの、NC-1 の挙動の変更、新しい authority・保存先・送信先・製品の入口・評価専用の入口、Graph と local 送信の公開、Session C-2 の承認。依存する契約（K3/3 を含む）と、K6/2 の条件付きの 2 行（`g01-eval-revision`、`graph-eval-procedure`）は確認しない。
9. threat model と受入れ（GDX-PRECHECK-001 の明示の確認の対象）: 「threat model」の節の 6 要素（Trusted actors、Untrusted actors、In-scope attacks の 1〜11、Out-of-scope attacks の 1〜5、Mandatory defenses、Acceptance implications）、「受入れ」の節（receipt に加えるもの、K6/3-P1〜P3、K6/3-N1〜N20）、「変える点」の 5〜14、「引き継ぐもの」の節。

注記（批准の対象ではない）: 2026-10-25 にユーザーが選んだ (A)（「Aで」）は、この draft を起案する指示で、確認文ではない。この起案は選択肢の逐語の質問文を見ておらず、integrator の伝聞による。版の番号の読み替え（6）は、integrator が DP-H の置換版の必要（別 lane）から加えた項目で、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/3` |
| contractId | `nir1-final-request-packing-eval`（K6/2 と同じ。選んだ理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `7af0be93`（#707）。この draft の行番号（K6/2 の本文、`electron/main`、`electron/scripts`、`scripts/quality`、台帳 `docs/plans/nir1-l6-l9-execution-plan.md`、続行計画）は `7af0be93` で確かめた。K6/2 の bytes の SHA-256 は `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8`、K3/3 は `e5362f3e40e662781d57c46d20db617aded3c7d4cf72912c0d27991b0dbded11` で、どちらも台帳の値と一致することを再計算して確かめた |
| 確認済み baseline | `nir1-final-request-eval-proposal/2#nir1-final-request-packing-eval`（K6/2。2026-10-17 の Session B1 で確認。commit `af643a93`）。台帳の 2026-10-23 の注記（K6/2 の「確認後の記録」への DI-1a の注記。台帳 558 行）を含む。K6/2 の bytes は変えない（この draft は別のファイル） |
| 前提 | K3/3 は 2026-10-18 の Session B3 で確認され（台帳 187 行）、NC-1／LS-1 は #683 で master にある（`electron/main/rendererContainment*.ts`）。K3/3 の引き継ぎ H4 は、K6/2 の分類がこの 2 項目と両立するかを K6 の確認者の判断に残し、台帳の lane snapshot（544 行）と続行計画（§4 の 154 行、§10.5 の 494 行、§11 の 510 行）は DD-1 をその判断まで着手しないとしている。DD-1 の harness（評価の Electron の起動と接続の試みの記録・分類）は `7af0be93` に無い（未実装。`scripts/quality/nir1-packing/final-request/` は DP-H の scorer と receipt で、接続の試みを扱わない）。DP-H の版1 は Native に観測されて frozen にできない（freeze 記録の `status` は `pending-review`。DR-DPH-70） |
| 版の呼び方 | 「変える点」の 14 の読み替えの後、DD-1 が足す版を「DD-1 の版」、その fixture と freeze 記録を「DD-1 の fixture」「DD-1 の freeze 記録」と書く（DP-H の版1 が失効した今の状態では版3） |
| 確認を求めるもの | 冒頭の「ユーザーが批准すること」の 1〜9（範囲の正本。ここに別の列挙を置かない） |
| 変えないもの | K6/2 のほかの全部。P の Gold（12 task、保持 100%、禁止情報 0、prose 非回帰）、P-12 の slot と 0→1、P の固定値（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）、既存の 24 件、G-01 の v1、G-02〜G-08、IR の floor、K1 の値と規則、Packing の 2 MiB と 512 items、AttemptBinding の 64 KiB、事前登録の凍結の規則、失効率の物差し（1%）、AI 使用ポリシーを書かない setup、recorder への接続の規則（run の全体で 1 本）、AI の送信先の規則、Chromium の network stack を通らない試みの規則と `github.com` の限界、意味モデルのない初回起動の状態、既存の型（spellchecker の辞書ファイルの取得の型を含む）、版の規則（命名と引く先を除く）。新しい authority・保存先・送信先・製品の入口は加えない |

## 引き継ぐもの（K6/2 の 147 行の規則による）

K6/2 の「確認の扱い」（147 行）は、同じ contractId の後続の draftRef が確認されると先行の行を全体として supersede し、後続は先行の行から引き継ぐもの（作った版、receipt、失敗の記録、事前登録の規則）を本文に書くとする。/3 が確認されたときの `nir1-final-request-packing-eval` の内容は「K6/2 の全文に、下の『変える点』の表を当てたもの」で、次を引き継ぐ。

1. K6/2 の下で作った DP-H の記録は、/3 の行の下でも /2 の下で作った記録として、その状態のまま有効とし、それらの `draftRef` の欄は `/2` のまま読む: fixture 版1（`evals/nir1-packing/final-request.v1.json`、SHA-256 `0d277e0cc00dc42f61ad583b7bb59a6b2f9f038a2932684d9bc823ac8dc9ac49`）、その freeze 記録 `evals/nir1-packing/final-request.freeze.v1.json`（SHA-256 `0bc52f5e8e5b97842e800ceecb943dc97f7ab1cd5adde5cf765f0347b1f50dd7`。`draftRef` は `nir1-final-request-eval-proposal/2`、`status` は `pending-review`。Native が freeze の前に材料を観測したので、置換版が要る。`docs/plans/nir1-lane-decisions/dp-h-decisions.md` の DR-DPH-69〜72 の失敗の記録）、expectation review の記録、DP-H の receipt。どちらの file も `7af0be93` での最後の commit は `bf69e2f0`。版1 は「変える点」の 14 の読み替えの下で「失効した版1」で、置換版（版2）が `supersedes` として引く。版1 の失効の状態を変えず、frozen にしない。validator の `DRAFT_REF`（`scripts/quality/nir1-packing/final-request/receipt.mjs:30`、704、`contract.mjs:1053`、1306）は /3 では変えない。
2. 置換版（版2）と DD-1 の版（版3）の fixture と freeze 記録は、/3 の読み替えの下で新しく作る記録で、`nir1-final-request-eval-proposal/3` を名乗る。それを受け付ける validator の変更（新しい版の記録だけ /3 を受け、版1 の記録は /2 のまま照合する）は DP-H と DD-1 の lane の実装で、この draft は書かない。
3. K6/2 の事前登録の凍結の規則（条件付きの 2 行。`claude/nir1-contracts` の `e49d0758` と /2 の凍結）は、別の contractId の行の規則で、この draft の対象外。そのまま残る。
4. K6/2 の確認の記録（2026-10-17、台帳 191 行）と、台帳の 2026-10-23 の注記（558 行）、2026-10-17 の読み方の注（206 行）は消さない。

前例は `nir1-l6-l9-contract-proposal/7`（確認済みの /6 の値を、同じ contractId の新しい draftRef で改訂し、/6 の確認を履歴として残した）。台帳の行の置き方（先行の行を残して後続の行を並べる）は K3/3 の行（186・187 行）に倣う。K3/3 は K3/2 を置き換えない加算で、/3 は K6/2 の規則による supersede なので、形は同じでない。

## 変える点（K6/2 との関係）

次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。**1〜4 は /2 の文面より弱い読み**（批准 5）、5 と 2 の後半は狭める防御、6〜13 は具体化か開示、14 は命名と引く先の読み替え（批准 6）である。以下、この表の行は「/3 の変える点 n」と呼び、K6/2 本文の「/1 からの差分」の #n とは別の番号である。

| n | 箇所（K6/2 の行） | /2 の文 | /3 の文 | 理由 |
| - | ---------------- | ------- | ------- | ---- |
| 1 | 「接続の試みの分類（DD-1）」の前置きの一覧（279 行） | 期待された通信は、K3 の確認済みの開示の「続く通信」の一覧（起案時点の K3/2 では、license の確認、更新の確認と download、意味モデルの download、IME 辞書の download、spellchecker の辞書ファイルの取得）の項目への試みのうち、記録から型と起点を確かめられたものだけ | 一覧に、K3/3 が加えた (a) LS-1 への接続と (b) blackhole された辞書の要求の試みを加える。型と起点はこの draft の「型の定義」による。ほかの項目の型と起点は /2 のまま | K3/3 の「変える点」9。/2 の K3/2 への前提の 6（119 行）は一覧を K3 の確認に合わせるとするが、/3 の変える点 3 の文と URL による型の照合（280 行）が LS-1 への接続を扱えないので、文で定める（K3/3 の H4） |
| 2 | 同じ前置きの対応づけ（279 行） | 環境側の記録の件のうち、net log の期待された通信の要求に対応するもの（同じ host で、要求の開始以後）は、その要求の一部として数え、別の件にしない | 加えて、環境側の記録の LS-1 への接続のうち、「型の定義」の (a) に合い、net log の (b) の要求に「件数の規則」のとおり対応するものは、その (b) の要求の一部として数え、別の件にしない。**(b) の要求には、環境側の記録の DNS の問合せを対応づけない**（`redirector.gvt1.com` などの問合せは /2 の DNS だけの件の規則で「それ以外」のまま。防御を狭める側） | LS-1 への接続は環境側の記録では `127.0.0.1:L` にしか見えず、「同じ host」で対応づけられない。SOCKS5 の下で Chromium は辞書の host を引かない（事実の測定） |
| 3 | 「期待された通信は…」の loopback の文（284 行） | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本を除く）は、一覧に項目がないので、すべてそれ以外に入れる | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本と、/3 の変える点 2 で (b) の要求の一部として数えた LS-1 への接続を除く）は、一覧に項目がないので、すべてそれ以外に入れる | 除くのは変える点 2 に当たる接続だけ。L への接続でも変える点 2 に当たらないものは、それ以外のまま |
| 4 | 「Chromium の network stack を通る試み」の後（280 行の次） | （なし） | 新しい項「NC-1 の下の LS-1 への接続と辞書の要求（K3/3 の (a)(b)）」を置き、この draft の「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」を本文とする | 型を URL でなく net log の `proxy_info` と socket の段で定義するため |
| 5 | 「観測の後に型を足せるのは…」（285 行） | 型を足せるのは同じ帰属の証拠があるときだけ。足すときは失敗の記録を残し、独立期待値 reviewer の確認のうえ新しい版の freeze 記録で足す | (a)(b) の型、URL の集合、終わり方の集合、N_b、M_a、`diagLengthMs`、ε、挨拶の長さ、event の指定、capture の mode、port の同定の方法には 285 行の規則を当てない。観測の後に変えてよいのは狭める方向だけで、診断の run の記録、独立期待値 reviewer のレビュー、新しい版の freeze 記録を要し、変える前の run は DP-1 の証跡にしない。広げる変更は新しい draftRef でだけ行う（批准 4） | 285 行の「同じ帰属の証拠」は件数や時刻の幅に当てはまらず、観測の後に結果に合わせて広げる余地を残さないため（狭める防御。/2 より厳しい） |
| 6 | 「接続の試みの記録」（277 行） | 記録は Chromium の net log、遮断の環境側の記録、IPC の trace から書く。記録の仕組みが動いた印も書く | 加えて、LS-1 の port の同定のための OS の socket 表の snapshot（s1、s2）と、その印（取得の時刻と成否）を書く。印のない run は記録を取っていない run として扱う。net log の capture の mode は DD-1 の freeze 記録に書いた値で取る | 「LS-1 の port の同定」の (L2) |
| 7 | Trusted actors（229 行） | DD-1 の接続の試みの記録（net log、遮断の環境側の記録、IPC の trace の観測器） | threat model の Trusted actors の加算 | threat model |
| 8 | In-scope attacks の「DD-1 の外への通信」（248 行） | （下の各項は無い） | threat model の In-scope attacks の 1〜11 を加える | 緩和の悪用を拒否する |
| 9 | Out-of-scope attacks（249 行） | （LS-1 の残余は無い） | threat model の Out-of-scope attacks の 1〜5 を残余として加え、Session C-2 の提示に添える | 誤分類の余地を開示する |
| 10 | Acceptance implications（288 行） | DD-1 の各 run の receipt の項目と、「DP-1 の証跡にする run では期待された通信でない試みが 0 件」 | receipt の項目に「receipt に加えるもの」を足し、「受入れ」の K6/3-P1〜P3、K6/3-N1〜N20 を加える。DP-1 の証跡にする run を NC-1 を当てた起動に限る。「期待された通信でない試みが 0 件」は変えない | 受入れ |
| 11 | 失効（310 行） | 外への通信の遮断と接続の試みの記録の方法（…）、期待された通信の型と起点（版2の freeze 記録） | 記録の方法に「LS-1 の port の同定の方法（OS の socket 表の snapshot の取り方と browser process の同定の規則）と net log の capture の mode」を、DD-1 の freeze 記録の内容に「(b) の URL の集合、終わり方の集合、N_b、`diagLengthMs`、ε、挨拶の長さ、event の名前と params の指定、診断の run の記録」を加える。「版2の freeze 記録」は変える点 14 で「DD-1 の freeze 記録」と読む | NC-1 の実装の変更は /2 の「候補の head と tree」で失効する（足さない） |
| 12 | 「選択肢と推奨」の表（507 行の行の後） | （LS-1 の論点は無い） | この draft の「選択肢と推奨」の 5 行を加える | 選択の記録 |
| 13 | 「確認後の記録」の DD-1 の TASK（781 行） | 外への通信の遮断と接続の試みの記録・分類を写す | 加えて「確認後の記録」の DD-1 の TASK の項を写す | 実装は DD-1 の lane |
| 14 | 「fixture の版と freeze 記録」（253 行）、保存先（297 行）、「case ごとの材料と測る時期」（417 行、439 行）と、本文で DD-1 の版を「版2」と呼ぶすべての箇所 | DP-H の fixture は版1、DD-1 で足す variant は版2 に置き、版2 の freeze 記録は版1 の freeze 記録の commit と版1 の file の sha256 を引く。DD-1 の harness は版1 の file の sha256 が版1 の freeze 記録と一致しなければ実行しない。版3以降も同じ規則に従う（253 行）。DP-H の版1と、DD-1 で足す版2は別の file にする（297 行）。DD-1 は混在・Graph・history の variant を版2として新しい材料で加える（417 行）。DD-1 で加える variant の材料は、DP-H のどの variant にも使っていない新しい材料で作り、版2に置く（439 行） | DP-H の版1 が失効した場合（frozen にならないまま観測された場合）、DP-H の置換版を「版2」、DD-1 が足す版を「版3」と読む。版N+1 が版N の freeze 記録の commit と file の sha256 を引く規則、DD-1 の harness が引く先の一致を実行の条件とする規則、「版3以降も同じ規則」は、DD-1 の版（版3）が**置換版（版2）の freeze 記録**を引く形でそのまま当てる。置換版は、失効した版1 の fixture と freeze 記録の sha256（と最後の commit）を `supersedes` として引き、版1 の材料（logical ID と text）を再利用せず、新しい材料だけで作る。置換版の fixture の作者と独立期待値 reviewer は、版1 の作者・実装者とも、置換版の contract／gate の実装者とも別で、Native の出力を見ていない者とする。DD-1 の版の材料は、過去の全版（frozen でない版1 を含む）のどの variant にも使っていない新しい材料で作る（439 行の「DP-H のどの variant にも使っていない」を、置換版が入った後も保つ）。版1 が失効していなければ、/2 の番号（DD-1 の版は版2）のまま読む | 253 行の規則は版1 が frozen になる前提で書かれ、HOLD になった版の置換は文面の外にある。「版3以降も同じ規則」は相対の規則と読めるが、DD-1 を版3 にすることを許す文ではない。確認済みの文言からの逸脱にならないよう、命名と引く先だけを読み替える |

## 事実

コードは `7af0be93` で確かめた。既存の記録は master にある測定の記録、新しい測定は「確認前の測定」の項のとおりで、記録にないものは「未検証」と書く。

- LS-1 の実装: `net.createServer` を `127.0.0.1`、port 0（ephemeral）で listen する（`electron/main/rendererContainmentListener.ts:30`、114）。受けた socket は `resume()` で読み捨て、`data` の listener を付けず、書き込まない（:95-96）。同時 256 を超える接続は受けた直後に破棄し、1 接続の保持は 5 秒以下（:25、28、82-90）。start は 1 回だけで再 bind しない（:63-66）。製品のコードは listener を閉じない。port は orchestrator が `buildProxyConfig(listenerPort)` で default session の `setProxy` に渡すだけで（`electron/main/rendererContainmentStartup.ts:300`、310）、file や log には書かない（固定コードの出力は port を含まない。`nc1-decisions.md` の DR-NC1-4）。
- bypass は `<-loopback>` だけで（`electron/main/rendererContainment.ts:43-50`、66-80）、NC-1 の下では default session の要求は、loopback の宛先（recorder の socket、旧 local provider の既定の port を含む）も含めてすべて L へ向かう。環境側の記録には、その宛先でなく `127.0.0.1:L` への接続が現れる。
- `electron/main` と `electron/preload` の試験でない file で `.listen(` か `createServer` を持つのは `rendererContainmentListener.ts` だけ（`7af0be93` を検索。K3/3 の Negative (31) の静的な検査も `.listen(` を NC-1 の listener の file に限る。DR-NC1-2）。
- NC-1 の適用: `shouldRegisterAppProtocol()` が true の起動だけ（`electron/main/index.ts:244-246`。非 packaged で `ELECTRON_RENDERER_URL` がある起動は除く。`electron/main/devRendererUrl.ts:61-66`）。
- NC-1 の自己確認（`rendererContainmentStartup.ts:147-187`）は、`resolveHost` 3 件（sentinel と EXCLUDE していない IP literal）と `resolveProxy` 3 件（`https://turn.attacker.invalid:443/` などの固定の URL）を起動の前に行う。これらは net log に host 解決などの event を残しうるが、接続の試みでも wire の DNS でもない。
- updater: 非 packaged では無効で（`electron/main/updater.ts:89-97`）、electron-updater の singleton にも触れない（:198-205）。K3/3 が書く updater の session の辞書の要求は、その session が最初の request で作られるので（K3/3 の「開示に無かったこと」の 1）、DD-1 では起きない見込み（コードの読取による）。macOS の electron-updater の loopback listener（K3/3 の影響表 8）も DD-1 の範囲外。
- 既存の記録（`docs/plans/nir1-lane-decisions/nc1-g-open/nc1-order-product-nc1-{none,ip,localhost}.json`。製品の orchestrator を `index.ts` と同じ順序で呼ぶ scratch main で、`initBackend` を呼ばない。Linux、Electron 43.8.3、窓の作成後 9 秒の観測〔`electron/scripts/webrtc-block-probe-order-main.cjs:87`、152〕）: 15 回すべてで、辞書の要求 1 件、`proxy_info` が `SOCKS5 127.0.0.1:<port>`、net error -120、blackhole の listener への接続 1 本、`Dictionaries/` 空。**DD-1 の条件（env の proxy なし）に合うのは `none` の 5 回だけ**で、`ip`／`localhost` の 10 回は env に `http_proxy`／`https_proxy` を置いている（`electron/scripts/webrtc-block-probe-order.mjs:116-118`）。probe は URL の query を削って記録し（52 行）、`gvt1.com` の要求だけを数える。記録に LS-1 の port は無く、`proxy_info` の port が LS-1 の port であることはコードからの推定だった。挨拶の長さは、K3/3 の `al0-dict.json` の `proxyHeads` が `"..."`（印字不能の 3 文字に置換。`electron/scripts/webrtc-block-probe.mjs:511`）で、3 byte と読める（値は未記録。Electron 43.5.0、probe の listener）。
- 確認前の測定（2026-10-25、この起案で実施。記録は commit していない）: 上の scratch main を `product-nc1` で、env の proxy なし、Wayland／D-Bus の変数を外し、`ELECTRON_OZONE_PLATFORM_HINT=x11`、`scripts/local-ci-xvfb.mjs` 経由（host の namespace）で、`--log-net-log` と `--net-log-capture-mode=Everything` を付けて 2 回走らせた（窓の作成後 9 秒と 60 秒。Linux、Electron 43.8.3。cargo の build は使っていない）。どちらの run でも次が成り立った。
  1. net log の URL の要求は辞書の 1 件だけ（`GET https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`、query なし）。60 秒の run でも再試行はなかった。
  2. 要求の source（`URL_REQUEST`）から、`source_dependency` の鎖で `HTTP_STREAM_JOB_CONTROLLER`（`PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST` の `proxy_info` が `SOCKS5 127.0.0.1:L`、`HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED` の `proxy_chain` が `[socks5://127.0.0.1:L]`）、`HTTP_STREAM_JOB`（`TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET`、`SOCKET_POOL_BOUND_TO_CONNECT_JOB`）、`SSL_CONNECT_JOB`（`SOCKS_CONNECT_JOB_CONNECT`、`TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT` の `address` が `127.0.0.1:L`）、`SOCKET` へ結べた。鎖は向きが混ざる（子が親を指す event と親が子を指す event がある）ので、推移的閉包は両向きで辿る必要があった。
  3. `SOCKET` の source に `TCP_CONNECT`（終わりの params に `local_address` と `remote_address` = `127.0.0.1:L`）、`SOCKS5_CONNECT`、`SOCKS5_GREET_WRITE`（`SOCKET_BYTES_SENT` が 3 byte、`BQEA` = `05 01 00`）、`SOCKS5_GREET_READ`（受信 0 byte、`SOCKS_UNEXPECTEDLY_CLOSED_DURING_GREETING`、net error -120）があり、`SOCKS5_HANDSHAKE_WRITE` はなかった。挨拶の書込みから切断まで 5001 ms（LS-1 の保持 5 秒）。net log の constants には `SOCKS5_HANDSHAKE_WRITE`、`SOCKS5_HANDSHAKE_READ` などの名前もある。
  4. run の net log の `proxy_info` の値は `SOCKS5 127.0.0.1:L` の 1 つだけで、event の params に自己確認の URL は現れなかった。
  5. 実行中に 2 回（窓の読込の後と終了の 1 秒前）読んだ `/proc/net/tcp` と各 process の `/proc/<pid>/fd` の照合で、loopback の LISTEN の socket は 1 つだけ（`127.0.0.1:L`）で、持ち主は `--type=` のない electron の process（browser process）だった。起動した process（`child.pid`）は wrapper の node（`local-ci-xvfb.mjs`）で、Main はその子だった。ほかの electron の process は `--type=zygote`、`utility`、`renderer`、`gpu-process` を持っていた。blackhole の listener への接続は run の全体で 1 本、`Dictionaries/` は空。
  これは scratch main（窓は stub の `index.html`、`initBackend` なし）の 2 回の観測で、実アプリの起動、DD-1 の環境、ほかの capture の mode では確かめていない。
- /2 の既存の観測手段で足りない点: net log は Chromium がどの port へ向かったかを示すが、その port を持つのが Main の LS-1 であることは示さない。/2 は起動に proxy を置かないこと（env と起動引数の記録）を求めるので、`SOCKS5 127.0.0.1:L` の出所が NC-1 の `setProxy` だけであることはコードから推定できるが、記録では確かめられない。そこで、OS の socket 表の snapshot を 1 種だけ足す。
- DP-H の版1: `evals/nir1-packing/final-request.freeze.v1.json` は `draftRef` が `/2`、`status` が `pending-review` で、note は「Native が freeze の前に材料を観測したので、この形では freeze できず、新しい材料と別の作者の置換 fixture が要る」とする（DR-DPH-70）。

## 設計

### 型の定義

(b) blackhole された辞書の要求の試み（Chromium の network stack を通る。起点は default session の spellchecker）。net log の 1 つの URL の要求で、次をすべて満たすもの。

1. method が GET で、upload（request の body）がない（/2 の辞書の型と同じ）。
2. URL が、DD-1 の freeze 記録に書いた exact な URL の集合のどれかと一致する（scheme・host・path・query を含めて完全一致）。集合は、K3/3 の型（`redirector.gvt1.com` の `/edgedl/chrome/dict/` の下の `.bdic`）に合う URL だけからなり、診断の run で観測した URL を書く（推奨の初期値は `https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` の 1 件）。K3/3 の型より狭い（file 名を固定する）。
3. その要求に属する `proxy_info` が、すべて `SOCKS5 127.0.0.1:L`（L は下の「LS-1 の port の同定」で同定した port）で、ほかの値を含まない。default session だけが NC-1 の `setProxy` を受けるので、これが default session の要求であることの記録上の根拠になる（session の名前は net log に現れない。コードによる帰属）。
4. 終わり方が、DD-1 の freeze 記録に書いた集合のどれかである。集合は診断の run で観測した net error（測定では -120。LS-1 が接続を 5 秒保持した後に出る）と、「未完（その run の Electron の process の終了で要求の終わりの event がないまま打ち切られた）」からなる。redirect の連鎖がなく、応答の body を受けていない。
5. run の終わりに、profile の `Dictionaries/` に file がない（取得 0。/2 の「外へ到達していない証跡」と同じ確認）。
6. URL と request header に fixture の材料の文字列がない（/2 の規則。これに当たれば製品の送信の FAIL で、(b) にしない）。

(a) Chromium（default session）から LS-1 への接続（起点は (b) の要求を処理する Chromium の network stack）。環境側の記録の 1 本の TCP の接続の試みで、次をすべて満たすもの。

1. 接続先が `127.0.0.1:L`。
2. net log の対応: ある (b) の要求の source から `source_dependency` の鎖を両向きに辿った推移的閉包（URL の要求 → stream job controller → stream job → connect job → socket。名前は事実の測定の 2 のとおり）に属する `SOCKET` の source があり、その `TCP_CONNECT` の `remote_address` が `127.0.0.1:L` である。socket pool では接続の job が同じ group の別の要求に割り当て直されうるので、要求への帰属は、その socket を使った stream job が束縛された要求（`SOCKET_POOL_BOUND_TO_CONNECT_JOB` と `HTTP_STREAM_JOB_BOUND_TO_REQUEST`）で決め、どの要求にも束縛されないか、2 つ以上に束縛される socket は (a) にしない。
3. 時刻と port の照合: 環境側の記録の接続の時刻が、対応する `TCP_CONNECT` の始まりから終わりまでの区間の ±ε に入る（ε は観測の前に DD-1 の freeze 記録に書く）。net log の `TCP_CONNECT` の `local_address` と環境側の記録の両方に local の port があるときは、port の一致を**必ず**求める（測定では net log 側にあった。環境側にあるかは DD-1 の harness の記録の方法に依る）。
4. 内容は SOCKS5 の挨拶だけ（積極的な証拠を求める）: その `SOCKET` の source に、DD-1 の freeze 記録に書いた挨拶の書込みの event（測定では `SOCKS5_GREET_WRITE`）があり、host 名を運ぶ handshake の書込みの event（測定の名前は `SOCKS5_HANDSHAKE_WRITE`）がなく、挨拶への応答の読取が 0 byte で終わるか未完である。挨拶の書込みの event がない接続は、event の不在だけで挨拶だけとは読まず (a) にしない。capture の mode が送信の byte 数を記録するなら、挨拶の byte 数が freeze 記録に書いた長さ（測定では 3）以下であることも求める。環境側の記録が接続ごとの byte 数を持つなら、client から L への byte 数が同じ長さ以下で、L から client への byte 数が 0 であることも求める。
5. 起点が Chromium の network stack であることは、2 の net log との対応で示す。net log に対応のない L への接続は、起点を確かめられないので (a) にしない。

(a) は (b) の要求の一部として数える（批准 2）。(b) の要求を運ばない L への接続（ほかの URL の要求、net log に対応のない接続）は (a) にしない。

### LS-1 の port の同定

run ごとに、次の (L1)〜(L4) をすべて満たす port L を、その run の LS-1 の port とする。満たす L がない run には (a) を当てない（下の「分類の順序」の 1）。

- (L1) net log: その run の net log の `SOCKS5` の `proxy_info`（と `proxy_chain`）が、すべて同じ `127.0.0.1:L` を指す。自己確認の結果の event が net log に現れる場合も、それを含めて同じ L である。
- (L2) OS の socket 表の snapshot: harness が、NC-1 の起動の完了の後（最初の窓の読込みの後。LS-1 の listen は ready の後数 ms で、窓より前）で測る request（start の IPC）より前に 1 回（s1）と、Electron の process を終える直前に 1 回（s2）、Main が持つ TCP の LISTEN の socket を読む。s1 と s2 の両方で、Main が `127.0.0.1:L` を LISTEN している。
  - Main（browser process）の同定: harness が起動した process とその子孫のうち、実行 file が測る build の Electron の binary で、cmdline に `--type=` がない process がちょうど 1 つあるとき、それを Main とする。起動した process が wrapper（`scripts/local-ci-xvfb.mjs` の node、`unshare` など）でも、その pid を Main とみなさない。ちょうど 1 つでなければ snapshot は失敗とする。
  - 推奨の読み方: Main の `/proc/<Main の pid>/net/tcp`（Main の network namespace の表）の LISTEN（state `0A`）の行の inode と、`/proc/<Main の pid>/fd` の socket の inode の照合。LS-1 は `127.0.0.1` だけで listen するので IPv4 の表だけを照合に使うが、`/proc/<Main の pid>/net/tcp6` も読み、Main が持つ loopback（`::1`、`::ffff:127.0.0.1`）の LISTEN を (L3) の集合に入れる。file の読取だけで、subprocess を起動せず、どの port にも接続しない。方法と版は receipt に書く。
- (L3) s1 と s2 の両方で、Main の loopback の LISTEN の socket（IPv4 と IPv6）から harness が所有する port（CDP など。/2 の freeze 記録の一覧）を除いた集合が、ちょうど {L} である。
- (L4) L が、harness が所有する port の一覧、recorder の socket の port、DD-1 の freeze 記録の AI の送信先の一覧（旧 provider の既定の接続先を含む）のどれとも一致しない。一致したら、環境の偶然の衝突として、その run を harness の隔離の不備で無効にし、測り直す。

LS-1 は start が 1 回だけで再 bind せず、製品のコードから閉じないので、s1 と s2 で同じ L を Main が持てば、L は `setProxy` の時点の port と同じと読む（コードによる推定）。snapshot が取れなかった run（印がない run）は、記録を取っていない run として /2 のとおり無効にする。snapshot は取れたが (L1)〜(L3) のどれかが成り立たない run は、(a) を当てず、loopback の接続を /2 のとおり分類する（その run は DP-1 の証跡にならない）。stderr に NC-1 の固定コード（`NC-*`）が出た run は、その事実を receipt に書き、(a) と (b) を当てない。

### 件数の規則

- M_a = 1: (b) の要求 1 件が対応を持つ L への接続は、ちょうど 1 本（net log の `SOCKET` と環境側の記録の接続が 1 対 1）。2 本目以降は (a) にしない。根拠は既存の記録の `none` の 5 回と確認前の測定の 2 回（どれも要求 1 件、接続 1 本。scratch main）。
- 環境側と net log の過不足: 同じ run で、環境側の記録の `127.0.0.1:L` への接続の数が、net log の `127.0.0.1:L` への `TCP_CONNECT` の数より少なければ、記録の不備として、その run を記録を取っていない run と同じに無効にする。多ければ、対応のない接続は (a) にせず、それ以外に入れる。
- N_b: 1 つの Electron の process の run（/2 の run の区切り。起動から終了まで）の (b) の要求の件数は N_b 以下。N_b は、DD-1 の harness が fixture の材料を含まない診断の run（/2 の「観測前の固定」が認める診断 case。DD-1 と同じ build の作り方、起動の方法、環境、capture の mode）で観測した最大値とし、観測の前に DD-1 の freeze 記録に、診断の run の記録とともに書き、独立期待値 reviewer のレビューを受ける。診断の run は 5 回以上で、最短の run（測る request の直後に終える長さ）と、`diagLengthMs` の長さの run を含める。**N_b の上限は 3**（批准 4。初期案）。診断の最大値が 3 を超えたら `[precheck]` で止まる。推奨の見込みは 1（事実の観測。60 秒まで再試行なし）。N_b を超えた (b) の要求は、その要求と運んだ L への接続をそれ以外に入れる。
- `diagLengthMs`: 診断の run の長さ（Electron の process の起動から終了まで）の最大値。DD-1 の freeze 記録に書く。DD-1 の run（評価 build と参照 build）が `diagLengthMs` を超えたら、その run の (b) には N_b の根拠がないので、(b) にせず、その run を DP-1 の証跡にしない（測り直すなら `diagLengthMs` 以内の run で）。harness は観測の前に、DD-1 で予定する最も長い run を覆う値を選ぶ。
- (b) の要求が 0 件の run は、それだけで無効にも FAIL にもしない（期待された通信は起きることを求めない。/2 と同じ）。

### 分類の順序

/2 の分類の順序（まず net log の各要求、次に対応しない環境側の記録の件）に、次を挟む。

1. NC-1 の適用の確認: 起動の env に `ELECTRON_RENDERER_URL` がなく、stderr に `NC-*` がなく、L を同定できた run だけに 2〜4 を当てる。`ELECTRON_RENDERER_URL` のある run は /2 のまま分類して記録し、DP-1 の証跡にしない（批准 2）。
2. L を経由する net log の要求（`proxy_info` が `SOCKS5 127.0.0.1:L`）の接続先は、環境側の記録（`127.0.0.1:L` しか見えない）でなく、net log の URL の host と port で判定する。URL が AI の送信先（`ai-settings.json` の endpoint〔recorder を含む〕、旧 external／local の provider の既定の接続先）なら、/2 の規則で製品の送信の FAIL にする。fixture の材料が URL か request header にある要求も同じく FAIL にする。(b) は 2 の後に判定する。
3. net log の要求を (b) の型で判定し、N_b を当てる。(b) に合わない辞書の形の要求は、/2 の既存の辞書の型で分類する（/2 の型は変えない）。ただし、その要求が L へ接続していれば、その接続は (a) にならない（4）。
4. 環境側の記録の `127.0.0.1:L` への接続を、(b) の要求に M_a、ε、port の照合で対応づけ、(a) に合うものをその要求の一部として数える。残りは /3 の変える点 3 の文でそれ以外に入れる。
5. 自己確認の event（host 解決と proxy の解決）は、接続の試みでも wire の DNS でもないので分類しない（接続や DNS の問合せを伴えば、その接続と問合せは /2 のまま分類する）。
6. ほかは /2 のまま（recorder への接続の規則は、2〜4 より先に当てる /2 の順序を変えない）。

## threat model（GDX-PRECHECK-001）

security-sensitive な分類の緩和なので、確認されるまで draft とする（批准 9 で明示の確認を求める）。K6/2 の threat model（229、230、248、249 行と Mandatory defenses）への加算で、ほかは変えない。

- Trusted actors（加える）: OS の socket 表の snapshot の読取（harness が行い、読取だけで接続しない。結果は Main の pid、実行 file、LISTEN の port の組だけを receipt に書く）。LS-1（製品の Main の一部。K3/3 の確認済みの設計どおり、返事をせず、受けた bytes を捨てる。この評価は LS-1 の挙動を net log の SOCKS5 の段と環境側の byte 数でだけ確かめる）。置換版の fixture の作者と独立期待値 reviewer（「変える点」の 14 の分離を満たす者）。Main、OS、backend の侵害は /2 と同じく範囲外。
- Untrusted actors（/2 のとおりで、次を加える）: run の中で L に接続しうる、Chromium 以外の client（Native の client、Main の `globalThis.fetch`、harness と test の基盤の process）を、起点を確かめるまで信頼しない。Chromium の network stack を経由しても、(b) でない URL の要求は信頼しない。
- In-scope attacks（加える）:
  1. L への接続を、port の一致だけで (a) に数える（net log の (b) の要求との対応を見ない）。Native の回帰や harness の接続が L に向かっても、期待された通信に見える。
  2. (b) でない要求（Main が default session で `net.fetch` を使う回帰、renderer 由来の要求、別の file 名の `.bdic`）を運ぶ L への接続を (a) に数える。
  3. L を、harness の設定、Chromium の起動引数、net log だけ、または Main に入れた hook から同定し、Main が実際にその port を LISTEN していることを確かめない。別の process の port（harness の port、利用者の local の SOCKS5 の server）を LS-1 と取り違え、host 名が渡りうる接続を期待された通信にする。
  4. Main 以外の process（wrapper の node、`unshare`、Xvfb、`--type=` を持つ子の process）を Main とみなして snapshot を読む。
  5. Main が持つ別の loopback の listener（CDP、将来の listener）への接続を LS-1 への接続として数える。
  6. M_a を超える接続や N_b を超える要求を数え、`diagLengthMs` を超える run の (b) を数え、または観測の後に N_b、URL の集合、ε、event の指定を結果に合わせて広げる。
  7. 環境側の記録の欠け（net log より接続が少ない）を、対応づけの成功として扱う。時刻の幅を観測の後に決める、両方に local の port があるのに port を照合しない。
  8. host 名を運ぶ SOCKS5 の handshake がある接続、LS-1 が応答した接続、挨拶の書込みの event がない接続を、挨拶だけの接続として数える。
  9. L を経由した AI の送信先や fixture の材料の要求を、環境側の記録が `127.0.0.1:L` しか示さないことを理由に、(a) か loopback の一般の件として扱い、製品の送信の FAIL を逃す。
  10. loopback を記録と分類から外して L への接続を消す、L を harness が所有する port の一覧に入れて除く（/2 が禁じたまま）、`ELECTRON_RENDERER_URL` を置いて NC-1 を外した run を DP-1 の証跡にする。
  11. 版の番号の読み替えを使って、観測済みの材料を新しい版に持ち込む（版1 の logical ID や text を置換版か DD-1 の版で再利用する、frozen でない版1 を材料の検査の対象から外す）、または置換版の作者・reviewer を版1 や gate の実装者と兼ねる。
- Out-of-scope attacks（残余として加え、Session C-2 の提示に添える）:
  1. (a) の内容の確認は、net log の SOCKS5 の段の event（と capture の mode が記録する byte 数）と LS-1 のコード（返事をしない）に依る。環境側の記録が byte 数を持たない場合、wire の上の bytes そのものは確かめない。
  2. (b) が default session の要求であることは、`proxy_info` が NC-1 の proxy であることからの帰属（default session だけが `setProxy` を受けるコード）で、net log が session を名指すわけではない。
  3. 環境側の記録が local の port を持たない場合、net log の接続と環境側の記録の接続の 1 対 1 は、数と時刻（±ε）による対応づけで、同じ時刻に記録の欠けと Chromium 以外の client の接続が同数だけ重なると、取り違えを検出できない。
  4. NC-1 の下では、Chromium の network stack を経由する送信（default session の要求）はすべて L へ向かい、recorder にも旧 local provider にも届かない。その検出は net log の完全さ（すべての要求と URL が載ること）に依り、K6/2 の「recorder への接続」の規則（recorder が受けた接続を数える）はこの経路を見ない。
  5. NC-1 そのものの有効性（renderer の外向き通信が塞がること、辞書の要求が `setProxy` の後に出ること）は DD-1 で評価しない（K3/3 の G-open と G-pub の範囲）。DD-1 の run で辞書の要求が L を経由せずに現れても、/2 の辞書の型で分類し、その事実を receipt に書いて NC-1 の lane に申し送るだけで、この行の FAIL にしない。
- Mandatory defenses（加える）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」の全部と、「変える点」の 14 の材料と作者の規則。harness は run の間に L へ接続しない（snapshot は file の読取で行う）。(b) の URL の集合、終わり方の集合、N_b（3 以下）、`diagLengthMs`、ε、挨拶の長さ、event の指定、capture の mode、port の同定の方法は観測の前に DD-1 の freeze 記録に書き、独立期待値 reviewer のレビューを受ける。観測の後の変更は狭める方向だけ。DD-1 の harness の分類器は、「受入れ」の Negative の合成の記録で検出力を示してから使う。DD-1 の版の材料の検査は、過去の全版（frozen でない版を含む）の材料を対象にする。
- Acceptance implications: 「受入れ」の節。品質閾値（保持 100%、禁止情報 0、prose 非回帰、P-12 の 0→1）と「DP-1 の証跡にする run では期待された通信でない試みが 0 件」は変えない。変わるのは、(a)(b) に合う試みが「期待された通信」に入ること、DP-1 の証跡にする run を NC-1 を当てた起動に限ること、版の番号と引く先の読み替えだけ。
- owner／lifecycle: この draft は新しい外への通信、subprocess、背景の処理、async の lifecycle を加えない。足す観測（snapshot）は、DD-1 の harness が run ごとに 2 回行う同期の file の読取で、再試行しない。失敗は「印のない run」として無効になり、待ちを作らない。LS-1 の lifecycle は K3/3 と NC-1 の lane（DR-NC1-16）のまま。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| 2 項目の扱い（ユーザーが (A) を選んだ論点） | (A) K6 の /3 で、型と起点つきで期待された通信に加える（この draft） | freeze 記録に書くだけで足りるとする: /2 の 284 行と URL による照合（280 行）の文面と合わず、確認されていない読みで run を証跡にすることになる。loopback を記録と分類から外す: /2 が禁じている。L を harness が所有する port に入れる: 製品の listener で、対応づけなしに除くことになる |
| NC-1 のない起動 | DP-1 の証跡にする run を NC-1 を当てた起動に限る | NC-1 のない起動（`ELECTRON_RENDERER_URL`）も証跡にする: packaged の製品と違う構成を測り、dev server への loopback の接続が増え、(a)(b) の緩和の当て先が曖昧になる |
| port の同定 | net log（既存）と OS の socket 表の snapshot（追加の観測 1 種） | net log だけ: Main が port を持つことを記録で確かめられない。Main に hook を入れて port を読む: 評価専用の入口が Main に増える。listener の port を file や log に出す: 製品の変更で、この draft の範囲（NC-1 の挙動を変えない）を超える |
| 件数 | M_a = 1、N_b は診断の run から freeze 記録に書き上限 3、観測の後は狭める方向だけ | N_b = 1 に固定: より厳しいが、実アプリと DD-1 の長さでの再試行は未検証で、起きれば DD-1 が再び構造的に通らず /4 が要る。freeze 記録だけに委ねる（上限なし）: 繰り返す要求の回帰を診断の結果に合わせて受け入れうる。件数を置かず 1 対 1 だけにする: 繰り返す要求の回帰を見逃す。/2 は `github.com` で試みの数に上限を置く案を採らなかった（DNS の問合せの数が resolver に依るため）が、(b) は net log の URL の要求の単位で数え、観測の範囲では 1 件で決定的だった |
| 版の番号 | DP-H の置換版を版2、DD-1 の版を版3 と読み、版の規則はそのまま当てる | DD-1 の版を版2 のまま置き、置換版を別の名前（版1b など）にする: 253 行の「版N+1 は版N を引く」の鎖から置換版が外れ、DD-1 の版が引く先が失効した版1 になる。版3以降の相対の規則で黙って読む: 確認済みの文言（「DD-1 で足す版2」）から逸脱する |

## 受入れ（DD-1 の分類）

番号は K6/2 と K3 の (n) と衝突しないよう `K6/3-` を付ける。DD-1 の harness の分類器は、合成の記録（実 run の記録を複製して接続や event を書き加え、または取り除いたもの。K3/3 の `ll-synthetic-leaks` と同じ考え方）で、Negative のそれぞれを期待どおりに分けることを、DD-1 の freeze の前に示して記録する。

receipt に加えるもの（各 run）: NC-1 の適用（env の `ELECTRON_RENDERER_URL` の有無、stderr の `NC-*` の有無）、net log の capture の mode、Main の pid と実行 file とその同定、snapshot s1 と s2（時刻、Main の loopback の LISTEN の port の一覧、方法と版）、同定した L（または同定できなかった理由）、(b) の要求の一覧（URL、開始の時刻、`proxy_info`、終わり方）、(a) の接続の一覧（環境側の時刻と local の port、対応する net log の `SOCKET` と (b) の要求、挨拶の event と byte 数）、N_b と M_a と `diagLengthMs` に対する件数と run の長さ、対応づけの過不足、run が使う版と、その版が引く freeze 記録の commit と sha256。

Positive:

- K6/3-P1: NC-1 を当てた run で、L を (L1)〜(L4) で同定でき、(b) の要求が 1 件（freeze 記録の URL、GET、upload なし、`proxy_info` が `SOCKS5 127.0.0.1:L`、freeze 記録の終わり方、`Dictionaries/` が空）、それに対応する L への接続が 1 本（挨拶の書込みの event あり、handshake の書込みなし、ε と port の照合が合う）。(a)(b) は期待された通信として件数と接続先と起点を receipt に書くだけで、その run を無効にも FAIL にもしない。
- K6/3-P2: NC-1 を当てた run で (b) の要求も L への接続も 0。期待された通信なしとして扱い、それだけで無効にしない。
- K6/3-P3: (b) の要求が未完のまま process の終了で打ち切られた run（終わり方の集合に「未完」がある場合）。ほかの条件が P1 と同じなら (a)(b) として数える。

Negative（どれも、その試みを期待された通信にしない。それ以外の内訳〔製品の FAIL、無効、台帳の不備〕は /2 の規則のまま）:

- K6/3-N1: net log に対応のない L への接続（Chromium 以外の client、harness の接続）。
- K6/3-N2: (b) でない URL の要求（Main の `net.fetch` の default session の要求、別の file 名の `.bdic`、query つき、`rr*.gvt1.com` など）を運ぶ L への接続。
- K6/3-N3: 1 件の (b) の要求に対応する 2 本目の L への接続（M_a の超過）。
- K6/3-N4: N_b を超えた (b) の要求と、それが運んだ接続。
- K6/3-N5: snapshot で Main が L を LISTEN していない、s1 と s2 で L が違う、Main の loopback の LISTEN に harness の一覧にない別の port がある、net log の `SOCKS5` の `proxy_info` に 2 つ以上の port がある。(a) を当てない。
- K6/3-N6: snapshot の印がない run、Main をちょうど 1 つに同定できない run（記録を取っていない run として無効）。
- K6/3-N7: host 名を運ぶ SOCKS5 の handshake の書込みがある接続、挨拶への応答の読取が bytes を受けた接続、byte 数が挨拶の長さを超えるか L からの byte がある接続。
- K6/3-N8: 辞書の形の要求の `proxy_info` が別の loopback の port か `PROXY` を指し、その port への接続を伴うもの（その接続はそれ以外）。
- K6/3-N9: `Dictionaries/` に file がある run（(b) にしない。/2 の「外へ到達した証跡」でもある）。
- K6/3-N10: L が harness の port、recorder の port、AI の送信先の一覧と一致する run（harness の隔離の不備として無効、測り直す）。
- K6/3-N11: (b) の URL か request header に fixture の材料の文字列がある要求（/2 のとおり製品の送信の FAIL。(b) の判定より先）。
- K6/3-N12: 環境側の記録の L への接続が net log の `TCP_CONNECT` より少ない run（記録の不備として無効）。
- K6/3-N13: harness が run の間に L へ接続した run（harness の隔離の不備として無効）。
- K6/3-N14: 観測の後に、狭める方向でない変更（N_b、URL の集合、ε、終わり方、event の指定、port の同定の方法を広げる）か、診断の記録・独立期待値 reviewer のレビュー・新しい版の freeze 記録のない変更をした receipt（DP-1 の証跡にしない）。
- K6/3-N15: 環境側の記録の `redirector.gvt1.com` の DNS の問合せ（(b) の一部にしない。/2 の DNS だけの件の規則で、それ以外のまま）。
- K6/3-N16: 合成の記録で、(b) の要求に対応する `SOCKET` の source から SOCKS5 の段の event（挨拶の書込みを含む）を取り除いたもの（挨拶の積極的な証拠がないので (a) にしない）。
- K6/3-N17: URL が AI の送信先（recorder の endpoint、旧 local provider の既定の port）で、`proxy_info` が `SOCKS5 127.0.0.1:L` の要求（L を経由した AI の送信先への試みとして製品の送信の FAIL）。
- K6/3-N18: `diagLengthMs` を超えた run の (b) の要求（(b) にせず、その run を DP-1 の証跡にしない）。
- K6/3-N19: `ELECTRON_RENDERER_URL` のある run（(a)(b) を当てず、DP-1 の証跡にしない）。環境側の時刻が ±ε に入らない接続と、両方に local の port があって一致しない接続も (a) にしない（同じ番号で試験する）。
- K6/3-N20: 版の規則の違反（DD-1 の版が置換版の freeze 記録以外を引く、引く先の commit か file の sha256 が一致しない、置換版が失効した版1 を `supersedes` で引かない、DD-1 の版か置換版の材料が過去のどれかの版〔frozen でない版1 を含む〕の logical ID か text と重なる）。harness は実行しない（/2 の 253 行の扱いと同じ）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| DD-1 | 分類器、snapshot と browser process の同定、対応づけ（両向きの推移的閉包、ε、port の照合）、診断の run と N_b・`diagLengthMs`、合成の記録による検出力、receipt の欄、DD-1 の版（版3）が置換版の freeze 記録を引く検査、過去の全版の材料を避ける検査、/3 を受ける validator を実装する。H4 による着手の保留は、この draft の確認で解ける（確認されなければ保留のまま） |
| DP-H | 置換版を版2 として作る前提になる（別 lane の実装）。置換版は K6/3 の確認の後に置く。版1 の記録は /2 のまま（「引き継ぐもの」の 1） |
| PUB-L（Session C-2 の提示） | Out-of-scope attacks の 1〜5 と、DD-1 の (a)(b) の件数を開示に添える |
| NC-1／DA-1／CP-2b（K3/3） | 影響しない。DD-1 で辞書の要求が L を経由しなかった run は事実として申し送る（判定は K3/3 の G-open と G-pub） |
| CP-4、`g01-eval-revision`、`graph-eval-procedure` | 影響しない |

## 未確認と未検証

- 実アプリの起動（`initBackend` と製品の窓を含む）、DD-1 の環境の長さ（60 秒を超える run）での辞書の要求の再試行と、N_b の値。DD-1 の環境の locale での辞書の URL。
- `--net-log-capture-mode=Everything` 以外の mode で、SOCKS5 の段の event、`SOCKET_BYTES_SENT` の byte 数、`TCP_CONNECT` の `local_address` が載るか。
- 環境側の記録が接続ごとの local の port と byte 数を持つか（DD-1 の harness の記録の方法に依る）。
- 確認前の測定は scratch main の 2 回で、記録は commit していない。DD-1 の診断の run で取り直す。
- DD-1 の環境で `/proc/<Main の pid>/net/tcp` と `/proc/<Main の pid>/fd` が読めること（測定では同じ user の process として `/proc/net/tcp` と各 process の `fd` が読めた。`/proc/<Main の pid>/net/tcp` を Main の pid で読む形は試していない）。同じ OS ユーザーの別の process が、Main が持つ `127.0.0.1:L` を同時に bind できないこと（Node の既定の listen と Linux の bind の規則からの推定）。
- updater の session が非 packaged で作られないこと（コードの読取と、測定の run で辞書の要求が 1 件だったことだけ）。
- Linux 以外での DD-1（K6/2 は OS を固定していない。この draft の snapshot の推奨の方法は Linux のもの。ほかの OS では同等の読取の方法を DD-1 の harness が定め、版を receipt に書く。方法がなければ (a) を当てない）。

## 引き継ぎ（DD-1 と DP-H の lane への申し送り。この確認の条件ではない）

- D1 診断の run を最初に取る: fixture の材料を含まない材料で、DD-1 と同じ build、起動、環境、capture の mode で、最短の run と `diagLengthMs` の run を含めて 5 回以上取り、(b) の URL の集合、終わり方、event の名前と params、挨拶の長さ、N_b を観測し、DD-1 の freeze 記録に書く。N_b が 3 を超える、M_a が 1 にならない、挨拶の書込みの event が現れない、のどれかなら、型を広げずに `[precheck]` で止め、K6 の新しい draftRef を求める。
- D2 snapshot と browser process の同定: Linux では `/proc/<Main の pid>/net/tcp`、`tcp6`、`fd` の読取（subprocess なし）を推奨。CDP などの harness の port を DD-1 の freeze 記録の一覧に書き、(L3) で使う。
- D3 起動: DP-1 の証跡にする run は `ELECTRON_RENDERER_URL` を置かない（NC-1 を当てる）起動に限る（批准 2）。置いた run は記録と分類だけを行う。
- D4 合成の記録: K6/3-N1〜N20 を検出することを、分類器の試験で固定する。
- D5 辞書の要求が L を経由しなかった run、`NC-*` が出た run は、NC-1 の lane（DA-1／CP-2b）へ事実を渡す。
- D6 validator: 新しい版（置換版と DD-1 の版）の記録だけ `nir1-final-request-eval-proposal/3` を受け、版1 の記録は /2 のまま照合する（「引き継ぐもの」の 1、2）。
- D7 DP-H の置換版: K6/3 が確認されるまで置換 fixture は置かない運用とする（integrator の運用）。置くときは「変える点」の 14 の `supersedes`、新しい材料、作者と reviewer の分離に従う。

## 確認の扱い

- 確認は末尾の「確認文」の 1 文で行う（台帳の Confirmation protocol。`draftRef` と 1 つの `contractId` を名指す 1 文）。1 文で確認されるのはこの contractId の行の、冒頭の 1〜9 だけで、依存する契約（K3/3 を含む）と K6/2 の条件付きの 2 行は確認されない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答、2026-10-25 の「Aで」は、確認として扱わない。
- 確認されたら、K6/2 の 147 行の規則で /3 の行が K6/2 の行を全体として supersede する。内容は「引き継ぐもの」のとおりで、K6/2 の確認の記録と行は消さない。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の取り込みの表（K3/3 の B3-1 の表と同じ形）: 受信の日時、確認された版（commit）、取り込んだ draft の SHA-256、確認文の逐語を、新しい補足の段落と表の行（例: `| B4-1 | nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval（K6/3。K6/2 と同じ contractId の新しい draftRef） | [nir1-final-request-eval-proposal-3-draft.md](nir1-final-request-eval-proposal-3-draft.md) | <SHA-256> |`）に書く。「1 文の範囲」の段落（この文は draft 冒頭の 1〜9 だけを批准する。範囲の正本はその一覧）と、「K6/3 が許さないもの」の段落（批准 8 と、DD-1 の実装と実行、DP-H の置換版の作成、DD-1 の DP-1 の PASS、PUB-L はこの確認で行っていないこと）を足す。
- 確認台帳の行: K6/2 の行（191 行）を残し、その下に行を足す。列は 191 行と同じ（contractId、draftRef、confirmedRef、confirmedScope、remainingDelta、affectedLanes、startStatus、blockedReason、unblockingEvidence）。
  - draftRef `nir1-final-request-eval-proposal/3`、confirmedRef `nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval`。
  - confirmedScope 案: 「K6/3 の範囲: draft 冒頭の『ユーザーが批准すること』の 1〜9 の全項目（この一覧が範囲の正本で、台帳は別の列挙を持たない）。DD-1 の『接続の試みの分類』に、K3/3 が『続く通信』に加えた (a) Chromium（default session）から LS-1 への接続と (b) blackhole された辞書の要求の試みを、型と起点つきで期待された通信として加える（(a) は (b) を運ぶ接続に限る。M_a = 1、N_b は DD-1 の freeze 記録に書き 3 以下、観測の後は狭める方向だけ。LS-1 の port は net log と OS の socket 表の snapshot で同定する。DP-1 の証跡にする run は NC-1 を当てた起動に限る）。DP-H の版1 が失効した場合、置換版を版2、DD-1 の版を版3 と読む（命名と引く先だけ）。threat model の 6 要素と受入れを含む。**K6/2 の文面より弱い読み**（『変える点』の 1〜4）。K6/2 のほかの全部は変えず、/3 が引き継ぐ（DP-H の版1 の記録は /2 のまま）。`g01-eval-revision`、`graph-eval-procedure`、K3/3 を含む依存する契約は確認しない」。
  - remainingDelta: 「none — 差分は確認済み。DD-1 の harness の実装（分類器、snapshot、対応づけ、診断の run と N_b、合成の記録、版の検査、/3 を受ける validator）と受入れは DD-1 に、置換版の作成は DP-H に残る」。
  - affectedLanes: 「DP-H（置換版の命名）、DD-1、PUB-L（Session C-2 の提示）」。
  - startStatus: 「ready-after-normal-dependencies（K6/2 の行のまま）」。
  - blockedReason: 「none — explicit user confirmation recorded. DD-1 の H4 による保留は解け、DP-H は置換版を置ける。DD-1 と PUB-L は K6/2 の行と同じ通常の依存が要る」。
  - unblockingEvidence（191 行と同じく最後の列に確認の証跡を置く）: confirmedRef、exact statement、確認の日時（JST）、draft の commit と SHA-256、「this independently ratifies only this row; per K6/2's own rule (line 147) it supersedes the K6/2 row as a whole, with content equal to K6/2 plus the /3 delta; the K6/2 ref is kept as history」。
- 台帳の注記: K6/2 の 2026-10-17 の注（206 行）の下に、/3 の「変える点」の 1〜14 を読み替えとして足し、1〜4 が K6/2 の文面より弱い読みであること、14 が版の命名と引く先の読み替えであることを書く（先の注は消さない）。K3/3 の行（187 行）の備考「DD-1 は K6 の確認者への照会まで着手を保留する」と lane snapshot の DD-1 の行（544 行）に、H4 が `nir1-final-request-eval-proposal/3` の確認で解けたことを注記する（K3/3 の bytes と行の確認範囲は変えない）。lane snapshot の DP-H の行（545 行）に、置換版を版2 として置けることを注記する。
- 続行計画（`docs/plans/nir1-continuation-2026-10.md`）: §1 に「Aで」（2026-10-25）の逐語と出所を記録する。§4 のレーン表の DD-1 の行（154 行）と §10.5 の表の DD-1 の行（494 行）の保留の注記、§11 の H4 の項（510 行）を解決済みにし、確認の記録を §10 に足す。
- DD-1 と DP-H の TASK（K6/2 の「確認後の記録」の DP-H と DD-1 の TASK の項に足す）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」、receipt に加えるもの、K6/3-P1〜P3 と K6/3-N1〜N20、「変える点」の 14 の版の規則、引き継ぎの D1〜D7 を写す。
- 確認されなければ、DD-1 は H4 の保留のまま着手せず、DP-H の置換版も置かない。別の案を選ぶ場合は /4 で起案する。

## 確認文

contractId の選択: **`nir1-final-request-packing-eval`**（K6/2 と同じ）。

- 理由: (1) この差分は、K6/2 が確認した `nir1-final-request-packing-eval` の行の一部（DD-1 の接続の試みの分類と、版の命名）を読み替える改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) 前例は `nir1-l6-l9-contract-proposal/7`（確認済みの /6 の値を同じ contractId の新しい draftRef で改訂し、/6 の確認を履歴として残した形）。K6/2 の 147 行の規則により /3 は K6/2 の行を全体として supersede し、引き継ぐものは本文の「引き継ぐもの」に書いた。(4) 確認は contractId ごとの 1 文（台帳の Confirmation protocol）。

確認は次の 1 文で行う（空白を含め一字違わない。ユーザー自身が打ったときだけ有効）。

- I confirm draftRef nir1-final-request-eval-proposal/3 for contractId nir1-final-request-packing-eval.
