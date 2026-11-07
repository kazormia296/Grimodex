# ⑤ trace（S4b''・候補 `86427ee5`、run `trace-editing-s5r4-1`／`trace-browsing-s5r4-1`）の記録：2 件とも完走し、受領書は valid

2026-11-01（UTC）に integrator が実行した、CP-4 の ⑤ の (b) trace（`trace-runner.mjs`、frozen、`--trace-kind editing|browsing`）。④ SP-P4（`sp-p4-s5r4-1`、passed）の直後に、同じ候補・同じ S4b''（`557e683c`）で取った。旧 S4b' の下の 2 件（`trace-*-s5r3-1`、受領書 invalid）は開示に残し、判定に入れない（`s4-revocation-9f52e7da-2026-11-01.md`）。**この README は受領書の数値の事実を写す。(b) の判定は S6 の集計で行い、ここでは解釈しない**。

## 結果

| run | 時間（UTC） | 台帳 | 受領書 `status` | `attemptOutcome` | `problems`／`defects`／`stalled` |
|---|---|---|---|---|---|
| `trace-editing-s5r4-1` | 00:20:41Z〜00:36:36Z | completed（attempt 1） | **valid** | completed | 空／空／null |
| `trace-browsing-s5r4-1` | 00:36:56Z〜00:40:43Z | completed（attempt 1） | **valid** | completed | 空／空／null |

`statusReasons` は両方とも空。K6/2・K6/4 とも `status: valid`、`invalid: []`、`violations: []`。Native の整列は両方 `aligned: true`（editing：seeded begin 204 = Native 記録 204、browsing：402 = 402、窓の外の末尾の除外 `excludedAfterWindow` は null）。旧 run で無効の原因だった 3 つの不備（Native 記録の件数の不一致、F-6 の resolver 未配線、`parseArgs` の既定）は、今回は現れていない。

### editing（`trace-editing-s5r4-1`）

- Q = 201、**U = 1**、窓の中 0 件・窓の外 201 件（窓の外の U = 1、`outOfWindowExceeds: true`）。
- 失効（lapse）200 件、すべて **(i) B の封印**（`i-b-seal` 200、うち begin の前に取り消された counted parent 3 件〔`cancelledBeforeBegin`〕）。`lapseRate` 0.995、`lapseExceeds: true`。残り 1 件は `freshness-stamp-stamp0-missing:overlap-record-missing`。`mainReason: lapse`。
- outcomes：`graph-unavailable` 191、`graph-late` 7、`cancelled` 3。
- 取り消された counted parent（DR-CP4-V-3）は 3 件（`nir1-cp4-trace-editing/1#82`〔seq 87〕、`#104`〔110〕、`#136`〔143〕。いずれも index-ready の約 3.6〜3.7 ms 後、開始時の封印は dirty）。再 query は 6 件（graph-ready 2、index-ready 3、unattributed 1、outside-q 0）。cycle end の後に呼ばれた再 query（DR-CP4-V-4）は 4 件（上の 3 件の親の再 query と、`#152` の seq 161。cycle end の 329〜371 ms 後）。これらは規則どおり子にされず、開示されている（`requeryAfterCycleEnd`）。K6/4 は valid で `violations` は空。

### browsing（`trace-browsing-s5r4-1`）

- Q = 201、**U = 201**、窓の中 0 件・窓の外 201 件（`outOfWindowExceeds: true`）。
- 失効 0 件。`freshness` 171（`graph-late:stale-start`）、`other` 30（`freshness-stamp-stamp0-missing:clear` 28、`freshness-stamp-unavailable:clear` 2）。outcomes は `graph-late` 201。
- 再 query は graph-ready 201（うち Q の外 200、すべて completed）。取り消された親・cycle end の後の再 query は 0 件。

### 1% の yardstick（`exceedsYardstick(outOfWindowU, U)`）

どちらの trace も `outOfWindowU / U` が 100%（editing 1/1、browsing 201/201）で、1% を厳密に超えている（`constants.mjs` の `exceedsYardstick`）。**この README は、それが (b) の判定にどう響くかを判断しない**（S6 の集計と S7 の報告で、S2 の規則を当てる）。

## 開始時の封印と stderr（`start-seal-extract.json`、観測の sha256 つき。解釈はしない）

- editing：開始時の封印は 201 件中 current 1、dirty 200。B（entity-relation index）は before で `generation=1 dirty=false` 1 件、`generation=1 dirty=true` 1 件、`generation=2 dirty=true` 199 件。Chronicle の generation は before で 3〜202、dirty は before で 200 件。**前回（`trace-editing-s5r3-1`）は B が 201 件とも generation=1、200 件で dirty=true だった**ので、今回は B の generation が 1 から 2 に進んだ点が前回と違う（dirty のまま残った件数は同じ）。原因は調べていない。
- browsing：201 件すべて current（B は generation=1 で dirty=false、Chronicle は generation=3 で dirty=false）。
- prep Main の stderr の `[narrative-maintenance] discovery failed: … NEX_VALIDATION_TERMINATED:context-unavailable` は editing・browsing とも 3 件。**editing は Entity/Relation 2 件と Chronicle 1 件、browsing は Entity/Relation 3 件**（前回の editing の 3 件は Chronicle の文言だった）。measure Main の stderr には 2 つとも出ていない（debugger の 2 行のみ）。editing で B が dirty のまま残ることとの関係は未確認（DR-BSEAM-5 は別 lane への報告で、確認済みではない）。

## 台帳と実行

- 台帳 `attempts/trace-editing-s5r4-1.json`：開始時の sha256 `43f012278345b6f816666d5dfb51146f77bfc9241e8417c414ecff259f444770`（contracts の `6c2fa83a`）→ 終了後 `87a00a5de01ec9d58eb35b7b3f8818b96ca586a9d91e6e7cd8e49fead7f01f59`。`attempts/trace-browsing-s5r4-1.json`：開始時 `1c4a3ae3e1c39a0bd08915455b80fa04e7cbab7d91f8bd0855d401a7b16b7b8c`（`552ee8ae`）→ 終了後 `abe795835a0ff3c60b080e87e65b9acf13988026dcd0fd4beb470f71f03f9756`。受領書・run-report の sha256 は `files.sha256`。
- 台帳の key は (trace file、trace の commit `f7a42789`〔S4a''〕、trace file の sha256、候補 `86427ee5`)。attempt は 1（取り直しなし）。
- 候補 `86427ee53a73e669e34631c5774fbd56960ac050`、`--prep-commit 557e683c…`、`--procedure-version v1 --procedure-commit 557e683c…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--setup` は G-02/base の完全な setup（`s5r4-g-02-base`）、`--sp-p4-receipt` は `sp-p4-s5r4-1/sp-p4-receipt.json`。trace-runner は `--keep-test-worktree` を受けない。静けさの確認（`wait-quiet.sh 3`、3 回連続）は editing の開始前に 1 回だけ行い、browsing は editing の終了の 20 秒後に続けて開始した（browsing の前の個別の検査は無い）。trace の受領書は窓の sampler の記録（`windowSamples`）を持たない（`environment` は hostSnapshot、windowAssessment、removedEnv、netns、netLog、observer、stop）。`windowAssessment` は `clean: true`（違反・欠けとも空）だが、sample を入力にしていないので、測定中に他の process が無かったことの証拠ではない。環境：AMD Ryzen 5 3600、12 論理 CPU、load average（終了時）0.12／0.59、cpuPressure some avg10=0.00。
- 起動の不備（precheck の draft、EEXIST）は今回は起きていない（`parseArgs` を直したうえで、`--procedure-version`・`--procedure-commit` を明示した）。
