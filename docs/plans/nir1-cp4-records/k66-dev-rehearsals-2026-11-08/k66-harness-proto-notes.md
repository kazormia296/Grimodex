# K6/6（改訂 3）の harness の試作の記録（非判定の dev の試作）

- 枝: `claude/k66-harness-proto`（基点は `claude/k65-harness` の `d1fefed2`）。push しない。S4 が pin する harness は S4 の枝でだけ merge する。
- 正本: contracts の `docs/plans/nir1-final-request-eval-proposal-6-draft.md`（改訂 3、SHA-256 `58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`）と
  `docs/plans/nir1-cp4-records/quality-verdict-prereg-v2-draft.md`（改訂 3）。
- **位置づけ**: K6/6 はまだユーザーの確認の前。この枝は「非判定の dev の試作と予行」で、判定・凍結・receipt の正本ではない。
  s6r1 の受領書は読んでいない（参考値にも使っていない）。Electron を起こす実機の予行は**行っていない**（下の「未実行」）。

## 表の行ごとの状態

「この draft が確認されたときに変わる harness の file」の表に対応する。行番号は今の枝で取り直した。

| 行 | file | 状態 | 変えたこと・理由 |
| -- | ---- | ---- | ---------------- |
| 1 | `join.mjs` | 済 | `steadyStateInWindow` を `k62SteadyStateInWindow` に改名して残し（K6/2 の字義。開示と K6/2 の時代の要約に使う）、注記を直した。/6 の first-render の関数は `followup.mjs` の `firstRenderOf`（H1 の分割） |
| 2 | `followup.mjs` | 済 | `firstRenderOf`（R-6 (a)(b)(c)、R-7、FR-1〜FR-8）。`nextGraphArmOf`（(c) の次の Graph arm の sample）。R1 の検査を first-render の候補にも当てた（N-a）。F1 `parent-joined` は残し、落ちた下位条件を detail に書く（`parent-joined:b:prepares-started-2` など）。`DPRIME_COUNTER_KEYS` は従来の 7 key のまま、`preparesStarted`・`preparesReady` は steady のときだけ `missingR7` が求める。trace と follow-up の経路は変えていない |
| 3 | `outcome.mjs` | 済 | import を K6/2 の字義の別名に替えた。`k64AvailableQuality` で、窓内に合流して Graph が表示に寄与した（`graph-ready`・`joined`・宣言 `used`・`edgeCount` 1 以上）のに first-render に数えられなかった親が 1 件でもあれば FAIL（`graph-contributed-parent-not-counted-as-first-render`。Scene の一覧が R+IR と同じでも。1% の許容は効かない） |
| 4 | `availability.mjs` | 済 | re-export を整理。case ごとの `k64` に、first-render の候補の件数・数えられなかった件数・下位条件ごとの件数と理由・`contributedNotCounted` を開示として追加。`entry.stampResults`（stamp の result の内訳）を追加。`firstRenderOutOfWindowRate`（見出しの開示。`k64` の level、case ごとの `entry.k64`、`decideCp4Availability` の `disclose`）は /6 の first-render の件数（`n − firstRender`）から求める（変える点 5）。K6/2 の字義の率は `k62OutOfWindowRate`（`pool.outOfWindowRate`・`entry.outOfWindowRate` もそのまま）で残す。K6/2 の字義の `inWindow`・`notReadyAtStart`・`stampMismatch`・`stampWithoutComparison`・境界の食い違いはそのまま開示。DR-CP4-F-6 の形式の関門（steady）を親の `contribution` にも当てた。(b) の trace の側の関門（:860-866）は trace が親の寄与の記録を持たないので変えていない |
| 5 | `receipt.mjs` | 済 | F-6 の関門を親の寄与にも当てた。`head.k66` の照合（`receiptHeadErrors` の `freeze66`、`validateCp4Receipt` の `deps.freeze66`。試験専用） |
| 6 | `run-sample.mjs` | 済 | `windowOutCause` の `not-ready-at-start` を、R7 の記録を持つ行では (a)〜(c)・FR の理由（`first-render:<code>`）に置き換えた。R7 の記録が無い行（S1b の runner。K6/2 の時代）は K6/2 の読みのまま。`previewSummary` も同じ（`flags.k66Rows` に /6 で読んだ行数） |
| 7 | `k64-record.mjs` | 済 | `DPRIME_COUNTER_KEYS` に 2 key を足した（steady のみ。(b) の trace は従来の 7 key のまま出る）。親の寄与 `followUp.parent.contribution` を、子と同じ `contributionOf` を親の fetch の `paths` に当てて作る（steady のみ。r1 が無い trace の記録には作らない）。Native・probe の変更は無い |
| 8 | `constants.mjs` | 済（暫定） | `K66_FREEZE` を足した。`sha256` は改訂 3 の bytes、`confirmedCommit`・`freezeCommit` は `null`（未確認の draft）。`null` は正式の receipt をすべて拒む（fail closed） |
| 9 | `head.k65` を扱う file | 済 | `admission.mjs`（`readK66FreezeHead`、`admitGraphCaseRun`・`assertReceiptHeadBound`）、`frozen-k64-admission.mjs`、`receipt.mjs`、`frozen-diagnostics.mjs`（`buildRunHead`、SP-P4 gate）、`diagnostic-runner.mjs`、`trace-frozen.mjs`、`trace-runner.mjs`（option）、`frozen-k64-run.mjs`、`k64-runner.mjs`、`quality-verdict-cli.mjs`、`test-support.mjs`。`head.k65` は残した。`--k66-commit` を足した。/6 の凍結の前に始めた run（head.k66 が無い。s6r1 を含む）は拒む（K6/6-N9） |
| 10 | 手順のファイル | 変更なし | v2 のまま。`FORMAL_PROCEDURE_VERSION`、`PROCEDURE_FILE`、`observation-prep-freeze.v1.json` も変えていない |
| 11 | dev fixture | 済 | `dev-shape-fixture.mjs` を拡張し、s6r1 で窓内に合流した親が出ていた G-02・G-08 の構造をまねた非凍結の dev fixture（`dev-shape-g02.v1.json`、`dev-shape-g08.v1.json`。既存の G-01・G-03・G-06 と同じ生成法。ID と文は全部合成、凍結した材料の写しではない。E-7 の防御は変えない）。予行の下限と止める条件は `k66-rehearsal.mjs`（`assessK66Rehearsal`。非判定）。dev の preview の runner は、親の寄与だけ Revision の単位で記録する（`parentMaterialContribution`。子は Scene の単位のまま。FR-7 は Revision の単位でしか予行できないため） |
| 12 | `observation-prep.mjs` の `CONTRACTS` | 済（key のみ） | `k66` を別の key で足した（`k64`・`k65`・`K64_VALUES` は変えていない）。validator はまだ `k66` を読まない（S2 追補の `contracts.k66`・`userConfirmations`・`k66Readings` が確認の後に束縛する） |
| 13 | `quality-verdict.mjs`、`quality-verdict-cli.mjs` | 済（D3 の (d) の後半は保留） | v2 の D1（分類器に `next`）、D2・D3（G-08/chronicle-index-unusable の `index-ready` の子。6 条件を満たせば子から外して (a)〜(c) と `unresolvedEdges` を検査、欠ければ子のまま）、D6（first-render の edge の束縛は親の寄与の記録）、D8（表示されなかった sample を fail に。Scene の一覧が違うのも hold から fail）、D7 の `head.k66`。**保留**: D3 (d) の「setup の記録の最新の typed Revision に解決する」は未実装で、Graph を出した適格な子には `d-revision-resolution-not-implemented` の hold を付ける |
| 14 | `evals/nir1-graph/observation-prep.v1.json`（S2 追補） | 保留 | 確認の後の S2 追補で行う（S4 が束縛）。この試作では触れていない |
| 15 | `evals/nir1-graph/observation-prep-freeze.v1.json` | 保留 | S4 の 7 回目の凍結。pin のし直しも S4 の仕事 |
| 16 | 試験 | 済 | 下の「試験」 |
| 17 | 検出力の記録 | 保留 | K6/6-P・N の合成の記録の試験は済。S4 の時の「下位条件ごとの落とした理由の code を並べる」記録 file は作っていない |
| 18 | 変えないもの | 変更なし | trace の file、`trace-record.mjs`、(b) の分類、T_late・W_f・T_show・D の定数、手順のファイル、Gold、凍結の fixture、`K64_VALUES` は変更なし |

## FR-7（親の寄与の記録）が取れる見込み

**取れる見込み**。理由と確かめたこと:

- renderer の probe（`renderer/cp4-k64-probe.tsx`）は親を含む全 fetch に `paths` を出し、`hashObservationPaths` は全 fetch の `paths` を hash してから記録に入れる（`frozen-k64-run.mjs` の `hashObservationPaths(raw)`）。probe・Native の変更は要らなかった。
- `buildFollowUpRecord` が親の fetch の `paths` を子と同じ `contributionOf` に当てて `followUp.parent.contribution`（`expectedContribution`、`contributionBasis`、`materialRevision`）を作る。`k64-record.test.mjs` の合成の観測で、解決器が親の `paths` を受け、`material-revision` の記録ができ、`firstRenderOf` が数えることを確かめた。
- 正式の run は `materialContribution`（Revision の解決器）が親にも当たる。dev の preview は子を Scene の単位に保つので、親だけ `parentMaterialContribution` で Revision の単位にした。
- 取れない形は見つからなかった。ただし**実機の予行は未実行**で、実際の親の fetch に `paths` が入ること（`graph` が親の結果に載る形）は合成の観測での確認にとどまる。取れないと分かった場合は `assessK66Rehearsal` が `fr7-record-missing`（/6 では判定せず /7）を返す。/6 の中で FR-7 を外す・緩めることはしていない。

## 判断（記録から読み切れず、起案者が置いた読み）

- (c) の「同じ phase の次の Graph arm の sample」: Gold の receipt は 1 variant なので、`variantKey` と `phase` ごとに引く（連結した pool でも variant の境界をまたがない）。user-operation の行だけを数える。次が無ければ (c) は当てない（K6/6-P4）。次の行に `preparesReady` が無ければ (c) の不一致（fail closed）。
- FR-4 の `countersAfterRelease` が記録に無い親は数えない（厳しい側。実機の記録には hook の runner が必ず残す）。
- 「Graph が表示に寄与した」の判定は窓内（`classifyJoin` の `inWindow`）に限る。窓の外の境界の食い違い（`joinedLateWithinTolerance`）は従来どおり hold。
- FR-8（N-d）は窓内に合流した親だけに当てる（`[artifact]` で止める）。
- `parentContributed`（品質の FAIL の条件、変える点 6）は草稿の字義どおり宣言が `used` と記録された親だけを数える。窓内に合流して `graph-ready`・`joined`・`edgeCount` 1 以上でも、R7 の記録が欠ける（`followUp`・`parent` が無い）か宣言が null／unused の親は `parentContributed` にならず、first-render にも数えられない。この形は X10 の欠落（1% の許容の対象）に数えられるだけで、Scene の一覧が R+IR と同じなら品質の FAIL にならない。fail-closed に広げるかは確認の後の判断（草稿の字義を変える）として、この試作では広げず**残余として開示**する。
- `K66_FREEZE.sha256` は改訂 3 の bytes の暫定値。確認で bytes が変われば入れ替える。
- 品質判定 v2 は草稿の D3 を、(1)〜(6) を全部見る形で実装した。Revision の解決（(d) の後半）は受領書だけで引けるか未確認なので hold。

## 試験

- 実行: `node --test --test-concurrency=4 scripts/quality/nir1-graph-eval/*.test.mjs scripts/quality/nir1-graph/*.test.mjs scripts/quality/impact-map.test.mjs`（Node 24.18.0、約 83 秒）
- 結果: **886 件中 881 件 pass、5 件 fail**。基点（`d1fefed2`）は nir1-graph-eval の 656 件が全部 pass。
- fail の 5 件はすべて `scripts/quality/nir1-graph/observation-prep.test.mjs` の **S2 の bytes の pin の試験**（committed の S2 が pin している harness の file の bytes〔`constants.mjs`、`frozen-diagnostics.mjs`、`frozen-k64-run.mjs` など〕と、今の bytes が違う）。K6/6 の表の「pin（S2 の `SOURCE_PINS`）」の列のとおり、pin のし直しは S4 の枝（S2 追補・7 回目の凍結）で行う。この試作では pin を触らない。したがって、この 5 件は S4 まで赤のままが想定どおり。
- 足した試験: `followup.k66.test.mjs`（K6/6-P1・P3・P4・P5、N1a〜N12c、集計・開示・N8）、`outcome.test.mjs`（P2、N13a・N13b、edgeCount 0）、`k64-record.test.mjs`（FR-7 の記録、dev の `parentMaterialContribution`）、`receipt.test.mjs`・`admission.test.mjs`・`frozen-k64-admission.test.mjs`・`frozen-diagnostics.test.mjs`・`trace-frozen.test.mjs`・`frozen-k64-run.test.mjs`・`quality-verdict.test.mjs`（N9: `head.k66`）、`quality-verdict.test.mjs`（D3・D6・D8）、`k66-rehearsal.test.mjs`、`dev-shape-fixture.test.mjs`（G-02・G-08）。
- K6/5-P1 の試験（`readyFresh: true`、stamp `fresh` の到達不能な fixture）は K6/6-P1（`k66Sample`: slot `empty`、`readyFresh: false`、`stamp0-missing`、begin `["pending"]`）に置き換えた。K6/4-P2 の試験は R1 の形の fixture と `next` に直した。K6/4-N39 は `k66Sample({graph:{source:'cache'}})` に直し、FR-1 だけを欠くこと（`firstRenderFails` が `["FR1:source-cache"]`）を固定した。`readyFresh`・`notReadyAtStart` に触れる `availability.test.mjs` は `k62SteadyStateInWindow` に直した。
- `impact-map.mjs` に新しい 2 つの試験 file を登録した。

## 未実行・未解決

- Electron を起こす実機の予行（dev fixture での定常状態の preview）は**未実行**。窓内に合流する親が 30 件以上出るか、`stamp0-missing` の頻度、`preparesStarted`・`preparesReady` の実測の差分、FR ごとの件数は未確認。`k66-rehearsal.mjs` はその結果を評価する関数で、実機の samples には当てていない。
- pin の試験 5 件（上記）、S2 追補、検出力の記録 file、品質判定 v2 の D3 (d) の Revision の解決は S4 または確認の後。
- 結果は「非判定の dev の予行」で、判定・凍結・receipt の正本ではない。
