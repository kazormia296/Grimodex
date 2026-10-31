# 再凍結の前の通し稽古の記録（2026-10-31）

CP-4 の S4（観測前の commit）を凍結し直す前に、harness の修正（DR-CP4-T-1〜T-5、枝 `claude/cp4-freshness-settle`）を dev の形と、凍結済みの 13 fixture の完全な setup で通した記録。**ユーザーの確認ではない。評価の run ではなく、Graph arm の観測でもない**（凍結した case の Graph arm は一度も走らせていない）。台帳（`.artifacts/cp4/attempts/`）に載る試行を作っていない。

- 背景：`parity-1`（⑤）で G-08/graph-index-unusable が blocked（`parity-1/` の記録）。ユーザーは 2026-10-31 に「凍結し直す」を確認した（`user-confirmation-2026-10-31-refreeze.md`）。
- 実施者：integrator（Claude）と、harness 修正を担当した Opus の subagent（以下の dev の行列は subagent の報告による自己申告。成果物は worktree の `.artifacts/cp4/t1-*`、`t3-*`、`t3r-*`、`t4-*` にあり、repo には載せない）。

## 1. dev の形の行列（subagent の報告）

全 dev fixture（13 variant 相当）を、dev の完全な setup → parity → gold の形（Graph arm を含む）で通し、G-01 の負例 N2・N3・N4、SP-P4 の dev、trace（editing／browsing）も通した。見つけた欠陥と対応：

| ID | 分類 | 内容 | 対応 |
|---|---|---|---|
| T-1 | harness | 測定 process が workspace を開いた後、cold DB の Freshness の未処理を製品が処理して B/C を無効化する | 測定側で read-only に待つ（15 s／100 ms） |
| T-3 | harness | 完全な setup が session の終わりに Freshness の未処理を cold DB に残す | setup が session の終わりと chronicle-index・measurement-point の段の前で待つ（60 s／250 ms、使い切れば [precheck]） |
| T-5 | harness | 完全な setup が maintenance の Verify を running のまま閉じる | 同じ位置で maintenance の静止も待つ（待ち切れは止めず開示） |
| T-4 | 設計が曖昧→決定 (a) | graph-held-unusable（B が dirty で保持）の V-10 READY は製品の設計上来ない | plan の `readyProbe` を steady-state だけにし、不適用と prepare の状況を `ownerReady.skipped` に開示。Graph arm は fallback を測る。判定・閾値は変えない |
| （製品） | 別 lane | Verify が約 250 ms ごとに `CONNECTION_PREEMPTED` で奪われる連鎖（DR-CP4-L-27） | 直さない |

T-4 の決定は dev の観測（`DEV-HARBOR/graph-index-unusable` の gold で READY が 90 s 来ない）の**後に** integrator が決めた。決定の前後で凍結 case の Graph arm は走らせていない。

## 2. 凍結済み 13 fixture の完全な setup の予行（run 名 `rh-*`、setup だけ）

- 候補：worktree `claude-cp4-s5cand` を `fc7770fd67f24f974509fd7aad5e16ddebff1eb6`（T-1〜T-4 の枝に origin/master `6f5c9c4a` を merge した commit、tree `d12e9918f30b0c2e27095e0bca0383ce34d53104`）に detach。clean。標準 build の受領書 sha256 `51f4f79e0bc51b3d1c3176772030800a7534a1047ec50ddaa30c29246e4802f5`（CARGO_NET_OFFLINE なし）。
- 実施：2026-10-31 01:14〜01:31Z、`frozen-setup-driver.mjs --stops-at complete --product-receipt …`、`scripts/local-ci-xvfb.mjs`、隔離の規則どおり（Wayland／D-Bus／proxy 除去、`TMPDIR=/tmp/gr5`）。前後で X socket は X0・X1 だけ、Xvfb／electron の残りなし。
- 結果：13/13 が `setup-complete`（約 11 分。G-03 の 2 variant が 3〜4 分）。

| variant | status | feed（cursor/head） | running の run | Freshness の待ち | 受領書 sha256（先頭） |
|---|---|---|---|---|---|
| G-01/v1 | setup-complete | 17/17 | 0 | 5（maintenance 待ち切れ 0） | 0ade3c4b1004f3e3… |
| G-02/base | setup-complete | 31/31 | 0 | 5（0） | 67d99ed1b6a78a12… |
| G-03/base | setup-complete | 141/141 | 0 | 5（0） | c363ddc8e745b49d… |
| G-03/frontier-exceeded | setup-complete | 141/141 | 0 | 5（**maintenance 待ち切れ 2**。idle でも Verify が完了しない。開示） | 04840903e76e1d17… |
| G-04/base | setup-complete | 34/34 | 0 | 5（0） | 0e85aa371b908d84… |
| G-05/base | setup-complete | 29/29 | 0 | 5（0） | 0a32191cccf82289… |
| G-06/base | setup-complete | 38/38 | 0 | 5（0） | 847d0bd5075497ff… |
| G-07/base | setup-complete | 39/39 | 0 | 5（0） | 64333b59a12fbe49… |
| G-08/base-usable | setup-complete | 21/21 | 0 | 5（0） | 75de2614a0d4ce78… |
| G-08/graph-index-unusable | setup-complete | 22/22 | 0 | 7（0） | 9e0c2b59b01e808c… |
| G-08/graph-recovered | setup-complete | 22/22 | 0 | 8（0） | f417631a9dd9a1e5… |
| G-08/chronicle-index-unusable | setup-complete | 21/21 | 0 | 7（0） | 06271d65cfddc894… |
| G-08/both-indexes-unusable | setup-complete | 22/22 | 0 | 6（0） | 821f36c2fc9eee02… |

どの cold DB も、setup の最後に製品の Freshness の cursor が feed の head に届き、running の maintenance run が無い（修正前は G-02 で 29/31、G-08/graph-index-unusable で 21/22 などの未処理が残っていた）。

## 3. 限界

- 測定 process 側（T-1）の効果は dev fixture でしか確かめていない。凍結した case の parity／Gold で Verify の連鎖（製品の別 lane）が再発するかは、正式の run でしか分からない。
- editing の trace は自分の編集を Freshness が処理して B を dirty にする（製品の設計どおり）。凍結した trace がこの状態を想定しているかは、正式の run まで未確認。
- 観測（Graph arm）の後に新しい欠陥が見つかれば、再び凍結のやり直しになり、ユーザーの確認を取り直す。
