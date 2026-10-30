# SP/1 の Negative（SP-N1〜N5、SP-N9〜N13）の合成の記録による検出の記録

## 目的と規則

- SP/1 の draft（`docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md` :178）の「CP-4 は、合成の記録で SP-N1〜SP-N5、SP-N9〜SP-N13 を期待どおりに分けることを、観測の前に示す」に対する記録。
- S2 の `evals/nir1-graph/observation-prep.v1.json`（branch `claude/cp4-s2-observation-prep`、読んだ commit `0749a4b4295022b135e7af5e51f599e4c5e9b81f`）の `r5Gate.syntheticDetection`（`record: "S4:sp-synthetic-detection-record"`）の `recordRule`（②' で統合 branch の node の試験を走らせ、試験の file と commit、各 SP-N の検出と違反の無い記録の通過を記録する）に従う。
- **この記録は K6/4 の分類器の Negative（K6/4-N1〜N40）の記録 `k64-synthetic-detection-record.md` とは別のもの**。あの記録は SP-N を扱っていない。
- 製品の runtime（Electron、Graph の arm）は起動していない。node の試験と、試験の module を読み込み時に書き換える変異だけを行った。G-case の Graph の実行出力は見ていない。
- 対象外の SP-N6、N7、N8、N14 は末尾の「参考」に、試験の題だけを載せる（この記録のための変異は当てていない）。

## 実行

- 日時：試験の実行 2026-10-30T15:41Z（JST 2026-10-31 00:41）、変異の実行 2026-10-30T15:42〜15:45Z（JST 2026-10-31 00:42〜00:45）。
- 候補：`82d427465b16a12809c6f93adad74ac97859c85a`（tree `2fd96d6dca0ee497472f010962edbf9dda70e55d`）。worktree `claude-cp4-synth2`（detach）。実行の前と変異の後に `git status --short` が空、`git rev-parse HEAD` が上の値であることを確かめた。`refs/remotes/origin/master` は同じ commit（`git merge-base --is-ancestor origin/master HEAD` は真）。
- node：v24.18.0。
- 対象の 3 file：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/seed-pin-setup.test.mjs scripts/quality/nir1-graph-eval/seed-pin.test.mjs scripts/quality/nir1-graph-eval/receipt.test.mjs` → **45 件、pass 45、fail 0、skipped 0**。TAP の sha256 `30669f407675ae05382bf449e0686e7317cd5e009e5b48a72fab975620490d48`。
- 全体：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs` → **552 件、pass 552、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `d4fa858a4df11b51648a02abdeb07eed79baf051d1a9e492f086805385b52ef5`。
- TAP の sha256 について：k64 の記録の `ca2dc770…` とは**一致しない**。同じ候補で全体を 2 回走らせると TAP の sha256 は毎回変わった（2 回目 `91e28f50…`）。TAP に `duration_ms` と試験の中の pid を含む run の名前（例 `s5a-test-blocked-516031`）が入るため。件数（552、pass 552）は k64 の記録と同じ。再現できる値として、TAP の `ok`／`not ok` の行から ` # …` を除いた 552 行の sha256 を取った：`be95fb64b4081448ade4819f7ddab09707b56071487741a04f63a3588851ce59`（2 回の実行で同じ）。
- TAP と変異の道具は記録の時の scratchpad にあり、追跡していない（この記録の file だけを commit する）。

## 合成の記録の作り方（規則との差の開示）

SP/1 :178 と `syntheticDetection.rule` は「実際の setup の receipt と DB の pin の行を複製し、書き換えたもの」と書く。この候補の試験の合成の記録は、**実際の setup（①）の receipt の複製ではない**。試験の中で次のように作る。

- 段の記録（`seed-pin-setup.test.mjs`）：凍結の G-02 の fixture から `seedPinPlanFromFixture` で plan を作り、`runSeedPinStep` を fake の `readState`／`upsertScenePin` で走らせた記録（`state()` で作った前後の状態）を書き換える。
- R5 の照合（`seed-pin.test.mjs`）：`test-support.mjs` の `seedPinWorkspace` が、variant ごとに一時の SQLite（`tree_nodes`、`codex_entries`、`scene_codex_pins` だけの最小の schema）と凍結の schema の setup の受領書を書き、`loadSetupReceipt` と `readQuerySceneSeedPins` で封印つきで読み戻した 13 の variant の行を書き換える。
- receipt（`receipt.test.mjs`）：試験の `receipt()` が作る正式の G-03/base の receipt を書き換える。

書き換える項目（pin の entry、数、順序、書込みの経路、pin の集合、Scene の archive、entry の project、arm ごとの pin、runner の種類、R5 の入力の出所）は rule の項目に対応する。entry の ID の空白・200 UTF-16 超えは下の SP-N9 の欄のとおり、規則の関数の試験だけ。

## SP-N ごとの結果

試験の題は TAP のとおり（行は `test(` の行）。「陽性の対照」は違反の無い記録が通ることの assert。変異は、候補の file を書き換えず、node の module の load hook（`--import` で登録）で読み込んだ source の 1 か所を置き換えて、示した試験 file だけを走らせた。どの変異も置換が 1 か所だけ当たったことを確かめた。

| SP-N | 違反 | 試験（file:行、題） | 検出の assert の要旨 | 陽性の対照 | 変異（置換）と結果 | 備考 |
|---|---|---|---|---|---|---|
| SP-N1 | pin の entry が予定の seed でない | 段：`seed-pin-setup.test.mjs:260`「SP-N1〜N5、N8、N9 と SP-P2: 合成の記録で段の違反を分ける」。R5：`seed-pin.test.mjs:161`「R5／SP-N1〜N3、N9、N11、N13、N14: …は [precheck]」の `N1`、`seed-pin.test.mjs:69`「R5: 一致・不一致・確かめられないを分ける」 | 段：問いの Scene の pin を別の Entity 1 つにすると `assessSeedPinStep` の findings が `["SP-N1"]`。R5：G-02/base の pin を別の Entity にすると `assertSeedPinsBeforeK64` が `/G-02\/base: mismatch/` で throw | 段：`seed-pin-setup.test.mjs:229`（違反の無い段の記録で findings が `[]`、`assertSeedPinStep` が ok）。R5：`seed-pin.test.mjs:151`（13 variant が `match`） | `seed-pin-setup.mjs` の `else if (pins.length === 1 && pins[0].entryId !== seed)` → `else if (false)`：:260 が落ちた（`[]` ≠ `["SP-N1"]`）。`seed-pin.mjs` の `productSeed !== expectedSeed` → `false`：:161（`Missing expected exception: N1`）、:69、`P2-1: 封印した読取は…` が落ちた | — |
| SP-N2 | 問いの Scene に pin が 2 つ以上 | 段：`seed-pin-setup.test.mjs:260`。R5：`seed-pin.test.mjs:161` の `N2` | 段：予定の seed と後の別の pin で findings が `["SP-N2"]`。R5：G-04/base に 2 つ目の pin を足すと `/G-04\/base: multiple-pins/` で throw | SP-N1 と同じ | `if (pins.length > 1) add("SP-N2"` → `if (false) add("SP-N2"`：:260 が落ちた。`? "multiple-pins"` → `? "match"`：:161 が落ちた（`Missing expected exception: N2`） | — |
| SP-N3 | 最初の pin が別の Entity で、2 つ目が予定の seed | 段：`seed-pin-setup.test.mjs:260`。R5：`seed-pin.test.mjs:161` の `N3` | 段：pin `[other, seed]` で findings が `["SP-N2", "SP-N3"]`（SP-N3 を単独で分ける）。R5：G-05/base の pin を `[other, seed]` にすると `/G-05\/base: (mismatch\|multiple-pins)/` で throw | SP-N1 と同じ | `add("SP-N3", "the first pin is another Entity");` → `void 0;`：:260 が落ちた（`SP-N3` が欠けた）。R5 の側には SP-N3 だけの変異を当てていない | R5 の側の assert は mismatch と multiple-pins のどちらも受けるので、R5 の照合では SP-N3 を SP-N2 から分けない（どちらも `[precheck]` で止まることは assert している）。SP-N3 を分けるのは段の判定 `assessSeedPinStep` |
| SP-N4 | pin を `upsertScenePin` 以外で書いた、経路の記録が無い | `seed-pin-setup.test.mjs:260` の後半（:353 の付近）。参考：`seed-pin-setup.test.mjs:623`「setup-driver の段: renderer の API の upsertScenePin を 1 回だけ呼び、前後は SELECT の読み戻しで記録する（SQL の書込みなし）」 | 段の記録の `writer` を `"sql"`、`undefined` にする、`createdAt` を `null` にすると findings がそれぞれ `["SP-N4"]`。`assertSeedPinStep` が `/\[precheck\] SP\/1.*SP-N4/` で throw。:623 は fake の page で、`db_execute` 以外の呼出しが `["upsertScenePin"]` だけ（fake の page は SELECT 以外の `db_execute` を拒む） | `seed-pin-setup.test.mjs:229`（`writer` が `SEED_PIN_WRITER`、findings `[]`） | `if (record?.writer !== SEED_PIN_WRITER)` → `if (false)`：:260 が落ちた。`typeof record?.createdAt !== "string" &&` → `false &&`：:260 が落ちた | **限界（下の「限界の開示」1）**：`writer` は `runSeedPinStep` が書く定数で、観測ではない |
| SP-N5 | 問いの Scene 以外に pin を足した、fixture の pin を変えた | `seed-pin-setup.test.mjs:260` | 別の Scene に pin を足す、fixture の pin を 1 つ消す、段の前から問いの Scene に pin がある、でそれぞれ findings に `SP-N5`（前 2 つは `["SP-N5"]` 単独） | SP-N1 の段と同じ | 「段の前の pin が fixture のものでない」の `add("SP-N5", …)` → `void 0;`：:260 が落ちた。「問いの Scene の外の pin が変わった」の `add("SP-N5", …)` → `void 0;`：:260 が落ちた | — |
| SP-N9 | 問いの Scene が archive、seed の entry が別の project、entry の ID が空白か 200 UTF-16 超え | 段：`seed-pin-setup.test.mjs:260`。R5：`seed-pin.test.mjs:161` の `N9-archived`、`N9-project`。規則：`seed-pin.test.mjs:34`「R5: seed は製品の規則（created_at、entry_id の順で最初の pin だけ）で決まる」 | 段：`queryScene.live: false`、`entryInProject: false` で findings が `["SP-N9"]`。R5：G-06/base の Scene を archive、G-07/base の entry を別の project にすると `mismatch` で throw。規則：空白の ID、201 字の ID の最初の pin で `productSeedOf` が `null`（200 字は通る） | 段・R5 は SP-N1 と同じ。規則：:34 の 200 字の ID、`entity-seed` の通常の場合 | `if (pins.length === 1 && pins[0].entryId === seed && productSeed !== seed)` → `if (false)`：:260 が落ちた。`if (!input.sceneLive) return null;` を削除：:34 と :161（`N9-archived`）が落ちた。`.filter((row) => row.entryInProject)` → `.filter(() => true)`：:34 と :161（`N9-project`）が落ちた。`entryId.trim().length === 0 \|\|` を削除：:34 が落ちた。`entryId.length > SEED_UTF16_MAX` → `false`：:34 が落ちた | entry の ID の空白・200 超えは、`productSeedOf` の規則の試験（:34）だけで、段の判定（`assessSeedPinStep`）や R5 の gate（`assertSeedPinsBeforeK64`）に空白・長すぎる ID の記録を通す試験は無い。gate が同じ `productSeedOf` を使うことはコードで読んだが、試験では示していない |
| SP-N10 | case の arm の間で pin の集合が違う | `seed-pin-setup.test.mjs:493`「SP-N10: case の arm の間で pin の集合が同じ（Graph の arm の workspace にだけ pin があれば [precheck]）」 | hybrid の側に pin が 1 つ少ないと `assertArmsShareSeedPin` が `/\[precheck\] SP\/1 SP-N10/` で throw | 同じ試験：順序だけ違う同じ集合で `ok: true` | `fail("SP-N10", …)` → `void ("SP-N10", …)`：:493 が落ちた（`Missing expected exception.`） | `assertArmsShareSeedPin` は、この候補では `seed-pin-setup.mjs` の外から呼ばれていない（試験だけ）。run の経路に結線されていることはこの記録では示していない。arm の pin の列は試験が直接渡す（DB からの読取ではない） |
| SP-N11 | unavailable を期待する variant に pin が無い | `seed-pin.test.mjs:161` の `N11` と後半（variant の欠け） | G-08/graph-index-unusable の pin を空にすると `/G-08\/graph-index-unusable: no-pin/` で throw。G-08/graph-index-unusable の行を除くと `/missing G-08\/graph-index-unusable/` で throw | `seed-pin.test.mjs:151` | `? "no-pin"` → `? "match"`：:161 が落ちた（`Missing expected exception: N11`）。`if (missing.length > 0) problems.push` → `if (false) problems.push`：:161 が落ちた | pin なしの試験は G-08/graph-index-unusable の 1 variant だけ。G-03 frontier-exceeded と G-08 の他の unusable の 2 つは個別の試験が無い（同じ `verifySeedPins` の分岐を通る） |
| SP-N12 | harness が seed を直接渡した run（`direct-fetch-preview`）を判定に使った | `receipt.test.mjs:997`「S1f（R5、K6/4-N16）: 正式の Graph の receipt は hook の消費者の runner のもの。direct-fetch の dev の runner は予告だけで集計に入らない」 | 正式の G-03/base の receipt の `runnerKind` を `"direct-fetch-preview"` にする、または欠くと、`validateCp4Receipt` の errors が `/runnerKind/` に当たる（`R5 / K6/4-N16: a formal Graph receipt comes from the hook-consumer runner …`）。`selectReceiptsForAggregation` が direct-fetch と runner の無い run を `runner-is-not-the-k64-hook-consumer` で除き、hook の消費者の run だけを残す | 同じ試験：違反の無い `receipt()` の errors が `[]`、`k64-hook-consumer` の run が `included` | `if (receipt?.runnerKind !== HOOK_CONSUMER_RUNNER)` の `errors.push` → `if (false)`：:997 が落ちた（errors が `''`）。`selectReceiptsForAggregation` の `GRAPH_RUN_KINDS.has(receipt?.runKind) && receipt?.runnerKind !== HOOK_CONSUMER_RUNNER` → `false`：:997 が落ちた（`direct`、`unmarked` が included に残った） | **対応づけの判断と限界は下の「限界の開示」2**。題に SP-N12 の語は無い |
| SP-N13 | R5 の照合を setup の receipt の自己申告で行い、DB から読み直していない | `seed-pin.test.mjs:161` の SP-N13 の部分 | 封印の無い読取（`read` を JSON の複製にしたもの）で `/self-reported/`、封印の無い setup（`{ ...setup }`）で `/setup-self-reported/` の throw | `seed-pin.test.mjs:151`（封印した受領書と DB の読取で `match`） | 封印の判定を外す `const sealedRead = isProductDbPinRead(read);` → `read != null`：:161（`Missing expected exception.`）と :367「R5: dev の照合は dev の workspace だけ」が落ちた。`const sealedSetup = isLoadedSetupReceipt(setup);` → `setup != null`：:161 が落ちた（`Missing expected exception.`）。ラベルだけを外す変異 2 つ（`self-reported` の push を外す：:161 と :367 が TypeError で落ちた。`setup-self-reported` の push を外す：:161 が落ちた。この時 gate は `unconfirmed` で止まり、ラベルが変わっただけ）も当てた | — |

## 限界の開示

1. **SP-N4（DR-CP4-R-6 (3) の判断）**：`docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-R-6 (3) は「SP-N4 は直さず限界を記録する」と決めている。その内容の要約：`writer` は `runSeedPinStep` が書く定数で、観測ではない。段の deps は製品の `upsertScenePin` と SELECT だけを呼ぶ（fake の page の試験 `seed-pin-setup.test.mjs:623` で確かめた）が、実行の時に他の書込みが無かったことを IPC の trace で示していない。S4 への提案は、setup の harness の build で bridge の timing shim を使い、段の間の `db_execute` の SQL の種類を記録し、書込みが `upsertScenePin` の呼出しの中の `scene_codex_pins`／`scene_codex_mentions` の INSERT だけであることを求めること。実 Electron で shim が当たることの確認が要るので、その回は入れていない（DR-CP4-R-8 (7)、DR-CP4-I-9 (4) も未実装と記録）。この候補でも IPC の trace は無い。したがって、この記録が SP-N4 について示すのは「段の記録の `writer` が `upsertScenePin` でない、または `writer`／`createdAt` の記録が無い記録を、段の判定が SP-N4 として止める」ことだけで、SQL や注入による実際の書込みを観測して検出することは示していない。
2. **SP-N12 の対応づけ**：SP-N12 の違反は、seed を harness が直接渡した run（`runner.mjs` の `fetchRelatedPastScenes` を呼ぶ runner。`run-sample.mjs:537` が `runnerKind: "direct-fetch-preview"` を書く）を判定に使うこと。`receipt.test.mjs:997` は、その runner の種類の正式の Graph の receipt を `validateCp4Receipt` が拒み、`selectReceiptsForAggregation` が集計から除くことを assert し、違反の無い hook の消費者の receipt を通す。判定に入る経路（receipt の検証と集計の選別）で止めることを示すので、SP-N12 の検出として妥当と判断した。限界：
   - 検査は receipt の `runnerKind` の値に依る。値は runner のコードが書く（direct-fetch の runner は `"direct-fetch-preview"`、K6/4 の runner は `K64_RUNNER_KIND`。`run-sample.test.mjs` と `k64-runner.test.mjs` が各 runner の書く値を assert）が、direct-fetch の run を `k64-hook-consumer` と書いた receipt は、この検査だけでは検出しない（hook の消費者の記録との照合は SP-P5、DR-CP4-F-2 の側）。
   - `selectReceiptsForAggregation` は、この候補では `receipt.mjs` の外から呼ばれていない。集計の経路への結線はこの記録では示していない（`validateCp4Receipt` は `admission.mjs`、`frozen-k64-run.mjs`、`k64-runner.mjs` などから呼ばれる）。
   - 試験の題は K6/4-N16 の名で、SP-N12 の語は無い。SP/1 の SP-N12 は K6/4 の In-scope attacks の 9（cp4:585 DR-CP4-F-2 の検証）を指しており、同じ検査を共有する。
3. **合成の記録の出所**：上の「合成の記録の作り方」のとおり、実際の setup の receipt の複製ではなく、試験が凍結の fixture と最小の schema の一時の DB から作った記録。
4. **SP-N3 の R5 の側**、**SP-N9 の ID の規則**、**SP-N10 の結線**、**SP-N11 の variant の範囲**：表の備考のとおり。
5. 製品の runtime を使う確認（実 Electron での段、①の receipt での照合）はこの記録の範囲の外。

## 参考（対象外の SP-N）

この記録のための変異は当てていない。全体の実行ではすべて pass。

- SP-N6、SP-N14：`seed-pin-setup.test.mjs`「SP-N6／SP-N14: 段の置き場（…）」、`seed-pin.test.mjs:161`（G-01 の欠け `missing G-01/v1`）。
- SP-N7：`seed-pin-setup.test.mjs`「SP-N7／SP-P4: …」、`frozen-diagnostics.test.mjs` と `diagnostic-runner.test.mjs` の SP-N7 の試験。
- SP-N8：`seed-pin-setup.test.mjs`「SP-N8: 凍結の bytes（…）」と :260 の後半（`countedAsSetupTimelineStep`、`countedAsMeasurementPoint`）。

## 取り直しの規則

この候補（`82d42746`）以後に、SP-N の検出に関わる file（`seed-pin.mjs`、`seed-pin-setup.mjs`、`workspace-db.mjs`、`receipt.mjs`、`run-sample.mjs`、`setup-receipt.mjs`、`test-support.mjs`、`constants.mjs`、`k64-runner.mjs`、`runner.mjs`、`r5-check-runner.mjs`、`frozen-setup-driver.mjs`、`setup-driver.mjs`、または上の試験 file）を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。
