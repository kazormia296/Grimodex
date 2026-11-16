# CP-4 品質の判定：事前に固定する定義 v3（草案 改訂 1。2026-11-16）

> 状態：**改訂 2（Opus レビュー 1 と確認前の読みを反映。ユーザーの確認の前）**。確定版でも、判定の結果でもない。この file の SHA-256 は本文に書かない（file が自分の値を含めないため）。ユーザーへの確認では、この file の bytes の SHA-256 を名指しして聞く（§11）。確認の後に 1 byte でも変えたら、SHA-256 を取り直して聞き直す。
> 骨子は `quality-verdict-prereg-v3-draft-outline.md`（この file は骨子を全文に広げ、決める点を決めたもの。骨子は書き換えない）。設計は `item-c-design.md`（改訂 2）、独立レビューは `item-c-review-opus.md`（設計）と `v3-review-opus-1.md`（この草案の初版。SHA-256 `75433691…` の bytes が対象）。いずれも contracts の外にある。
> 根拠：ユーザーの回答（contracts `docs/plans/nir1-cp4-records/user-confirmation-2026-11-16-item-c.md`。U1a＝FAIL を受け入れる〔条件：v3 の定義は、測る前に fixture と README だけから決めて固定する〕、U2＝D、追記＝`utf16-range` の読みと G-01 の A）。
> v1 は `quality-verdict-prereg-2026-11-06.md`、v2 は `quality-verdict-prereg-v2.md`（どちらも本文を書き換えない）。v3 は **次の S4 の下の最初の正式 run の受領書にだけ**当てる。s7r2 以前の受領書には当てない（新しい field が無く、4 項目は field の欠けで全部 `hold` になるだけ）。
> 基点：`origin/master` `3948eeb2a3e8c88cebe8e6dbf13881a5ce43cbe8`（コードと fixture はここで読み直し、引用の行番号を確かめた）、contracts `origin/claude/nir1-contracts` `fd1f69cee739915a94b26c29d35d2411a59b7706`（v1・v2・回答の記録はここで読んだ）。

## 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 骨子 | 2026-11-16 | `quality-verdict-prereg-v3-draft-outline.md`（骨子。G-01 の 4 案を含む回答の前の形） |
| 草案 | 2026-11-16 | 骨子を全文にした。回答（`utf16-range`＝`node-entity-evidence`、G-01＝A）を決定として書き、4 案は戻さない。pass の条件、sample の母集団、variant ごとの現在の text、全体の verdict の語彙（`hold` の理由であって `fail` ではない）を足した（SHA-256 `75433691…`） |
| 改訂 1 | 2026-11-16 | Opus レビュー 1（`v3-review-opus-1.md`）の必須 1〜9 を反映。**骨子から変えた点**：`utf16-range` の定義を fixture・README だけで決まる形にし、骨子・草案の「範囲が `[0, 長さ)`」と「`sourceRef` が `codex:<端点の Entity ID>`」を判定から外して開示の件数だけにした（製品のコードの読みが定義に入っていたため。§0・§2.1）。そのほか：Evidence 行が 0 件の edge を `fail` にした（必須 2）、全 variant が blocked の項目を `not-evaluable` にした（必須 3）、§4 の平文拒否の規則が草案自身の値を拒否しないようにした（必須 4）、skip の範囲を v1:54 の字義に戻した（必須 5）、文書の中の食い違い 3 点を直した（必須 6）、引用の行番号を直した（必須 7）、E 表に 1 行足した（必須 8）、§11 の質問文を差し替えた（必須 9）、§12 を「閉じた点」と「S2・S3 に回す点」に分けた |

| # | v2 からの差分 | 別 |
| - | ------------- | -- |
| E1 | v1 §6 条件 4 の「UTF-16 範囲、pin、Raw excerpt の不変、追加 Scene の本文 anchor」の 4 件（実装では `quality-verdict.mjs:860-871` の `evidenceComponents` が `not-evaluable: not-in-the-receipt` を直書きしている）を、受領書の観測と fixture の期待を突き合わせる判定に置き換える（§2） | 新設（範囲の限定） |
| E2 | 4 件を適用する variant を、fixture の `evidence.requirements` と G-01 の規則で決める（§3） | 新設 |
| E3 | 各項目の `pass`／`fail`／`hold` を、観測の前に決める（§2、§2.0） | 新設 |
| E4 | Q6 の読み（hash は照合のためで秘匿のためではない。判定の入力に平文・Evidence の JSON を使わない。平文の混入の拒否は S2 で固定）を明記する（§4） | 明確化 |
| E5 | 条件 4 の状態を、`edge-binding`、`graph-contributed-parent-counted`（v2 D8）と 4 件の最悪値で決める。4 件が `not-evaluable` でなくなるので、条件 4 は `pass`／`fail`／`hold` になりうる（§6） | 新設 |
| E6 | v2 の「確定は integrator が行い、ユーザーの確認の対象ではない」は持ち越さない。v3 の確定は、ユーザーが SHA-256 を名指しした草案を確認した後（§0、§11） | 変更 |
| E7 | v3 用の定数（`K66_QUALITY_VERDICT_V2` に当たるもの）と、`--v3-file` に当たる CLI の入力を S2 の追補で足す（§10） | 手順 |
| E8 | 4 件では、観測が取れていて期待と食い違えば **`fail`** と読む。v1 §2（v1:26）の `hold` の説明にある「期待値と観測が違うまま Hold として残す」と、manifest の `comparison.failure`（`manifest.v1.json:104`）は「違えば Hold」とも読める。4 件は「測定が条件を破った」ので `fail` と読む（ユーザーが受け入れた FAIL の意味。U1a）。例外は §2.0 に列挙した 3 点だけ | 新設（読みの固定） |
| E9 | 骨子からの変更：`utf16-range` の範囲 `[0, 長さ)` と `sourceRef` を判定に使わず、開示の件数にだけ載せる（§2.1） | 変更（骨子から） |

## 0. 観測の規律と、v3 の前に見たもの

- **v3 は新しい受領書の値を見る前に固定する**。順序は §10。v3 を当てるのは、**次の S4 の下の最初の正式 run の受領書だけ**（v2 §0 の「最初の正式 run」の規律を、v3 の file に当てる）。s7r2 以前の受領書、dev の予行、S4 の前の測定には当てない。
- **起案者が見たもの（開示）**：
  1. fixture（`evals/nir1-graph/g02〜g08`、`evals/nir1-g01/fixture.v1.json`）の `evidence.requirements`、`pins`、`pathAttachments`、`addedScene`、`scenesWithoutPath`、`mutations`、`setupTimeline`、`variants[].measurementPoint`、`assertions`、`entities`、`relations`。README（`evals/nir1-graph/README.md`）、`manifest.v1.json`、`schema.v1.json`。**期待値と定義の出所は、これらの fixture・README（schema・manifest を含む `evals/` の材料）だけ**（U1a の条件）。
  2. 検査器・判定の実装：`scripts/quality/nir1-graph/contract.mjs`（fixture の規則を検査する validator。定義の出所ではなく、fixture の規則の読みの裏取り）、`scripts/quality/nir1-graph-eval/quality-verdict.mjs`（`evidenceComponents` の直書きと、全体の verdict の集計）、`scripts/quality/nir1-graph/observation-prep.mjs`（S2 の定数）、`scripts/quality/nir1-graph-eval/setup-receipt.mjs`。
  3. **製品のコードと wire 型（fixture・README の外）**：骨子・草案の段で、`electron/shared/relatedScenesSearchWire.ts`（edge の Evidence は `{evidenceId, quote}`、Graph-only 行の `canonicalRange`・`excerpt`・`path.pinEntityId`・`path.hop`）と `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs`（prepare が Evidence の `sourceRef` と範囲を作る箇所）を読んだ。**草案の §2.1 の「範囲が `[0, 長さ)`」と「`sourceRef` が `codex:<端点の Entity ID>`」は、この製品コードの読みに由来していた**（レビュー 1 の必須 1。U1a の条件に反する）。改訂 1 は、この 2 つを判定から外し、**定義の根拠に製品のコードを使わない**（§2.1）。受領書の field 名（仮。§5）は wire の名前に引かれうるが、期待値は fixture だけから導く。
  4. contracts の v1・v2、回答の記録、設計と独立レビュー。
- **見ていないもの**：受領書の新しい field の値（そもそも s7r2 以前の受領書に無い）、dev の予行、製品が返す excerpt・Evidence の実物、4 件に当たる測定値。v1・v2 の起案者は s5r6・s6r1 の受領書の他の field を見た（v1 §0、v2 §0）。それらは v3 の 4 件の新 field を含まない（v1 §9）。本草案の起案者は受領書の本文を開いていない。
- **manifest の位置づけ（1 行）**：manifest は G-01 の `predeclaredImprovement`（`manifest.v1.json:26-33`）と、合格の要件の文言（`:95-104`「path Evidence validity 100%」〔`:98`〕「R+IR membership, order and excerpts unchanged …」〔`:100`〕）の確認にだけ使う。manifest は 4 件の期待値を持たない。期待値の出所は fixture。
- 順序で守ること：①この草案 → ②ユーザーの確認 → ③contracts に固定して push・remote 側の時刻を記録 → ④判定の実装（合成の受領書だけで試験）・独立のコードレビュー・push → ⑤S2 の追補（§10）→ ⑥dev の予行 → ⑦S4 の正式 run。**⑥ で見た値で v3 の定義を変えない**。変えるなら v4 を起案し、ユーザーの確認をやり直す。
- v3 の確定（③）と実装（④）は、新しい S4 の下の最初の正式 run より前に push する。③ の後に v3 の bytes を変えない。

## 1. v2 からの差分の範囲

**変えるのは、E1 の 4 件の `not-evaluable` だけ**（それに伴う条件 4 の集計、E5）。

**変えない**（項目名で列挙する）：
- v1：§1（位置づけと入力、許可リスト、blocked の台帳）、§2（共通の読み。状態の規則 `fail` > `hold` > `not-evaluable` > `pass`、sample の母集団）、§3（Graph arm の最終一覧）、§4（条件 3、Hybrid p95）、§5 条件 1（G-01 の事前指定改善）と条件 2 の **「既存 24 件の Graph arm」**（`not-evaluable` のまま。`quality-verdict.mjs:1141`）、§6 の「edge の束縛」の部分判定、§7 条件 5 の (a)(b)、§7 の **(c)**（既存 24 件の Graph の出現・Graph DTO の node／path。`not-evaluable` のまま。`:957`・`:1314`）、§8、§9。
- v2：D1〜D8（D3 の `a2-index-ready-requery-forbidden`、D8 の `graph-contributed-parent-counted` を含む）、C1〜C8（C2 の edge から typed Revision への推定を含む）。
- 閾値、fixture、Gold、DR-CP4-S1B-6・§15.2・T-2、製品・harness の bytes の方針。
- 全体の verdict の式（`quality-verdict.mjs:1333-1368`）：条件がすべて `pass` のときだけ `pass`、それ以外は `hold`。

## 2. 4 件の定義

### 2.0 共通の読み（4 件に共通）

- **sample の母集団**：v1 §2 のとおり。Graph arm の `phase === "measured"` かつ `trigger === "user-operation"`。各 variant はちょうど 30 件（違えば、その variant の 4 件は `hold`）。利用者に表示された一覧と、その側の記録は v1 §3 のとおり（first-render なら親、follow-up なら子）。以降、「表示側の記録」と書く。
- **検査する sample と skip（v1:54 の字義）**：v1 §6 の「edge の束縛」と同じに、**子が無い、または子が `graph-ready` でない sample だけ**を検査せず（`skipped`）、件数を出力に開示する。**`graph-ready` の子は、`edgeCount` が 0 でも検査する sample に数える**（「Graph が出ていない」ことを skip の理由にしない）。理由：Graph が出ていないことは、edge の束縛（v1 §6）、v2 D8、条件 1・2・5 が受け持ち、証拠の妥当性は「出たものの妥当性」を見る。選んだ理由であって、通りやすい側だから選んだのではない（skip が多いほど通りやすいことは §8 の 7 で開示する）。
  - **D8 の first-render の扱い**：子が無い sample のうち、親の合流が Graph を受けて表示に寄与した（v2 D8 が `fail` にする）sample は、`raw-excerpt-unchanged` では skip にせず `hold` に数える（§2.3）。ほかの 3 件では v1:54 のとおり skip。Graph の混入そのものは D8 が `fail` にするので、ここでは二重に `fail` にしない。
- **項目の状態**：variant × sample の最悪値（`fail` > `hold` > `pass`）。適用する variant ごとに、**検査した sample が 1 件以上**あり、検査した全 sample の全行が条件を満たすときだけ `pass`。検査した sample が 0 件の適用 variant は `hold`。項目全体は適用する variant の最悪値（`n/a` の variant は除く）。**§3 で適用すると決めた variant がすべて `blocked`（または評価できる variant が 0 件）の項目は、`n/a` ではなく `not-evaluable`** にする（manifest の `unverifiedRequirement`〔`manifest.v1.json:105`〕：全 applicable variant が blocked の required item は unverified）。実装の `worstStatus`（`quality-verdict.mjs:50-55`）は全部 `n/a` だと `n/a` を返し、条件 4 が `pass` になりうるので、v3 の実装はこの場合に `not-evaluable` を返す。
- **期待は fixture から導く**。観測どうしの照合だけで合格にしない（`raw-excerpt-unchanged` だけは、README・manifest の字義が相対の不変条件なので、同じ sample の親の観測と比べる。§2.3）。
- **`fail` と `hold`（E8）**：観測が取れていて期待と食い違えば `fail`、観測が取れていなければ `hold`。**例外は 3 点だけ**：(1) §2.3 の「比べられない」、(2) §2.1・§2.2・§2.4 の「期待する edge・Graph-only 行・path attachment が、`graph-ready` の表示側に 1 件も無い」（有無の食い違いは v1 §6 の edge の束縛〔期待の集合とちょうど一致を要求〕が `fail` にするので、ここで二重に数えず `hold`。条件 4 は edge の束縛の `fail` で落ちる）、(3) §2.3 の D8 の first-render。この選択を観測の後に変えない。
- **入力の誤りと、対応の無い ID は `[precheck]`**：fixture から current の text が導けない、G-05 の `assertions[current-entity-evidence].currentText` と導いた current が矛盾する、論理 ID が受領書の `settings.setupReceipt.logicalToRuntime` と 1 対 1 でない、または未対応の runtime ID がある（v1:22 の ID の規則と同じ。`setup-receipt.mjs:209-215` も map の欠けを `[precheck]` にする）、など。`hold` にしない。
- **blocked の扱い**：台帳の `blocked:*` の variant は 4 件とも `n/a`（README:96-100。macro の分母から外す）。`blocked:cb4-inputs` は `added-scene-body-anchor` も評価しない（README:99-100）。台帳が無いときは v1 §1 と同じ開示（blocked の判定を取り込まず、全 variant を数えた）。

### 2.1 `utf16-range`（fixture の `node-entity-evidence`）

**読み（回答で決定）**：v1 の名前 `utf16-range` を、fixture の `evidence.requirements` の `node-entity-evidence`、README:53 の「Entity の名前／要約の exact UTF-16 範囲」に当てる。期待値は、ユーザーの回答（追記その 1）のとおり「fixture の現在の名前／要約の `[start, end)` の hash」。

**出所の引用**（`origin/master` `3948eeb2`）：
- `evals/nir1-graph/README.md:52-54`「必須要素：Relation 正本、Entity の名前／要約の exact UTF-16 範囲、Revision／Decision の束縛、明示 pin。加えて、既存 Raw excerpt を変えないことと、追加 Scene の本文 anchor を求める」。
- `evals/nir1-graph/g06-evidence-anchor-path.v1.json:533`（`G-06-P1` の期待：「Entity Evidence whose quote is an exact UTF-16 range of the current name or summary Source」）。
- `evals/nir1-graph/schema.v1.json:936-960`（`evidence.requirements` の enum と `pathEvidenceValidity: 1`）。`manifest.v1.json:98`「path Evidence validity 100%」。
- `scripts/quality/nir1-graph/contract.mjs:263-268`（`REQUIRED_EVIDENCE`＝Graph が寄与する variant は `edge-relation-evidence`・`node-entity-evidence`・`revision-decision-binding`・`explicit-pin-association` を持つ）、`:1484-1508`（検査）。
- **fixture・README が言うのは「現在の名前か要約の exact な UTF-16 範囲」までである**。範囲が全長でなければならないこと、`sourceRef` が特定の形であることは言わない。製品のコードが何を作るかは、この定義の根拠にしない（§0 の 3）。

**適用する variant**：§3。

**期待値（current の text の集合 TS）**：端点 Entity E の、その variant の測定時の current の text の集合 TS(E) ＝ { current の label、current の summary }。
- label は fixture の `entities[].label`（`schema.v1.json:365-371` で `label`・`summary` は必須）。mutation の `kind` に label を変えるものは無いので、label は変わらない。
- summary の基になる text は fixture の `entities[].summary`。`mutations[]` のうち `kind` が `codex-entry-summary-edit` のものを、`setupTimeline` の順に、その Entity に適用する。`onlyInVariants` を持つ mutation は、その variant の名前を含むときだけ適用する（G-08 の `g08-m-juno`〔`g08-graph-index-fallback.v1.json:207-218`〕は `graph-index-unusable`・`graph-recovered`・`both-indexes-unusable` だけ。したがって G-08/base-usable の Juno は適用前の「Juno teaches music in a rented parlor.」、G-08/graph-recovered は適用後の「…violin…」）。他の `kind` の mutation（`codex-relation-type-edit`、`ir-approval-withdrawal`）は text を変えない。
- G-05 は `assertions[current-entity-evidence].currentText`（`g05-xan`＝「Xan carries a silver lamp on night watch.」。`g05-current-revision-freshness.v1.json:515-518`）と導いた current が一致しなければ `[precheck]`。
- G-01 には mutation が無い。current は `entitySeed`・`targetEntity` の `label`・`summary`（`evals/nir1-g01/fixture.v1.json:50-63`）。

**受領書に要る入力（範囲・hash・ID だけ）**：
- variant の測定の後に 1 回読んだ、typed Revision ごとの Evidence 行：`evidenceId`・`startUtf16`・`endUtf16`・`quoteSha256`（hash は node 側で作り、平文は受領書に書かない）と、「sample の後に読んだ」ことの印。`sourceRef` は開示の件数のためだけに載せる（判定に使わない）。
- 表示側の edge の Evidence 行：`evidenceId`・`quoteSha256`（既存の hash 済み path への足し）。端点の Entity の runtime ID は既存の path にある。
- edge から typed Revision への対応は v2 C2（harness の推定）をそのまま使う。

**pass の条件**：検査した sample の、表示した各 edge（両端の Entity を E1・E2 とする）について、次の 3 つがすべて成り立つ。
- (i) その edge の表示した Evidence 行（wire の行）の**すべて**について、E1 か E2 のどちらかの E と、TS(E) の T が在って、`evidenceId` で対応する読み取り済みの行の `[startUtf16, endUtf16)` が `0 ≤ start < end ≤ len(T)`（UTF-16 の長さ）で、**wire の行の `quoteSha256` と読み取り済みの行の `quoteSha256` の両方が、sha256(T[start, end)) に等しい**。
- (ii) 表示した `evidenceId` が、読み取り済みの Revision の Evidence の中に在る。
- (iii) E1・E2 のそれぞれについて、(i) を満たす行（その E の T で成り立つ行）が **1 件以上**ある。Evidence の行が 0 件の edge は、この条件で `fail`。

**開示の件数（判定に数えない）**：範囲が `[0, len(T))` の行数と、そうでない行数。範囲の長さ（`end − start`）が 1 の行数。`sourceRef` の異なる値の数と行数。（骨子・草案が判定に使っていた `[0, 長さ)` と `sourceRef` は、これらの件数にだけ載せる。E9。）

**fail**：読み取り済みの Revision の行が読めていて、(i)〜(iii) のどれかが成り立たない。G-05 の「superseded の text」（copper）の hash を返す古い Evidence は (i) で `fail`（`mustNotContain` は hash の不一致で見る）。表示した edge の Evidence 行に、端点の label・summary 由来でない行が含まれるときも (i) で `fail`（§6 の 2、§8 の 4）。

**hold**：読み取り済みの Evidence が無い（`evidenceObservation` に当たる記録が無い）、「sample の後に読んだ」ことの印が真でない、対応する typed Revision の行が読めない（`unavailable` など）、検査した sample が 0 件、検査する `graph-ready` の表示側に期待する edge が 1 件も無い（§2.0 の例外 (2)）。論理 ID を runtime に写せないのは `[precheck]`。

### 2.2 `explicit-pin-association`

**出所の引用**：
- `README.md:128`「到達した非 seed Entity の明示 pin だけを Scene に対応付ける。名前の一致や本文中の言及は使わない」。
- fixture：`pins[]`（`{sceneId, entryId, source: "scene_codex_pins"}`。例：G-02 `:215-`、G-05 `:202-`、G-08 `:169-`、G-01 `:71-`）、`variants[].expectations.pathAttachments[].path`（`{seedEntityId, edgeIds, targetEntityId, hop}`。G-02 `:415-`）、`addedScene.path`（G-02 `:426-`）、`scenesWithoutPath`（G-02 `:444`）。G-06 の `assertions[no-name-inferred-association]`（`sceneId: g06-c4`、`nameMentioned: Bram`。`g06-evidence-anchor-path.v1.json:500-504`）。G-01 は `expectations.graphPath`（`:90-97`。`targetEntityId`・`sceneId`・`hop: 1`）と `pins`。
- 検査器：`scripts/quality/nir1-graph/contract.mjs:1484-1508`、`:1459-1466`（`scenesWithoutPath` は、返された Scene のうち path も追加も持たないもの全部）。

**適用する variant**：§3。

**期待値（fixture から）**：
- Graph-only 行：期待の `sceneId`＝`addedScene.sceneId`（G-01 は `graphPath.sceneId`）、`pinEntityId`＝`addedScene.path.targetEntityId`（G-01 は `graphPath.targetEntityId`）の runtime ID。fixture の `pins` に `{sceneId, entryId == その targetEntityId}` が在ること（なければ入力の誤りで `[precheck]`）。`hop`＝`addedScene.path.hop`（G-01 は `graphPath.hop`）。
- path attachment 行：期待の `sceneId` の集合＝`pathAttachments[].sceneId`。各行の期待の終端 Entity＝その `path.targetEntityId` の runtime ID（`pins` に在る）、期待の `hop`＝`path.hop`。
- 期待の外：`pathAttachments` と `addedScene` のどちらにも無い Scene（`scenesWithoutPath` を含む）には、path attachment も Graph-only 行も付かない。

**受領書に要る入力**：Graph-only 行の `sceneId`・`hop`・`pinEntityId`。path attachment 行の `sceneId`・`hop`（表示側の記録）と、path の終端 Entity の ID（既存の hash 済み path にある）。論理 ID と runtime ID の対応は `settings.setupReceipt.logicalToRuntime`（Entity・Scene の対応が無い、または 1 対 1 でなければ `[precheck]`。§2.0）。

**pass の条件**：検査した sample の、表示側の全行について、上の期待と一致する（Graph-only 行の `sceneId`・`pinEntityId`・`hop`、attachment 行の終端 Entity と `hop`）。期待の外の Scene に path が付かない。

**fail**：期待の外の Scene に attachment か Graph-only 行が付く（G-06 の `no-name-inferred-association` はこれ）。`pinEntityId` か終端 Entity が期待と違う。`hop` が期待と違う。

**hold**：`pinEntityId`・`hop` の field が受領書に無い、検査した sample が 0 件、期待した Graph-only 行か path attachment が表示側に 1 件も無い（E8 の例外 (2)）。

**G-01**：`scenesWithoutPath` を持たず、path attachment も持たない。G-01 の pass の条件は、**表示側に path attachment が 1 件も無く（fixture の `pathAttachments` は空）、かつ Graph-only 行の `sceneId` が `graphPath.sceneId`（`g01-mira`）の runtime ID で、`pinEntityId` が `graphPath.targetEntityId`、`hop` が 1**（Graph-only 行はちょうど 1 件。0 件は E8 の例外 (2) で `hold`）。attachment が付く、期待の `sceneId` 以外に Graph-only 行が出る、`pinEntityId`・`hop` が違う、は `fail`。

### 2.3 `raw-excerpt-unchanged`

**出所の引用**：
- `README.md:45-48`（`expectations.arms`：「R+IR+Graph は、同じ run で観測した R+IR を、その kind にかかわらずそのまま先頭に置く」〔`:48`〕）、`:54`「既存 Raw excerpt を変えない」。
- `manifest.v1.json:100`「R+IR membership, order and excerpts unchanged for raw-full and ir-supplemented cases」。
- `contract.mjs:1495-1501`（path attachment がある variant は `raw-excerpt-unchanged` を持つ）。

**適用する variant**：§3（6 件。G-01 は n/a）。

**定義**：**同じ sample の中で**、親の R+IR の行（親の最終一覧）と、表示された子の行のうち R+IR 由来の行（Graph-only 行を除く全行）を、membership・順序・各行の excerpt の sha256・UTF-16 長で比べる。arm をまたいで比べない（R+IR arm の行は取らない）。期待は同じ sample の親の観測。これは §2.0 の「期待は fixture から」の唯一の例外で、条件の字義が「観測した R+IR を変えない」という相対の不変条件であることによる。

**「比べられる sample」の意味（今、固定する）**：子が、**同じ親の、同じ query の世代の follow-up であり、かつ親の IR が完了している**sample だけを、比べられる sample とする。それ以外（親の IR が未完、子が別の query の世代、または子が無い first-render）は、同じ sample の中で比べられない。受領書のどの記録（field 名）でこれを読むかは S2 の追補で決める（§10、§12）。意味を変える読みが必要になれば v4。

**受領書に要る入力**：表示側（親と子）の最終一覧の行ごとに、`sceneId`・`kind`（raw／ir／graph-only）・`excerptSha256`・`excerptUtf16Length`。親の IR の完了と、子が同じ親の同じ query の世代の follow-up であることを示す既存の記録（v2 の `parent.completion`・`child.queryGeneration` に当たるもの。名前は S2 の追補で確定する）。

**pass の条件**：検査した sample（子が表示され、比べられる sample）について、子の Graph-only 行を除いた行の列が、親の行の列と、長さ・順序・各行の `sceneId`・`kind`・`excerptSha256`・`excerptUtf16Length` のすべてで一致する。

**fail**：上のどれかが違う（Graph の表示が R+IR の行を並べ替える・落とす・excerpt を変える・R+IR の外の行を足す）。

**hold**（§2.0 の例外 (1)(3)。食い違いではなく、比べられない）：`rowExcerpts` に当たる記録が無い。親の IR の completion が終わっていない、または子が親と別の query の世代を挟んでいて、同じ sample の中で比べられない。**v2 D8 の first-render の sample**（子が無く、親の合流が Graph を受けて表示に寄与した sample）。検査した sample が 0 件。

### 2.4 `added-scene-body-anchor`

**出所の引用**：
- `README.md:54`「追加 Scene の本文 anchor を求める」、`:99-100`（`cb4-inputs` が成り立たなければ `added-scene-body-anchor` を評価しない）。
- fixture：`variants[].expectations.addedScene.sceneExcerpt`（`{sceneId, body, canonicalUtf16Range{start, end}}`。G-02 `:434-437`、G-04 v2 `:565-568`、G-07 `:526-529`、G-08 base-usable `:338-341`、graph-recovered `:544-547`）。G-01 は `expectations.sceneExcerpt`（`evals/nir1-g01/fixture.v1.json:98-101`。範囲 `[0, 78)`、本文の UTF-16 長は 78）。
- 検査器：`contract.mjs:1426-1435`（`excerpt.body === scene.body`、`canonicalUtf16Range.end === utf16Length(body)`、「first non-empty line [0, length)」）、`:1502-1508`。

**適用する variant**：§3（5 件＋G-01）。

**期待値（fixture から）**：Graph-only 行の `sceneId`（runtime ID）＝`sceneExcerpt.sceneId`、`canonicalRange`＝`{start: 0, end: 本文の UTF-16 長}`（fixture の `canonicalUtf16Range` そのもの。この範囲は fixture が宣言する値で、追加 Scene の本文 anchor の期待値としてそのまま使う）、`excerptSha256`＝sha256(`sceneExcerpt.body`)、`excerptUtf16Length`＝`body` の UTF-16 長。

**受領書に要る入力**：Graph-only 行の `sceneId`・`canonicalRange{start, end}`・`excerptSha256`・`excerptUtf16Length`（excerpt の平文は node 側で hash と長さにして捨てる）。

**pass の条件**：検査した sample の Graph-only 行について、上の 4 つがすべて期待と一致する。

**fail**：4 つのどれかが違う（範囲の `end` が 1 ずれる、excerpt の hash が本文と違う、など）。

**hold**：Graph-only 行の field が受領書に無い。期待に追加 Scene があり、子が `graph-ready` で表示されているのに Graph-only 行が無い（§2.0 の例外 (2)。有無の食い違いは edge の束縛と v2 の条件 1・2・5 が受け持つ）。検査した sample が 0 件。

## 3. 適用する variant（fixture の `evidence.requirements` から。観測の後に選ばない）

Gold の run は G-04 v2 を使う（12 variant＋G-01 の 13 variant。G-04 v1 は使わない）。`requirements` は 3948eeb2 の fixture を数えた。

| variant | `requirements` の行（fixture） | `utf16-range` | `explicit-pin-association` | `raw-excerpt-unchanged` | `added-scene-body-anchor` |
|---|---|---|---|---|---|
| G-01（`evals/nir1-g01/fixture.v1.json`） | 持たない。**回答 A で、3 件を適用** | 適用 | 適用 | n/a（path attachment が無い） | 適用 |
| G-02 base | `g02-directed-relation.v1.json:448` | 適用 | 適用 | 適用 | 適用 |
| G-03 base | `g03-bounded-two-hop.v1.json:1722` | 適用 | 適用 | 適用 | n/a（追加 Scene が無い） |
| G-03 frontier-exceeded | `:1848`（`[]`） | n/a | n/a | n/a | n/a |
| G-04 v2 base | `g04-scope-exact-unknown.v2.json:581` | 適用 | 適用 | n/a（path attachment が 0 件） | 適用 |
| G-05 base | `g05-current-revision-freshness.v1.json:506` | 適用 | 適用 | 適用 | n/a |
| G-06 base | `g06-evidence-anchor-path.v1.json:486` | 適用 | 適用 | 適用 | n/a |
| G-07 base | `g07-reading-before-reveal.v1.json:540` | 適用 | 適用 | 適用 | 適用 |
| G-08 base-usable | `g08-graph-index-fallback.v1.json:352` | 適用 | 適用 | 適用 | 適用 |
| G-08 graph-index-unusable | `:436`（`[]`） | n/a | n/a | n/a | n/a |
| G-08 graph-recovered | `:558` | 適用 | 適用 | n/a（path attachment が 0 件） | 適用 |
| G-08 chronicle-index-unusable | `:641`（`[]`） | n/a | n/a | n/a | n/a |
| G-08 both-indexes-unusable | `:718`（`[]`） | n/a | n/a | n/a | n/a |

- 数：`utf16-range`・`explicit-pin-association` は 9（G-01＋8）、`raw-excerpt-unchanged` は 6、`added-scene-body-anchor` は 6（G-01＋5）、4 件とも n/a は 4。適用する variant は 9＋n/a 4＝13。
- `requirements` が `[]` の variant の「Graph が出ない」ことの検査は v1 §3・v2 D3・D8 が受け持つ。v3 は触れない。
- 追加 Scene の有無・path attachment の有無は fixture の事実で、v3 で変えない（`contract.mjs:1485-1508` が `requirements` との一致を検査している）。

## 4. Q6：hash は照合のためで、秘匿のためではない

- Q6（ユーザー決定）：記録は範囲（UTF-16 の位置）・hash・ID だけ。本文・excerpt・quote の平文を残さない。
- **hash は照合のためのもので、秘匿のためではない**。fixture の本文・summary は公開物で、期待の hash は fixture から誰でも再計算できる。**fixture 以外の本文（本物の作者のデータ）には、この hash を使わない**（short な本文の hash は辞書攻撃で戻せるので、秘匿にならない）。
- **判定の入力に、本文・excerpt・quote の平文も、Evidence の JSON も使わない**。判定は hash・範囲・長さ・ID だけを読む。期待の hash は、判定側が fixture（`FROZEN_FIXTURE_SHA256` を照合してから読む）から計算する。受領書の値どうしの突き合わせで期待を作らない（`raw-excerpt-unchanged` の同じ sample の比較を除く。§2.3）。
- **平文が受領書に混入したら検出して拒否する規則を、S2 で必須として固定する**（§10 の 5）。内容：(i) 新 field の値は、整数・64 桁の hex・ID の形に加えて、**列挙値（`kind` の `raw`／`ir`／`graph-only` など、固定の語彙）・真偽値・null** を許し、それ以外の文字列を許さない。`quote`・`excerpt`・`body`・`text`・`summary` を名前に持つ key を許さない。(ii) 受領書の全 field に、fixture 由来の **Scene の本文、`sceneExcerpt.body`、Entity の summary** が部分文字列として現れたら拒否する（走査はこの 3 種だけ。Entity の label は短く、ID や既存 field に正当に現れうるので走査しない）。(iii) Evidence の JSON の形（`evidenceId` と `quote` を持つ object）が現れたら拒否する。拒否の規則に負例の組（平文を新 field に入れた受領書、既存 field に入れた受領書、Evidence の JSON を入れた受領書、禁止 key 名を使った受領書。いずれも拒否されること）と、正例（列挙値・真偽値・null を含む、この草案自身の新 field の値の例が拒否されないこと）を足す。
- 置き場の実装は統合者の技術判断。平文の混入を拒む規則を置くこと自体は技術判断でなく、この版の定義として固定する。

## 5. 受領書に要る入力（まとめ。名前は仮で、S2 の追補で確定する）

| 入力 | 中身（整数・64 桁の hex・ID・固定の語彙・真偽値・null だけ） | 使う項目 |
|---|---|---|
| 親・子の `evidence` | `graphOnly: null \| { sceneId, hop, pinEntityId, canonicalRange{start, end}, excerptSha256, excerptUtf16Length }`、`pathAttachments: [{ sceneId, hop }]`、path の edge の Evidence 行に `quoteSha256` を足す | 2.1・2.2・2.4 |
| 親・子の `rowExcerpts` | `[{ sceneId, kind, excerptSha256, excerptUtf16Length }]`（表示側の最終一覧の行ごと）と、親の IR の完了・子が同じ親の同じ query の世代の follow-up であることを示す既存の記録 | 2.3 |
| Gold の最上位 `evidenceObservation` | typed Revision ごとの `[{ evidenceId, sourceRef, startUtf16, endUtf16, quoteSha256 }]` と、「sample の後に読んだ」印（`sourceRef` は開示の件数のためだけ） | 2.1 |

- 新 field が欠けた受領書は、harness が `[artifact]` で止めず、判定側が `hold` にする（harness の規則を増やさない）。ただし平文の混入は harness 側で拒否する（§4）。

## 6. 全体の verdict への影響（開示）

**実装の字義**（`scripts/quality/nir1-graph-eval/quality-verdict.mjs:1333-1368`）：全体は `pass` か `hold` の 2 つだけ（`:1366`）。5 つの条件のうち 1 つでも `pass` でなければ `hold`。理由は `failed-required-items`（`fail` の条件がある）、`held-required-items`、`unverified-required-items`（`not-evaluable` がある）が並ぶ。**全体が `fail` になることは無い**。以降の「FAIL」は、ユーザーが受け入れた意味（条件 4 が `fail` になり、全体が `hold: failed-required-items` になること）で書く。

- **全体は `pass` にならない**。既存 24 件の Graph arm（条件 2 の部品）と禁止寄与の (c)（条件 5 の部品）は `not-evaluable` のまま（v3 は測らない）。したがって 4 件がすべて `pass` でも、全体は `hold: unverified-required-items`。
- **FAIL になりうる**（ユーザーは受け入れた。U1a）。v1・v2 では条件 4 は常に `not-evaluable` だった。v3 は 4 件を測るので、1 件でも `fail` なら条件 4 は `fail`、全体の理由に `failed-required-items` が加わる。fixture・Gold・合格基準を直して通すことはしない。FAIL になりうる原因：
  1. `added-scene-body-anchor`：fixture の追加 Scene の範囲は単一行の本文で `[0, len)`（`contract.mjs:1426-1435`）。製品の canonical 化や excerpt の切り方が違えば、`end` が 1 ずれる、excerpt が本文と一致しない、が起きる。製品の表示用 excerpt が本文と完全一致する保証は、起案者は確かめていない。
  2. `utf16-range`：表示した edge の Evidence の行の hash が、端点 Entity の current の label・summary の範囲の hash と一致しなければ `fail`（G-05 の古い text〔copper〕を含む）。edge の Evidence に端点の text 由来でない行（Relation の Evidence など）が含まれるなら、その行も一致せず `fail` になる。含まれるかどうかは、起案者は確かめていない（製品のコードを根拠にしない）。端点に有効な行が 1 件も無い edge も `fail`。
  3. `explicit-pin-association`：製品が名前の言及で Scene を付ける実装なら、G-06 の `scenesWithoutPath`（`no-name-inferred-association`）で `fail`。検査したい挙動そのもの。
  4. `raw-excerpt-unchanged`：同じ sample の中で比べるので、arm 間の非決定では落ちない。落ちるのは、Graph の表示が R+IR の行を変えたときだけ。
  5. p95（条件 3）：採取は `tFetch`〜`tReturn` の外（返却後、node 側）に限る。s7r1 の Graph arm の p95 は 92.70 ms で上限 94.2 ms に 1.5 ms の余裕しかない（設計 §2）。dev の予行で前後の p95 の分布を比べる。p95 が上限を超えれば条件 3 が `fail` になる（v3 の定義の外の理由で全体の理由が増える）。
- 条件 4 が `pass` になるのは、`edge-binding`・`graph-contributed-parent-counted` と 4 件がすべて `pass`（または適用外の `n/a`）のときだけ。4 件のどれかが `not-evaluable`（§2.0。適用する variant がすべて blocked の項目を含む）なら、条件 4 は `not-evaluable` 以下。

## 7. 守ること（v3 の In-scope な誤り）

- 4 件を、期待の観測どうしの自己照合で `pass` にしない（§2.0。例外は §2.3 だけ）。
- 観測が取れていない sample を `pass` にしない。欠けは `hold`（§2）。Evidence の行が 0 件の edge を `pass` にしない（§2.1 (iii)）。
- 適用する variant がすべて blocked の項目を `n/a` にして条件 4 を `pass` にしない（§2.0）。
- 平文・Evidence の JSON を判定の入力にしない。受領書に平文を書かない（§4）。
- 定義の根拠に製品のコードを使わない。範囲の全長・`sourceRef` の形を判定に戻さない（§2.1）。
- 適用する variant を観測の後に選ばない（§3）。`fail` と `hold` の選択を観測の後に変えない。
- s7r2 以前の受領書や、dev の予行の値に v3 を当てて「結果」と呼ばない。
- 24 件の Graph arm と (c) を、4 件の結果で `pass` に読み替えない。
- G-01 に `raw-excerpt-unchanged` を当てない（回答 A）。

## 8. 確かめられないこと（v1 §9・v2 §3 に足す）

1. 製品の Graph-only の `excerpt` と `canonicalRange` が、fixture の本文・`[0, len)` と完全一致するか（dev の予行は ⑥ の後）。
2. `nir1_entity_relation_revision_read`（Evidence の範囲を読む）が、維持・cache に触れないか。
3. 親の IR の完了と、子が同じ親の同じ query の世代の follow-up であることを、受領書のどの記録（field 名）で読むか（§2.3 の「比べられる sample」の意味は固定した。field 名だけ S2 の追補で確定する）。確定した読みが §2.3 の意味と合わなければ v4。
4. 表示した edge の Evidence の行に、端点 Entity の label・summary 由来でない行（Relation の Evidence など）が含まれうるか。含まれれば hash の不一致で `fail` になる（§6 の 2）。製品のコードは根拠にしないので、起案者は確かめていない。
5. 平文混入の拒否の規則（§4 (ii) の部分文字列の走査）が、既存の受領書の正当な field（`paths` の hash など）を誤って拒否しないか。
6. `evidenceObservation` を variant の測定の後に 1 回読むことが、測定の p95 に触れないか（sample ごとには読まない）。
7. skip は v1:54 の字義（子が無い、または子が `graph-ready` でない sample）に限る。それでも、Graph が出る sample が少ない variant では、検査する sample が少ないまま `pass` になりうる（0 件は `hold`）。何件以上を要するかの閾値は置かない（閾値の追加になるため）。skip の件数は出力に開示する。
8. v3 の定数を S2 の `observation-prep.mjs` に足すことが、S2 の他の file の再凍結を招くか（§10 の 5）。
9. **範囲が 1 文字でも `utf16-range` は通る**。fixture・README は「現在の名前か要約の exact な範囲」としか言わず、範囲の長さの下限も、全長であることも求めない。したがって hash が current の text の `[start, end)` と一致する限り、1 文字の Evidence 行でも `pass` になる（古い text の hash を返す、別の text の hash を返す、端点に行が無い、は `fail`）。この弱点は、製品の知識（prepare が全長の範囲を作ること）で強めない。範囲が全長の行数・長さ 1 の行数は、開示の件数として出力に載せる（§2.1）。

## 9. s6r1・s7r1 などに当てた参考値

**無い**。観測の前に書くので、参考値を出さない（受領書に新しい field が無く、当てれば 4 項目は field の欠けで全部 `hold`）。

## 10. 確定の後の手順

1. ユーザーが、この file の SHA-256 を名指しした確認（§11）に回答する。回答を contracts に記録する。
2. v3 の file を contracts（`claude/nir1-contracts`）に固定して push し、remote 側の時刻を記録する（v2 §0 の記録の形）。
3. 判定の実装：`quality-verdict.mjs`（`evidenceComponents` の直書き `:860-871` を観測を読む形に。(c) と `existing-24-graph-arm` は変えない。§2.0 の「適用する variant がすべて blocked なら `not-evaluable`」を入れる）、`quality-verdict-cli.mjs`（`loadExpectations` に `requirements`・`sceneExcerpt`・`pins`・current の text〔label・summary〕の導出・G-01 の fixture の読みを足す）、`quality-verdict.test.mjs`（**合成の受領書だけ**で試験）。独立のコードレビュー（read-only。起案者の結論は渡さない）→ 反映 → push・remote 側の時刻。
4. S2 の追補：受領書の field の名前（技術判断）、親の IR の完了と子の query の世代の読み（§8 の 3。意味は §2.3 で固定済み）、harness の採取の変更（`cp4-k64-probe.tsx`・`material-revision.mjs`・`frozen-k64-run.mjs`、node 側の hash 化）。
5. **v3 用の定数が要る**：v2 は S2 の定数 `K66_QUALITY_VERDICT_V2`（`scripts/quality/nir1-graph/observation-prep.mjs:191-205`）に、v2 の path・commit・sha256、freeze record、`implementationCommit` を固定している。v3 にも同じ形の定数（名前は S2 の追補で確定する）が要る。v3 の commit を 2・3 で push した後に足す。同時に、`--v3-file` に当たる CLI の入力、v2 §0 の検査 (1)〜(5) を v3 に当てた検査（組の検査、**remote 側の時刻が最初の正式 run より前であること**、`--v3-file` の bytes と commit の一致、動いている実装の bytes と `--impl-commit` の一致）を足す。v2 の検査が名指しする実装の枝名は、v3 では枝名に固定せず、**commit で束縛する**（決定。§12）。平文の混入の拒否の規則（§4）と負例・正例の組もここで `receipt.mjs`・`test-support.mjs` に入れる。**S4 の ⑤（検出力の記録）より前に入れる**（S4 の規則の file を ⑤〜⑦ の間に変えないため）。
6. dev の予行（field が採れるか、製品の Graph-only の excerpt の形、前後の p95）。判定に数えず、**ここで見た値で v3 の定義を変えない**。
7. S4（凍結・pin の取り直し・正式 run）。Gold の run に相乗りする。回数の確定は S3。
8. 正式 run の後に v3 で判定し、v2 の判定と並べて記録する（v1・v2 を書き換えない）。

## 11. ユーザーへの最終確認（AskUserQuestion の案。1 問）

**質問**：

「品質判定 v3 の草案（この file の SHA-256）の決め方で、次の正式 run を測ってよいですか。
- 新たに測るのは、根拠の正しさの 4 項目です（Entity の引用範囲、明示 pin、既存の excerpt を変えないこと、追加 Scene の本文）。既存 24 件の Graph と、Graph DTO の禁止寄与は測らずに開示します。
- 引用範囲は fixture の文言どおり、『現在の名前か要約の中の正確な範囲で、hash が一致すること』だけで見ます。骨子にあった『先頭から全長』の条件は製品のコードから来ていたので、判定から外して件数の開示だけにします。
- Graph の取り直し（子）が無いか、完了していない sample は検査せず、件数を開示します。
- 期待した Graph の行が表示に無い場合と、子の無い first-render は、この 4 項目では保留と数えます。不合格は既存の項目（edge の束縛、D8）が出します。
- 全体の判定は合格になりません。食い違いが 1 つでもあれば『保留（理由：不合格の項目あり）』と出ます。
- 決め方は測る前に固定し、測った後には変えません。」

選択肢：
1. **「この SHA-256 の決め方で測る（推奨）」**：確定の手順（§10）へ進む。
2. **「変えたい点がある」**：変える点を書いてもらう。草案を直し、SHA-256 を取り直して聞き直す。
3. **「今は確定しない」**：v3 を確定せず、4 件は `not-evaluable` のまま開示する。

- 値（SHA-256）は本文に埋めず、質問を出す時点で `sha256sum` を取って示す。草案を変えたら取り直す。
- 前回の追記の回答（`utf16-range`＝`node-entity-evidence`、G-01＝A）は決定済みなので、選択肢に戻さない。

## 12. 決めきれず、確認・後の手順に残す点

### 閉じた点（Opus レビュー 1 の推奨 1〜4 で閉じた）

1. **`utf16-range` の定義の出所**：fixture・README だけで決まる版にした（§2.1）。範囲 `[0, 長さ)` と `sourceRef` は判定から外し、開示の件数にする。1 文字の範囲でも通る弱点は §8 の 9 で開示し、製品の知識で強めない。骨子から変えたことは §0・改訂の履歴・§11 に書いた。
2. **「Graph を表示していない sample は検査しない」（skip）**：残す。v1:54 の字義（子が無い、または子が `graph-ready` でない sample）に戻し、件数を開示する（§2.0、§8 の 7）。D8 の first-render は §2.3 で `hold` にする。
3. **§2.3 の「比べられない」の意味**：今、固定した。子は同じ親の同じ query の世代の follow-up で、親の IR が完了している。field 名だけを S2 に回す（下）。
4. **v2 §0 の検査 (2) の実装の枝名**：v3 では枝名に固定せず、commit で束縛する。あわせて、push の時刻が最初の正式 run より前であることを検査する（§10 の 5）。

### S2・S3 に回す点（Opus レビュー 1 の推奨 5）

5. v3 の定数名、受領書の field 名（§2.3 の「比べられる sample」を読む記録の名前を含む）、S4 の回数：S2 の追補・S3 で確定する（草案では作らない）。
