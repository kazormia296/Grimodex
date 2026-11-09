# K6/6（改訂 3、未確認）の dev の予行 4・5（**非判定**）

- **位置づけ**: 非判定の dev の予行。K6/6 の threat model「dev の予行」の 4（確認の前の非判定の予行）。判定・凍結・receipt の正本ではなく、/6 の判定には使わない。凍結の receipt・正式 run の経路は使っていない（`admitDevPreview` の範囲。`frozen-setup-driver.mjs --dev-fixture`、`frozen-k64-run.mjs --dev-fixture`）。D = 40 ms、R1 の下。前回までは `docs/k66-dev-rehearsal-1.md`（予行 1〜3 と integrator の判断）。
- 枝: `claude/k66-harness-proto`。push しない。基点: #830（B′）の merge `3f9e5a4a` を含む master。予行 5 の HEAD は `2e598fea`（#831 の取込み後。fixture の直しの commit を含み、worktree は clean）。
- 生の出力: `.artifacts/k66-rehearsal-2/`（ignore。commit しない）。run の実体は `.artifacts/cp4/k66-r4g0*`（予行 4）・`k66-r5g0*`（予行 5）。集計は `analysis-r5.json`・`analysis-r5.err`（品質の予告と stamp）・`attempt-4a/analysis-r4.*`・`pervariant.mjs`。

## 結論

1. **FR-7 は取れた**（予行 5）。窓内に合流した親 125 件の全件に `followUp.parent.contribution`（`material-revision`）が記録された。
2. **止める条件（落ちた割合が 1/30 を超える）は予行 5 で満たさなかった**。落ちた親 0／125。30 件の下限は予行の全体で 125 件（G-03 単独でも 30）。
3. 予行 4 では、G-08/graph-recovered の 30 件が前回と同じ `FR7:no-expected-contribution` で落ち、止める条件に当たった（30/132）。原因は fixture の形（下）。直して予行 5 で解消した。
4. **/6 の regime の品質の予告は 1 variant が FAIL**（G-08/chronicle-index-unusable。製品の不具合か dev の形かは未決。下の「気づいた問題」1）。

## 予行の回数（この文書の分。前の分は rehearsal-1 の表）

| 回 | 内容 | 結果 |
| -- | ---- | ---- |
| 準備 | #830 の merge 待ち（10 分ごとに確認。05:10Z〜06:30Z、約 1 時間 20 分）。取込み（`62df0695`）後、評価 build（約 5.5 分）・electron build・napi build | 成功 |
| 失敗（build） | 評価 build の出力先が前回のまま存在（EEXIST）で停止 | 予行ではない。前回の出力を `eval-build-rehearsal-1` に改名して取り直した |
| **予行 4** | G-02・G-03・G-06・G-08（5 variant）。待ち 360 秒（06:42:07Z〜06:48:07Z）、run は 06:48Z〜07:31Z。G-08 の dev の形は「語の羅列＋query を引用する control」の版（commit `ca2e7f5f`） | 測定は 4 run とも完了。窓内に合流 132、**落ちた 30（G-08/graph-recovered、`FR7:no-expected-contribution`）**、止める条件に当たる。Raw は G-08 でも 5 件（全 Scene） |
| 失敗（build） | 予行 5 の評価 build が、origin/master が #831 に進んだため `merge-base --is-ancestor` で停止 | 予行ではない。origin/master（#831、renderer の UI の変更。DB に無関係）を取り込み（`2e598fea`）、評価 build・electron build をやり直した |
| **予行 5** | 同じ 4 run。待ち 60 秒（07:36:31Z〜07:37:31Z）、run は 07:37Z〜08:22Z。G-08 の dev の形を直した版（commit `155353ca`） | 測定は 4 run とも完了。以下の集計は予行 5 |

測定が完了した予行は、前回の分と合わせて 1・3・4・5（予行 2 は precheck で停止）。setup と runner の launch は、予行 4 に 4+4、予行 5 に 4+4。重い process は待ちの後、各 run の直前にも確認し、cargo・Electron は無かった（`busy` 0 回）。`windowAssessment.clean` と `candidate.clean`（validation）は予行 5 で問題なし。`validation.json` の error は `candidate.productReceiptSha256 must be a sha256` のみ（dev の予行では製品の standard build の receipt を作らない。従来どおり）。

## 直したもの（dev fixture と集計）

1. **G-08 の dev の形**（`dev-shape-fixture.mjs` の `rawLexicalShape`、`dev-shape-g08.v1.json`）。
   - 原因: Raw は dense（cosine 0.51 の床。sparse の救済床 0.46）と FTS5 trigram の sparse。生成の文（`Dev G-08 text N: the ... line.`）や語の羅列は、query に対し cosine 0.58〜0.88 で、5 Scene の全部が Raw に入り、graph-only の Scene が出なかった。凍結の G-08 は、control が query を引用し、ほかは無関係な平文（cosine 0.34〜0.43）で、答えの Scene は Graph だけが足す。
   - 直し: 凍結の fixture で query を引用する Scene は、dev の query を引用する（`On a mill post hung a copied line: <dev query> Nobody answered.`）。それ以外は、query と無関係な合成の平文 3 文（cosine 0.43〜0.45。query の 3 字以上の語の部分文字列を含まない）。凍結の title・本文は使っていない（E-7 の試験が `Canal board` の一致を実際に止め、語も言い換えた）。**期待（`expectations`）は変えていない**（addedScene は dvs8-5、graph-recovered の pathAttachments は空のまま）。観測に合わせて期待を調整していない。
   - 測定: onnxruntime と tokenizers を venv（`/home/grimodex/k66venv`。リポジトリの外）に入れ、bge-small の int8 で cosine を事前に確かめた（予行 4 の語の羅列は 0.58〜0.63）。
2. **/6 の regime の品質の予告**（`outcome.mjs` の `rehearsalK64Quality`、`k66-rehearsal.mjs` の `assessK66RehearsalQuality`）。dev の receipt の regime は sealed で k62 のため、/6 の品質 FAIL の規則（変える点 6 を含む `k64AvailableQuality`、unavailable の variant の `unavailableQuality`）を samples に当てる。`summarizeVariantQuality` の seal（regime を呼び手が選べない）は変えていない。receipt の `quality` にも判定にも使わない。
3. 試験: `scripts/quality/nir1-graph-eval/*.test.mjs` が 710 件すべて pass（今回足した試験 2 本を含む。S2 の bytes の pin の赤は出なかった）。

## 結果（予行 5。非判定）

D = 40 ms。1 variant の Graph arm の measured は 30 sample。窓内に合流した親 = `classifyJoin` が inWindow の親。

| run / variant | measured | 窓内に合流 | FR-7 記録 | first-render | 落ちた | follow-up | 欠落 | Raw |
| ------------- | -------: | ---------: | --------: | -----------: | -----: | --------: | ---: | --: |
| G-02 base | 30 | 7 | 7 | 7 | 0 | 0 | 23（窓外 X5） | 7 |
| G-03 base | 30 | 30 | 30 | 30 | 0 | 0 | 0 | 8 |
| G-03 frontier-exceeded | 30 | （unavailable の variant）| - | - | - | - | - | 8 |
| G-06 base | 30 | 30 | 30 | 30 | 0 | 0 | 0 | 8 |
| G-08 base-usable | 30 | 28 | 28 | 28 | 0 | 0 | 2（窓外） | **2** |
| G-08 graph-recovered | 30 | 30 | 30 | **30** | **0** | 0 | 0 | **2** |
| G-08 の unavailable 3 variant | 30×3 | （unavailable。steady の集計なし）| - | - | - | - | - | 2 |
| **合計** | 270（steady の Graph arm は 150）| **125** | **125（全件）** | **125** | **0** | **0** | 25 | |

- 窓内に合流した親が 30 件以上: 満たした（全体で 125）。FR-7 の記録: 125 件中 125 件。**止める条件: 落ちた 0／125 で満たさない（status `ok`）**。
- follow-up（first-render でない表示）は steady の全 variant で 0 件。欠落 25 件はすべて Graph が D の窓内に合流しなかったもの（G-02 の 23、G-08 base-usable の 2。first-render の候補ではない）。
- G-08/graph-recovered の観測の寄与は、期待どおり graph-only の Scene（dvs8-5、added-scene）として material-revision に解決された。

### FR ごと（R-6 の (a)〜(c) と FR-1〜FR-8）の下位条件（窓内に合流した親 125 件）

| 下位条件 | 満たした | 欠いた |
| -------- | -------: | -----: |
| (a) R1（reachedQuiet と 4 項目の計算し直し）| 125 | 0 |
| (b) 親の準備が 1 回 | 125 | 0 |
| (c) 次の Graph arm の `preparesReady` との差が 1 | 125 | 0 |
| FR-1 worker の結果 | 125 | 0 |
| FR-2 | 125 | 0 |
| FR-3 stamp | 125 | 0 |
| FR-4 counter の差分 | 125 | 0 |
| FR-5 宣言 used・publishCount 1 | 125 | 0 |
| FR-6 通知・子・IR の再試行が無い | 125 | 0 |
| FR-7 親の寄与（material-revision、unresolvedEdges 0、期待寄与あり）| 125 | 0 |
| FR-8（記録の誤り）| 125（`[artifact]` で止まった親 0）| 0 |

### stamp0-missing の頻度

measured の Graph arm 270 sample のうち、`stamp0-missing` 206、`fresh` 4（G-02・G-03 frontier-exceeded・G-08 base-usable・G-08 graph-recovered に 1 件ずつ）、`none` 60（G-08 の unavailable の 2 variant の 30×2）。steady で Graph が使える variant では 29〜30／30 が `stamp0-missing`。**頻度は予行 3 と同じく高い**（R-7 の読みが効く場所）。FR-3 は窓内に合流した 125 件のすべてが満たした。

### 品質（/6 の regime の予告。判定に使わない）

予行の receipt の regime は k62。/6 の regime（K6/4 の品質の読み。変える点 6 を含む）を samples に当てた予告: 9 variant のうち **measurable 5、fallback-measured 3、hold 0、FAIL 1**。

- measurable: G-02 base（表示 7、first-render 7・follow-up 0）、G-03 base（30）、G-06 base（30）、G-08 base-usable（28）、G-08 graph-recovered（30）。`graph-contributed-parent-not-counted-as-first-render` は 0 件（予行 4 では graph-recovered が FAIL だった）。
- fallback-measured: G-03 frontier-exceeded、G-08 の both-indexes-unusable・graph-index-unusable。
- **FAIL: G-08/chronicle-index-unusable**（`graph-shown-for-a-variant-expected-unavailable`、repeat 0）。予行 4 でも同じ variant が FAIL（予行 3 の samples を同じ読みにかけたものは未実施）。

## 落ちた親（理由・構造的か偶発か）

- 予行 5: 落ちた親は 0 件。
- 予行 4（参考）: G-08/graph-recovered の 30 件（`FR7:no-expected-contribution`、ほかの下位条件はすべて満たす）。**構造的**（dev fixture の形。Raw が 5 Scene の全部を含み、graph-only の Scene が出ず、Graph が path 添付として届いた）。偶発ではない。予行 3 と同じ理由で、直した形（Raw 2 件）で解消した。期待は変えていない。

## A・B′ の前（予行 3）との比べ

| 項目 | 予行 3（#829・#830 の前） | 予行 5（#830 の後） |
| ---- | ------------------------ | ------------------ |
| 窓内に合流した親 | 130 | 125 |
| 落ちた親 | 30（G-08/graph-recovered。fixture の形） | 0 |
| FR-7 の記録 | 130／130 | 125／125 |
| G-02 の窓内合流 | 12／30（予行 1 は 14） | 7／30 |
| Graph の到着（Raw-ready から、合流した sample の p50／p90 ms） | G-03 27.4／30.9、G-06 32.9／34.0、G-08 base-usable 32.3／33.1、graph-recovered 25.3／26.8、G-02 38.2／39.7 | G-03 30.5／33.9、G-06 34.2／37.1、G-08 base-usable 35.8／38.8、graph-recovered 28.5／31.9、G-02 37.3／39.5 |
| Raw-ready（p50 ms） | 18.4〜20.6 | 19.4〜21.2 |
| 1 batch の所要（G-08） | 約 29 分 | 約 32 分 |

A・B′ で Graph の到着が速くなった形跡は、この dev corpus（5〜数 Scene）では出なかった。到着はむしろ数 ms 遅く（p50 で +2〜4 ms）、窓の端に近い G-02（D = 40 ms に対し p90 39.5 ms）が 12→7 に減った。G-02 の合流は D との差が 1 ms 未満で、回ごとのぶれ（14・12・7）に支配される。予行の差は fixture の変更（G-08 の Raw が 5→2 件）も含み、A・B′ だけの効果とは言えない。DB の改善は監査の検証・checkpoint の時間を縮めるもので、この corpus では寄与が小さいと読める（未確認）。

## 気づいた問題

1. **G-08/chronicle-index-unusable が /6 の regime の予告で FAIL**。parent の Graph は `graph-unavailable`（`cancelled`）だが、30 sample のうち 29 件で index-ready の子（`origin: index-ready`、`chronicleIndexUsable: true`、`edgeCount: 1`）が `graph-ready` で Graph を表示した。つまり dev の run の途中で Chronicle の index が回復し、variant が宣言する「unusable」が保たれない（凍結の手順では precondition `index-state-holding` が unmet で、variant は `blocked:index-state-holding` になるはず）。**予告の品質の読み（`unavailableQuality`）は precondition を見ない**ため FAIL になる。製品の不具合なのか、/6 の品質を「precondition が満たされた variant だけ」に当てるべきなのかは、人が決める点。S4 以後の正式 run でも同じ形が出る可能性がある。
2. G-02 は窓内に合流する割合が 7／30 まで下がった（予行 1・3 は 14・12）。30 件の下限は予行全体では問題なし（125）が、G-02 は D = 40 ms の端にあり、run ごとのぶれが大きい。
3. dense の床が Raw の membership を決めるので、dev の形（凍結の構造のまね）では、Scene の文の cosine を事前に測らないと「Graph だけの Scene」が出ない。dev fixture を作るときの注意として、`dev-shape-fixture.mjs` の注に残した。
4. 評価 build の出力先が既存だと EEXIST で止まる。取り直しのたびに前回の出力を改名する必要がある（rm は使わない）。origin/master が進むと build が祖先条件で止まるので、予行の前に取り込む。
5. `fallback-measured`（unavailable の variant）の first-render は集計されない（前回の 5 と同じ）。
