# S2 の第 1 段の凍結（2026-11-19 未明、統合者）

- 根拠：ユーザーの回答「A2b の merge 後に進める」（contracts `7f4c2cea`、寝る前の 4 問）。S1-A2b は #949 で master `90c8f9ae` に merge 済み。
- 凍結した事前登録：`fusion-eval-data/design-notes/chat-ir-2026-11-08/s2-harness/prereg-s2-draft-r2.md`
  - 凍結の操作：1 行目から「草案」「下書き」を 2 か所とも外しただけ（2 行目以降は凍結前と同一。写しは `prereg-s2-draft-r2.pre-freeze.md`、sha256 `554c33a7…0d92`）。
  - **凍結後の sha256：`a16728f921f0f0800126d99efa1a105673c24ba5b71e57b54d5e994c4f4e7ced`**
  - ir-slot（9930ab64 の `assertRunnable`）と S2 の live（`assertLiveAllowed`）の gate が、この sha で OPEN、違う sha で拒否することを API なしで確かめた。
- 凍結の前の点検（read-only の独立の点検で「凍結してよい」）：
  - 抽出の build：第 6 版の build-ir-24 の成果物は 11-17 の片付けで消えていたので、同じ HEAD `9930ab64` から作り直した（build-ir-25、receipt sha256 `4d7065fa…926e67`、passed）。JS の成果物 3 つは build-ir-24 と同じ sha256、native の `.node` だけ違う（build の path の埋め込みと推測、未確認）。作業場所は git worktree ではなく独立した clone（standard-build の base 検査のため。prereg §3 に記載）。
  - dry-run（`90c8f9ae`、API 0 回）：全段通過、harness の試験 54 件、`harnessSha256` は今の file と全件一致。
  - `s2.mjs verify`：gold `064c9ae4…`、manuscript `a919fd63…`、judge v3 `80eaa8fb…`、config `3774ad14…`。
- **統合者の判断（ユーザーが寝た後。朝に報告。凍結に入った）**：prereg §15.1 の 7 項目。
  - Q15：0 件の率・平均件数の分母は「届いた呼出し」に限る。旧い分母での同じ規則を感度分析として並べ、τ* が割れたら自動で選ばず止めて伺う（`analyze` が exit 2）。
  - Q14′：注入の導入文は「承認済み（human-approved）」だけ（「作者が」を外した）。
  - Q16：盲検の「検索結果→原稿」の置換は残す（pilot で較正済み、件数は事後に見られる）。
  - 停止規則の「IR を引いた」は、届いた呼出しのある回答に限る（厳しい向き）。
  - turn の累積上限（6 回・20,000 字）を製品と同じ値で置く（S2 の後に見直す仮の値。返す件数の多い τ ほど先に枠を使い切る混ざりがある）。
  - 空の query の数え方。D3 の合わせ直し。
  - これらをユーザーが覆す場合は、改訂 3 と再凍結が要る。
- 凍結物の sha256 の一覧：下（`s2-harness/freeze-sha-2026-11-19.txt` と同じ）。
- 抽出の費用の自動停止：`fusion-eval-data/s2-extract-2026-11/tools/extract-cost-guard.mjs`（$12 か失敗の場面 15 超で ir-slot を止め、止まったことを確かめる。合成の値の自己試験 6 件が通過）。

```
a16728f921f0f0800126d99efa1a105673c24ba5b71e57b54d5e994c4f4e7ced  prereg-s2-draft-r2.md
3774ad1463ba4f19de07032f1bbc1f87ff6d0a14715476ce946d0ba7ae243faf  config.mjs
d1c981d29b38ea62397c9305241cf9ebb18be6380a28defcda6614462fda40a7  s2.mjs
45086e26b5ad32543b4d1fd86e547bd4bf6c22215420e2da0365ad99890225a8  lib/agent-loop.mjs
f46899e55b54c9fe8a5c130a10614b82c97469eec91171d3f2fbf146098ac09e  lib/analysis.mjs
3926c352e046ea8d34bc57a0a652e563ad828f69f5b1aa6823cb489749458f9a  lib/anthropic.mjs
86c3ced2b31f5f821e0fdcbda10978b52a055963dc7c6ad36baef9339464476a  lib/embed.mjs
483aa087ddbd0a4a8311479dabfd6cb684af872169a7ffa67e5825b59702bfb3  lib/gen-product-chat-ir.mjs
45b97dd81d62d86791fe8ad9d5aea3164e2e20e35ad8b451ea52deb140834f55  lib/gold.mjs
ed4912c1a7c5eb828b112b8b79430404cf29761d3c0680f8e0e41eaaaa231a9b  lib/integrity.mjs
5a0c5d3845fd5cb1c63f657a67f3ddac1ebb7480b0f51d3ad14917e0f30677f9  lib/ir.mjs
a1f89b9f583aec38ebedce368cc588ec631cbd744a065e44a4ee083dc5684289  lib/judge.mjs
81833a7756a8f295b0bd0fdb948be2c19a1bc16a99b45f660dce258bf1887e6a  lib/labels.mjs
e3664b67714130efe775e177c0b0a7bfa6cefad568c6c611d78d5b727ad7a885  lib/leak.mjs
7bb36cb682847d0e2d9c135674bc1183d86a8d358c32bcb9d041db2ab39a661b  lib/ledger.mjs
3865ab57a439843b1cb3708113c5c2384ca17651313186be8655f59132817269  lib/manuscript.mjs
295f3426abfce179daf2a8af2b303eebcb605ecd115b757adeb0fd87d454e713  lib/product-chat-ir.generated.mjs
ded177c5aaf368ead1a8bbd36fa3a56005a216b4e5825a30a6c7ff889b052700  lib/tools.mjs
b446cf3ec533fe1637deb89f7a0890f4f23e17fad6e120452864dd23cf0f0942  lib/transport.mjs
d992666066ce615b577c22d5095e977d7011b11feaae4df531447c1d59966501  lib/util.mjs
598e23bd8b12430e82e9f9b8ae717832b964aa2df83d1748701b7616511d2bd4  tests/harness.test.mjs
3a30162f926101070a237cf17519381abb9219926cc4383f2d329cb6dbff6da9  dry-run.sh
4c10c967505e827eac1ffdd713aab0aa77df50ece469c0845bf7532b7d94154b  dry-run-record.mjs
72d70b6ec256e4be8dd90f8715a37fc3210d435a4350f445eb879a7287d825a7  product/build-system.mts
6ed6fe8e281a3fb100a6c89812fc972e45b5a06ad7b8e9df7c12d799bbca127f  out/scenes-s2-ja-1.json
2a42303a5ac7e985dd36d3048d24373f2214364d7c7908f6d4311561e36c16d8  dry-run-out/dry-run-record.json
4d7065fa3349be8d4932e234d60b9300c6d34d330ff4d320ba9bb5366e926e67  pd-2026-11/build-ir-25/standard-build-receipt.json
866f10c179dc985d5aa79edc696ab33860da69904f286bb11d5ed30a94aba750  s2-extract-2026-11/tools/extract-cost-guard.mjs
054c1f02acbd47b8fe87c945f8e867b7ba663107bb9d637e28b99ca211de45ef  s2-extract-2026-11/tools/run-s2-extract.DRAFT.sh
```
