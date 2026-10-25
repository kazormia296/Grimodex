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
| DR-CP4-S1B-3 | 2026-10-25 | 同 | 窓内の判定は K6/2 手順の 5 のとおり `arrivedAt ≤ t_raw_ready + D`（両端を含む）。製品の合流の判定は renderer の TS にある（`src/features/related-scenes/nir1RelatedScenesGraphJoin.ts:211-213` の `performance.now()` と `now < deadline.deadlineAtMs`、`nir1RelatedScenesDeadline.ts:89-93`、D は `relatedScenesConfig.ts:7` の 10.840000000596048）。Rust ではない（2026-10-25 の独立 review の訂正）。境界の 1 点で両者がずれうる。harness は「製品が合流した（`joined`）」と「時刻が窓内」の両方を求める。合流したのに時刻が窓外のときの扱いは DR-CP4-S1B-10 で決め直した。製品の定数は変えない | 遅れた結果を窓内に数えないこと | 製品の strict な比較に合わせる（K6/2 の文と違う）／時刻だけで判定する（製品が合流しなかった結果を窓内に数えうる） | なし | 該当なし | 不要 | 記録済み。DR-CP4-S1B-10 で補った |
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

### 独立 review の反映（2026-10-25。Opus、read-only。P1 5、P2 12、P3 5）

mutation の前の判断（integrator の決定を含む）：

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP4-S1B-10 | 2026-10-25 | CP-4 S1b-pure | 窓の境界（integrator の決定）。窓内＝製品が合流した、かつ `arrivedAt ≤ t_raw_ready + D`。`arrivedAt` は合流 helper が比べたのと同じ renderer の `performance.now()` で取る。食い違いを 2 種に分けて (a) と (b) の両方に `boundaryDisagreement` として書く：(i) 合流していないが時刻は窓内（K6/2 の窓外。止めない。件数を開示）、(ii) 合流したのに時刻が窓外。(ii) は許容幅 `BOUNDARY_TOLERANCE_MS`＝0.01 ms（10 µs）の内側なら保守側の窓外（(b) の区分は「その他」）、超えたら製品の N-7 違反の疑いとして `[precheck]` で止める。許容幅の根拠：同じ時計（renderer の `performance.now()`）で比べるので時計の差は無く、残るのは `<` と `≤` の違いと D の端数 6e-7 ms だけで、µs の桁で足りる。手順 8：(ii) の許容幅の内側の sample は最終結果に Graph の行を含むので、その variant を fail にせず HOLD（理由 `boundary-disagreement`）にする | 遅れを窓内に数えないこと、計器と製品の食い違いを結果を見て選ばないこと（T-1） | 1 ms（広すぎる）／許容幅なし（境界の 1 点で記録が止まる） | integrator の決定 | 閾値の緩和に当たらない（D と 1% は不変。許容幅は分類の規則）。observation-prep に登録して review を受ける項目として開示する | 不要 | 記録済み |
| DR-CP4-S1B-11 | 2026-10-25 | 同 | 観測前の commit の照合（P1-1、P2-1）。記録の path は定数 `evals/nir1-graph/observation-prep-freeze.v1.json`、schema は `nir1-cp4-observation-prep-freeze/1`。中身として `graphRuntimeObservedBeforeFreeze:false`、K6/2 の凍結の commit と sha、`freeze.v1.json` と G-01 の fixture の path と凍結の sha、`boundFiles`（path→sha、空でない）を求め、束縛する各 file の sha が候補の HEAD の bytes と一致することを確かめる。その commit が記録を入れた commit である（どの親にも記録が無い）ことと、`refs/remotes/origin/master` の祖先であることを求める（ほかの remote-tracking ref では通さない） | 観測前の commit を無関係な commit で代用させないこと（T-1） | 呼び出し側が path を渡す（review の再現で迂回できた） | なし | 該当なし | git の同期の子 process | 記録済み。S2／S4 はこの schema で記録を作る（integrator に返す） |
| DR-CP4-S1B-12 | 2026-10-25 | 同 | 評価の受領書と fixture（P1-2、P1-3、P2-10）。artifact の key は空、`.`、`..` の要素、`\`、絶対 path を拒否し、すべて `.artifacts/cp4/eval-build/` の内側で、addon と固定名の worker の 2 件だけにする。`features` は配列で完全一致。G-case の admission は製品の受領書も求め、head と tree が評価の受領書と同じであることを確かめる。admission は許した fixture の path と sha を持ち、runner は `assertFixtureReadAllowed` を通してだけ fixture を読む（lstat と realpath で symlink を拒否し、bytes の sha を照合し、dev の bytes が凍結の材料の sha と一致すれば拒否）。既定の addon の path の `.node` は製品の受領書の sha と一致すること（肯定形）を求める | 評価の入口の漏れと、凍結の材料の dev への持込みを防ぐこと（T-1、T-2） | 文字列の前方一致だけ（迂回できた） | なし | 該当なし | 不要 | 記録済み |
| DR-CP4-S1B-13 | 2026-10-25 | 同 | (a) と receipt の規則（P1-4、P1-5、P2-2、P2-7、P2-8、P2-12）。(a) の窓内は開始時の slot が新しい READY かつ鮮度の stamp が一致したものだけ。frozen の plan は常に 13 variant で、AB／BA の予定の全件を内部で照合する。dev の fixture の予告の run は `dev:<file>/<variant>` の key と `fixture:{path, sha256, kind}` を持ち、常に `preview:true`。K2/4 の負例は Graph の run。receipt の窓の判定、宣言の照合、aggregates は行から計算し直して照合し、net log の非 loopback の試みが 0 でなければ `[precheck]`（N-12）。窓の標本の欄の欠けは証跡の欠け | 自己申告を信じないこと（T-1、T-5） | — | なし | 該当なし | 不要 | 記録済み |
| DR-CP4-S1B-14 | 2026-10-25 | 同 | (a) で snapshot が usable でない sample の扱い（P3、DR の案）。run を setup の不備として無効にする判断は残す。取り直しの規則の案：同じ variant の取り直しは 2 回まで、無効にした receipt はすべて残して記録 branch に置き、3 回目も無効なら `[precheck]`。回数は観測前に observation-prep に登録する項目として開示し、S1b-pure では強制しない | 取り直しで結果を選べないようにすること（T-1） | 黙って分母から外す（K6/2 に反する） | なし | 該当なし | 不要 | 案。observation-prep への登録は S2 の担当 |

実装後の追記（review 反映）：

- interface の変更（S1c が依拠する点）：
  - `assertGraphArmRequestable` の `graph-case` の admission は `{buildReceipt, productReceipt, fixtures:[{path, sha256}], observationPrep}` になった（`fixturePaths` は廃止）。返す admission は `allowedFixtures` と `candidateTree` を持つ。
  - 新しい `assertFixtureReadAllowed(admission, {root, path})` は検査した bytes を返す。runner は fixture をこの関数でだけ読む。
  - `collectObservationPrepFacts({root, commit, candidateHead})` は path を受け取らない（渡すと `[precheck]`）。返り値は `recordPath`、`remoteRef`、`onRemoteRef`、`recordIntroducedByCommit`、`recordSha256AtCommit/AtHead`、`record`、`headFileSha256`。
  - `assertDefaultAddonIsNotEvaluation` は `assertDefaultAddonIsProduct({defaultAddonSha256, productReceipt, evalReceipt})` に替えた。新しく `readNetNamespaces()` を足した。
  - `joinedWithinWindow` は残し、`classifyJoin(sample)` → `{joined, inWindow, disagreement}` を足した。`summarizeSteadyState` は `plan`（`{kind:"frozen"}` か `{kind:"dev", variants}`）を必須にし、`boundaryDisagreement` と `planKind` を返す。
  - `summarizeVariantQuality({variant, samples})` は variant の行を受け取る。`resolveCp4VariantOutcome({loaded, evidence, quality, comparisonPassed})` は `loadFrozenVariant` か `loadDevVariant` の結果だけを受け付ける。`summarizeGraphArm(arm, comparisons, {queryIds})`。
  - `assertElectronLaunch({env, argv, xvfbDisplay, netns})`。receipt は `run`、`fixture`、`environment.ownPids`、`measurementWorkspace`、trace では `settings.traceKind`、dev では `settings.devVariant` を持つ。`computeRunAggregates(receipt, variant)` を export した。
  - 製品の受領書の検査は `scripts/quality/nir1-retrieval/standard-build-receipt.mjs` の `validateStandardBuildSuccessReceipt` に移し、`standard-build.mjs` と guard が使い回す（挙動は変えない）。
- 検証：`node --test scripts/quality/nir1-graph-eval/*.test.mjs scripts/quality/nir1-retrieval/*.test.mjs scripts/quality/nir1-graph/contract.test.mjs` は 120 件 pass。`validate-nir1-retrieval --require-freeze` は valid。`pnpm eval:fixtures` は exit 0。`impact-map`／`quality-workflow`／`eval-fixtures` の試験は 70 件 pass。`pnpm eval:impact --base origin/master` は Fallback no。prettier と eslint は変更した file で問題なし（`standard-build.mjs` の既存の eslint の誤り 20 件は master と同数）。
- 変異 53 種（各 P1／P2 の修正を戻すもの、P3、境界の 2 種、既存の主なもの）を 1 つずつ入れ、すべて該当の試験が落ちた。すべて元の bytes に戻した（sha で確認）。
- 実行しなかったもの：Quick／Full、cargo、実 Electron、外向きの git の操作。
