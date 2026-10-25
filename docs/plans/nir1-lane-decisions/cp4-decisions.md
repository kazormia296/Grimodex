# CP-4 の委任判断の記録（継続計画 §3.2 の形式）

CP-4（Graph arm を実 Electron で初めて観測する計測 lane）の判断記録。出所は K2/4、K6/2（`docs/plans/nir1-final-request-eval-proposal-2-draft.md`、凍結の commit `af643a93eeae7f937c9cd5a9dd87a6308c96fab6`、sha256 `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8`）、X1/1、proposal/7、CP-0 の `evals/nir1-graph/`（`freeze.v1.json` の sha256 `6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`）。閉じた gate（`PRODUCT_GRAPH_PUBLISHED=false` ほか）は変えない。

各 subtask の builder が自分の見出しの節だけを書く（同じ file を並行して編集するため）。

## 共通（integrator）

（integrator が DR-CP4-0〜19 を書く。）

## S1a（Native の評価 feature）

（S1a の builder が書く。）

## S1b-pure（harness の pure な部分。node だけ）

範囲：TASK §5 S1 の harness のうち、Electron も Native も動かさずに書けて node:test で検査できる部分。窓と指標の計算、可用性の分岐、receipt の形と検査、`SHA256SUMS`、Graph arm の接続の契約、前提条件と判定。実 Electron の observer、静的 server、setup driver の実行は S1c、観測前の commit は S2〜S4 の担当。cargo と実 Electron は走らせない。凍結済みの G-case の材料は Graph に通さない（この節の試験は合成の値だけを使う。variant の目録の試験だけが凍結 file の variant ID と `expectations.graph.status` を読む。これは Graph の入力ではない）。

### mutation の前の判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP4-S1B-1 | 2026-10-25 | CP-4 S1b-pure（branch `claude/nir1-cp4-s1b`） | 置き場所は新しい directory `scripts/quality/nir1-graph-eval/`。`constants.mjs`（凍結の値と 13 variant の目録）、`availability.mjs`（(a)／(b) と分岐）、`receipt.mjs`（receipt、宣言の照合、計測窓、`SHA256SUMS`、起動 env）、`outcome.mjs`（前提条件と判定、24 件の一致）、`admission.mjs`（git の事実の収集）に分ける。Graph arm の guard 自体は `scripts/quality/nir1-retrieval/contract.mjs` に置く（TASK D14、§15.2） | harness は trusted だが、入力の receipt と sample は観測の結果で untrusted とみなし、形と整合を検査して throw する。新しい受信先、IPC、env、設定の入口は足さない | 1 file にまとめる（読みにくい）／`nir1-graph/` に足す（freeze が束縛する directory の近くを避ける） | なし（委任の内側の構成の判断） | 該当なし | 不要（process も timer も持たない pure な関数。`admission.mjs` の git の読取だけが同期の子 process で、retry なし・終了を待つ） | 記録済み |
| DR-CP4-S1B-2 | 2026-10-25 | 同 | D＝10.84 ms、lease 100 ms、物差し 1%、warm-up 5／測定 30、Q≥200 は `constants.mjs` の凍結した定数で、関数は引数でこれらを受け取らない。D／lease／物差しに当たる option（`d`、`dMs`、`windowMs`、`leaseMs`、`yardstick` など）を渡すと `[precheck]` で拒否する（N-9）。率の比較は整数（`分子×100 ≤ 分母`）で行い、浮動小数の丸めで 1% の境界が動かないようにする | 閾値を測定の側から変えられないこと | option で受け取り既定値を置く（N-9 に反する） | なし | 閾値の緩和に当たらない（値を変えない） | 不要 | 記録済み |
| DR-CP4-S1B-3 | 2026-10-25 | 同 | 窓内の判定は K6/2 手順の 5 のとおり `arrivedAt ≤ t_raw_ready + D`（両端を含む）。製品の合流 helper（`nir1RelatedScenesDeadline.ts`）は `now < deadline` で、`RELATED_SCENES_IR_EXTRA_WAIT_MS` は 10.840000000596048 なので、境界の 1 点で両者がずれうる。harness は「製品が合流した（`joined`）」と「時刻が窓内」の両方を求め、合流したのに時刻が窓外なら遅れを混ぜたとして throw する（N-7）。製品の定数は変えない | 遅れた結果を窓内に数えないこと | 製品の strict な比較に合わせる（K6/2 の文と違う）／時刻だけで判定する（製品が合流しなかった結果を窓内に数えうる） | なし | 該当なし | 不要 | 記録済み。integrator に返す（境界の食い違いの開示） |
| DR-CP4-S1B-4 | 2026-10-25 | 同 | (b) の失効の (i)〜(iv) は「1 つの query は 1 回だけ数える」ので、(i)〔B の seal、Chronicle の停止の順〕→(ii)→(iii)→(iv) の順で先に当たったものに入れる。順序は内訳にだけ効き、失効率は変わらない。`registration-unavailable` は snapshot の記録が usable でも (i) の B の seal に入れる | 規則の文どおり、失効を鮮度に数えないこと | 内訳を重複して数える（「1 回だけ」に反する） | なし | 該当なし | 不要 | 記録済み |
| DR-CP4-S1B-5 | 2026-10-25 | 同 | 可用性の分岐は TASK §15.4 のとおり。(a) が物差しを超えたら HOLD で、(b) の値は記録と開示だけ（(iii) の診断も `[precheck]` も出さない）。(a) が内側で (b) のどれかが超えたら HOLD と「(iii) の診断が要る」だけを返す。失効率による `[precheck]` は (iii) などの診断を判定する別の関数（`evaluateDiagnosticCondition`）の中でだけ起こし、その関数は (iii) では CP-4 の receipt の先頭の trace の file と同じ commit と sha を求める。`graph-ready` などの再 query の行は (a)／(b) の分母に入れず、D5／A3 の別の欄にだけ集める | 結果を見て分岐や分母を選べないこと（T-1） | CP-4 の receipt の上で失効率の `[precheck]` を出す（§15.4 で訂正された旧 D16-3） | なし | 該当なし | 不要 | 記録済み |
| DR-CP4-S1B-6 | 2026-10-25 | 同 | Graph arm の guard（`assertGraphArmRequestable`）は既定の `not-wired` を従来どおり受け付け、`wired` は admission を伴うときだけ受け付ける。24 件と P（scope `existing-queries`）は製品の standard-build の受領書（`nir1-standard-build/1`）だけで許し、評価の受領書は拒否する。G-case（scope `graph-case`）は評価の受領書（`nir1-graph-eval-build/1`。`.node` と worker は `.artifacts/cp4/eval-build/` の下だけ、feature `nir1-graph-eval`、capability `nir1GraphEval: true`）を求め、fixture の path で分ける。dev fixture（`scripts/quality/nir1-graph-eval/dev-fixtures/`）は評価の受領書だけで許し、凍結した fixture（`evals/nir1-graph/`、`evals/nir1-g01/`）は、観測前の commit が候補の HEAD の祖先で remote-tracking ref にあり、freeze 記録の sha がその commit と HEAD で同じときだけ許す（§15.8、N-1）。それ以外の path は拒否する（N-16）。既存の runner（`paired.mjs`、`run-nir1-retrieval.mjs`）は admission を渡さないので、挙動は変わらない（`wired` は従来どおり拒否） | 評価の入口を製品の候補に混ぜないこと（T-2）、観測前の commit より前に凍結の材料で Graph を動かさないこと（T-1） | 評価の受領書があれば 24 件も許す（§15.2 で訂正された §6 P-1）／guard を runner の側に置く（契約の正本が分かれる） | なし | 製品の gate を開けない（harness の受け付けの規則だけ） | 不要 | 記録済み |
| DR-CP4-S1B-7 | 2026-10-25 | 同 | remote にあることは、`git for-each-ref refs/remotes --contains <commit>` が 1 件以上返すことで確かめる（network に出ない。`standard-build.mjs` が `refs/remotes/origin/master` を使うのと同じ作法）。`git ls-remote` は外向きの操作なので S1b-pure では呼ばず、記録 branch の `ls-remote` は S4 で integrator が取る | 新しい外向きの通信を足さないこと（T-3） | `ls-remote` で確かめる（network。S1b の範囲外） | なし | 該当なし | git の同期の子 process（retry なし、exit を待つ） | 記録済み |
| DR-CP4-S1B-8 | 2026-10-25 | 同 | 前提条件 6 種は、variant が宣言したものだけを receipt の証跡から判定し、`resolveVariantOutcome`（`scripts/quality/nir1-graph/contract.mjs`）にそのまま渡す。証跡が欠けたら unmet（blocked）にし、満たしたとは扱わない。G-01 は前提条件を宣言しないので、B の seal に届かなければ v1 期待値未達の Hold にする（D2）。宣言が current でない、または宣言の段の前後で Index の metadata が違うときは blocked にせず `[precheck]` で止める（N-5、N-6） | 既存の validator を弱めないこと | 自前の判定を書く（P-6 に反する） | なし | 該当なし | 不要 | 記録済み |
| DR-CP4-S1B-9 | 2026-10-25 | 同 | 計測窓（D3）の証跡は、run の前と後の標本があり、隣り合う標本の間隔が予定の 20 秒の 2 倍以下であることを求める（1 回の取りこぼしまで。これより開いた run は証跡の欠けとして組から外す）。違反は heavy の slot の使用、build の process、別の計測、同じ worktree の build が観測されたことだけで決め、負荷の数値の閾値は置かない（GDX-PRECHECK-001）。外した run は理由つきで残す（N-14） | 測定の汚れを結果を見ずに外すこと（T-5） | 間隔の検査を置かない（窓の証跡にならない） | なし | 容量・負荷の固定閾値を置かない | 不要 | 記録済み |

### 実装後の追記（2026-10-25）

commit：`1468affa`（この節の mutation の前の記録）、`6a1e356a`（Graph arm の guard）、`87ac90d8`（`scripts/quality/nir1-graph-eval/` と試験の登録）。DR-CP4-S1B-1〜9 は記録どおりに実装した。変えた判断は無い。

#### 公開する関数（S1c と S2 が使う interface）

| file | 関数 | 入力 → 出力 |
|---|---|---|
| `nir1-retrieval/contract.mjs` | `assertGraphArmRequestable(requested, admission)` | `"not-wired"` → `{wiring}`。`"wired"` と `{scope:"existing-queries", buildReceipt, seedPolicy}` か `{scope:"graph-case", buildReceipt, fixturePaths, observationPrep}` → 凍結した admission。それ以外は `[precheck]` |
| 同 | `classifyGraphFixturePath(path)`、`assertProductBuildReceipt`、`assertEvalBuildReceipt`、`assertObservationPrepAdmits(facts, head)` | path → `"frozen"`／`"dev"`。受領書と事実の形を検査して throw |
| 同 | `describeGraphArm({seedPolicy, admission})`、`summarizeGraphArm(arm, comparisons)` | 24 件の wired の arm は `not-requested`、一致なら `equal-to-hybrid`。`pass` は常に false |
| `nir1-graph-eval/admission.mjs` | `collectObservationPrepFacts({root, commit, candidateHead, freezeRecordPath})` | local の git から `assertObservationPrepAdmits` の入力を作る |
| 同 | `readK62FreezeHead({root, commit})`、`assertDefaultAddonIsNotEvaluation({defaultAddonSha256, evalReceipt})` | receipt の先頭の K6/2 の値。読めなければ receipt を書かずに止める |
| `availability.mjs` | `graphCaseScheduleKeys(variantKey)`、`validateGraphCaseSchedule(samples, keys)` | AB／BA の予定と照合 |
| 同 | `joinedWithinWindow(sample)`、`steadyStateInWindow(sample)` | 窓内の判定。遅れを混ぜた sample は throw（N-7） |
| 同 | `summarizeSteadyState({samples, fixedGraphMode})` | (a) の pool、case ごとの値、品質 HOLD の variant、再 query の別欄 |
| 同 | `summarizeTrace({trace:{kind, queries}, fixedGraphMode})`、`validateTraceEvents(kind, events)` | (b) の Q、U、窓外率、失効率と (i)〜(iv)、区分、主な理由。trace の密度 |
| 同 | `decideCp4Availability({steadyState, traces})`、`evaluateDiagnosticCondition({kind, steadyState, traces, traceFile, cp4TraceFile})` | §15.4 の CP-4 の判定（`[precheck]` を出さない）。診断の rule 6（ここだけが失効率の `[precheck]` を出す） |
| `receipt.mjs` | `validateCp4Receipt`／`assertCp4Receipt`、`receiptHeadErrors` | §7.2 の最小集合の検査 |
| 同 | `assertDeclarationCurrent({declaration, measurementWorkspace})` | 宣言が current で Index の metadata が同じなら `{proceed:true}`、違えば `[precheck]` |
| 同 | `assessMeasurementWindow({samples, run, ownPids})`、`selectReceiptsForAggregation(receipts)` | 計測窓の判定と、理由つきの除外 |
| 同 | `assertElectronLaunch({env, argv})`、`formatSha256Sums`／`parseSha256Sums`／`writeSha256Sums`／`verifySha256Sums` | 起動 env の検査、`sha256sum -c` 互換の `SHA256SUMS` |
| `outcome.mjs` | `unmetPreconditions`、`resolveCp4VariantOutcome`、`summarizeVariantQuality`、`compareExistingQueryGraphArm` | 前提条件と Hold／blocked、手順の 8 の品質、24 件の一致 |

評価の受領書の schema（`nir1-graph-eval-build/1`）は guard が求める形として決めた。受領書を作る `standard-build.mjs` の評価の mode は S1b-pure の範囲外で、作る担当は integrator が決める。

#### 試験の対応（TASK §6）

P-1、P-2、P-4、P-5、P-6、P-9、P-10、N-1、N-3（受領書の部分）、N-4、N-5、N-6、N-7、N-8（`summarizeGraphArm` の pass が常に false）、N-9、N-11、N-14、N-15、N-16 と、§15.4 の分岐、§15.2 の既定の addon の拒否、§15.10 の「`graph-ready` の再 query を (a) の分母に入れない」を node:test で固定した（`scripts/quality/nir1-graph-eval/*.test.mjs` の 40 件、`scripts/quality/nir1-retrieval/contract.test.mjs` に 5 件を追加）。P-3 は宣言の照合の pure な部分だけで、合成の dev fixture を実 Electron に通す部分は S1c。P-7、P-8、N-2、N-10、N-12、N-13 は範囲外（S1a、standard-build、S1c、S2）。

#### 検証（実行したもの）

- `node --test scripts/quality/nir1-graph-eval/*.test.mjs`：40 件 pass。
- `node --test scripts/quality/nir1-retrieval/*.test.mjs`：36 件 pass。`node --test scripts/quality/nir1-graph/contract.test.mjs`：27 件 pass。
- `node scripts/quality/validate-nir1-retrieval.mjs --require-freeze`：valid。`pnpm eval:fixtures`：errors なし。
- `node --test scripts/quality/impact-map.test.mjs`：37 件 pass。`node --test scripts/quality/quality-workflow.test.mjs scripts/quality/eval-fixtures.test.mjs`：33 件 pass。
- `pnpm eval:impact --base origin/master`：Fallback no、未分類の path なし（`scripts/quality/**` の critical path なので Light は全 suite）。
- `prettier --check`（新しい file と `nir1-retrieval/contract*.mjs`）、`eslint`（同）：問題なし。`impact-map.mjs` と decisions の md は master の時点で prettier に合っていないので整形しなかった。
- 変異 28 種を 1 つずつ入れて該当の試験が落ちることを確かめ、すべて元の bytes に戻した（sha で確認）：D を 11、`<=` を `<`、1% を 2%、pool を case ごと、(iv) を数えない、cache を (a) の窓内に、分岐の入替え、再 query を分母に、override を受け付ける、主な理由のちょうど半分を過半数に、重なった `busy` を鮮度に、N-1 の guard を外す（2 経路）、祖先の検査を外す、24 件で評価の受領書を許す、clean の検査を外す、path の allowlist を外す、receipt の先頭の K6/2 を省く、宣言の前後の比較を外す、宣言の不一致を blocked に、窓の証跡を無視、env の除去を外す、`resolveVariantOutcome` を自前の判定に、比較の field（excerpt）を外す、seed の検査を外す、窓内 0 件を HOLD にしない、証跡の欠けを満たしたとする、K6/2 の sha の照合を外す。

実行しなかったもの：Quick／Full、cargo、実 Electron、`git ls-remote` などの外向きの操作。

#### integrator に返す点

1. 窓の境界：K6/2 は「`t_raw_ready + D` までに」で両端を含むが、製品の合流 helper は `now < deadline`、D は 10.840000000596048 である（DR-CP4-S1B-3）。harness は製品が合流したことと時刻の両方を求めるので、境界の 1 点で「製品は合流したが harness は窓外」となりうる。その場合は N-7 として throw する（記録が止まる）。境界をどちらに揃えるかの判断が要る（閾値の変更ではないが、K6/2 の文の読み方）。
2. (a) の定常状態で snapshot が usable でない sample は、K6/2 の分母の定義から外れるので、黙って除かず run を setup の不備として無効にした（取り直し）。
3. `graph-late` で開始時の slot か鮮度の stamp の記録が欠けたものは「その他」に入れた（規則は記録がある場合だけを定める。鮮度に数えない側に倒した）。
4. 評価の受領書の schema と、`.node` の隣の worker の固定名 `nir1-c-query-worker` は guard の側で決めた。S1a と standard-build の評価の mode をこれに合わせるか、guard を合わせるかを決める。
5. 計測窓の標本の間隔の上限（予定の 20 秒の 2 倍）は証跡の欠けの判定で、負荷の閾値ではない（DR-CP4-S1B-9）。
