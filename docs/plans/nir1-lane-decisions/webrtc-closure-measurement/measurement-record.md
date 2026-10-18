# 測定の記録: renderer の外向き通信の閉じ込め（nir1-d2a-activation-proposal/3）

この文書は `nir1-d2a-activation-proposal-3-draft.md` の数値の根拠である。draft には要約だけを書き、記録の全体はここと `records/` に置く。draft の数値はこの記録の JSON を開いて確かめたものだけで、記録にない主張は draft で「推定」「未検証」と書いている。`SHA256SUMS`（この directory の全 file）の SHA-256 を draft が指す。

## 条件

- 試作: branch `claude/nir1-webrtc-proto`（push していない。製品コードは変更しない）。commit は `910db8d9`（接続を塞ぐ候補の試験）、`5132c379`（名前解決の試験）、`3bff3d1a`（DoH の canary）、`01ae08bd`（独立のレビューの指摘の再走）、`5147f9d8`（AL-0／AL-3 の記録の追加。この記録の `al0-*`／`al3-*`）、`ce7e5fa3`（net log の host resolver の host の観測と RS-1 の行の追加。この記録の `nl-*`）、`98bc5750`（行ごとの合否の道具 `webrtc-block-probe-verdict.mjs`、link-local の行、起動の順序の試験。この記録の `ll-*`／`ord-*`）、`05e7f840`（行ごとの合否の道具に、対象外の行と帰属しない到達を不合格にする必要条件を足した。`ll-synthetic-leaks`、`harness/webrtc-block-probe-verdict.test.mjs`）、`39b65493`（起動順序の試験に `protocol.handle` の暗黙の接触の mode を足した。この記録の `ord-protocol-first-*`／`ord-nc1-then-protocol-*`）、`ef5a8a10`（行ごとの合否の道具で、DNS だけの行は対照の試みを要求せず、対照の行列にない行を不合格にした。`ll-synthetic-hint-not-in-baseline`）、`b7c0a858`（行ごとの合否を 活性／canary 不可／不活性 の 3 区分に揃え、FQDN の remote candidate の 5 行を足した。この記録の `fq-*`）、`35659062`（名前の写しに末尾 dot つきを足して FQDN の remote candidate と名前の UDP を活性の行にして取り直し〔`fm-*`〕、独立のレビューの追加行〔`sx-*`〕を取り込んだ。判定の道具は、不活性の行の名前の確認を行の種類に関わらず行う）。`harness/` はその commit の probe 一式の写し。
- 環境: Electron 43.5.0（Chromium 150.0.7871.250）、Linux、sandbox 有効。窓は本体の `buildWebPreferences()`（`electron/main/windows.ts:234-240`（`01238cfc` の行番号。測定時の試作 branch では `windows.ts:218` 付近で、`buildWebPreferences()` の内容は同じ））と同じ webPreferences、本体の `protocol.ts` の `app://bundle` と CSP の下で動く。Xvfb は `scripts/local-ci-xvfb.mjs` 経由で host namespace に起動し（`unshare -n` は使わない）、`WAYLAND_DISPLAY`・`XDG_SESSION_TYPE`・`DBUS_SESSION_BUS_ADDRESS`・env の proxy を外す。他の socket と desktop には触れていない。
- 受け手: canary（loopback の複数 port、127.0.0.2、`[::1]`、LAN の IPv4 の TCP と UDP の受信 socket）と、blackhole の proxy の listener（接続と先頭の bytes を数える）。攻撃者が受け手になりうる外部サーバーへは送っていない。`--real-network` の記録は、実網の DNS と Google の辞書 URL、`github.com` への通常の通信を伴う（Electron の通常の動作と、名前解決の観測のための実在の名前の解決）。
- 名前解決の観測: `getaddrinfo` を包む記録層（`harness/webrtc-block-probe-dnslog.c`、`LD_PRELOAD`）と、DoH の canary（`o0`〜`o2`、`al0-doh`）。記録の `dnsAll`／`dnsNames` がその結果。
- 共有機の負荷（1 分負荷平均 7 前後）の下で走らせた。時間は目安にもしていない。

## 行の数え方

draft の「行」は、記録の `rows` のうち `control.*` と Main 側の通信の確認の行（`main.net-fetch*`、`main.updater-style-net-request`、`main.node-fetch`）を除いたものである（`realm.worker-rtc-defined` を含む）。「canary へ到達」は `leaked > 0` の行の数、「proxy の listener へ」は `proxied > 0` の行の数、「名前の解決の行」は `dnsNames` が空でない行の数（旧い行列は RS-1 の行を持たないので、攻撃者が選んだ名前の解決の行と一致する。RS-1 の行を足した `nl-*` では RS-1 の名前の行が加わるので、`nl-*` の「攻撃者が選んだ名前の解決」は別に数える: nonce つきの名前、または RS-1・sentinel・`127.0.0.1` の外の名前が `dnsNames` か net log の host に現れた行）。記録ごとに行列の大きさが違う（`h` 系 83、`z0`／`z1`／`z8`／`z9`／`z11` 93、`z2`／`z10`／`z12`／`k2`／`al0-*` 111、`z3`〜`z5` 105、旧い `a`・`d`・`e`・`f` 系 67、`reviewer/rv-*` 146、`fm-*` 98、`sx-*` 190）ので、分母は記録ごとに書く。

## 行ごとの合否（`ll-*`、`records/ll-verdicts.txt`）

集計値（canary 到達 0 の合計、proxy 宛の合計）では、canary を置けない宛先（link-local）や、`<-loopback>` を外して blackhole に届かなくなった行を見逃す。判定の道具 `harness/webrtc-block-probe-verdict.mjs` は記録を**行ごと**に判定する（規則は draft の「行ごとの合否（RJ）」）。TCP の行は canary 到達 0 かつ proxy の listener への接続 1 以上、UDP の行は canary 到達 0 かつ outcome が `gathering:complete`／`ice:new`、DNS だけの行は canary 到達 0（対照で試みが観測できることは要求しない。R14）、`--baseline` を渡すと TCP／UDP の行で対照（閉じ込めなし）で試みが観測できない行を「不活性の行」として合否に数えず列挙し、対照にない行（DNS だけの行を含む）と分類できない行は不合格にする。

- 行列: `al0-final-real` の 111 行に link-local の行 16 行（`ll.*`: `169.254.169.254` と `[fe80::1]` × {stun、stuns、turn-udp、turn-tcp、turns、turns-tcp} の 12 行、remote candidate の udp／tcp × 2 宛先の 4 行）を足した 135 行（`ll-*`）。`resolveProxy` の入力に `https://169.254.169.254/` と `https://[fe80::1]/` を足した。
- `ll-al0-final`（AL-0 の最終構成）: canary 到達 0、blackhole の listener への接続の総数 170。判定 112 行（TCP 59、UDP 41、DNS だけ 12）で**不合格 0**、記録全体の不合格 0（`totals.unattributed` 0、`totals.canaryHits` 0）。DNS だけの 12 行のうち、`ll-baseline` で試みが観測できる（名前の解決の記録がある）のは `dns.dns-prefetch` の 1 行だけで、`preconnect`／`preconnect-http`／`prefetch`／`modulepreload`／`stylesheet`／`img`／`fetch`／`websocket`／`a-ping`／`iframe-http`／`form-submit` の 11 行はベースラインでも解決・到達とも 0（Electron で no-op か CSP で止まる）。この 11 行は正の対照を持たず、canary 0 だけを見る（名前の合否は NL）。道具の初期の表示（`05e7f840` より前）は、不活性の 8 行（TCP 4、UDP 4）も種類に数えて「TCP 63、UDP 45」と表示していた。判定した行だけを数えると TCP 59、UDP 41（合計 112）。対象外 23 行（control・Main 側・CSP と handler で止まる行 15、不活性 8）。`resolveProxy(https://169.254.169.254/)` と `resolveProxy(https://[fe80::1]/)` は `SOCKS5 127.0.0.1:<port>`。
- `ll-baseline`（閉じ込めなし）: `169.254.169.254` の 8 行は canary 0 のまま `gathering:gathering`／`ice:checking`（試みが進行する＝対照が成立）。`[fe80::1]` の 8 行は `gathering:complete`／`ice:new` で、ベースラインでも試みが観測できない（不活性の行＝合否に数えない。Chromium は scope なしの IPv6 link-local を ICE の対象にしていないとみられる〔推定〕）。
- `ll-al0-no-neg-loopback`（`proxyBypassRules` を書かず暗黙の bypass が残る。rules と policy はある）: **23 行が不合格**。うち canary 到達 0 のまま不合格になる行が 10 行（`main.*.lo4b`／`lo6` の TCP 6 行は rules が IP literal を拒否していて canary に届かないが blackhole も通らない、link-local `169.254.169.254` の TCP 4 行〔`ll.turn-tcp.ll4`、`ll.turns.ll4`、`ll.turns-tcp.ll4`、`ll.remote-candidate-tcp.ll4`〕は proxy 宛 0）。残り 13 行は canary 到達あり（loopback の TCP、`localhost` 名、remote candidate の tcp、iframe）。
- `ll-al0-no-policy`（policy なし）: **21 行が不合格**。うち canary 到達 0 のまま ICE の状態だけで不合格になる行が 4 行（`ll.stun.ll4`、`ll.stuns.ll4`、`ll.turn-udp.ll4`、`ll.remote-candidate-udp.ll4`＝`gathering:gathering`／`ice:checking`）。
- 既存の記録に適用した参考（`records/ll-verdicts.txt`）: `al0-final-real` は判定 104 行で不合格 0、`nl-al0-final`（`nl-baseline` と対）は判定 122 行で不合格 0、`z8`（`<-loopback>` なし）21、`z9`（policy なし）19、`z11`（proxy なし）49。`al0-closed-proxy`（listener なし）は `--no-listener`（TCP の行は canary 0 だけを見る）で不合格 0。

### 不合格だけを足す必要条件（`05e7f840`。`ll-synthetic-leaks`）

行ごとの合否は集計値を合否に使わないので、対象外の行（control、Main 側、outcome が `error:`／`no-window`／`rtc-undefined`／`setRemoteDescription-failed` の行、不活性の行、`.local` の行）に帰属した到達と、どの行にも帰属しない到達（`totals.unattributed`。遅れて届いた接続が次の行の時間窓や対象外の行に入る場合）を見逃した。道具に次を足した: (1) 対象外の行でも `leaked > 0` なら不合格（不活性の行は合否の外に出さない）。(2) 記録全体の必要条件として `totals.unattributed`、`totals.canaryHits`、`totals.leakedProbes` のどれかが 0 でなければ「記録全体の不合格」（`totals.unattributed` がない記録も不合格）。合格の根拠にはしない。
- `ll-synthetic-leaks`: `ll-al0-final` の複製に、Main 側の行 `main.net-fetch.window-session` へ 3、blob iframe の SecurityError の行 `realm.iframe-blob.turn-tcp.name` へ 2、`totals.unattributed` へ 5 を書き込んだ**合成**の記録（実機の記録ではない）。足す前の道具は「判定 112 合格 112 不合格 0」で終了コード 0 だった。足した後は 2 行の不合格と記録全体の不合格 1 で終了コード 1（`records/ll-verdicts.txt` の「対照の受入れ判定（合成）」）。
- 既存の記録に適用した結果は、`ll-al0-final`、`al0-final-real`、`nl-al0-final`、`al0-closed-proxy` が不合格 0 のまま（`totals` の `unattributed`／`canaryHits`／`leakedProbes` が 0）。対照の構成（`ll-al0-no-neg-loopback` など）は行の不合格に加えて記録全体の不合格も出る。
- 単体試験: `harness/webrtc-block-probe-verdict.test.mjs`（`node --test`。R14 の時点は合成の少数の行で 10 件〔うち 3 件は DNS だけの行の規則〕。R15 で 18 件になった。下の R15 の節）。

### DNS だけの行と対照の行列（`ef5a8a10`。`ll-synthetic-hint-not-in-baseline`）

DNS だけの行（hint）は、道具が `--baseline` の対照の確認を丸ごと免除していた。免除の根拠は「名前の合否は NL の述語で、試みの観測は要求しない」だが、対照の行列にない hint の行も通っていた（`ll-al0-final` に baseline にない `dns.new-hint-not-in-baseline` を足すと合格 113 不合格 0 で終了コード 0）。R14 で、hint の行は対照の試みを要求しないまま、対照の行列にない行を不合格にした。
- `ll-synthetic-hint-not-in-baseline`: `ll-al0-final` の複製に、`ll-baseline` にない `dns.new-hint-not-in-baseline`（outcome `link:preconnect`、leaked 0、proxied 0）を 1 行足した**合成**の記録（実機の記録ではない）。足す前の道具は合格 113 不合格 0 で終了コード 0、足した後は不合格 1 行で終了コード 1（`--expect-min-fail 1` で検出）。
- 既存の記録（`ll-al0-final`、`ll-al0-no-neg-loopback`、`ll-al0-no-policy`、`ll-baseline`、`al0-final-real`、`nl-al0-final`）の判定の数は変わらない（hint の行はすべて対照の行列にある）。

### FQDN の remote candidate と 3 区分（K3/3 R15。`fq-*`、`b7c0a858`。R16 で `fq-baseline-mapped` を取り下げ、`fm-*` に取り直した）

`ll-*` の行列に FQDN の remote candidate の 5 行（address が非 mDNS の FQDN `rc<tag>-<nonce>.probe.test`。`main.remote-candidate-udp.fqdn`、`main.remote-candidate-tcp.fqdn`、`main.remote-candidate-tcp.fqdn-so`〔`tcptype so`〕、`main.remote-candidate-udp.fqdn-relay`〔`typ relay`〕、`main.remote-candidate-udp.fqdn-srflx`〔`typ srflx`〕）を足した 140 行の再走（実 DNS の構成。`fq-baseline`、`fq-al0-final`）。
- `fq-baseline`（閉じ込めなし、実 DNS）: FQDN の 5 行は canary 0、outcome は `ice:new` のまま、`getaddrinfo` の記録層には名前が現れる（`rcu-<n>.probe.test.` など。末尾 dot つき。**隣の行の名前が時間窓に入るため、1 行に 2 名が出る行がある**）。実 DNS では `*.probe.test` が解決できない（NXDOMAIN）ので接続しない。**これは対照の環境の性質で、経路の性質ではない**（下の `fm-*`）。
- `fq-al0-final`（AL-0 の最終構成、実 DNS）: canary 0。FQDN の 5 行は canary 0、`ice:new`、proxy 宛 0、`getaddrinfo` の記録に名前 0（`dnsNames` が空）。blackhole の listener への接続の総数 170。
- 判定の道具で `fq-al0-final` を `fq-baseline` と対にすると、判定 112 行（TCP 59、UDP 41、DNS だけ 12）で不合格 0、記録全体の不合格 0（`ll-al0-final` と同じ判定の行数）。区分は活性 43／canary 不可 57／不活性 13（活性＋canary 不可は TCP／UDP の 100 行の内訳で、DNS だけの 12 行と不活性の 13 行は別。不活性は判定 112 の外）。不活性の 13 行は `[fe80::1]` の 8 行と FQDN の 5 行。旧い道具（`ef5a8a10`）を同じ 2 つの記録に適用すると、判定 118 行で**不合格 3 行**（終了コード 1）: FQDN の TCP の 2 行（proxy 宛 0）と、`ll.remote-candidate-tcp.ll6`（隣の行の名前が窓に入って対照の名前の解決が空でなくなり、活性側に入った。proxy 宛 0）。いずれも閉じているのに不合格になる。
- 3 区分の定義（draft の「行の区分」）: 活性＝対照で canary に届く行、canary 不可＝対照で canary に届かないが接続の試み（ICE が進行中、または ICE server の行の名前の解決）が観測できる行、不活性＝対照でも接続の試みが観測できない行。remote candidate の行は名前の解決だけでは試みに数えない（`fq-baseline` の `ll.remote-candidate-tcp.ll6` は、隣の行の名前が窓に入って `dnsNames` が空でないため）。
- `nl-al0-final` を `nl-baseline` と対にすると、判定 122 行で不合格 0、不活性は `rs1.turn-tcp.localhost`、`rs1.turns.localhost` の 2 行（`nl-baseline` で `gathering:complete`＝localhost の TURN の port に canary がない）。localhost の TCP は `main.*.localhost`（canary あり。`ll-al0-no-neg-loopback` で不合格になる）が担う。
- `fq-synthetic-fqdn-leaks`: `fq-al0-final` の複製に、不活性の行 `main.remote-candidate-tcp.fqdn` へ許容集合の外の名前の解決（`rct-<n>.probe.test.`）、`main.remote-candidate-udp.fqdn-srflx` へ canary 到達 2 を書き込んだ**合成**の記録（実機の記録ではない）。不合格 2 行＋記録全体 2 件（`--expect-min-fail 3` で検出）。
- 再走: `TMPDIR=<tmpfs> PROBE_DNSLOG_LIB=<dir>/dnslog.so node electron/scripts/webrtc-block-probe-candidates.mjs fq-baseline fq-al0-final --out-dir <dir>`。
- 測定の限界: FQDN は `*.probe.test` だけを試した。実在の名前が解決される場合の挙動、`.local`（mDNS）の FQDN、`typ prflx` などは試していない。`fq-al0-final` の `getaddrinfo` 0 は、rules（`MAP * ~NOTFOUND`）が名前を拒否した結果とみられるが、拒否が `getaddrinfo` の前か後かは区別していない（推定）。

### 名前の写しの末尾 dot と (23a) の形（K3/3 R16。`fm-*`、`35659062`）

**R15 までの誤りの訂正**: R15 の記録 `fq-baseline-mapped`（名前を `127.0.0.1` へ写す対照）は、FQDN の 5 行を「canary 0、`ice:new`」と記録し、draft は「FQDN の remote candidate は名前を canary に解決させても接続しない」と書いた。原因は harness の写し `MAP *.probe.test 127.0.0.1` が、WebRTC が FQDN の remote candidate と STUN／TURN-UDP の名前を事前解決するときの末尾 dot つきの名前（`rcu-<n>.probe.test.`）に一致せず、名前が `MAP * ~NOTFOUND` で拒否されていたこと。独立のレビューが `MAP *.probe.test. 127.0.0.1` を足して再走し、FQDN の 5 行が canary に届くことを示した。`fq-baseline-mapped.json` は取り下げた（この記録から削除）。`z0`〜`z12`、`h*` などの旧い記録は、末尾 dot の写しがない harness で取った（ICE server の名前の TCP の行は接続時の dot なしの名前で写しに一致し canary に届いたが、名前の UDP と FQDN の remote candidate の行は当時の写しでは届かない行だった）。

R16 の harness: `HARNESS_PREFIX` と非 real-network の既定の rules に `MAP *.probe.test. 127.0.0.1` を足した。構成は `fm-baseline`（閉じ込めなし。非 real-network の既定の rules）、`fm-final`（AL-0 の最終構成。写しを prefix にして RULES_AL0 と 1 つの switch にする。(23a) の形）、機構を 1 つずつ外した `fm-no-policy`、`fm-no-proxy`、`fm-no-neg-loopback`。行列は `gvt1`、`localhostRows`、`fqdn` を含む 106 行（行の数え方では 98 行）。すべて判定の道具に `--baseline fm-baseline.json` を渡す。

| 記録 | canary へ到達した行 | proxy の listener へ届いた行 | 判定 78 行の合否（活性 78、不活性 13） | FQDN の 5 行と名前の UDP 9 行 |
| ---- | ------------------ | --------------------------- | ------------------------------------ | ---------------------------- |
| `fm-baseline` | 78／98（602 件） | 0 | （対照） | FQDN の 5 行は `ice:checking` で canary に届く（udp 36、tcp 35、relay 36、srflx 36）。名前の UDP（STUN 3、STUNS 3、TURN-UDP 6）も届く |
| `fm-final` | 0 | 51 | 合格 78、不合格 0 | FQDN の TCP 2 行は proxy 宛 1、UDP 3 行は `ice:new`。名前の UDP 9 行は `gathering:complete` |
| `fm-no-policy` | 34 | 51 | 不合格 34（すべて UDP） | 名前の UDP 9 行と FQDN の UDP 3 行（udp、relay、srflx）が canary に届く |
| `fm-no-proxy` | 44 | 0 | 不合格 44（すべて TCP） | FQDN の TCP 2 行が canary に届く（35 件ずつ）。名前の TURN-TCP／TURNS も届く |
| `fm-no-neg-loopback` | 19 | 32 | 不合格 19（loopback の TCP、`localhost` 名、remote candidate tcp の IP literal、iframe） | FQDN の行と名前の TCP は漏れない（SOCKS5 が名前を proxy 側へ渡すため。推定） |

単体試験（`harness/webrtc-block-probe-verdict.test.mjs`）は 21 件、すべて通った（R15 の 18 件に、対照が名前を canary に写す環境の FQDN の行は活性の行になり proxy 宛／ICE の状態で合否が決まること、proxy 宛 0 や ICE の進行は不合格、canary に届けば不合格、の 3 件を足した）。

不活性の 13 行は名前が写されない行（`ext` の未解決名 6 行、`gvt1` の TURN 4 行）と `localhost` の UDP 3 行で、(23a) の対照でも接続を試みない。名前の UDP の正の対照は、この写しで初めて取れた（R15 までの「UDP の名前の正の対照が取れない」は、道具の写しが原因の欠陥だった）。再走: `node electron/scripts/webrtc-block-probe-candidates.mjs fm-baseline fm-final fm-no-policy fm-no-proxy fm-no-neg-loopback --out-dir <dir>`（1 構成約 4〜5 分）。

### 独立のレビューが足した行（`sx-*`、`35659062`）

大文字小文字（`GitHub.com`、`GITHUB.COM`、`LOCALHOST`、末尾 dot つきなど）、数値形式の literal（`0.0.0.0`、`127.1`、`0x7f.1`、`[::ffff:7f00:1]`、`[::ffff:LAN]`、`[0:0:0:0:0:0:0:1]`、LAN の 10 進と 16 進）、zone 付き link-local、`iceCandidatePoolSize` 10、`iceTransportPolicy: 'relay'`、複数 URL を混ぜた server、`setConfiguration` と `restartIce`、WebTransport、同梱 worker を足した 83 行（`sx.*`）を、`sx-baseline`（閉じ込めなし、実 DNS）と `sx-al0-final`（AL-0 の最終構成、net log つき）で走らせた（行列は `dns`、`localhostRows` と合わせて 190 行）。`sx-baseline` は 84 行が canary に届く（`sx.*` の 41 行を含む）。`sx-al0-final` は canary 0、proxy 宛 95 行（`sx.*` の 44 行を含む）、判定 156 行（TCP 89、UDP 54、DNS だけ 13）で不合格 0、記録全体の不合格 0。不活性 24 行（zone 付き／scope なしの link-local と `[::1%251]` の 16 行、名前の STUN の 8 行）。大文字小文字の名前は最終構成の `dnsNames` が空（名前の漏れ 0）。`sx.pool.turn-tcp.lo4` は proxy 宛 10、`sx.relay.turns.lo4` は 1、`sx.multi-url.lo4` は 2、`sx.setconfiguration.turn-tcp.lo4` は 1。WebTransport は両構成で `WebTransportError`（CSP の `connect-src`）。判定の道具は `sx.multi-url` を TCP の行、`sx.setconfiguration.stun` を canary 0 だけを見る行、`sx.webtransport.*` と `sx.bundled-worker-rtc` を対象外として扱う。

## 起動の順序と辞書の要求（`ord-*`）

製品の起動順序（`electron/main/index.ts`、`01238cfc`）では `applySessionPermissionPolicy()`（240 行。`security.ts:126,145` の `session.defaultSession`）、`installProductDownloadGuard()`（242 行）、`registerAppProtocolHandler()`（246 行。`protocol.handle`）が default session の接触で、NC-1 の `setProxy` はその後になる。辞書の要求（spellchecker。`redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`）が `setProxy` の前に始まりうるかを、scratch main（`harness/webrtc-block-probe-order-main.cjs`。製品を変えない）と runner（`webrtc-block-probe-order.mjs`）で測った。Electron 43.5.0、Linux、Xvfb、窓は `about:blank`（sandbox 有効）、`host-resolver-rules` は AL-0 と同じ。net log の `URL_REQUEST_START_JOB` の時刻（`timeTickOffset` で epoch に直す）を main の `Date.now()` の時刻と比べ、辞書の要求の proxy 解決（`proxy_info`）、env の proxy（`http_proxy`／`https_proxy` を CONNECT を記録するだけの小さな proxy に向ける。502 を返し外へは出さない）が受けた CONNECT、blackhole の listener への接続、`Dictionaries/` の file を見る。

| 記録 | 順序と環境 | 実行 | 辞書の要求の行き先 | `setProxy` 完了より前に始まった要求 | env の proxy が受けた CONNECT | `Dictionaries/` |
| ---- | ---------- | ---- | ------------------ | ---------------------------------- | ---------------------------- | --------------- |
| `ord-permission-first-pre3000-none` | 旧い順序（default session を触って 3 秒後に NC-1）、OS／環境の proxy なし | 3 | `DIRECT`（`ERR_NAME_NOT_RESOLVED`〔-105〕。rules が名前を拒否） | 3／3 | 0 | 空 |
| `ord-permission-first-pre3000-ip` | 同、`http_proxy=http://127.0.0.1:<port>` | 3 | env の proxy（`PROXY 127.0.0.1:<port>`） | 3／3 | `CONNECT redirector.gvt1.com:443` が 3／3 | 空（proxy は 502 を返す） |
| `ord-permission-first-pre3000-localhost` | 同、`http_proxy=http://localhost:<port>` | 3 | env の proxy（`PROXY localhost:<port>`） | 3／3 | 3／3 | 空 |
| `ord-permission-first-{none,ip,localhost}` | default session を触った直後（待ちなし）に NC-1（K3/3 の以前の順序） | 5 ずつ | blackhole（`SOCKS5 127.0.0.1:<port>`。`ERR_SOCKS_CONNECTION_FAILED`〔-120〕） | 0／15 | 0 | 空 |
| `ord-nc1-first-{none,ip,localhost}` | **NC-1 が default session の最初の接触**（`setProxy` が最初の接触。listener は接触の前に起動） | 5 ずつ | blackhole | 0／15 | 0 | 空 |
| `ord-nc1-first-delay{20,50,100,300}-ip` | 同、ready から NC-1 の開始を 20／50／100／300 ms 遅らせる（遅い環境の模擬）、env の proxy あり | 3 ずつ | blackhole | 0／12 | 0 | 空 |
| `ord-nc1-first-stress-ip` | 同、24 個の busy loop を並走させた CPU 負荷下（12 core）、env の proxy あり | 8 | blackhole | 0／8 | 0 | 空 |
| `ord-protocol-first-pre3000-none` | **`protocol.handle`（`registerAppProtocolHandler` に相当）が最初の接触**、3 秒後に NC-1。OS／環境の proxy なし | 3 | `DIRECT`（-105。rules が名前を拒否） | 3／3 | 0 | 空 |
| `ord-protocol-first-pre3000-ip` | 同、`http_proxy=http://127.0.0.1:<port>` | 3 | env の proxy（`PROXY 127.0.0.1:<port>`） | 3／3 | `CONNECT redirector.gvt1.com:443` が 3／3 | 空 |
| `ord-protocol-first-pre3000-localhost` | 同、`http_proxy=http://localhost:<port>` | 3 | env の proxy（`PROXY localhost:<port>`） | 3／3 | 3／3 | 空 |
| `ord-protocol-first-ip` | `protocol.handle` が最初の接触で、その直後（待ちなし）に NC-1、env の proxy あり | 3 | blackhole | 0／3 | 0 | 空 |
| `ord-nc1-then-protocol-{none,ip,localhost}` | **NC-1 が最初の接触で、その後に `protocol.handle` と permission 相当の接触**（製品の起動順序で NC-1 を最初にした形） | 3 ずつ | blackhole | 0／9 | 0 | 空 |

- 読み取り: 旧い順序（default session の最初の接触が `session.defaultSession` の getter の permission 相当〔9 回〕か `protocol.handle`〔9 回〕で、NC-1 は 3 秒後）は、辞書の要求が ready から 33〜132 ms（接触の 30〜116 ms 後。`permission-first` 30〜44、`protocol-first` 38〜116）で始まり、18／18 が `setProxy` の前に出る。`protocol.handle` は Electron 43.5.0 の binary の JS で `protocol.handle:(...e)=>o.session.defaultSession.protocol.handle(...e)` と default session に委譲しており（`registerStringProtocol` ほか 19 の `protocol.*` が同じ形。binary の文字列で確認）、製品側の `session.defaultSession` の getter を通らない暗黙の接触である。OS／環境の proxy がなければ rules が止め（-105）、ある利用者は env の proxy へ CONNECT が届く。NC-1 を default session の最初の接触にした 35 回（待ちなし 15、遅延 12、負荷 8）と、default session を触った直後（待ちなし）に NC-1 を当てた 15 回の、計 50 回、`protocol.handle` を最初の接触にして直後に NC-1 を当てた 3 回、NC-1 の後に `protocol.handle` を呼んだ 9 回の、計 62 回すべてで辞書の要求が `setProxy` の完了後に始まり、blackhole へ向いた。遅延 20／50／100／300 ms の NC-1 でも要求は `setProxy` の完了の約 0〜6 ms 後に始まった（`ord-nc1-first-delay*`）ので、`setProxy` が最初の接触であれば要求はそれより前に出なかった。仕組み（Chromium が最初の proxy 設定を待つのか、時間差なのか）は特定していない。
- 範囲: Linux、Electron 43.5.0、窓は `about:blank` の scratch main。OS／環境の proxy は env の `http_proxy`／`https_proxy`（desktop 環境の変数を外した Linux。`127.0.0.1` と `localhost` の 2 形）だけ。GNOME／KDE の設定、PAC／WPAD、Windows、macOS、LAN の host の proxy、製品の `index.ts` そのもの（実アプリの起動）は未測定。`ord-*` は updater の session（partition `electron-updater`）の辞書の要求を見ていない（NC-1 の対象外。影響表 4）。
- NC-1 の所要（Linux。`timelineMsFromReady` から計算。自己確認〔`resolveHost`、`resolveProxy`〕と製品の `index.ts` の他の起動は含まない）: `ord-nc1-first-{none,ip,localhost}` の 15 回は、`setProxy start` から `closeAllConnections done` まで 26〜65 ms（ready から 32〜70 ms）。24 個の busy loop を並走させた `ord-nc1-first-stress-ip` の 8 回は 91〜152 ms（ready から 112〜167 ms）。`ord-nc1-first-delay*` の 12 回は `setProxy start` から 3〜17 ms（NC-1 の開始自体を遅らせているので ready からの値は参考にしない）。Windows／macOS は未測定。

## net log の host resolver の観測（`nl-*`）

`nl-*` の記録は `--log-net-log`（`--net-log-capture-mode=Everything`）を付け、`HOST_RESOLVER_MANAGER_REQUEST`／`JOB` の `host` を `netLog.hostResolver` に集計する。`requestHosts`／`jobHosts` は scheme・port・末尾の dot・IPv6 の角括弧を外して小文字にした host の件数、`rawRequestHosts` は net log の生の形、`nonceBearing` は生の host のうち試験の nonce を含むものの数。行列は `al0-final-real` の 111 行に RS-1 の 4 名（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`localhost`）× {stun、turn-udp、turn-tcp、turns} と dns-prefetch の 20 行（`rs1.*`）を足した 131 行。

- `nl-baseline`（閉じ込めなし、実 DNS）: 131 行中 43 が canary に届く。net log の生の host に nonce つきの名前が 72 件現れる（正の対照）。`getaddrinfo` の記録に nonce つきの名前の行が 51。
- `nl-al0-final`（AL-0 の最終構成）: 131 行中 canary へ 0、proxy の listener へ 63（`al0-final-real` の 55 と RS-1 の TCP 8 行）。net log の生の host に nonce を含むものは 0。正規化した host は `127.0.0.1`、`github.com`、`localhost`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`~notfound` の 6 種だけ。`~notfound` は `MAP * ~NOTFOUND` が拒否した名前の書換え先で、生の形は `https://~notfound`、`http://~notfound:<port>`、`app://~notfound`、`~NOTFOUND:0`。拒否された名前の元の名前は net log に出ない。この記録では WebRTC の TURN／STUN の名前（攻撃者が選んだ名前）に対する host resolver のイベントは net log に現れず、`~notfound` のイベントは WebRTC 以外の要求（`http://*.probe.test`、辞書の URL、`resolveHost` の自己確認）に由来する。
- RS-1 の 20 行（`nl-al0-final`）: canary へ 0。TURN-TCP と TURNS の 8 行（`localhost` を含む）は proxy の listener に 2 件ずつ、STUN と TURN-UDP の 8 行と dns-prefetch の 4 行は proxy へも 0。`getaddrinfo` の記録は、`turns`（`localhost` を除く）3 行と dns-prefetch 3 行に RS-1 の名前の `[rc0]` があり、RS-1 の名前は解決される。`localhost` の行は解決の記録がない。
- `nl-al0-idle`（renderer の行なし、spellcheck 有効）: 行なし。net log の host は `127.0.0.1`、`github.com`、`localhost`、`release-assets.githubusercontent.com`（自己確認の `resolveHost`）と `~notfound` で、nonce つきは 0。

## 再走の手順

1. 試作 branch を取得する（`harness/` は写し）。`eval "$(fnm env --shell bash)"` の後、`pnpm install --frozen-lockfile --offline`。
2. 記録層を作る: `gcc -shared -fPIC -O2 -o <dir>/dnslog.so electron/scripts/webrtc-block-probe-dnslog.c -ldl`。
3. `TMPDIR=<tmpfs の dir> PROBE_DNSLOG_LIB=<dir>/dnslog.so node electron/scripts/webrtc-block-probe-candidates.mjs <id>... --out-dir <dir>`。id は `webrtc-block-probe-candidates.mjs` の `CANDIDATES` の key。1 候補は 111 行で約 4 分（無負荷時）。
4. `records/reviewer/` の再走（`r4-*`、`rv-*`）は、独立のレビューが probe に足した拡張（cm の `r4`／`rv` key、dns-prefetch の多数生成、TURN の USERNAME、DNS 改ざんを模擬する名前の写し、別形式の literal の行）を使ったもので、拡張は試作 branch にない。そのままは再走できない。draft が頼る AL-0 の主張（到達 0、名前の解決 0）は `al0-final-real` で再走できる。

## draft の主張と記録

| draft の主張 | 記録 | 値 |
| ------------ | ---- | -- |
| ベースラインは 83 行中 56 行が canary に届く | `h0-baseline` | 83／56 |
| ベースライン（実 DNS）は 111 行中 43 行が届き、50 行で攻撃者が選んだ名前が解決される | `z12-baseline-real-dns` | 111／43／名前 50 |
| proxy＋policy だけ（rules なし）は到達 0、名前は 33 行で解決される | `z10-final-no-rules` | 111／0／proxy 52／名前 33 |
| proxy だけ、policy だけ、rules だけは漏れる | `h2-proxy-only`、`h3-policy-only`、`z5-rules-only-real` | 83 行中 17、83 行中 39、105 行中 17 |
| 機構を 1 つ外すと漏れる | `z8`（`<-loopback>` なし）、`z9`（policy なし）、`z11`（proxy なし） | 93 行中 19、17、42 |
| production の rules＋policy だけ（proxy なし）は loopback の TCP が漏れる | `reviewer/rv-nc7-prodrules` | 146 行中 21 |
| 推奨 AL-0 は到達 0、名前の解決 0 | `al0-final-real` | 111／0／proxy 55／名前 0 |
| 同（literal の追加 35 行を含む） | `reviewer/rv-al2-nogvt`、`reviewer/r4-nogvt-matrix` | 146／0／proxy 68／名前 0、111／0／proxy 55／名前 0 |
| gvt1 の hint の行（dns-prefetch、preconnect、prefetch など）も解決 0 | `reviewer/r4-nogvt-prefetch` | 17 行／0／名前 0 |
| AL-3（exact の `redirector.gvt1.com:443`）も到達 0、名前の解決 0。`resolveProxy(辞書の URL)` は `DIRECT` | `al3-final-real` | 111／0／proxy 55／名前 0 |
| AL-0 では辞書が取得できない | `al0-dict` | `dictionaries` が空。要求の proxy_info は `SOCKS5 127.0.0.1:<port>`。`resolveHost(redirector.gvt1.com)` は `ERR_NAME_NOT_RESOLVED` |
| AL-3 でも辞書は取得できない（redirect 先が blackhole へ向く） | `al3-dict` | `dictionaries` が空。net log の URL が `redirector.gvt1.com` の後 `rr8---sn-….gvt1.com` へ、後者の proxy_info は `SOCKS5` |
| AL-1（glob）では辞書が取得できる | `z2-final-real`、`d1-dictionary-wild-socks+rules` | `Dictionaries/en-US-10-1.bdic` |
| 自己確認: sentinel の `MAP` だけの構成は sentinel と proxy の確認を通り、IP literal と名前を解決する | `al0-selfcheck-sentinel-only` | `resolveHost(1.1.1.1)`・`resolveHost(127.0.0.2)`・`resolveHost(example.org)` が解決される |
| 自己確認: 最終構成では IP literal の `resolveHost` が失敗する。policy は読み戻せる | `al0-selfcheck-final`、`al0-final-real` の `events` | `1.1.1.1`・`127.0.0.2` が `ERR_NAME_NOT_RESOLVED`。`policy readback => disable_non_proxied_udp` |
| 近い名前と特殊な literal | `al0-nearnames` | `127.0.0.1` に正規化される 4 形式以外は `ERR_NAME_NOT_RESOLVED` |
| network service を SIGKILL した後も維持される | `al0-netservice-kill`（AL-1 の旧構成は `k2-netservice-kill-final`） | network service の pid が 70142 から 70155 に変わった後も、111 行で到達 0、proxy へ 55 行、名前の解決 0（AL-1 の旧構成の `k2` は 111／0／52／3） |
| proxy の listener がなくても fail-closed | `al0-closed-proxy`（旧構成は `g2-c5-closed-proxy`） | 111 行で到達 0、proxy の listener への到達 0（DIRECT へ落ちない）。Main の `net.fetch` は `ERR_PROXY_CONNECTION_FAILED`（旧構成の `g2` は 79 行中 0） |
| 名前の観測を OS に依らず DoH で取れる。最終構成で出る名前 | `al0-doh`（旧構成は `o0`〜`o2`） | DoH の canary に届いた名前は 28 件で、`www.gstatic.com`（Chromium 自身の到達性確認）だけ。攻撃者が選んだ名前は 0 |
| 更新の確認と asset の取得が AL-0 の下で通る | `al0-updater`、`u2`／`u3`、`v2`／`v3` | asset は `github.com` から `release-assets.githubusercontent.com` へ 200。`GrimodexReleases` の確認は 404（未公開）まで届く。`github.com` を除くと確認が、asset の host を除くと取得が `ERR_NAME_NOT_RESOLVED` |
| env の proxy を使う利用者の更新 | `w0`〜`w5` | `localhost`・`127.0.0.1` の proxy には `CONNECT github.com:443` が届く。LAN の IP literal と hostname は `ERR_PROXY_CONNECTION_FAILED` |
| dns-prefetch で多数の名前が解決される（名前を許可した構成） | `reviewer/r4-flood-final` | 1500 本の link／8778 ms／711 の別名（198 文字） |
| 許可 host の許可 port への TURN の平文が届く | `reviewer/r4-payload3`（cm は最終構成から `EXCLUDE *.gvt1.com` を外して名前の `MAP` で代替し、bypass の許可 port を canary の port に置換した模擬） | USERNAME 300／500 文字が平文で canary に届く（`leakHeads`）。別 port は proxy へ向く |
| net log の host に攻撃者が選んだ名前の生の host が現れない。閉じ込めなしでは現れる。拒否された名前は `~notfound` で現れる | `nl-al0-final`、`nl-baseline`、`nl-al0-idle` | 生の host の nonce つきは 0／72／0。正規化した host は RS-1 の 4 名の一部、`127.0.0.1`、`~notfound` だけ |
| RS-1 の名前を TURN／STUN の host にした行は canary に届かず、TCP は proxy へ向く | `nl-al0-final` | 20 行（STUN／TURN-UDP／TURN-TCP／TURNS が 16、dns-prefetch が 4）／0／proxy 8（TURN-TCP と TURNS の 4 名分。STUN／TURN-UDP と dns-prefetch は proxy へも 0） |
| 行ごとの合否: 最終構成は link-local を含め全行合格、`<-loopback>` を外すと canary 到達 0 のまま不合格になる行がある。対象外の行と帰属しない到達も不合格にする | `ll-al0-final`、`ll-al0-no-neg-loopback`、`ll-al0-no-policy`、`ll-baseline`、`ll-synthetic-leaks`（合成）、`ll-synthetic-hint-not-in-baseline`（合成）、`ll-verdicts.txt` | 判定 112 行（TCP 59、UDP 41、DNS だけ 12。DNS だけのうちベースラインで試みが観測できるのは 1）で不合格 0／23（うち canary 0 のまま 10）／21（うち 4）／83。不活性 8（`[fe80::1]`）。合成: 不合格 2 行＋記録全体 1 件、不合格 1 行 |
| 名前の写しに末尾 dot を足すと、FQDN の remote candidate と名前の UDP が閉じ込めなしで canary に届く（R15 の「接続しない」は写しの欠陥）。proxy を外すと TCP が、policy を外すと UDP が漏れる | `fm-baseline`、`fm-final`、`fm-no-policy`、`fm-no-proxy`、`fm-no-neg-loopback`、`ll-verdicts.txt` | 98 行中 78 が届く／最終 0（proxy 宛 51）／34（UDP のみ）／44（TCP のみ）／19（FQDN と名前の TCP は漏れない）。FQDN の 5 行は最終構成で TCP が proxy 宛 1、UDP が `ice:new` |
| 大文字小文字、数値形式の literal、pool／relay、複数 URL、setConfiguration、WebTransport、zone 付き link-local も最終構成で canary 0 | `sx-baseline`、`sx-al0-final` | 190 行中 84 が届く／最終 0（proxy 宛 95）。判定 156 行で不合格 0、不活性 24 |
| NC-1 を default session の最初の接触にすると辞書の要求は blackhole へ向く。旧い順序（3 秒後）は env の proxy へ出る。最初の接触が `protocol.handle` でも同じ | `ord-nc1-first-*`、`ord-permission-first-*`、`ord-protocol-first-*`、`ord-nc1-then-protocol-*` | 0／15、0／12、0／8、0／9（NC-1 の後に `protocol.handle`）、0／3（`protocol.handle` の直後に NC-1）。`pre3000` は `permission-first` 9／9、`protocol-first` 9／9 が `setProxy` の前で、env の proxy に CONNECT が 6／6 ずつ（env の proxy なしは -105） |
| 旧い構成の候補（PAC、partition、コマンドラインの proxy、preload、header） | `a1`／`a2`、`b5`、`d4`、`e1`、`f1` | `a1` 67 行中 30、`a2` 15、`b5` 79 行中 0（partition）、`d4` 67 行中 0（更新が壊れる）、`e1` 19、`f1` 49 |

## 記録の一覧

下の表は `records/` の JSON を機械的に集計したもの（`集計は `summ.py` 相当の簡単な script による。行の数え方は上のとおり。行が 1〜2 の記録（`u*`、`v*`、`w*`、`al0-updater`）は更新の確認・asset の取得の行で、名前の解決の行は GitHub の名前（`github.com`、`release-assets.githubusercontent.com`）である。`y1/` の 2 file は Y-1 の probe（`renderer-isolation-probe.mjs`）の記録で、別の schema`）。

### records/（試作 branch の記録と、この draft のために追加した記録）

| 記録 | label | 行 | canary へ到達 | proxy の listener へ | 名前の解決の行 | 注記 |
| ---- | ----- | -- | -------------- | ------------------- | -------------- | ---- |
| `records/a1-default-pac.json` | a1-default-pac | 67 | 30 | 0 | 0 |  |
| `records/a2-default-pac+policy.json` | a2-default-pac+policy | 67 | 15 | 0 | 0 |  |
| `records/al0-closed-proxy.json` | al0-closed-proxy | 111 | 0 | 0 | 0 |  |
| `records/al0-dict.json` | al0-dict | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/al0-doh.json` | al0-doh | 111 | 0 | 55 | 0 |  |
| `records/al0-final-real.json` | al0-final-real | 111 | 0 | 55 | 0 |  |
| `records/al0-nearnames.json` | al0-nearnames | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/al0-netservice-kill.json` | al0-netservice-kill | 111 | 0 | 55 | 0 |  |
| `records/al0-selfcheck-final.json` | al0-selfcheck-final | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/al0-selfcheck-sentinel-only.json` | al0-selfcheck-sentinel-only | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/al0-updater.json` | al0-updater | 2 | 0 | 0 | 2 |  |
| `records/al3-dict.json` | al3-dict | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/al3-final-real.json` | al3-final-real | 111 | 0 | 55 | 0 |  |
| `records/b5-partition-fixed-neg-loopback+policy.json` | b5-partition-fixed-neg-loopback+policy | 79 | 0 | 40 | 0 |  |
| `records/c1-fixed-bypass-local.json` | c1-fixed-bypass-local | 83 | 33 | 26 | 0 |  |
| `records/c2-fixed-default-bypass.json` | c2-fixed-default-bypass | 83 | 33 | 26 | 0 |  |
| `records/d1-dictionary-wild-socks+rules.json` | d1-dictionary-wild-socks+rules | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/d2-dictionary-no-allow+rules.json` | d2-dictionary-no-allow+rules | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/d4-cmdline-proxy+policy.json` | d4-cmdline-proxy+policy | 67 | 0 | 34 | 0 |  |
| `records/e1-preload-disable.json` | e1-preload-disable | 67 | 19 | 0 | 0 |  |
| `records/f1-connection-allowlist-header.json` | f1-connection-allowlist-header | 67 | 49 | 0 | 0 |  |
| `records/g2-c5-closed-proxy.json` | g2-c5-closed-proxy | 79 | 0 | 0 | 0 |  |
| `records/h0-baseline.json` | h0-baseline | 83 | 56 | 0 | 0 |  |
| `records/h1-final-c5.json` | h1-final-c5 | 83 | 0 | 42 | 0 |  |
| `records/h2-proxy-only.json` | h2-proxy-only | 83 | 17 | 42 | 0 |  |
| `records/h3-policy-only.json` | h3-policy-only | 83 | 39 | 0 | 0 |  |
| `records/k1-netservice-kill+rules.json` | k1-netservice-kill+rules | 101 | 0 | 47 | 1 |  |
| `records/k2-netservice-kill-final.json` | k2-netservice-kill-final | 111 | 0 | 52 | 3 |  |
| `records/nl-al0-final.json` | nl-al0-final | 131 | 0 | 63 | 6（RS-1 の行だけ） | net log の host を集計。RS-1 の行を含む |
| `records/nl-al0-idle.json` | nl-al0-idle | 0 | 0 | 0 | 0 | 行列なし。net log の host を集計 |
| `records/nl-baseline.json` | nl-baseline | 131 | 43 | 0 | 66（nonce つき 51） | net log の host を集計。閉じ込めなしの正の対照 |
| `records/ll-al0-final.json` | ll-al0-final | 135 | 0 | 62 | 0 | link-local の行を含む |
| `records/ll-al0-no-neg-loopback.json` | ll-al0-no-neg-loopback | 135 | 13 | 39 | 0 | link-local の行を含む |
| `records/ll-al0-no-policy.json` | ll-al0-no-policy | 135 | 17 | 62 | 0 | link-local の行を含む |
| `records/ll-baseline.json` | ll-baseline | 135 | 43 | 0 | 0 | link-local の行を含む |
| `records/ll-synthetic-leaks.json` | ll-synthetic-leaks | 135 | （合成） | （合成） | 0 | `ll-al0-final` の複製に到達を書き込んだ合成の記録。実機の記録ではない |
| `records/ll-synthetic-hint-not-in-baseline.json` | ll-synthetic-hint-not-in-baseline | 136 | （合成） | （合成） | 0 | `ll-al0-final` の複製に、`ll-baseline` にない DNS だけの行を 1 行足した合成の記録。実機の記録ではない |
| `records/fq-baseline.json` | fq-baseline | 140 | 43 | 0 | 63 | `ll-*` に FQDN の remote candidate の 5 行を足した。閉じ込めなしの正の対照（FQDN の行は canary 0、`ice:new`） |
| `records/fq-al0-final.json` | fq-al0-final | 140 | 0 | 62 | 0 | 同上。AL-0 の最終構成 |
| `records/fm-baseline.json` | fm-baseline | 98 | 78 | 0 | 0 | 名前を `127.0.0.1` へ写す（末尾 dot つきも）。閉じ込めなし。FQDN の 5 行と名前の UDP 9 行は canary に届く。R15 の `fq-baseline-mapped`（写しが末尾 dot に一致せず FQDN が解決されなかった）の取り直し |
| `records/fm-final.json` | fm-final | 98 | 0 | 51 | 0 | (23a) の形。AL-0 の最終構成。写しを prefix にして RULES_AL0 と 1 つの switch にした |
| `records/fm-no-policy.json` | fm-no-policy | 98 | 34 | 51 | 0 | policy を外した (23a) の形 |
| `records/fm-no-proxy.json` | fm-no-proxy | 98 | 44 | 0 | 0 | proxy を外した (23a) の形 |
| `records/fm-no-neg-loopback.json` | fm-no-neg-loopback | 98 | 19 | 32 | 0 | `<-loopback>` を外した (23a) の形 |
| `records/sx-baseline.json` | sx-baseline | 190 | 84 | 0 | 55 | 独立のレビューが足した行（`sx.*` 83 行）を含む。閉じ込めなし、実 DNS |
| `records/sx-al0-final.json` | sx-al0-final | 190 | 0 | 95 | 0 | 同上。AL-0 の最終構成。net log つき |
| `records/fq-synthetic-fqdn-leaks.json` | fq-synthetic-fqdn-leaks | 140 | （合成） | （合成） | （合成） | `fq-al0-final` の複製に名前の解決と到達を書き込んだ合成の記録。実機の記録ではない |
| `records/n0-dns-baseline.json` | n0-dns-baseline | 101 | 37 | 0 | 47 |  |
| `records/n1-nc1-al1-dns.json` | n1-nc1-al1-dns | 101 | 0 | 47 | 30 |  |
| `records/n2-nc1-al1+rules.json` | n2-nc1-al1+rules | 101 | 0 | 47 | 1 |  |
| `records/o0-doh-baseline.json` | o0-doh-baseline | 101 | 37 | 0 | 0 |  |
| `records/o1-doh-nc1-al1.json` | o1-doh-nc1-al1 | 105 | 0 | 49 | 0 |  |
| `records/o2-doh-final.json` | o2-doh-final | 111 | 0 | 52 | 0 |  |
| `records/u1-updater-baseline.json` | u1-updater-baseline | 1 | 0 | 0 | 1 |  |
| `records/u2-updater-nc1+rules.json` | u2-updater-nc1+rules | 1 | 0 | 0 | 1 |  |
| `records/u3-updater-nc1+rules-no-github.json` | u3-updater-nc1+rules-no-github | 1 | 0 | 0 | 0 |  |
| `records/u4-updater-envproxy-baseline.json` | u4-updater-envproxy-baseline | 1 | 0 | 0 | 0 |  |
| `records/u5-updater-envproxy-nc1+rules.json` | u5-updater-envproxy-nc1+rules | 1 | 0 | 0 | 0 |  |
| `records/u6-updater-envproxy-nc1+rules-excl.json` | u6-updater-envproxy-nc1+rules-excl | 1 | 0 | 0 | 0 |  |
| `records/v1-asset-baseline.json` | v1-asset-baseline | 1 | 0 | 0 | 1 |  |
| `records/v2-asset-nc1+rules.json` | v2-asset-nc1+rules | 1 | 0 | 0 | 1 |  |
| `records/v3-asset-nc1+rules-no-asset-hosts.json` | v3-asset-nc1+rules-no-asset-hosts | 1 | 0 | 0 | 1 |  |
| `records/w0-envproxy-localhost-baseline.json` | w0-envproxy-localhost-baseline | 1 | 0 | 0 | 0 |  |
| `records/w1-envproxy-localhost-final-nolocalhost.json` | w1-envproxy-localhost-final-nolocalhost | 1 | 0 | 0 | 0 |  |
| `records/w2-envproxy-localhost-final.json` | w2-envproxy-localhost-final | 1 | 0 | 0 | 0 |  |
| `records/w3-envproxy-127-final.json` | w3-envproxy-127-final | 1 | 0 | 0 | 0 |  |
| `records/w4-envproxy-lan-final.json` | w4-envproxy-lan-final | 1 | 0 | 0 | 0 |  |
| `records/w5-envproxy-hostname-final.json` | w5-envproxy-hostname-final | 1 | 0 | 0 | 0 |  |
| `records/x1-cli-rules-replaced.json` | x1-cli-rules-replaced | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/x2-prefix-composed.json` | x2-prefix-composed | 0 | 0 | 0 | 0 | 行列なし（単独の確認） |
| `records/z0-baseline-localhost.json` | z0-baseline-localhost | 93 | 59 | 0 | 0 |  |
| `records/z1-final-harness.json` | z1-final-harness | 93 | 0 | 47 | 0 |  |
| `records/z10-final-no-rules.json` | z10-final-no-rules | 111 | 0 | 52 | 33 |  |
| `records/z11-final-no-proxy.json` | z11-final-no-proxy | 93 | 42 | 0 | 0 |  |
| `records/z12-baseline-real-dns.json` | z12-baseline-real-dns | 111 | 43 | 0 | 50 |  |
| `records/z2-final-real.json` | z2-final-real | 111 | 0 | 52 | 3 |  |
| `records/z3-min-rules-real.json` | z3-min-rules-real | 105 | 0 | 0 | 3 |  |
| `records/z4-rules+policy-only-real.json` | z4-rules+policy-only-real | 105 | 0 | 0 | 5 |  |
| `records/z5-rules-only-real.json` | z5-rules-only-real | 105 | 17 | 0 | 5 |  |
| `records/z8-final-no-neg-loopback.json` | z8-final-no-neg-loopback | 93 | 19 | 28 | 0 |  |
| `records/z9-final-no-policy.json` | z9-final-no-policy | 93 | 17 | 47 | 0 |  |

### records/reviewer/（独立のレビューの再走。probe の拡張が試作 branch にないので、そのままは再走できない）

| 記録 | label | 行 | canary へ到達 | proxy の listener へ | 名前の解決の行 | 注記 |
| ---- | ----- | -- | -------------- | ------------------- | -------------- | ---- |
| `records/reviewer/r4-flood-final.json.gz` | r4-flood-final | 1 | 0 | 0 | 1 |  |
| `records/reviewer/r4-nogvt-matrix.json` | r4-nogvt-matrix | 111 | 0 | 55 | 0 |  |
| `records/reviewer/r4-nogvt-prefetch.json` | r4-nogvt-prefetch | 17 | 0 | 0 | 0 |  |
| `records/reviewer/r4-payload3.json` | r4-payload3 | 5 | 4 | 1 | 0 |  |
| `records/reviewer/rv-al2-nogvt.json` | rv-al2-nogvt | 146 | 0 | 68 | 0 |  |
| `records/reviewer/rv-nc7-prodrules.json` | rv-nc7-prodrules | 146 | 21 | 0 | 9 |  |

## 記録に入っていない試験

`b1`〜`b4`、`c3`〜`c5`、`d2`／`d3` の一部、`g1`、`g3`〜`g6`、`r3`〜`r5`、`f2`〜`f8`、`h1` 以外の旧い構成の数値は作業記録にあり、JSON を収めていない（`webrtc-block-probe-candidates.mjs` の id で再現できる）。draft がこれらを根拠にする箇所は「JSON 未収録」と書いている。
