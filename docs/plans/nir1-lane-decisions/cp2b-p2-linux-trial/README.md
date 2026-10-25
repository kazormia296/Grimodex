# CP-2b P2 の packaged smoke の Linux の試運転の記録（G-pub の証跡ではない）

`electron/scripts/packaged-smoke/run.mjs` を Linux のローカルの機で走らせた出力そのもの（`<out-dir>/linux/` の写し。手で書き換えていない）。目的は道具の試運転で、K3/3 `nir1-d2a-activation-proposal/3` のゲート表の **G-pub（Negative (34)）の証跡ではない**（候補の head でも hosted の 3 OS でもない。G-pub の記録は P4 が merge 後の master の SHA で `packaged-smoke.yml` を dispatch して `cp2b-g-pub/` に採る）。`SHA256SUMS` が全 file の bytes を固定し、`electron/scripts/packaged-smoke/trial-record.test.mjs` が記録を読んで判定の再計算が `verdict.json`／`verdict.txt` と一致することを固定する。判断の記録は [cp2b-decisions.md](../cp2b-decisions.md) の §8、§9（DR-CP2B-P2-1〜）。

## 採取した条件

- head: `de86d6e61085e86a27e51ef854559b5a98404b0f`（branch `claude/cp2b-p2-packaged-smoke`、基点 master `8e93bb31`。独立レビュー〔lifecycle、security〕の修正と記録の伏せ字の拡張の後）。追跡中の file の変更なし（記録の `environment.candidate`）。この head の後に変わるのは、この記録、文書だけ。harness か製品が変わったら、この記録は古い。最初の試運転（head `db76aef0`）の記録は、伏せ字（絶対 path）の拡張と判定の出力（shim 済みの行）の追加の前のものなので置き換えた。**この記録は G-pub の証跡ではない**（候補の head でも hosted の 3 OS でもない）。
- 環境: Linux 7.2.11-arch1、Electron 43.8.3（Chromium 150.0.7871.250）、Node 24.18.0、2026-10-26。packaged は `electron-builder --dir --linux --publish never` の `linux-unpacked`（release と同じ `pnpm electron:native:release` と `pnpm electron:build`。semantic recall の reranker は bootstrap していない）。Chromium の sandbox は既定（`--no-sandbox` なし。この機は unprivileged user namespace を許す）。
- 隔離: `scripts/local-ci-xvfb.mjs` を host の namespace で使い（`unshare` なし）、`WAYLAND_DISPLAY`／`WAYLAND_SOCKET`／`XDG_SESSION_TYPE`／`DBUS_SESSION_BUS_ADDRESS`／env の proxy を除き、一時の `HOME`／`XDG_*`／`TMPDIR`（短い path）／`GRIMODEX_USER_DATA_DIR` を与えた。利用者の `/tmp/.X11-unix/X0`、`X1` は採取の前後で残っていた。外部網なしは主張しない（辞書の要求、RS-1 の名前の行の実 DNS などは起きる）。
- 所要: 3 構成で 751 秒（共有機。1 分負荷平均は記録の `environment.loadavg`）。

## 再走の手順

```
eval "$(fnm env --shell bash)"
pnpm electron:native:release && pnpm electron:build && pnpm exec electron-builder --dir --linux --publish never
TMPDIR=<短い path> node electron/scripts/packaged-smoke/run.mjs --out-dir <dir>
node electron/scripts/packaged-smoke/verdict.mjs <dir>/linux
```

## 記録

| file | 中身 |
|---|---|
| `baseline.json` | probe の main（閉じ込めなし）、DoH の canary、net log、UDP 5353。(34) の正の対照と行の区分の対照 |
| `toolcheck.json` | probe の main に製品の NC-1 の orchestrator。Main の listener の実数（`proxiedListener`）と net log の接続数（`proxiedNetLog`）を行ごとに残す |
| `packaged.json` | `linux-unpacked` に CDP で攻撃 JS を注入した行列。`proxied` は net log の LS-1 への接続数 |
| `package-check.json` | 同梱の worker（seam なし、実行可能）と `app.asar` の file 一覧（harness・probe の file なし） |
| `verdict.json`／`verdict.txt` | `verdict.mjs` の判定（RJ・NL・`.local`・行列・道具の対照・正の対照・package） |

raw の net log、userData、packaged の binary は置かない（net log は SHA-256 と派生の要約だけを各記録の `netLog` に残す）。LAN の IPv4、hostname、試験ごとの nonce は `<lan>`、`<host>`、`<n>` に、repo・一時 dir・home の絶対 path は `<repo>`、`<tmp>`、`<ostmp>`、`<home>` に、子の出力の末尾などの自由文の利用者名は `<user>` に伏せた。
