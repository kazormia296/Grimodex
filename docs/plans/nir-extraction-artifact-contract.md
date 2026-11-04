# Chronicle 抽出の途中の記録の契約（案 0）

| 項目         | 値                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状態         | 契約として明文化し、試験で固定した（2026-11-05）。製品コードの挙動は変えていない                                                                                                                                                |
| 依頼         | ユーザー「案 0 の契約の固めも進めておいてください」（2026-11-05）。案 0 は Fable との read-only の設計相談の推奨（要約とユーザーの回答は repo 外の `fusion-eval-data/design-notes/nir-raw-observations-consult-2026-11-05.md`） |
| 基点         | `master@6d7f0941`                                                                                                                                                                                                               |
| 対象         | `narrative_extraction_artifacts`（Chronicle 抽出の途中の記録。kind は `CHRONICLE_EXTRACT_ARTIFACT_KINDS` の 10 件）                                                                                                             |
| 判断 ID      | DR-NAC-1〜6（本書が記録先。作業記録は [nir1-continuation-2026-10.md](nir1-continuation-2026-10.md) §3.2 の箇条書きに 1 行）                                                                                                     |
| 範囲外       | 新しい table（正本化）、検索・表示・chat への経路（Consumer 化）、増分再解釈、ネタバレの開示制限、安定 ID の割当て。これらは新しい保存範囲・送信先・authority を伴うので、この契約では決めない                                  |
| 固定する試験 | §8                                                                                                                                                                                                                              |

## 1. 目的

Chronicle 抽出は、場面の本文から「観測」（モデルが本文から読み取った出来事の主張）を作り、根拠の解決、merge、クラスタ化、合成、既存事象との照合を経て、作者が review する提案を作る。途中の各段の結果は `narrative_extraction_artifacts` に残る。

この記録は、すでに次の読み手を持つ。resume、IR の cold build の CAS、Source としての解決、restore、承認済み Revision の根拠の検証、material roster の replay、適用済み Revision の存在検証（§5）。後から動かすと、保存済みの記録が読めなくなるか、同一性が食い違う点が 4 つある。本書はそれを、**今の挙動を変えずに**契約として書き、試験で固定する。

1. kind の版と payload の形（DR-NAC-2）
2. 観測の同一性（DR-NAC-3）
3. 保持の方針と、消す経路を作るときの条件（DR-NAC-4）
4. 観測と根拠の対応（DR-NAC-5）

あわせて、観測の位置付け（DR-NAC-1）を書く。

## 2. DR-NAC-1 観測の位置付け

ユーザーの方針（2026-11-05）に従う。

- 観測は、モデルが本文を読んだときの**解釈の一例**であり、確定した事実ではない。Codex の項目や、作者が承認した Revision と同じ重さを持たない。
- 承認は記録された決定（`narrative_proposal_decisions`）だけが作る。承認された提案の Revision だけが正本側（IR、Graph、chat の `chronicleSnapshot`）に届く。観測、仮説、承認されなかった提案は届かない。IR の roster（`nir1_chronicle_index/source.rs` の `EligibilitySource`）の digest には未承認・不適格の Revision も入るが（空の index も失効できるように）、retrieval に admit されるのは承認済みの Revision だけである（`retrieval_admission/build.rs` の `BuildCandidate`）。観測は roster にも admit にも入らず、観測を直接読む経路は無い。
- 今は、観測を検索・表示・chat の文脈に出す経路を作らない。run を跨いだ再利用もしない。
- 現在の観測の入力は、場面の本文と、既存事象の catalog（決定的な照合にだけ使い、モデルには見せない）だけである。この間、観測にはネタバレが生じない（結果的に正しくても、読者が本文から辿り着ける）。そのため、今の観測には開示制限（secret／reveal）を付けていない。提案が持つ `disclosure` の既定（`secret: true`）は観測には無い。
- **「本文だけを読む」ことは製品の契約ではない。** 抽出の文脈は Chat と同じ挙動でよい、というユーザーの回答（2026-11-05）に従う。Context Set に Codex の名前、視点人物や時制などの設定、前の場面を足す設計は、この契約と矛盾しない。ただし、**注入する文脈の種類で、観測の開示を決め直す**（再決定の対象）。本文と Codex の名前だけなら今のままだが、Codex の詳細や作者の設定まで入れるなら、その観測は Codex と同じ開示の扱いになりうる。この文書は、その開示をここでは決めない（冒頭の「範囲外」と同じ）。Codex の名前や設定をモデルに送ることは送信範囲の拡大で、別にユーザーの確認が要る。
- 将来、観測を見せる口や Consumer を作るときの**必須の条件**: Codex と承認済み Revision から、機械的にも見た目でも**明確に区別できる**こと（「AI の観測であり、承認されていない」と判別できる出所の表示を持つ）。また、新しい保存範囲・送信先・authority を伴うので、AGENTS.md の NIR-1 の委任の外で、ユーザーの確認が要る。
- ADR 010 §16 と整合する。「Durable identity のない IR を Consumer にしない」。観測は §4 の内容キーしか持たず、安定 ID を持たない。

## 3. DR-NAC-2 artifact kind の版の凍結

### 3.1. kind の一覧（固定）

`src/application/narrative-extraction/extractionContract.ts` の `CHRONICLE_EXTRACT_ARTIFACT_KINDS`。増減・改名・版上げは試験が落ちる。

| 識別子                  | kind                                  | 作る task（`validate_chronicle_resume_artifacts` の `TASK_ARTIFACTS`。`repository.rs`） | Rust 側で kind を読む場所                                                                                    |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `snapshot`              | `source.snapshot@1`                   | `source.snapshot@1`                                                                     | resume（`repository.rs`）、`scope_authority_runtime.rs`、`material_membership_root.rs`、replay               |
| `windowPlan`            | `source.window-plan@1`                | `source.window-plan@1`                                                                  | resume、`material_membership_root.rs`、replay（`/windows[]/windowId`）                                       |
| `observations`          | `chronicle.raw-observations@1`        | `chronicle.observe-events@1`                                                            | resume、`stage_provenance.rs:38`、replay。AI 観測の 1 attempt に付き**ちょうど 1 件**（`repository.rs:869`） |
| `resolvedEvidence`      | `evidence.resolved@1`                 | `evidence.resolve@1`                                                                    | resume、`nir1_chronicle_index/evidence.rs`、`retrieval_admission/build.rs:186`                               |
| `mergedObservations`    | `chronicle.merged-observations@1`     | `chronicle.merge-local-observations@1`                                                  | resume、replay（raw と一致する recipe だけ対応）                                                             |
| `clusters`              | `chronicle.event-clusters@1`          | `chronicle.cluster-event-observations@1`                                                | resume、replay（`observationRefs`）                                                                          |
| `hypotheses`            | `chronicle.event-hypotheses@1`        | `chronicle.synthesize-event@1`                                                          | resume、`stage_provenance.rs`                                                                                |
| `stageSynthesisOutputs` | `chronicle.stage-synthesis-outputs@1` | `chronicle.synthesize-event@1`（companion。C1 のみ）                                    | `stage_provenance.rs`、replay                                                                                |
| `matches`               | `chronicle.existing-event-matches@1`  | `chronicle.match-existing-events@1`                                                     | resume                                                                                                       |
| `proposals`             | `chronicle.proposal-plan@1`           | `chronicle.plan-proposals@1`                                                            | resume                                                                                                       |

`source.snapshot@1` の payload には、入れ子の `chronicle.existing-events-catalog@1` と `chronicle.snapshot-evidence-companion@1`、`scopeAuthorityDocuments` が入る。これらは別の artifact kind ではなく、`source.snapshot@1` の形の一部として同じ規則に従う。

### 3.2. 規則

1. **保存済みの記録は、互換 adapter なしに形を変えない。** `@1` の payload の field の削除・改名・意味の変更はしない。追加は 3 の条件を満たす任意 field だけである。`@1` を読む Rust／TS のコードは、既存の workspace に保存された `@1` を今後も読める。
2. 形を変えるときは、新しい kind（`@2`）を作り、`@1` の読み手を残す。`@1` を `@2` に書き換える migration は、ユーザーの確認が要る保存範囲の変更として扱う。
3. 追加する field は、`@1` の読み手が無視できる任意 field に限る。ただし digest を取る payload（`payload_digest`。resume、CAS、replay が照合する）に field を足すと、その kind を再生成した run と保存済みの run の digest は一致しなくなる。足すなら、既存の記録を書き換えず、新しい run だけに現れることを確かめる。
4. 新しい kind を足すときは、`CHRONICLE_EXTRACT_ARTIFACT_KINDS`、Rust の `TASK_ARTIFACTS`（resume の検証）、本書の表、固定する試験を同時に更新する。

### 3.3. `@1` の読み手が依存する field（下限）

次は Rust が名前で読む field で、`@1` のうちは変えない。

- `evidence.resolved@1`: `anchors[].id`、`documentRef`、`quote`、`quoteDigest`、`canonicalRange.start`、`canonicalRange.end`（`nir1_chronicle_index/evidence.rs`）。承認済み Revision は anchor の `id` を `evidenceAnchorIds` で参照する。anchor の `id` は run の中の連番で、run を跨ぐ ID ではない。
- `chronicle.raw-observations@1`: `observations[].localId`。形は `<windowId>:obs-NNN`（`rekeyObservationsForWindow`）で、`source.window-plan@1` の `windows[].windowId` と 1 対 1 に対応する（replay の `observation-window-lineage-invalid`）。
- `source.snapshot@1`: `evidence.catalog.version` と `evidence.catalog.segmentationVersion`（replay が `sentence-like-v1` だけを対応とする）。
- `chronicle.event-clusters@1`: `observationRefs`（replay が観測の `localId` と突き合わせる）。`source.window-plan@1`: `windows[].windowId`。

これは**下限**であり、payload の形の全体を固定するものではない。試験が固定するのは、kind 名と、Rust が名前で読む field の存在（文字列の一致）までである。それ以外の field（観測の `payload` など）は TS の型と schema が正本で、`@1` のうちは互換 adapter なしに変えないという §3.2 の規則だけが契約になる。

## 4. DR-NAC-3 観測の内容ベース同一性キー

### 4.1. 規則

観測の同一性は、**内容**で決まる。`mergeObservationsByEvidence`（`src/features/chronicle/extraction/observationMerger.ts`）が、cross-window の重複を畳む唯一の規則であり、これを契約とする。

| 部分         | 入る field                                                                                                                                                                                                                   | 入らない field                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 観測         | `evidence`、`assertion`、`payload`                                                                                                                                                                                           | `localId`                                                        |
| `evidence[]` | `sourceRef`、`quote`（`chronicleEvidenceTupleKey` で collision-free にし、**整列した多重集合**として扱う。順序は無視するが、**重複は除かない**）                                                                             | `prefix`、`suffix`（解決の絞り込みの手がかりで、同一性ではない） |
| `assertion`  | `attribution`、`narrativeFrame`                                                                                                                                                                                              | なし                                                             |
| `payload`    | `predicate`、`semanticType`（未指定は null）、`actuality`、`participants`（順序を含む。要素の `surface`／`role` の全 field が入る）、`locationSurface`（未指定は null）、`temporalExpressions`（順序を含む）、`durationKind` | なし                                                             |

- 同じ文が複数の述語・actuality・参加者の役・narrative frame を支える場合、evidence が同じでも**畳まない**。
- evidence の重複は畳まない。`evidence: [a, a]` と `[a]` は別の同一性になり、merge で畳まれない。
- `participants` は配列ごと `JSON.stringify` されるので、要素の field の追加・削除に加えて、キーの挿入順の違いも同一性を変える（現状の挙動。モデルの出力は schema を通った正規形なので、実害は無い）。
- 畳むときは、先に来た行を残す（first-wins）。後の行の `localId` は捨てる。
- 型 `RawChronicleEventObservation` に field が増減したら、試験の対応表が型エラーになる。**増えた field を同一性に入れるか、入れないか**を明示的に決めてからでないと merge できない。同一性キーの field を足す・外すと、保存済みの run の `chronicle.merged-observations@1` を同じ規則で再現できなくなる。変えるなら新しい kind（merge 結果の版）として扱う（§3.2）。
- 同一性キーを緩めて**より多く畳む**と、material roster の replay は raw と merged が一致しない run を「`nonidentity-merge-recipe-not-implemented`」（未対応）にする。つまり merge で行が減る run は、今は承認済みの Revision の material 検証が通らない。キーの変更は、この replay の対応範囲と一緒に決める。

### 4.2. `localId` は同一性ではない

`localId` は窓ごとのモデルの出力を `rekeyObservationsForWindow` が窓内の連番に振り直したもので、cross-run で安定した ID ではない。同じ本文を再抽出すると、同じ観測に別の `localId` が付く。`localId` は 1 つの run の中で、クラスタ（`observationRefs`）と仮説（`observationRefs`）が観測を指すためだけに使う。

### 4.3. 将来の安定 ID

- **heuristic な別 ID を作らない。** 類似度、述語の近さ、順序などから ID を捏造しない。ADR 005 の「Stable assertion identity」（`docs/adr/005-narrative-semantic-core-boundary.md`）は、安定 identity が無いとき Deterministic Core が heuristic matching で identity を捏造してはならないと定め、ADR 010 §16（`docs/adr/010-narrative-dependency-role-granularity-contract.md`）も「Payload から heuristic ID を作ってはならない」と定める。
- 将来 `assertionId` などの安定 ID を割り当てるときは、**この内容キーを導出元の第一候補とする**（決定的な digest とし、入力 field は §4.1 のとおり）。ただし、内容キーはモデルの言い回し（`predicate`、`quote`）に依存するので、再抽出で同じ観測が同じ ID になる保証は無い。cross-run で安定するかどうかは、割当て規則を決めるときに評価する（この契約では確定しない）。ADR 010 §16 の「Payload から heuristic ID を作ってはならない」は `narrative-ir-revision` の Consumer の粒度の規則で、決定的な内容 digest を直ちに禁じるものではない。割当て規則は、cross-run merge、partial retraction、長期の Dependency FK、利用者に見える履歴、Assertion ID による Graph の traversal のいずれかが必要になった段階で、ADR 005 が定めるとおり別途決める（この契約では決めない）。
- 内容キーの入力を将来変える場合は、旧キーから新キーへの対応を持つ（同じ観測が別の ID にならない）ことが条件になる。

## 5. DR-NAC-4 保持の方針

### 5.1. 方針

- artifact の行は**追記だけ**で、GC も期限も無い。製品コードの INSERT は `repository.rs:997` の 1 箇所で、UPDATE／REPLACE／DROP／ALTER／TRUNCATE は無い。
- 削除は **project の削除だけ**。製品コードで artifact を DELETE するのは `domain_writes.rs:2201`（`project_delete`）の 1 箇所で、run の削除（`domain_writes.rs:2248`）より前に消す（artifact は run への join で選ぶため）。`narrative_extraction_artifacts` は `policies/narrative/protected-writers.json` の active な table 保護（writer は `narrative.extraction-artifact`）で、renderer からの SQL の書き込みは拒否される（`execute.rs` の `PROTECTED_WRITER_SQL_ERROR`）。製品の TS が直接書き換えるコードも `validate-narrative-writers` が拒否する。
- `narrative_extraction_artifacts` には FK も CASCADE も無い。run や project を先に消す経路を作ると、artifact が孤児として残る。run／project を消す製品コードも `domain_writes.rs` の `project_delete` だけである。

### 5.2. 依存（消す経路を作るなら、これを壊さない設計が要る）

| #   | 依存                         | 内容                                                                                                                                                                                                                                                  | 根拠                                                                                       |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | task resume                  | 完了済みの task は、その attempt の artifact が揃っていなければ `NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT` で fail-closed になる。run を再開できなくなる                                                                                            | `repository.rs` の `validate_chronicle_resume_artifacts`（`:4661`）、`:1841`、`:1995`      |
| 2   | IR の cold build の CAS      | project の**全 artifact 行**を入力 digest に含める。1 行消えても digest が変わり、build の前提が崩れる                                                                                                                                                | `nir1_chronicle_index/input_guard.rs:20`                                                   |
| 3   | Source としての解決          | `narrative-artifact`（`artifact:<id>`）の revision token を `payload_digest` で解決する。Revision の Source basis が参照する                                                                                                                          | `source_revision.rs:1025`（`resolve_narrative_artifact`）                                  |
| 4   | restore／rebuild             | durable graph state の digest に、project の run の artifact と、適用済み Revision が `narrative-artifact` の Source basis として束縛する artifact を含める                                                                                           | `restore_rebuild.rs:2882`                                                                  |
| 5   | 承認済み Revision の根拠     | Revision の `evidenceAnchorIds` が指す anchor を `evidence.resolved@1` から検証する                                                                                                                                                                   | `nir1_chronicle_index/evidence.rs`、`retrieval_admission/build.rs:186`                     |
| 6   | material roster の replay    | 完了した Task／Attempt の artifact を**厳密に 1 件**選ぶ（`accepted-artifact-roster-invalid`）。digest を再計算して照合する                                                                                                                           | `material_roster/replay.rs:18`                                                             |
| 7   | 適用済み Revision の存在検証 | 適用済み Revision の `artifact:<id>` の Source basis について、artifact の存在、所属する run の存在（孤児の検出）、同じ project への所属を検証する（`artifact-missing`／`artifact-run-missing`／`artifact-cross-project`）                            | `verify_coverage.rs:137`（`verify_application_revision_artifact_references_with_control`） |
| 8   | NIR-1 generation の入力束縛  | generation の入力（`InputTarget::Artifact`）に artifact を束縛するとき、artifact を `id` と project で引き、見つからなければ `NIR1_GENERATION_ARTIFACT_MISSING`、`payload_digest` が違えば `NIR1_GENERATION_ARTIFACT_MISMATCH`／`_CHANGED` で失敗する | `nir1_generation.rs`（`NIR1_GENERATION_ARTIFACT_MISSING`）                                 |
| 9   | scope authority              | run の corpus artifact（`scopeAuthorityDocuments` を含む）と scope authority artifact を読み、basis と突き合わせる。行が消えると `NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID` などで scope の authority を再構成できない                             | `scope_authority_runtime.rs`                                                               |
| 10  | material membership root     | run の artifact（`ORDER BY id`）を読んで membership root を作る                                                                                                                                                                                       | `material_membership_root.rs`                                                              |
| 11  | stage provenance             | `chronicle.stage-synthesis-outputs@1` の `outputs[]` を、receipt の stage execution ID で引いて検証する                                                                                                                                               | `stage_provenance.rs`（`json_each(a.payload_json, '$.outputs')`）                          |

**この表は網羅ではない。** artifact 行を読む箇所は、他にもありうる。消す経路を作るときは、`FROM narrative_extraction_artifacts` を読む全箇所の棚卸しを設計に含める（§5.3）。試験が固定するのは、既知の 11 経路の目印が今も在ること（存在確認）までで、各経路の振る舞いは Rust の試験が固定する。

### 5.3. 消す経路を作る場合の条件

GC、期限、編集、圧縮、project 削除以外の削除を足す場合は、次をすべて満たす設計にする。満たせない場合は足さない。

1. #1〜#11（と棚卸しで見つかる読み手）を壊さない。特に、承認済み Revision が束縛する artifact（#3〜#5、#7、#8）と、完了した run の artifact（#1、#6、#9〜#11）は消さない。
2. IR の cold build の CAS（#2）の前提を変える場合は、digest の入力の変更を契約として扱い、旧 digest との対応を持つ。
3. 保存範囲の縮小も拡大も、ユーザーの確認が要る変更として扱う。
4. 試験（§8）の「消す製品コードは `domain_writes.rs` だけ」を、新しい経路に合わせて**意図して**更新する。試験だけを書き換えて通さない。

## 6. DR-NAC-5 観測と根拠の対応

### 6.0. 対象の evidence mode

観測の evidence の形は、抽出の evidence mode で違う。

- **`legacy-v1`**: モデルが `{ sourceRef, quote, prefix?, suffix? }` を出す。`prefix`／`suffix` は解決の絞り込みの手がかりで、同一性ではない。
- **`citation-id-v2`**（coordinator の AI lane の既定。`resolveCoordinatorEvidenceMode`）: モデルは catalog の `evidenceRef`（文単位の segment）を引くだけで、観測の evidence は `{ sourceRef, quote }` だけになる（`prefix`／`suffix` は付かない）。解決は snapshot の `evidence.catalog` の segment を通る。同じ文が 2 回出る本文は、別の segment（別の `sourceRef`）になるので、別の anchor に解決され、`(sourceRef, quote)` も別になる。

§6.1 の辿れる経路は両方の mode で成り立つ。§6.2 の 4 は `legacy-v1` に固有である。DR-NAC-5 の試験は両方の mode を確かめる（§8）。

### 6.1. 辿れる経路

```text
chronicle.raw-observations@1   observations[].evidence[] = { sourceRef, quote, prefix?, suffix? }
        │  resolveObservationEvidence（raw の全観測・全 evidence を順に解決）
        ▼
evidence.resolved@1            anchors[] = { id: "anchor-NNNN", sourceRef, quote, documentRef, canonicalRange, … }
```

- 観測 → anchor の対応キーは **`(sourceRef, quote)` の一致**（`chronicleEvidenceTupleKey`）。`localId` ではない。coordinator の照合段（`extractionCoordinator.ts` の `matchExisting` task）と提案の planner（`proposalPlanner.ts:71-87`）が、この鍵で anchor を引く。
- anchor → `documentRef` → `source.snapshot@1` の document → `sourceKey`（`project:scene:<id>`）。これで観測の根拠が、どの場面のどの範囲かに辿れる。
- 仮説 → 観測は `hypothesis.observationRefs` が merged の `localId` を指す。仮説 → 提案の根拠は、planner が上の鍵で anchor を引いて `evidenceAnchorIds` を作る。
- anchor は raw の観測から作られるので、merged の観測の evidence は、解決できた限り必ず anchor を持つ。anchor の `(sourceRef, quote)` は必ず raw の evidence の部分集合になる。

### 6.2. 辿れない（または限られる）経路。直さずに報告する

次は**今の実装の限界**であり、契約の違反ではない。契約はこれを「今はできないこと」として固定する。

1. **anchor は観測を指さない。** anchor に `localId` や観測への参照は無い。辿る向きは観測 → anchor だけで、anchor → 観測は、`(sourceRef, quote)` が同じ evidence を持つ観測を全て探すしかない。
2. **解決できなかった evidence は痕跡を残さない。** `not-found`、`ambiguous`、`invalid` の evidence は anchor を作らず、`evidence.resolved@1` にも失敗の記録が無い。task の `outputJson.anchorCount` と観測の evidence 数の差から件数が分かるだけで、どの観測のどの evidence かは残らない。
3. **同じ `(sourceRef, quote)` を引く観測が複数あると、anchor が観測ごとに作られる。** 重複した anchor が残り（`id` は連番で別）、照合の lookup は先頭の 1 つを使う。
4. **（`legacy-v1` のみ）`prefix`／`suffix` で絞り込まれた evidence が、同じ文の別の出現位置に解決された場合、`(sourceRef, quote)` だけでは区別できない。** lookup は `documentRef` が違う場合だけ曖昧（null）とし、同じ document 内の別の範囲は区別しない。同じ文が 2 回出る本文で、`prefix`／`suffix` が別の出現位置を指す 2 観測が、範囲の違う 2 つの anchor に解決され、`(sourceRef, quote)` が同じになることを、coordinator を通した試験で確かめた。
5. **lookup が 2 箇所に実装されている**（coordinator の照合段と `proposalPlanner.ts`）。同じ規則だが、共有されていない。

これらを直す（anchor に観測の参照を持たせる、失敗を記録する、など）には、`evidence.resolved@1` の形の変更が要り、DR-NAC-2 の規則に従って `@2` として扱う。

## 7. DR-NAC-6 今の挙動と契約の差

製品コードを読んだ限り、§3〜§5 の契約と**違う挙動は見つからなかった**。§6.2 の 5 点は契約が「できない」と認める限界であり、挙動の食い違いではない。直すかどうかは、観測を正本側に出す設計（案 3／4）と一緒に決める。

試験を書く中で、次の事実を確かめた（契約には含めない）。

- 製品に同梱されない開発・CI の harness（`scripts/`、`electron/scripts/`）は、使い捨ての DB で artifact を UPDATE／DELETE する。構造試験の対象外である。ブラウザ用の in-memory mock（`browser-mock`）も対象外にした（`validate-narrative-writers` と同じ除外）。
- 製品の TS には、artifact を直接書き換えるコードが無い（`validate-narrative-writers` が既に拒否する）。

## 8. 固定する試験

| 判断     | 固定するもの                                                                                                                                                                                                                                                                                                                                                                                                        | 試験                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| DR-NAC-2 | kind の一覧と版（10 件）、`<名前>@<整数>` の形、Rust の resume 検証・stage provenance・IR・replay が同じ文字列と anchor／observation の field を読むこと                                                                                                                                                                                                                                                            | `src/features/chronicle/extraction/extractionArtifactContract.test.ts`                |
| DR-NAC-3 | 同一性キーに入る field（型の対応表で増減を tsc が検出。実行時は field を 1 つずつ変えて畳まれない／畳まれることを確認）、evidence の整列した多重集合としての扱い（重複は保持）、participants（要素の field を含む）／temporalExpressions の順序、first-wins、`localId` 非依存                                                                                                                                       | 同上                                                                                  |
| DR-NAC-4 | artifact を消す製品コードは `domain_writes.rs` だけ、追記は `repository.rs` の 1 箇所だけ、run／project を消すのも `domain_writes.rs` だけ、artifact の削除が run の削除より前、既知の依存 11 経路が今も在ること（存在確認。網羅ではない）                                                                                                                                                                          | 同上                                                                                  |
| DR-NAC-5 | coordinator を通した fixture で、raw → resolved → merged の対応（`(sourceRef, quote)`）、`localId` の形、anchor の連番、重複 anchor、解決できなかった evidence が痕跡を残さないこと、anchor が観測を指さないこと、`legacy-v1` で同じ文が 2 回出る本文の `(sourceRef, quote)` が同じ別範囲の anchor ができること、`citation-id-v2` で同じ文が 2 回出る本文が別の `sourceRef`・別範囲の anchor に 1 対 1 で辿れること | `src/application/narrative-extraction/extractionCoordinator.test.ts`（"DR-NAC-5: …"） |

この契約を変える変更は、試験が落ちる。落ちたら、実装を直す前に本書の該当節を読み、契約を変えるなら本書と試験を一緒に更新する。

## 9. 参照

- [Narrative Semantic Core ロードマップ](narrative-semantic-core-roadmap.md)（M2 の D2: Chronicle の移行。「保存済み Artifact の互換 adapter」）
- [Chronicle 評価契約 v2](chronicle-evaluation-contract-v2.md)（観測と提案の分離）
- [ADR 005](../adr/005-narrative-semantic-core-boundary.md)（Stable assertion identity）、[ADR 010](../adr/010-narrative-dependency-role-granularity-contract.md) §16
- [作業記録](nir1-continuation-2026-10.md) §3.2
