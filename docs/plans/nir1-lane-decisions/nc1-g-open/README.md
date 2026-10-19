# NC-1 の G-open の記録（K3/3 `nir1-d2a-activation-proposal/3`、ゲート表の G-open）

製品の NC-1 の module（`electron/main/rendererContainment*.ts`）を import した probe（`electron/scripts/webrtc-block-probe*.mjs`）を、最終候補の head の Linux の実機で走らせて採った記録。この directory の JSON は実機の出力そのもの（この機の LAN の IPv4 を `<lan>`、hostname を `<host>` に伏せたもの。runner が記録に残す前に伏せる）で、手で書き換えていない。`SHA256SUMS` が全 file の bytes を固定し、`electron/main/rendererContainmentGOpenRecord.test.ts` が記録を読んで合否を固定する。

## 採取した候補

- 候補の head: `d91c24f1b0a6f6218127ab5440a58e9256898df1`（DA-1 の開放 commit。branch `claude/nir1-da1-open`、base は origin/master `bf69e2f0`）。この head の後に変わるのは、この記録、記録を読む判定の試験、文書だけで、`electron/main` の製品コードと `electron/scripts/webrtc-block-probe*` は変えない（記録の commit は `git diff d91c24f1b0a6f6218127ab5440a58e9256898df1..HEAD -- electron/main electron/scripts/webrtc-block-probe*` が空）。製品コードか harness が変わったら、この記録は無効（GDX-TRACE-001）。DA-1 の開放 commit は、最終 head と一致する記録だけを引く（DR-NC1-46(b)）。
- 経緯: 最初の記録は NC-1 の最終候補 `fd549d4c06bd3dfe78965d96445e86919ef79c54`（branch `claude/nir1-nc1`、base `7c3d3110`）で採った。その後 integrator の rebase と CB-2 などで `electron/main` に差分が入ったため、開放 commit の head で JSON 全体と起動順序を採り直した（古い記録は残さない）。判定の結果は前回と同じ（不合格 0、対照の成立）。
- 環境: Linux 7.2.9-arch1、Electron 43.5.0（Chromium 150）、sandbox 有効、2026-10-19。Xvfb は `scripts/local-ci-xvfb.mjs` 経由で host namespace に起動し、`WAYLAND_DISPLAY`・`XDG_SESSION_TYPE`・`DBUS_SESSION_BUS_ADDRESS`・env の proxy を外した（`unshare -n` は使わない）。1 分負荷平均は 0.00〜0.86（採取中の標本。上限 1.5 を超えず、共有機の負荷による `proxy 宛 1 以上` の揺れは出なかったので再走は不要だった）。34 構成は 3 本の流れに分けて並列に走らせた（起動順序 6 本は別に直列）（Xvfb の display と port は runner が自動で別に取る）。
- 実機は Linux だけ。Windows／macOS と packaged の build は G-pub（CP-2b）の範囲で、この記録には含まない。

## 再走の手順

```
eval "$(fnm env --shell bash)"
gcc -shared -fPIC -O2 -o <dir>/dnslog.so electron/scripts/webrtc-block-probe-dnslog.c -ldl
TMPDIR=<tmpfs の dir> PROBE_DNSLOG_LIB=<dir>/dnslog.so node electron/scripts/webrtc-block-probe-candidates.mjs <id>... --out-dir <dir>
node electron/scripts/webrtc-block-probe-order.mjs --mode product-nc1  --env <none|ip|localhost> --repeat 5 --out <file>
node electron/scripts/webrtc-block-probe-order.mjs --mode product-none --env <none|ip|localhost> --repeat 3 --out <file>
node electron/scripts/webrtc-block-probe-verdict.mjs <record.json> --baseline <baseline.json> [--expect-min-fail <n>]
```

`<id>` は `webrtc-block-probe-candidates.mjs` の `CANDIDATES` の key（記録の file 名から `.json` を除いたもの。`nc1-` で始まる）。判定の出力は `verdicts.txt`。

## 記録と、受入れの対応

| 記録 | draft の項目 | 読み方 |
|---|---|---|
| `nc1-fm-final`／対照 `nc1-fm-baseline` | Negative (23)(23a)。名前を末尾 dot つきも含めて canary に写す形。(30b) の churn と再読込・遷移の行を含む | 判定 87 行で不合格 0（固定の sentinel 名の TURN-TCP／TURNS／TURNS-TCP の 3 行を含む）。対照は 87 行すべてが canary に届く |
| `nc1-ll-final`／`nc1-fq-final`／`nc1-nl-final`／`nc1-sx-final`／対照 `*-baseline` | (23b)。実 DNS の形（link-local、`.local`、FQDN の remote candidate、RS-1 の名前、大文字小文字・数値形式・zone つき literal） | 判定 126／112／122／156 行で不合格 0（`ll` は sentinel 名の 6 行を含む） |
| `nc1-doh-final`／`nc1-doh-baseline` | (32)。DoH の canary による名前の観測（getaddrinfo を使わない） | 攻撃者が選んだ名前 0 |
| `nc1-ll-kill` | (23c)。network service を SIGKILL して pid が変わった後 | 判定 126 行で不合格 0 |
| `nc1-fm-no-policy`／`nc1-fm-no-proxy`／`nc1-fm-no-neg-loopback`／`nc1-ll-no-proxy`／`nc1-ll-no-neg-loopback`／`nc1-ll-no-policy`／`nc1-nl-no-rules` | (29)。機構を 1 つずつ外した構成 | 外すと不合格（`<-loopback>`・policy を外した構成には canary に届かないまま不合格の行がある）。外した機構ごとの期待カテゴリを行 id で固定する（`judgeControlCategories`）: proxy は TCP だけで、固定の sentinel 名の TURN-TCP／TURNS／TURNS-TCP の 3 行が (23a)・(23b) の両方で canary に届く、policy は UDP だけ、`<-loopback>` は loopback の IP literal と `localhost` の TCP だけで sentinel 名の TCP は漏れない。rules を外した構成は RJ では合格し、NL が許容集合の外の名前 81 件で検出する |
| `nc1-nearnames` | (23) の「近い名前（`al0-nearnames` の形）」。製品の orchestrator と rules の `resolveHost` | 近い名前（`gvt1.com`、`a.gvt1.com`、`a.b.github.com`、`github.com.evil.test`、`x.localhost`、`foo.local` など）と末尾 dot つき（`github.com.`、`localhost.`）は `ERR_NAME_NOT_RESOLVED`、別形式の loopback（`127.1`、`0x7f.0.0.1`、`2130706433`、`127.0.0.1.`）は `127.0.0.1` に正規化される。19 入力 |
| `nc1-w0-…-baseline`、`nc1-w2`〜`nc1-w5-…-final` | (33)。更新と env の proxy（AL-0 の構成で取り直し） | `localhost`／`127.0.0.1` の proxy には `CONNECT github.com:443` が届き、LAN の IP literal と hostname は `ERR_PROXY_CONNECTION_FAILED` で proxy への接続 0 |
| `nc1-upd-baseline`、`nc1-upd-final` | (33) の外部網の記録（合否にしない。結果と日時を残す） | 外部網に依存する |
| `nc1-session-fail`／`nc1-session-none`、`nc1-policy-fail`／`nc1-policy-ok`／`nc1-policy-none`、`nc1-devtools` | 実機の観測（`NC-SESSION`、`NC-POLICY`、DevTools） | 固定コード、graceful な終了、何も読み込まれない |
| `nc1-order-product-nc1-{none,ip,localhost}`（各 5 回）、`nc1-order-product-none-*`（各 3 回） | 起動の順序（(30a) の実機の観測）と辞書の要求 | 15／15 回で順序どおり、辞書の要求は `setProxy` の完了後に始まり blackhole へ向く。NC-1 を呼ばない対照は判定が赤 |
| `verdicts.txt` | 上のすべての判定の出力 | 合成の記録（漏れを書き込んだもの）が `--expect-min-fail` で検出されることを含む |

## 行の区分についての注記（記録を読むときの前提）

- 固定の sentinel 名の UDP（`main.{stun,stuns,turn-udp}.sentinel`）は、(23a) の対照でも不活性の行になる（WebRTC の事前解決は末尾 dot つきの名前で、製品の rules の `MAP grimodex-rule-sentinel.invalid` は dot なしの名前だけに一致するため、閉じ込めなしでも名前が `127.0.0.1` に写らず canary に届かない）。最終構成では canary 0（`rendererContainmentGOpenRecord.test.ts` が固定）。sentinel 名の TCP は接続時の dot なしの名前で写るので活性で、proxy を外した構成の検出カテゴリになる。
- DNS だけが起きる行に、draft が挙げる `prerender`／`preload` の行はない（測定の記録の harness にも無い行で、閉じ込めなしでも解決・到達とも 0 の見込み。`nc1-decisions.md` の DR-NC1-44）。

## 未検証（この記録で満たしていないもの）

- `.local` の規則: この機では対照で問合せ（UDP 5353）を 6 件観測でき（対照が成立）、最終構成と `nc1-ll-kill` は 0 だった（`pass`）。観測できない OS／環境は「未検証」として G-pub に渡す。
- Windows／macOS と packaged の build（G-pub。CP-2b）、実アプリの `--remote-debugging-port` 経由の TURN 攻撃の smoke（任意。G-open の条件ではない）。
- 起動の所要は Linux の probe 用の起動（`index.ts` の全体ではなく NC-1 と窓の作成）の値。製品の `index.ts` 全体の起動は、既存の journey（PR 本文と decisions の「実装後の追記」）を参照。
