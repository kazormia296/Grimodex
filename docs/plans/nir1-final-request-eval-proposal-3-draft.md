# NIR-1 最終 request 評価の契約提案 proposal/3（draft）: DD-1 の接続の試みの分類に、NC-1 が加えた 2 項目（LS-1 への接続と blackhole された辞書の要求）を型と起点つきで加える

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## ユーザーが批准すること

末尾の確認文 1 文で批准するのは、次の 7 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、「前書き」「範囲」「確認後の記録」の台帳の `confirmedScope` はこの一覧を指すだけで、別の列挙を持たない。一覧にないものは批准しない。数値と根拠は各節に 1 回だけ書き、ここには再掲しない。

1. 加えるもの: K6/2 の DD-1 の「接続の試みの分類」の期待された通信に、K3/3（`nir1-d2a-activation-proposal/3#caller-profile-egress`。確認済み）が「続く通信」に加えた 2 項目を、この draft の「型の定義」の型と起点つきで加える。(a) Chromium（default session）から LS-1（Main の process が持つ `127.0.0.1` の blackhole の listener）への接続、(b) blackhole された辞書の要求の試み。
2. 加え方の制約: (a) は (b) の要求を運ぶ接続としてだけ期待された通信になり、(b) の要求の一部として数える（別の件にしない）。(b) の要求を運ばない LS-1 への接続、型に合わない接続、件数の規則を超える接続は、従来どおり「それ以外」に入れる（「件数の規則」「分類の順序」）。
3. LS-1 の port の同定: run の net log の `proxy_info` と、harness が取る OS の socket 表の snapshot（この draft が DD-1 に足す唯一の観測。読取だけで接続しない）の両方で同定する。同定できない run には (a) を当てない（「LS-1 の port の同定」）。
4. 件数の規則: (b) の要求 1 件が運ぶ LS-1 への接続は 1 本ちょうど（M_a = 1。この draft で固定）。(b) の要求の件数の上限 N_b は、fixture の材料を含まない診断の run の観測から、観測の前に版2の freeze 記録に書く（観測の後に変えるときは K6/2 の「観測の後に型を足せる」規則と同じ証拠と手順を要する）。
5. これが合格基準の緩和に当たること: /2 の文面のままでは、NC-1 を含む build の DD-1 の run は、LS-1 への接続が毎回記録されるので、すべて「一覧にない製品の通信」になり、DP-1 を PASS にできない。/3 は、上の型に合う接続に限ってその run を証跡にしてよいとする。**/2 の文面より弱い読み**であり、弱める範囲は 1〜4 の型と件数に限る。残る誤分類の余地は threat model の Out-of-scope attacks と「未確認と未検証」に書く。
6. 変えないもの: /2 のほかの全部（「前書き」の「変えないもの」の列挙）。loopback を記録と分類から外さない（/2 が禁じたまま）。recorder への接続の規則、AI の送信先の規則、`github.com` の分類の限界、意味モデルのない初回起動の状態、P の Gold と固定値、事前登録の凍結の規則、失効率の物差し、AI 使用ポリシーを書かない setup は変えない。
7. 許さないもの: DD-1 の実装と実行そのもの、NC-1 の挙動の変更、新しい authority・保存先・送信先・製品の入口・評価専用の入口、Graph と local 送信の公開、Session C-2 の承認。依存する契約（K3/3 を含む）と、K6/2 の条件付きの 2 行（`g01-eval-revision`、`graph-eval-procedure`）は確認しない。

注記（批准の対象ではない）: 2026-10-25 にユーザーが選んだ (A)（「Aで」）は、この draft を起案する指示で、確認文ではない。この起案は選択肢の逐語の質問文を見ておらず、integrator の伝聞による。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/3` |
| contractId | `nir1-final-request-packing-eval`（K6/2 と同じ。選んだ理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `7af0be93`（#707）。この draft の行番号（K6/2 の本文、`electron/main`、`electron/scripts`、台帳 `docs/plans/nir1-l6-l9-execution-plan.md`）は `7af0be93` で確かめた。K6/2 の bytes の SHA-256 は `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8`、K3/3 は `e5362f3e40e662781d57c46d20db617aded3c7d4cf72912c0d27991b0dbded11` で、どちらも台帳の値と一致することを再計算して確かめた |
| 確認済み baseline | `nir1-final-request-eval-proposal/2#nir1-final-request-packing-eval`（K6/2。2026-10-17 の Session B1 で確認。commit `af643a93`）。台帳の 2026-10-23 の注記（K6/2 の「確認後の記録」への DI-1a の注記。台帳 558 行）を含む。K6/2 の bytes は変えない（この draft は別のファイル） |
| 前提 | K3/3 は 2026-10-18 の Session B3 で確認され（台帳 187 行）、NC-1／LS-1 は #683 で master にある（`electron/main/rendererContainment*.ts`）。K3/3 の引き継ぎ H4 は、K6/2 の分類がこの 2 項目と両立するかを K6 の確認者の判断に残し、台帳の lane snapshot（544 行）は DD-1 をその判断まで着手しないとしている。DD-1 の harness（評価の Electron の起動と接続の試みの記録・分類）は `7af0be93` に無い（未実装。`scripts/quality/nir1-packing/final-request/` は DP-H の scorer と receipt で、接続の試みを扱わない） |
| 確認を求めるもの | 冒頭の「ユーザーが批准すること」の 1〜7（範囲の正本。ここに別の列挙を置かない） |
| 変えないもの | K6/2 のほかの全部。P の Gold（12 task、保持 100%、禁止情報 0、prose 非回帰）、P-12 の slot と 0→1、P の固定値（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）、既存の 24 件、G-01 の v1、G-02〜G-08、IR の floor、K1 の値と規則、Packing の 2 MiB と 512 items、AttemptBinding の 64 KiB、事前登録の凍結の規則、失効率の物差し（1%）、AI 使用ポリシーを書かない setup、recorder への接続の規則（run の全体で 1 本）、AI の送信先の規則、Chromium の network stack を通らない試みの規則と `github.com` の限界、意味モデルのない初回起動の状態、既存の型（spellchecker の辞書ファイルの取得の型を含む）。新しい authority・保存先・送信先・製品の入口は加えない |

## 変える点（K6/2 との関係）

この /3 は K6/2 の本文を引き継ぎ、次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。K6/2 の「確認の扱い」の規則（同じ contractId の後続の draftRef が確認されると、先行の行を全体として supersede し、後続は引き継ぐものを本文に書く）により、/3 が確認されたときの `nir1-final-request-packing-eval` の内容は「K6/2 の全文に、この表を当てたもの」である。K3/3 が K3/2 に加算した形（K3/3 の「変える点」）と同じく、加算で /2 のほかの文を弱めない。**#1〜#4 は /2 の文面より弱い読み**（批准 5）、ほかは具体化か、弱い読みを狭める防御である。

| # | 箇所（K6/2 の行） | /2 の文 | /3 の文 | 理由 |
| - | ---------------- | ------- | ------- | ---- |
| 1 | 「接続の試みの分類（DD-1）」の前置きの一覧（279 行） | 期待された通信は、K3 の確認済みの開示の「続く通信」の一覧（起案時点の K3/2 では、license の確認、更新の確認と download、意味モデルの download、IME 辞書の download、spellchecker の辞書ファイルの取得）の項目への試みのうち、記録から型と起点を確かめられたものだけ | 一覧に、K3/3 が加えた (a) LS-1 への接続と (b) blackhole された辞書の要求の試みを加える。型と起点はこの draft の「型の定義」による。ほかの項目の型と起点は /2 のまま | K3/3 の「変える点」9 が一覧に 2 項目を加えた。/2 の K3/2 への前提の 6（119 行）は「K3 が確認で一覧を変えるなら、期待された通信の一覧と起点も確認済みの開示と台帳に合わせる」とするが、下の #3 の文と URL による型の照合（280 行）が LS-1 への接続を扱えないので、文で定める（K3/3 の H4） |
| 2 | 同じ前置きの対応づけ（279 行） | 環境側の記録の件のうち、net log の期待された通信の要求に対応するもの（同じ host で、要求の開始以後）は、その要求の一部として数え、別の件にしない | 加えて、環境側の記録の LS-1 への接続のうち、「型の定義」の (a) に合い、net log の (b) の要求に「件数の規則」のとおり対応するものは、その (b) の要求の一部として数え、別の件にしない | LS-1 への接続は SOCKS5 の挨拶だけで host を運ばず、環境側の記録では `127.0.0.1:<port>` にしか見えないので、「同じ host」で対応づけられない |
| 3 | 「期待された通信は…」の loopback の文（284 行） | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本を除く）は、一覧に項目がないので、すべてそれ以外に入れる | loopback の接続の試み（harness が所有する port と、上の「recorder への接続」の測る request の 1 本と、#2 で (b) の要求の一部として数えた LS-1 への接続を除く）は、一覧に項目がないので、すべてそれ以外に入れる | 除くのは #2 に当たる接続だけ。LS-1 の port への接続でも #2 に当たらないものは、それ以外のまま |
| 4 | 「Chromium の network stack を通る試み」の後（280 行の次） | （なし） | 新しい項「NC-1 の下の LS-1 への接続と辞書の要求（K3/3 の (a)(b)）」を置き、この draft の「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」を本文とする | 型を URL でなく net log の `proxy_info` と socket の段で定義するため（K3/3 の H4） |
| 5 | 「観測の後に型を足せるのは…」（285 行） | 型を足せるのは同じ帰属の証拠があるときだけ。足すときは失敗の記録を残し、独立期待値 reviewer の確認のうえ新しい版の freeze 記録で足す | 同じ規則を、(b) の URL の集合、N_b、net log の event の名前と params の指定、port の同定の方法を変えるときにも当てる。M_a はこの draft で固定し、freeze 記録で変えない | 観測の後に件数や型を結果に合わせて広げないため |
| 6 | 「接続の試みの記録」（277 行） | 記録は Chromium の net log、遮断の環境側の記録、IPC の trace から書く。記録の仕組みが動いた印も書く | 加えて、LS-1 の port の同定のための OS の socket 表の snapshot（s1、s2）と、その印（取得の時刻と成否）を書く。印のない run は記録を取っていない run として扱う | 「LS-1 の port の同定」の (P2) |
| 7 | Trusted actors（229 行） | DD-1 の接続の試みの記録（net log、遮断の環境側の記録、IPC の trace の観測器） | 加えて、OS の socket 表の snapshot の読取（harness が行う。接続しない）。LS-1 は製品の Main の一部で、K3/3 の確認済みの設計（返事をしない、受けた bytes を捨てる）として扱う | threat model |
| 8 | In-scope attacks の「DD-1 の外への通信」（248 行） | （下の threat model の In-scope attacks の各項は無い） | threat model の In-scope attacks の 1〜9 を加える | 緩和の悪用を拒否する |
| 9 | Out-of-scope attacks（249 行） | （LS-1 の残余は無い） | threat model の Out-of-scope attacks の 1〜4 を残余として加え、Session C-2 の提示に添える | 誤分類の余地を開示する |
| 10 | Acceptance implications（288 行） | DD-1 の各 run の receipt の項目と、「DP-1 の証跡にする run では期待された通信でない試みが 0 件」 | receipt の項目に「receipt に加えるもの」を足し、この draft の「受入れ」の K6/3-P1〜P3、K6/3-N1〜N15 を加える。「期待された通信でない試みが 0 件」は変えない | 受入れ |
| 11 | 失効（310 行） | 外への通信の遮断と接続の試みの記録の方法（…）、期待された通信の型と起点（版2の freeze 記録） | 記録の方法に「LS-1 の port の同定の方法（OS の socket 表の snapshot の取り方）」を、版2の freeze 記録の内容に「(b) の URL の集合、N_b とその診断の run の記録、net log の event の名前と params の指定」を加える | NC-1 の実装の変更は /2 の「候補の head と tree」で失効する（足さない） |
| 12 | 「選択肢と推奨」の表の「DD-1 の外への通信の遮断と接続の試みの記録」の行（507 行） | （LS-1 の論点は無い） | この draft の「選択肢と推奨」の 3 行を加える | 選択の記録 |
| 13 | 「確認後の記録」の DD-1 の TASK（781 行） | 外への通信の遮断と接続の試みの記録・分類を写す | 加えて「確認後の記録」の DD-1 の TASK の項を写す | 実装は DD-1 の lane |

## 事実

コードは `7af0be93`、記録は master にある測定の記録で確かめた。記録にないものは「未検証」と書く。

- LS-1 の実装: `net.createServer` を `127.0.0.1`、port 0（ephemeral）で listen する（`electron/main/rendererContainmentListener.ts:30`、114）。受けた socket は `resume()` で読み捨て、`data` の listener を付けず、書き込まない（:95-96）。同時 256 を超える接続は受けた直後に破棄し、1 接続の保持は 5 秒以下（:25、28、81-90）。start は 1 回だけで再 bind しない（:63-66）。製品のコードは listener を閉じない。port は orchestrator が `buildProxyConfig(listenerPort)` で default session の `setProxy` に渡すだけで（`electron/main/rendererContainmentStartup.ts:300`、310）、file や log には書かない（固定コードの出力は port を含まない。`nc1-decisions.md` の DR-NC1-4）。
- `electron/main` と `electron/preload` の試験でない file で `.listen(` か `createServer` を持つのは `rendererContainmentListener.ts` だけ（`7af0be93` を検索。Negative (31) の静的な検査も `.listen(` を NC-1 の listener の file に限る。DR-NC1-2）。
- NC-1 の適用: `shouldRegisterAppProtocol()` が true の起動だけ（`electron/main/index.ts:244-246`。非 packaged で `ELECTRON_RENDERER_URL` がある起動は除く。`electron/main/devRendererUrl.ts:61-66`）。DD-1 は非 packaged の Electron で .node を読む（K6/2 の「評価専用の呼び出し口」）ので、`ELECTRON_RENDERER_URL` がなければ NC-1 が当たる。
- updater: 非 packaged では無効で（`electron/main/updater.ts:89-97`）、electron-updater の singleton にも触れない（:198-205）。K3/3 が書く updater の session（partition `electron-updater`）の辞書の要求は、その session が最初の request で作られるので（K3/3 の「開示に無かったこと」の 1）、DD-1 では起きない見込み（コードの読取による。実 run は未検証）。macOS の electron-updater の loopback listener（K3/3 の影響表 8）も DD-1 の範囲外。
- 辞書の要求の観測（`docs/plans/nir1-lane-decisions/nc1-g-open/nc1-order-product-nc1-{none,ip,localhost}.json`。製品の orchestrator を `index.ts` と同じ順序で呼ぶ scratch main、Linux、Electron 43.8.3、窓の作成後 9 秒の観測〔`electron/scripts/webrtc-block-probe-order-main.cjs:87`、152。runner は `ORD_WAIT` を渡さない〕、5 回 × 3 環境）: 15／15 回で、辞書の要求は 1 件（URL `https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`）、その `proxy_info` は `SOCKS5 127.0.0.1:<その run の LS-1 の port>`、net error は -120（`ERR_SOCKS_CONNECTION_FAILED`）、blackhole の listener への接続は run の全体で 1 本、`Dictionaries/` は空だった。`initBackend` と製品の窓を含む実アプリの起動、9 秒より長い run、別の locale は観測していない（未検証）。
- net log の読み方: probe は `PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST` の event の `proxy_info` を、要求の source とその依存の source に帰属させて読む（`electron/scripts/webrtc-block-probe-order.mjs:61-69`）。要求ごとの `proxy_info` と net error は、K6/2 が既に取る net log から読める。SOCKS5 の段（挨拶の書込みと読取、host 名を運ぶ handshake）の event の名前と params、TCP の接続の event に local の port が載るかは、この起案では確かめていない（未検証）。
- 挨拶の内容: K3/3 の測定の記録の `proxyHeads` は、listener に届いた bytes を印字可能な文字に置き換えたもので（`electron/scripts/webrtc-block-probe.mjs:511`）、印字不能の数 byte だった（K3/3 の「SOCKS5 を選ぶ理由」）。byte の値そのものは記録にない（未検証）。
- /2 の既存の観測手段で足りない点: net log の `proxy_info` は Chromium がどの port へ向かったかを示すが、その port を持つのが Main の LS-1 であることは示さない。/2 は起動に proxy を置かないこと（env と起動引数の記録）を求めるので、`SOCKS5 127.0.0.1:<port>` の出所が NC-1 の `setProxy` だけであることはコードから推定できるが、記録では確かめられない。そこで、OS の socket 表の snapshot を 1 種だけ足す（「LS-1 の port の同定」）。

## 設計

### 型の定義

(b) blackhole された辞書の要求の試み（Chromium の network stack を通る。起点は default session の spellchecker）。net log の 1 つの要求で、次をすべて満たすもの。

1. method が GET で、upload（request の body）がない（/2 の辞書の型と同じ）。
2. URL が、版2の freeze 記録に書いた exact な URL の集合のどれかと一致する（scheme・host・path・query を含めて完全一致）。集合は、K3/3 の型（`redirector.gvt1.com` の `/edgedl/chrome/dict/` の下の `.bdic`）に合う URL だけからなり、fixture の材料を含まない診断の run で観測した URL を書く（推奨の初期値は、上の事実の `https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` の 1 件）。K3/3 の型より狭い（file 名を固定する）。
3. その要求の `proxy_info` が、すべて `SOCKS5 127.0.0.1:P`（P は下の「LS-1 の port の同定」で同定した port）で、ほかの値（`DIRECT`、別の port、`PROXY` など）を含まない。default session だけが NC-1 の `setProxy` を受けるので、これが default session の要求であることの記録上の根拠になる（session の名前は net log に現れない。コードによる帰属）。
4. 要求が error で終わり（net error は、診断の run で観測した値を版2の freeze 記録に書く。観測した値は -120）、redirect の連鎖がなく、応答の body を受けていない。
5. run の終わりに、profile の `Dictionaries/` に file がない（取得 0。/2 の「外へ到達していない証跡」と同じ確認）。
6. URL と request header に fixture の材料の文字列がない（/2 の規則。これに当たれば製品の送信の FAIL で、(b) にしない）。

(a) Chromium（default session）から LS-1 への接続（起点は (b) の要求を処理する Chromium の network stack）。環境側の記録の 1 本の TCP の接続の試みで、次をすべて満たすもの。

1. 接続先が `127.0.0.1:P`（P は同定した LS-1 の port）。
2. net log で、ある (b) の要求の source（とその依存の source）に属する、`127.0.0.1:P` への接続の試みに対応する（「件数の規則」の 1 対 1）。対応する net log の接続の時刻は、その (b) の要求の開始以後。時刻は /2 と同じ時計で揃える。
3. 内容は SOCKS5 の挨拶だけ: net log のその接続に、host 名を運ぶ SOCKS5 の handshake の書込みの event がなく、挨拶への応答の読取が成功していない（LS-1 は返事をしない）。event の名前と params は、Chromium 150 の net log の constants から DD-1 の harness が診断の run で確かめ、観測の前に版2の freeze 記録に書く（名前の見込みは `SOCKS5_GREET_WRITE`、`SOCKS5_GREET_READ`、`SOCKS5_HANDSHAKE_WRITE` だが未検証）。環境側の記録が接続ごとの byte 数を持つなら、client から P への byte 数が版2の freeze 記録に書いた挨拶の長さ以下で、P から client への byte 数が 0 であることも求める。
4. 起点が Chromium の network stack であることは、2 の net log との対応で示す。net log に対応のない LS-1 への接続は、起点を確かめられないので (a) にしない。

(a) は (b) の要求の一部として数える（批准 2）。(b) の要求を運ばない LS-1 への接続（ほかの URL の要求、net log に対応のない接続）は (a) にしない。

### LS-1 の port の同定

run ごとに、次の (P1)〜(P4) をすべて満たす port P を、その run の LS-1 の port とする。満たす P がない run には (a) を当てない（下の「分類の順序」の 1）。

- (P1) net log: その run の net log の `SOCKS5` の `proxy_info` が、すべて同じ `SOCKS5 127.0.0.1:P` である。
- (P2) OS の socket 表の snapshot: harness が、Electron の process を起動した後で測る request（start の IPC）より前に 1 回（s1）と、Electron の process を終える直前に 1 回（s2）、Main（harness が起動した Electron の browser process。pid は harness が起動時に記録する）が持つ TCP の LISTEN の socket を読む。s1 と s2 の両方で、Main が `127.0.0.1:P` を LISTEN している。推奨の読み方は Linux の `/proc/net/tcp` の LISTEN の行の inode と `/proc/<Main の pid>/fd` の socket の inode の照合（file の読取だけで、subprocess を起動せず、どの port にも接続しない）。方法と版は receipt に書く。
- (P3) s1 と s2 の両方で、Main の loopback の LISTEN の socket から harness が所有する port（CDP など。/2 の版2の freeze 記録の一覧）を除いた集合が、ちょうど {P} である。
- (P4) P が、harness が所有する port の一覧、recorder の socket の port、版2の freeze 記録の AI の送信先の一覧（旧 provider の既定の接続先を含む）のどれとも一致しない。一致したら、環境の偶然の衝突として、その run を harness の隔離の不備で無効にし、測り直す。

LS-1 は start が 1 回だけで再 bind せず、製品のコードから閉じないので（事実の 1 項）、s1 と s2 で同じ P を Main が持てば、P は `setProxy` の時点の port と同じと読む（コードによる推定）。snapshot が取れなかった run（印がない run）は、記録を取っていない run として /2 のとおり無効にする。snapshot は取れたが (P1)〜(P3) のどれかが成り立たない run は、(a) を当てず、loopback の接続を /2 のとおり分類する（その run は DP-1 の証跡にならない）。stderr に NC-1 の固定コード（`NC-*`）が出た run は、その事実を receipt に書き、(a) と (b) を当てない。

### 件数の規則

- M_a = 1: (b) の要求 1 件が対応を持つ LS-1 への接続は、ちょうど 1 本（net log の接続の試みと環境側の記録の接続が 1 対 1）。2 本目以降は (a) にしない。根拠は事実の 15／15 回（各 run で要求 1 件、接続 1 本）。
- 環境側と net log の過不足: 同じ run で、環境側の記録の `127.0.0.1:P` への接続の数が、net log の `127.0.0.1:P` への接続の試みの数より少なければ、記録の不備として、その run を記録を取っていない run と同じに無効にする。多ければ、対応のない接続は (a) にせず、それ以外に入れる。
- N_b: 1 つの Electron の process の run（/2 の run の区切り。起動から終了まで）の (b) の要求の件数は N_b 以下。N_b は、DD-1 の harness が、fixture の材料を含まない診断の run（/2 の「観測前の固定」が認める診断 case。DD-1 と同じ build の作り方、起動の方法、環境で、DD-1 の最も長い run 以上の長さを 5 回以上）で観測した最大値とし、観測の前に版2の freeze 記録に、診断の run の記録とともに書き、独立期待値 reviewer のレビューを受ける。推奨の見込みは 1（事実の 9 秒の観測。長い run での再試行は未検証）。N_b を超えた (b) の要求は、その要求と運んだ LS-1 への接続をそれ以外に入れる。
- (b) の要求が 0 件の run は、それだけで無効にも FAIL にもしない（期待された通信は起きることを求めない。/2 と同じ）。

### 分類の順序

/2 の分類の順序（まず net log の各要求、次に対応しない環境側の記録の件）に、次を挟む。

1. NC-1 の適用の確認: 起動の env に `ELECTRON_RENDERER_URL` がなく、stderr に `NC-*` がなく、P を同定できた run だけに 2〜4 を当てる。ほかの run は /2 のまま分類する（(a)(b) による緩和はない）。
2. net log の各要求のうち、/2 の規則で製品の送信の FAIL になるもの（fixture の材料、AI の送信先）を先に分ける。(b) は 2 の後に判定する。
3. net log の要求を (b) の型で判定し、N_b を当てる。(b) に合わない辞書の形の要求は、/2 の既存の辞書の型で分類する（/2 の型は変えない）。ただし、その要求が `127.0.0.1:P` へ接続していれば、その接続は (a) にならない（4）。
4. 環境側の記録の `127.0.0.1:P` への接続を、(b) の要求に M_a で対応づけ、(a) に合うものをその要求の一部として数える。残りは /2 の loopback の文（#3）でそれ以外に入れる。
5. ほかは /2 のまま（recorder への接続の規則は、2〜4 より先に当てる /2 の順序を変えない）。

## threat model（GDX-PRECHECK-001）

security-sensitive な分類の緩和なので、確認されるまで draft とする。K6/2 の threat model（229、230、248、249 行と Mandatory defenses）への加算で、ほかは変えない。

- Trusted actors（加える）: OS の socket 表の snapshot の読取（harness が行い、読取だけで接続しない。結果は Main の pid と LISTEN の port の組だけを receipt に書く）。LS-1（製品の Main の一部。K3/3 の確認済みの設計どおり、返事をせず、受けた bytes を捨てる。この評価は LS-1 の挙動を net log の SOCKS5 の段と環境側の byte 数でだけ確かめる）。Main、OS、backend の侵害は /2 と同じく範囲外。
- Untrusted actors（変えない）: /2 のとおり。加えて、run の中で LS-1 の port に接続しうる、Chromium 以外の client（Native の client、Main の `globalThis.fetch`、harness と test の基盤の process）を、起点を確かめるまで信頼しない。
- In-scope attacks（加える）:
  1. LS-1 の port への接続を、port の一致だけで (a) に数える（net log の (b) の要求との対応を見ない）。Native の回帰や harness の接続が LS-1 の port に向かっても、期待された通信に見える。
  2. (b) でない要求（Main が default session で `net.fetch` を使う回帰、renderer 由来の要求、別の file 名の `.bdic`）を運ぶ LS-1 への接続を (a) に数える。
  3. P を、harness の設定、Chromium の起動引数、net log だけ、または Main に入れた hook から同定し、Main が実際にその port を LISTEN していることを確かめない。別の process の port（harness の port、利用者の local の SOCKS5 の server）を LS-1 と取り違え、host 名が渡りうる接続を期待された通信にする。
  4. Main が持つ別の loopback の listener（CDP、将来の listener）への接続を LS-1 への接続として数える。
  5. M_a を超える接続や N_b を超える要求を数え、または観測の後に N_b、URL の集合、event の指定を結果に合わせて広げる。
  6. 環境側の記録の欠け（net log より接続が少ない）を、対応づけの成功として扱う。
  7. host 名を運ぶ SOCKS5 の handshake がある接続、LS-1 が応答した接続を、挨拶だけの接続として数える。
  8. loopback を記録と分類から外して LS-1 への接続を消す、または LS-1 の port を harness が所有する port の一覧に入れて除く（/2 が禁じたまま）。
  9. `ELECTRON_RENDERER_URL` を置いて NC-1 を外した run と、NC-1 を当てた run を混ぜ、(a)(b) の緩和を NC-1 のない run に当てる。
- Out-of-scope attacks（残余として加え、Session C-2 の提示に添える）:
  1. (a) の内容の確認は、net log の SOCKS5 の段の event と LS-1 のコード（返事をしない）に依る。環境側の記録が byte 数を持たない場合、挨拶の bytes そのものは確かめない。Chromium の SOCKS5 の client が挨拶の応答の前に何を送るかは Chromium の実装に依る。
  2. (b) が default session の要求であることは、`proxy_info` が NC-1 の proxy であることからの帰属（default session だけが `setProxy` を受けるコード）で、net log が session を名指すわけではない。
  3. net log の接続と環境側の記録の接続の 1 対 1 は、数と時刻による対応づけで、local の port での照合ではない（net log に local の port が載るかは未検証。載るなら DD-1 の harness が port での照合に強めてよい）。同じ時刻に、記録の欠けと Chromium 以外の client の接続が同数だけ重なると、取り違えを検出できない。
  4. NC-1 そのものの有効性（renderer の外向き通信が塞がること、辞書の要求が `setProxy` の後に出ること）は DD-1 で評価しない（K3/3 の G-open と G-pub の範囲）。DD-1 の run で (b) が `DIRECT` などで現れても、/2 の辞書の型で分類し、その事実を receipt に書いて NC-1 の lane に申し送るだけで、この行の FAIL にしない。
- Mandatory defenses（加える）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」の全部。harness は run の間に LS-1 の port へ接続しない（snapshot は file の読取で行う）。(b) の URL の集合、N_b、event の指定、port の同定の方法は観測の前に版2の freeze 記録に書き、独立期待値 reviewer のレビューを受ける。DD-1 の harness の分類器は、下の Negative の合成の記録で検出力を示してから使う。
- Acceptance implications: 下の「受入れ」。品質閾値（保持 100%、禁止情報 0、prose 非回帰、P-12 の 0→1）と「DP-1 の証跡にする run では期待された通信でない試みが 0 件」は変えない。変わるのは、(a)(b) に合う試みが「期待された通信」に入ることだけ。
- owner／lifecycle: この draft は新しい外への通信、subprocess、背景の処理、async の lifecycle を加えない。足す観測（snapshot）は、DD-1 の harness が run ごとに 2 回行う同期の file の読取で、再試行しない。失敗は「印のない run」として無効になり、待ちを作らない。LS-1 の lifecycle は K3/3 と NC-1 の lane（DR-NC1-16）のまま。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| 2 項目の扱い（ユーザーが (A) を選んだ論点） | (A) K6 の /3 で、型と起点つきで期待された通信に加える（この draft） | freeze 記録に書くだけで足りるとする: /2 の loopback の文（284 行）と URL による照合（280 行）に反し、確認されていない読みで run を証跡にすることになる。loopback を記録と分類から外す: /2 が禁じている（旧 local の provider への試みが見えなくなる）。LS-1 の port を harness が所有する port に入れる: 製品の listener で harness の port ではなく、対応づけなしに除くことになる。NC-1 を外した起動（`ELECTRON_RENDERER_URL`）で測る: packaged の製品と違う構成を測り、dev server への loopback の接続が増える |
| port の同定 | net log の `proxy_info`（既存）と OS の socket 表の snapshot（追加の観測 1 種） | net log だけ: Main が port を持つことを記録で確かめられない（事実の最後の項）。Main に hook を入れて port を読む: 評価専用の入口が Main に増え、製品 build に残らないことの検査も増える。listener の port を file や log に出す: 製品の変更で、この draft の範囲（NC-1 の挙動を変えない）を超える |
| 件数 | M_a = 1 をこの draft で固定し、N_b は診断の run の観測から観測の前に版2の freeze 記録に書く（推奨の見込み 1） | N_b = 1 もこの draft で固定する: より厳しいが、長い run での再試行は未検証で、再試行が起きれば DD-1 が再び構造的に通らず /4 が要る。件数を置かず 1 対 1 だけにする: 繰り返す要求の回帰を見逃す。/2 は `github.com` で試みの数に上限を置く案を採らなかった（DNS の問合せの数が resolver に依るため）が、(b) は net log の要求の単位で数え、事実の範囲では 1 件で決定的だった |

## 受入れ（DD-1 の分類）

番号は K6/2 と K3 の (n) と衝突しないよう `K6/3-` を付ける。DD-1 の harness の分類器は、合成の記録（実 run の記録を複製して接続や event を書き加えたもの。K3/3 の `ll-synthetic-leaks` と同じ考え方）で、Negative のそれぞれを期待どおりに分けることを、版2の freeze の前に示して記録する。

receipt に加えるもの（各 run）: NC-1 の適用（env の `ELECTRON_RENDERER_URL` の有無、stderr の `NC-*` の有無）、Main の pid、snapshot s1 と s2（時刻、Main の loopback の LISTEN の port の一覧、方法と版）、同定した P（または同定できなかった理由）、(b) の要求の一覧（URL、開始の時刻、`proxy_info`、net error）、(a) の接続の一覧（環境側の時刻と、対応する net log の接続と (b) の要求）、N_b と M_a に対する件数、対応づけの過不足。

Positive:

- K6/3-P1: NC-1 を当てた run で、P を (P1)〜(P4) で同定でき、(b) の要求が 1 件（freeze 記録の URL、GET、upload なし、`proxy_info` が `SOCKS5 127.0.0.1:P`、freeze 記録の net error、`Dictionaries/` が空）、それに対応する LS-1 への接続が 1 本（SOCKS5 の handshake の書込みなし）。(a)(b) は期待された通信として件数と接続先と起点を receipt に書くだけで、その run を無効にも FAIL にもしない。
- K6/3-P2: NC-1 を当てた run で (b) の要求も LS-1 への接続も 0。期待された通信なしとして扱い、それだけで無効にしない。
- K6/3-P3: NC-1 を当てない run（`ELECTRON_RENDERER_URL` あり）は、(a)(b) を当てず /2 のまま分類する（緩和がないことの確認）。

Negative（どれも、その試みを期待された通信にしない。それ以外の内訳〔製品の FAIL、無効、台帳の不備〕は /2 の規則のまま）:

- K6/3-N1: net log に対応のない LS-1 の port への接続（Chromium 以外の client、harness の接続）。
- K6/3-N2: (b) でない URL の要求（Main の `net.fetch` の default session の要求、別の file 名の `.bdic`、query つき、`rr*.gvt1.com` など）を運ぶ LS-1 への接続。
- K6/3-N3: 1 件の (b) の要求に対応する 2 本目の LS-1 への接続（M_a の超過）。
- K6/3-N4: N_b を超えた (b) の要求と、それが運んだ接続。
- K6/3-N5: snapshot で Main が P を LISTEN していない、s1 と s2 で P が違う、Main の loopback の LISTEN に harness の一覧にない別の port がある、net log の `SOCKS5` の `proxy_info` に 2 つ以上の port がある。(a) を当てない。
- K6/3-N6: snapshot の印がない run（記録を取っていない run として無効）。
- K6/3-N7: host 名を運ぶ SOCKS5 の handshake の書込みがある接続、挨拶への応答の読取が成功した接続、環境側の byte 数が挨拶の長さを超えるか P からの byte がある接続。
- K6/3-N8: 辞書の形の要求の `proxy_info` が `SOCKS5 127.0.0.1:Q`（Q ≠ P）か `PROXY` で、loopback の Q への接続を伴うもの（Q への接続はそれ以外）。
- K6/3-N9: `Dictionaries/` に file がある run（(b) にしない。/2 の「外へ到達した証跡」でもある）。
- K6/3-N10: P が harness の port、recorder の port、AI の送信先の一覧と一致する run（harness の隔離の不備として無効、測り直す）。
- K6/3-N11: (b) の URL か request header に fixture の材料の文字列がある要求（/2 のとおり製品の送信の FAIL。(b) の判定より先）。
- K6/3-N12: 環境側の記録の P への接続が net log の接続の試みより少ない run（記録の不備として無効）。
- K6/3-N13: harness が run の間に P へ接続した run（harness の隔離の不備として無効）。
- K6/3-N14: 観測の後に、診断の run の記録と独立期待値 reviewer のレビューと新しい版の freeze 記録なしで、N_b、URL の集合、event の指定、port の同定の方法を変えた receipt（DP-1 の証跡にしない）。
- K6/3-N15: 環境側の記録の `redirector.gvt1.com` の DNS の問合せ（SOCKS5 の下では Chromium は名前を引かない見込みで、(b) の一部にしない。/2 の DNS だけの件の規則で、それ以外のまま）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| DD-1 | 分類器、snapshot、対応づけ、診断の run と N_b、合成の記録による検出力、receipt の欄を実装する。H4 による着手の保留は、この draft の確認で解ける（確認されなければ保留のまま） |
| PUB-L（Session C-2 の提示） | Out-of-scope attacks の 1〜4 と、DD-1 の (a)(b) の件数を開示に添える |
| DP-H | 影響しない（Electron を起動しない） |
| NC-1／DA-1／CP-2b（K3/3） | 影響しない。DD-1 で (b) が blackhole に向かなかった run は事実として申し送る（判定は K3/3 の G-open と G-pub） |
| CP-4、`g01-eval-revision`、`graph-eval-procedure` | 影響しない |

## 未確認と未検証

- net log の SOCKS5 の段の event の名前と params、TCP の接続の event の local の port（DD-1 の診断の run で確かめる）。
- 9 秒より長い run での辞書の要求の再試行と、N_b の値。実アプリの起動（`initBackend` と製品の窓を含む）での (b) と (a) の件数。DD-1 の環境の locale での辞書の URL。
- 挨拶の byte 値と長さ（記録は印字不能の文字の置換だけ）。環境側の記録が接続ごとの byte 数を持つか（DD-1 の harness の記録の方法に依る）。
- DD-1 の環境で `/proc/<pid>/fd` と `/proc/net/tcp` が読めること。同じ OS ユーザーの別の process が、Main が持つ `127.0.0.1:P` を同時に bind できないこと（Node の既定の listen と Linux の bind の規則からの推定）。
- updater の session が非 packaged で作られないこと（コードの読取だけ）。
- Linux 以外での DD-1（K6/2 は OS を固定していない。この draft の snapshot の推奨の方法は Linux のもの。ほかの OS では同等の読取の方法を DD-1 の harness が定め、版を receipt に書く。方法がなければ (a) を当てない）。

## 引き継ぎ（DD-1 の lane への申し送り。この確認の条件ではない）

- D1 診断の run を最初に取る: fixture の材料を含まない材料で、DD-1 と同じ build と起動で、(b) の URL の集合、net error、SOCKS5 の段の event の名前と params、N_b、挨拶の長さ（byte 数が取れるなら）を観測し、版2の freeze 記録に書く。結果が「型の定義」の形に合わない（たとえば M_a が 1 にならない）なら、型を広げずに `[precheck]` で止め、K6 の新しい draftRef を求める。
- D2 snapshot の方法: Linux では `/proc` の読取（subprocess なし）を推奨。CDP などの harness の port を版2の freeze 記録の一覧に書き、(P3) で使う。
- D3 起動: `ELECTRON_RENDERER_URL` を置かない（NC-1 を当てる）起動を推奨。置く場合は、その run に (a)(b) を当てないことと、dev server への接続の扱いを /2 の harness の port の規則で決める。
- D4 合成の記録: K6/3-N1〜N15 を検出することを、分類器の試験で固定する。
- D5 (b) が `DIRECT` などで現れた run、`NC-*` が出た run は、NC-1 の lane（DA-1／CP-2b）へ事実を渡す。

## 確認の扱い

- 確認は末尾の「確認文」の 1 文で行う（台帳の Confirmation protocol。`draftRef` と 1 つの `contractId` を名指す 1 文）。1 文で確認されるのはこの contractId の行の、冒頭の 1〜7 だけで、依存する契約（K3/3 を含む）と K6/2 の条件付きの 2 行は確認されない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答、2026-10-25 の「Aで」は、確認として扱わない。
- 確認されたら、K6/2 の「確認の扱い」の規則で /3 の行が K6/2 の行を全体として supersede する。内容は K6/2 の全文に「変える点」の表を当てたもので、K6/2 の確認の記録と行は消さない。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳（`docs/plans/nir1-l6-l9-execution-plan.md` の確認台帳）: `nir1-final-request-packing-eval` の K6/2 の行（191 行）を残し、その下に行を足す。draftRef `nir1-final-request-eval-proposal/3`、confirmedRef `nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval`。confirmedScope 案:「K6/3 の範囲: draft 冒頭の『ユーザーが批准すること』の 1〜7 の全項目（この一覧が範囲の正本で、台帳は別の列挙を持たない）。DD-1 の『接続の試みの分類』に、K3/3 が『続く通信』に加えた (a) Chromium（default session）から LS-1 への接続と (b) blackhole された辞書の要求の試みを、型と起点つきで期待された通信として加える（(a) は (b) の要求を運ぶ接続に限り、M_a = 1、N_b は観測の前に版2の freeze 記録に書く。LS-1 の port は net log の `proxy_info` と OS の socket 表の snapshot で同定する）。**K6/2 の文面より弱い読み**（『変える点』の 1〜4）。K6/2 のほかの全部は変えず、/3 が引き継ぐ。`g01-eval-revision`、`graph-eval-procedure`、K3/3 を含む依存する契約は確認しない」。remainingDelta: 「none — 差分は確認済み。DD-1 の harness の実装（分類器、snapshot、対応づけ、診断の run と N_b、合成の記録）と受入れは DD-1 に残る」。affectedLanes: 「DD-1、PUB-L（Session C-2 の提示）」。startStatus: 「K6/2 の行のまま（ready-after-normal-dependencies）。DD-1 の H4 の保留は解ける」。blockedReason／unblockingEvidence: K6/2 の行のまま。evidence の欄に確認文、確認の日時、この draft の commit と SHA-256、「this independently ratifies only this row; it supersedes the K6/2 row as a whole per K6/2's own rule, with content equal to K6/2 plus the /3 delta」を書く。
- 台帳の注記: K6/2 の 2026-10-17 の注（206 行）の下に、/3 の「変える点」の 1〜13 を読み替えとして足し、1〜4 が K6/2 の文面より弱い読みであることを書く（先の注は消さない）。K3/3 の行（187 行）の備考「DD-1 は K6 の確認者への照会まで着手を保留する」と lane snapshot の DD-1 の行（544 行）に、H4 が `nir1-final-request-eval-proposal/3` の確認で解けたことを注記する（K3/3 の bytes と行の確認範囲は変えない）。
- 続行計画（`docs/plans/nir1-continuation-2026-10.md`）: §1 に「Aで」（2026-10-25）の逐語と出所を記録し、§11 の H4 の項を解決済みにし、確認の記録を §10 に足す。
- DD-1 の TASK（K6/2 の「確認後の記録」の DD-1 の TASK の項に足す）: 「型の定義」「LS-1 の port の同定」「件数の規則」「分類の順序」、receipt に加えるもの、K6/3-P1〜P3 と K6/3-N1〜N15、診断の run（引き継ぎ D1）、snapshot の方法（D2）、起動（D3）、合成の記録（D4）、NC-1 の lane への申し送り（D5）を写す。
- 確認されなければ、DD-1 は H4 の保留のまま着手しない。別の案を選ぶ場合は /4 で起案する。

## 確認文

contractId の選択: **`nir1-final-request-packing-eval`**（K6/2 と同じ）。

- 理由: (1) この差分は、K6/2 が確認した `nir1-final-request-packing-eval` の行の一部（DD-1 の接続の試みの分類）を読み替える加算で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) 前例は K3/3（`nir1-d2a-activation-proposal/3`）が確認済みの K3/2 の一部を同じ contractId（`caller-profile-egress`）の新しい draftRef で読み替えた形と、`nir1-l6-l9-contract-proposal/7` の形。(4) 確認は contractId ごとの 1 文（台帳の Confirmation protocol）。

確認は次の 1 文で行う（空白を含め一字違わない。ユーザー自身が打ったときだけ有効）。

- I confirm draftRef nir1-final-request-eval-proposal/3 for contractId nir1-final-request-packing-eval.
