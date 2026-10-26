# CP-2b P4 の packaged smoke（G-pub）の hosted 3 OS の記録

`packaged-smoke.yml`（`Packaged smoke (G-pub)`、`workflow_dispatch`）を hosted の 3 OS で走らせた出力そのもの（`<os>/` は artifact の写し。手で書き換えていない）。K3/3 `nir1-d2a-activation-proposal/3` のゲート表の G-pub（Negative (34)）の記録。判断の記録は [cp2b-decisions.md](../cp2b-decisions.md)。

**これは CP-2b 時点の記録で、PUB-G の最終候補では採り直す。** 記録は候補の head に束縛される（GDX-TRACE-001）。最終候補の head が `10f7db66` と違えば、この記録は G-pub の証跡にならない。

## 出典

- run: https://github.com/kazormia296/Grimodex/actions/runs/40256736959（`workflow_dispatch`、`os=all`、全 job success）
- candidate: `candidate_ref` = `10f7db66612ad000da130567ae209907bf1a45c0`（master。記録の `environment.candidate` は 3 OS とも同じ head で `trackedDirty` false）
- 採取: 2026-10-26。runner は Linux ubuntu24（20261023.334.3）、macOS macos15 arm64（20260907.0337.1）、Windows win25-vs2026（20261021.278.1）。Electron 43.8.3（Chromium 150.0.7871.250）。

## 結果（(34) は 3 OS とも pass）

| OS | 判定の行 | 区分（活性／canary 不可／不活性） | 合格／不合格 | `.local` | toolcheck の食い違い |
|---|---|---|---|---|---|
| Linux | 118（tcp 57／udp 45／hint 16、対象外 16） | 43／59／2 | 118／0 | pass | 0（TCP 59 行すべて listener への接続あり） |
| macOS | 118 | 37／65／2 | 118／0 | **unverified** | 0 |
| Windows | 120（対象外 14） | 43／61／0 | 120／0 | pass | 0 |

- 不活性の行（合否に数えない）: Linux と macOS は `rs1.turn-tcp.localhost`、`rs1.turns.localhost` の 2 行。Windows は 0 行。
- NL は 3 OS とも合格。行列は 3 OS とも 134 行で欠け 0、余り 0。
- `dns.form-submit`（hint）は CDP の shim で送信されない（DR-CP2B-P2-5）。判定は pass で、合格の数には含む。
- 記録（合否にしない）、`verdict.txt` の値。NC-1 の network の段の下限／起動から窓まで（期限 5000 ms）: Linux 2 ms／557 ms、macOS 8 ms／1888 ms、Windows 2 ms／577 ms。

## 注意

- **macOS の `.local` は unverified**。ベースラインで `.local` の問合せ（UDP 5353）を観測できず、対照が取れない。K3/3 :283 により未検証として記録する。PUB-G の開示の残余（K3/3 :314）。
- **macOS は 127.0.0.2 に bind できず（EADDRNOTAVAIL）、`r-127.0.0.2` の canary が置けない。** 宛先が 127.0.0.2 の `main.*.lo4b` の 6 行（stun、stuns、turn-udp、turn-tcp、turns、turns-tcp）は canary 不可の区分になる。
- **不活性の行の OS 差と run 間の揺れ。** 同じ macOS の PR 時点の run（run 40251784411、head `a2802934`）は判定 119 行、不活性 1 行（`rs1.turns.localhost` のみ）、canary 不可 66 だった。macOS では `rs1.turn-tcp.localhost` の区分（canary 不可／不活性）が run の間で揺れる。どちらも合否は変わらない。Windows は不活性 0 行。

## 再走の手順

```
gh workflow run packaged-smoke.yml -f candidate_ref=<候補の head の SHA> -f os=all
gh run download <run id>   # 各 OS の artifact の <os>/ をこの dir に置く
node electron/scripts/packaged-smoke/verdict.mjs <dir>/<os>
node --test electron/scripts/packaged-smoke/g-pub-record.test.mjs
```

ローカルの Linux では [cp2b-p2-linux-trial/](../cp2b-p2-linux-trial/README.md) の手順で `run.mjs` を使う。

## 記録

各 OS の `<os>/` に `baseline.json`（対照）、`toolcheck.json`（道具の対照）、`packaged.json`（攻撃 JS の行列）、`package-check.json`（同梱の検査）、`verdict.json`／`verdict.txt`（判定）、`SHA256SUMS`。内容の説明は [cp2b-p2-linux-trial/README.md](../cp2b-p2-linux-trial/README.md) と同じ。`electron/scripts/packaged-smoke/g-pub-record.test.mjs` が、`SHA256SUMS` の一致、`verdict.mjs` による判定の再計算と保存した `verdict.json`／`verdict.txt` の一致、3 OS の (34) が pass であること、記録に絶対 path、hostname、利用者名、LAN の IP、MAC、token が無いことを固定する。

## 置かない物

raw の net log、userData、packaged の binary は置かない（net log は SHA-256 と派生の要約だけを各記録の `netLog` に残す）。LAN の IPv4、hostname、試験ごとの nonce は `<lan>`、`<host>`、`<n>` に、repo・一時 dir の絶対 path は `<repo>` などに伏せてある。
