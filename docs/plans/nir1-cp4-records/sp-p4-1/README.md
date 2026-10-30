# ④ SP-P4 の診断（試行 1、run `sp-p4-1`）の記録

2026-10-30（UTC）に integrator が実行した、CP-4 の ④ SP-P4 の診断の記録。凍結した材料（S4b＝`b7d7495034ee693e82b9a6e55bbcbfd433215012`）での最初の実 Electron の実行。**Graph の arm は動かしていない**（seed なしの R+IR の arm だけを、seed の pin の段の前後の写しで測り、論理 ID で比べる診断）。

## 結果

- **status: passed**。8 variant（G-01/v1、G-02〜G-07/base、G-08/base-usable）すべてで `same: true`、差異 0。`stop` は null、`problems` は 0 件。SP-N7（段の前後の R か R+IR が違う）は起きていない。
- 受領書 `sp-p4-receipt.json` の sha256: `7041c612b0ce116f9cb338e51d59e9e295c91d7807f20b762394a7c87211eae1`（`readSpP4Gate` が返す値）。`readSpP4Gate` が、この受領書、この run の head、この候補で通ることを確かめた（⑤ の前提の 1 つ）。
- 台帳 `attempts/sp-p4-1.json`: 開始時の sha256 `5ddcb5dedea02d3118c5aff127817c300159005fa055a57ee14979b4eb2a6ea5`（contracts の `372883c6` に写した）、終了後 `a6377c24a0d7fb584e1b6c8fec76892f888cf6eb3b9d0b2963b9e5b5365a425f`（status `completed`、attempt 1）。
- 実行時間: 2026-10-30T20:23:28Z（command 開始）〜20:32:06Z。台帳の開始 20:30:12Z（分岐の setup の後）〜終了 20:32:06Z。

## 候補と規則

- 候補: `5ce1221158f9855725a3c87704c17586324a08a9`（tree `291748e40d58bbbace9622b932d8ddac711a62de`、clean）。製品の標準 build と評価 build（`nir1-graph-eval` feature）の受領書は、候補の worktree の `.artifacts/cp4/s5-receipts/` にある。
- 比較の規則: `ir-complete-pairs`（S3 の 7 回目の条件 C1〜C3、側ごとの上限 6〔#757〕、組の上限 6〔#759〕）。warm-up 5、測定 30、試行の上限 2（今回は 1 回目）。R の membership と順位・denseHits・sparse は全 30 sample で比べた（全 variant で一致）。IR の寄与（R+IR と共通追加枠）は、期限切れだけで失われた sample の組を除いて比べた。

## 開示（IR の期限切れと IR の不在）

比べた組の数と、除外された組（IR の期限切れで外れた組）、側ごとの期限切れの数:

| variant | 比べた位置 | 両側 ir-ready の組 | IR を比べた組 | 除外した組 | 期限切れ（without, with） |
|---|---|---|---|---|---|
| G-01/v1 | 30 | 29 | 29 | 1 | 0, 1 |
| G-02/base | 30 | 27 | 29 | 1 | 0, 1 |
| G-03/base | 30 | 27 | 27 | 3 | 1, 2 |
| G-04/base | 30 | 25 | 25 | 5 | **5**, 0 |
| G-05/base | 30 | 30 | 30 | 0 | 0, 0 |
| G-06/base | 30 | 25 | 25 | 5 | 0, **5** |
| G-07/base | 30 | 30 | 30 | 0 | 0, 0 |
| G-08/base-usable | 30 | 30 | 30 | 0 | 0, 0 |

- 5 つの variant で IR の期限切れがあった。**G-04 は without の側に 5 件、G-06 は with の側に 5 件**で、側ごとの上限 6 と組の上限 6 の範囲内だが、近い。偏りの向きが両方（without 側に偏る variant と with 側に偏る variant）あるので、pin の有無に結びつく偏りには見えないが、**この診断はその区別を証明しない**（期限切れの sample の IR は比べていない）。除外した組の R の欄は比べ、一致した。
- G-02/base では、without の側の repeat 3 と 4 の IR が `ir-unavailable`（期限切れではなく、IR の不在。R+IR＝R、追加枠 null）だった。C1 は期限切れだけを外すので、この 2 組は除外せず `current` と同じに比べ、一致した（with の側の同じ位置の IR も R+IR＝R で追加枠 null）。
- 上の偏りは環境（同じ machine で 8 variant × 2 側を続けて測る負荷、IR の初回の読込み）で説明できるが、**原因は調べていない**。観測の後に規則を変えない（観測の前に固定した規則で passed）。

## 実行環境と副作用

- `scripts/local-ci-xvfb.mjs` を host の namespace で実行。`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS`、`WAYLAND_SOCKET`、proxy 変数を除去。`TMPDIR=/tmp/gr5`。`ELECTRON_OZONE_PLATFORM_HINT=x11`。
- 実行前: 残存プロセスなし、`/tmp/.X11-unix` は X0、X1、load 0.68。実行中: run 専用の Xvfb が X2。実行後: X0、X1 のまま、Xvfb／electron のプロセスなし、`/tmp/gr5` は空、`/tmp` の空きは変わらず（36G）。
- 事前に dev preview（`dev-shape-g04`、warm-up 1、測定 3。CP-4 の記録ではない）で同じ経路を通し、副作用がないことを確かめた。
- Electron の既定の動作（spellchecker の辞書の取得など）による外向き通信の有無は、この記録では確かめていない。

## 次

⑤ Graph arm を含む実行（Gold、K24 の負例ほか）。**⑤ の formal run には `--keep-test-worktree <候補の worktree>` が必須**（批准 5 の (b) RS-JOIN の hook の commit は squash 前で候補の祖先でなく、祖先の確認だけでは regime が K6/2 に落ちる。keep test〔8 件 pass〕を通せば K6/4）。
