# ADR 005: Narrative Semantic Core Boundary

## Status

Accepted — 2026-08-14（Gate C1.5 / Narrative Semantic Contract Ratification）
[ADR 004: Narrative Reconciliation Boundary](./004-narrative-reconciliation-boundary.md)を拡張する。  
本ADRはADR 004を置き換えない。意味評価、変更権限、Semantic retraction、
Deterministic Coreの境界については、引き続きADR 004を正本とする。
Mutation Authority Routeの詳細は[ADR 006](./006-narrative-mutation-authority-routes.md)で固定する。
Scopeの正規形と比較契約は[ADR 009](./009-narrative-scope-relation-contract.md)、
Dependencyの役割・粒度・宣言集合契約は
[ADR 010](./010-narrative-dependency-role-granularity-contract.md)を正本とする。

## Context

Grimodexには、同じ原稿を異なる観点から解釈する複数の機能が既に存在する。

- Codex Entity／Relation／Phase／Custom Detail
- Chronicle／Timeline／Temporal Constraint
- Plot Thread／Foreshadow
- Semantic Search／Related Scenes
- Chat Context planning
- Consistency／Maintenance diagnostics
- Import時の抽出とReconciliation

各機能が独自の抽出Schema、要約、Embedding、Evidence形式、増分更新規則を持つと、
同じSceneを機能ごとに再解釈することになる。Codexで承認したRelationがRelated Scenes
から見えず、Phase抽出で認識したState TransitionをChatが別の方法で再計算し、
Chronicle EventとSearch用のevent-like objectが異なるEvidenceを持つ、といった分裂が
生じる。

この構造には次の問題がある。

1. 同じ意味解釈を機能ごとに繰り返す。
2. 作者のレビュー結果を他機能で再利用できない。
3. Model、Prompt、Providerを変更すると、それまでの解釈作業が資産として残らない。
4. 機能固有の要約や構造化データが互いに不整合になる。
5. Source変更時に、依存するArtifactを正確に無効化できない。
6. 共有意味モデルがないため、各機能が大量の本文を毎回読み直す。

一方、単一の権威的な「作品の真実Graph」を作ることも誤りである。物語には、

- 信頼できない語り手
- 登場人物の誤解
- 噂や伝聞
- 意図的な曖昧さ
- 仮説
- 複数Timeline／Worldline
- 読者だけが知る情報
- 登場人物ごとに異なるKnowledge
- 後から覆る説明

が存在する。Deterministic Coreが、どの解釈が客観的に真であるかを決めてはならない。

Grimodexには既に、必要な部品の大半が存在する。

- immutable Source SnapshotとCanonical Text
- Evidence Anchor、source basis、read set、digest
- Extraction Run、Task、Artifact、Proposal Set、Proposal Revision
- Decision、Prepared Commit、source-basis OCC、Field Authority、Typed Writer
- Application、CommitMap、Journal、Undo、compensating application
- Change Feed、Dependency、Freshnessの基盤

これらを一つのArchitecture Boundaryと共有Contractの下に置く必要がある。

## Decision summary

Grimodexは、**Narrative Semantic Core**を第一級のbounded contextとして定義する。

Coreが保持するのは「作品の真実」ではない。次のものを分離して保持・関連付ける。

1. Source identityとrevision
2. Evidenceに結び付いた、scope付き・revision付きのsemantic assertion
3. Reviewとmutation authority
4. 適用済みDomain Projection
5. DependencyとFreshness
6. 再構築可能なSemantic Index

共有されるCanonicalな意味交換形式を**Narrative IR**と呼ぶ。

Narrative IRは、

- 単一の巨大Database tableではない。
- 万能Ontologyではない。
- 小さくversionedなEnvelopeとtyped payloadの組み合わせである。

AI InterpretationはNarrative IRを生成する手段の一つにすぎない。ほかにも次をProducerと
して認める。

- 作者による手動入力
- Import Parser
- 決定的Rule-based Extractor
- Migration Adapter
- Manual Reconciliation

Narrative IRを生成できることは、Domainを書き換える権限を意味しない。

Canonicalな処理経路は次の通りとする。

```text
本文 / 作者宣言 / Import Source / 明示的な既存Projection
  ↓
Interpretation Pipeline
  ├ LLM Extractor
  ├ Import Parser
  ├ Rule-based Extractor
  └ Manual Authoring
  ↓
Evidence-bound Narrative IR Revision
  ↓
Proposal / Review / Decision
  ↓
Prepared Commit / Typed Writer
  ↓
Domain Projection
  ├ Codex / Phase / Relation
  ├ Chronicle / Timeline
  ├ Plot Thread / Foreshadow
  └ その他の構造化Domain Data
  ↓
Rebuildable Index / Retrieval / View
```

増分更新は別の決定的経路で行う。

```text
SourceまたはDomainのmutation
  ↓
Change Feed
  ↓
Dependency / Freshness Graph
  ↓
影響するIR / Artifact / Projection / Indexを特定
  ↓
再検証 / Reanchor / Reconciliation / Rebuildの必要性を記録
```

Dependencyが伝播してよいのはFreshnessだけである。Dependency処理がSemantic
retractionやDomain mutationを直接行ってはならない。

## Definitions

### Source

現在のrevisionをDeterministicに解決できる一次入力。

例：

- Scene body
- Scene title／reading order／story order
- 作者が手書きしたCodex field
- Project outline／Scene intent
- sealed Import Source Package
- Project Calendar
- 明示的に入力として登録された既存Domain Projection
- versioned component contract

本文は引き続き一次Sourceである。Narrative IRは本文の代替ではない。

### Evidence

AssertionまたはInterpretationを支える、Source-boundな参照。

Evidenceは必要に応じて次を持つ。

- source identity
- source revision token
- Canonical Text上のrange
- exact quoteとquote digest
- context rangeとcontext digest
- normalizer version
- projection mapまたはanchor情報

Evidence SetとRead Setは分離する。

- **Evidence Set** — Assertionを直接支える箇所
- **Read Set** — Interpretation時に参照した全入力

### Narrative assertion

Interpreterまたは作者が生成した意味的な主張。typed payload、scope、modality、
polarity、Evidence、Provenanceを持つimmutable revisionとして表現する。

Assertionは、明示記述、推論、仮説、Character-relative、Narrator-relative、
Author-declared、Importedなどになり得る。互いに両立しないAssertionを同時に保持してよい。

### Narrative IR

Narrative assertionおよび意味Artifactを交換するためのversioned contract。

Narrative IRは次の性質を持つ。

- Evidence-bound
- source-basis-bound
- scope付き
- revision付き
- typed
- Producer identity付き
- Review前はauthority-neutral

Narrative IRは次のものではない。

- DB Operation
- Prepared Commit
- Domain Writer command
- 普遍的なtruth record
- UI state container
- Raw proseの代替

### Projection

Reviewされ、権限検証されたNarrative IRまたは作者意図を、製品のDomain Aggregateへ
適用したもの。

例：

- Codex Entry
- Codex Relation
- Phase
- Chronicle Event
- Temporal Constraint
- Plot Marker
- Foreshadow Setup／Payoff

Projectionは「承認され適用された」ことを意味し、「客観的に真である」ことを意味しない。

### Semantic Build Graph

SourceとConsumerを接続する、durableなDependency宣言とrebuildableなFreshness state。

Consumerには次を含む。

- Narrative IR Revision
- Extraction Artifact
- Proposal Revision
- Application
- Field-level Application Contribution
- Derived Projection
- Search Index

### Semantic Index

DurableなSourceとLedgerから再構築できる検索・参照用のAcceleration Structure。

例：

- Raw Text lexical index
- Raw Text embedding index
- Narrative IR embedding index
- Entity Mention index
- Graph adjacency index
- Temporal index
- Evidence reverse index

IndexはAuthorityではなく、削除・再構築可能でなければならない。

## Concern and authority

| Concern | Authority／Producer | Durable Artifact |
| --- | --- | --- |
| 本文と作者宣言 | Domain Typed Writer／作者 | Domain row、version、Change Event |
| Source revision／Evidence integrity | Deterministic Native Core | Source basis、read set、anchor、digest |
| Semantic interpretation | 交換可能なInterpreter | Narrative IR／Proposal Revision |
| Review status／mutation authority | Human Decision／Runtime Policy | Decision、actor authority、override |
| Projection execution | Prepared Commit／Typed Writer | Application、CommitMap、Journal |
| Dependency declaration | Producer＋Native validation | Dependency Edge、producer generation |
| Freshness evaluation | Deterministic Native Core | Rebuildableなedge／consumer state |
| Search ranking／candidate fusion | Retrieval Strategy | Rebuildable index／diagnostic |
| UI layout／presentation | Feature UI | Feature-local state。Narrative IRではない |

同じ責務に複数のAuthorityを作らない。

特に、次を禁止する。

- Search IndexをAssertionのAuthorityにする。
- LLM confidenceをApply authorityにする。
- Domain ProjectionがSource basisを暗黙に上書きする。
- Renderer stateをFreshnessのAuthorityにする。
- `stale`をSemantic retractionとして扱う。

## Narrative IR kernel

初期Kernelは意図的に小さくする。概念Contractは次のような形とする。

```ts
interface NarrativeAssertionRevision<TPayload> {
  schemaVersion: 1;

  assertionId?: string | null;
  revisionId: string;
  assertionKind: string;
  payloadSchemaId: string;
  payloadSchemaVersion: string;
  payload: TPayload;

  scope: NarrativeScope; // versioned contract owned by ADR 009
  modality: AssertionModality;
  polarity: AssertionPolarity;
  supportClass: AssertionSupportClass;

  sourceBasis: SourceBasis;
  evidenceSet: EvidenceSet;
  readSet: ReadSet;
  readSetDigest: Sha256Digest;

  producer: InterpretationProducerIdentity;
  changeKind: "add" | "revise" | "retract" | "merge" | "split";
  targetProjectionRef?: string;

  producerConfidence?: number;
  createdAt: string;
}
```

immutableなRevisionへ、mutableなReview／Freshness／Projection stateを埋め込まない。
これらは別軸のRead Modelとして管理する。

```ts
interface NarrativeAssertionState {
  assertionId?: string | null;
  revisionId: string;

  review:
    | "unreviewed"
    | "accepted"
    | "rejected"
    | "held"
    | "superseded";

  evidenceFreshness:
    | "fresh"
    | "stale"
    | "source-missing"
    | "anchor-mismatch"
    | "read-set-drift"
    | "unknown";

}

interface NarrativeProjectionState {
  revisionId: string;
  projectionRef: string;
  projectionKind: string;
  applicationId: string | null;
  state:
    | "unapplied"
    | "applied"
    | "compensated"
    | "undone"
    | "stale"
    | "not-applicable";
}
```

次の非同値関係を必須Contractとする。

```text
accepted ≠ fresh
fresh ≠ true
applied ≠ true
rejected ≠ permanently false
stale ≠ retracted
```

### Typed payloadと拡張

`Event`、`State`、`StateTransition`、`Relation`、`TemporalConstraint`、
`NarrativePromise`、`CharacterKnowledge`などはtyped payload familyとして表現する。

例：

```ts
NarrativeAssertionRevision<EventAssertionPayload>
NarrativeAssertionRevision<CharacterStatePayload>
NarrativeAssertionRevision<RelationAssertionPayload>
NarrativeAssertionRevision<CharacterKnowledgePayload>
```

Core Envelopeを共有しつつ、Domain semanticsはversioned typed schemaとして維持する。

あらゆる概念をunvalidated JSONで保存する単一の`narrative_ir_nodes` tableは導入しない。
初期StorageはProposal RevisionやExtraction Artifactを再利用してよい。次のいずれかが
必要になった時点で、概念ごとのtyped／indexed storageへの昇格を判断する。

- cross-run identity
- query performance
- integrity constraint
- 固有のlifecycle
- stable dependency key
- user-visible revision history

### Stable assertion identity

`assertionId`は、同じ概念的AssertionのRevision間identityを表す。ただしFirst Retrieval
Vertical SliceのIndex identityはimmutableな`revisionId`であり、`assertionId`はnullableの
ままにする。

初期移行ではnullableを許す。既存Proposalのすべてに信頼できるcross-run identityを
割り当てられるとは限らないためである。

次のいずれかが必要になった段階で、mandatoryなstable identityの割当規則を別途決定する。

- cross-run merge／deduplication
- partial retraction
- long-lived Dependency FK
- user-visible assertion history
- Assertion identityによるGraph traversal

Stable identityがない場合、Deterministic Coreがheuristic matchingでidentityを捏造しては
ならない。

## Scope, modality, ambiguity

Narrative assertionは、scope付きかつ相互矛盾可能でなければならない。

Scopeの正規形、Reference／Temporal軸、`any`と`unresolved`の非同値、
Revision付きOracle、Relation合成、Assertion Scope ProfileはADR 009を唯一の正本とする。
本ADRの旧`scopeStatus`／optional-axis形式は互換実装の履歴であり、新しいProducerや
Persistence Contractが複製してはならない。ScopeはAssertionが観測された場所ではなく、
Assertionが成立する適用範囲である。観測場所はEvidenceが保持する。

Scope Relationは作品世界のTruth Verdictではない。現在のScope、Registry、Order Basisから
確立できた関係を表すだけであり、すべてを単一のglobal truthへ潰してはならない。

次のAssertionを同時に表現できる必要がある。

```text
Character AはXを信じている。
Narratorはnot-Xと主張している。
ReaderはXを支持するEvidenceを持つ。
Character BはまだXを知らない。
作者はXを意図的に未確定としている。
```

`AssertionModality`は最低限、次を区別する。

- 本文での明示
- Narrator claim
- 伝聞
- Character belief
- Inference
- Hypothesis
- Author declaration
- Imported assertion

`AssertionPolarity`はaffirmative／negative／uncertainを区別する。

`producerConfidence`はdiagnosticおよびranking入力であり、Authorityではない。より重要な
表示・ranking signalは次である。

- support class
- 作者Review
- Evidence Freshness
- Scope
- Producer identity
- Source basis
- Projection state

## SourceとProjectionは一方向ではない

典型的なFlowは次である。

```text
本文 → Narrative IR → Domain Projection
```

ただし、作者が手動編集した構造化データは一次Sourceになり得る。

例：

```text
作者が手書きしたCodex設定
Scene Intent
Project Outline
手動で確定したCalendar
Human-authored Phase boundary
```

Domain Projectionを別のInterpretationのSourceとして使う場合、Dependencyを明示的に
宣言しなければならない。

暗黙の循環依存は禁止する。各Dependencyは最低限、次を記録する。

- source kind／source key
- consumer kind／consumer key
- producer identity
- generation
- observed revision token
- propagation mode
- 必要な場合はbaseline sequence

役割、Selector、`dependencyKey`、Context Set、Build Action集約、sealed Declaration Set、
V1／V2優先規則の正本はADR 010とする。上記は現行V1 Edgeの最低項目であり、
V2のRoleまたは粒度を推測させるものではない。

Application自身の書き込みで、自身が即座にstaleになることをSelf-stale guardで防ぐ。

Human-authored fieldまたは明示的にlockされたfieldはField Authorityを保持する。後続の
InterpretationはProposalを作ってよいが、maintenance ownershipを暗黙に奪い返したり、
直接上書きしてはならない。

## Domain Projection, Index, Query Service, UIの分離

すべての機能をProjectionと呼ばない。

### Domain Projection

Durableでuser-facingな構造化Domain Data。

- Codex
- Chronicle
- Phase
- Timeline
- Plot Thread
- Foreshadow

### Derived Index

再構築可能なAcceleration Data。

- Embedding
- Graph adjacency
- Entity Mention
- Temporal lookup
- Evidence reverse lookup

### Query Service

Source、IR、Graph、Indexを読み、runtimeで結果を生成するもの。

- Semantic Search
- Related Scenes
- Consistency Query
- Candidate Fusion
- Chat Context planning

### UI View

結果を表示・操作するPresentation Layer。

- Map
- Grid
- Timeline View
- Structure Health
- Relationship Visualization

Map座標、Grid列幅、色、selection、panel arrangement、editor-local stateなどは、それ自体に
作品Domain上の意味がない限りNarrative IRへ入れない。

## Interpretation Pipeline

すべてのInterpreterは、宣言的なNarrative IRまたはProposal Draftを返す。SQL、任意の
DB Operation、Prepared Commit command、Typed Writer commandを返してはならない。

認めるProducer classは次である。

```text
LLM Extractor
Import Parser
Rule-based Extractor
Manual Authoring
Migration Adapter
Reconciliation Strategy
```

すべてのProducerは、最低限同じProvenance Contractを使用する。

- producer ID／version
- payload schema ID／version
- source basis
- Evidence Set
- read set／digest
- scope
- modality
- polarity
- change kind

Feature固有Extractorはtyped fieldを追加してよいが、互換性のない独自Evidence modelや
Authority modelを定義してはならない。

## ReviewとRejected Interpretation

作者ReviewはDurable Assetとして保存する。

保存対象は次を含む。

- accepted interpretation
- author-modified interpretation
- held interpretation
- rejected interpretation
- rejection reason
- Review時点のsource basis
- producer／schema version

Rejectionの意味は次である。

> このsource basisとscopeに対して、このRevisionを採用しなかった。

次の意味ではない。

> この意味命題は、将来の全Scene、全Timeline、全Source Revisionにおいて永久に偽である。

Source basisがmaterialに変化した場合、過去のRejectionをPrior Review Evidenceとして
表示してよいが、新しいCandidateを無条件に抑止してはならない。

## Projection Runtime

Accepted Narrative IRが直接Domain Dataをmutationしてはならない。

Reconciler-originated mutationに許される経路は次だけである。

```text
Narrative IR / Proposal Revision
  ↓
Actor authority付きDecision
  ↓
Prepared Commit
  ↓
Source-basis / read-set OCC
  ↓
Field Authority validation
  ↓
Typed Writer
  ↓
Application / CommitMap / Journal
```

Commit前にSource basis、target version、Authority、Field ownership、Runtime Policyの
いずれかが変化した場合、Applyはfail-closedする。

Semantic retractionはADR 004に従い、forwardなCompensating Proposal／Applicationとして
行う。Undoをtruth correctionに使用しない。

## Semantic Build Graph

Semantic Build GraphはNarrative Semantic Coreのincremental build systemである。

Dependency Role、Selector V2、Declaration Set、Consumer Head、Context Setの詳細は
ADR 010を正本とする。本節はSource／Consumer／Freshness Authorityの境界だけを保持する。

DurableなDependency Edgeは、SourceとConsumerを接続する。

```text
Source
  ├ Scene body / document range
  ├ Domain field
  ├ Catalog
  ├ Calendar
  ├ Import Package
  ├ Component version
  └ Prior Projection
        ↓
Consumer
  ├ IR Revision
  ├ Extraction Artifact
  ├ Proposal Revision
  ├ Application
  ├ Field Contribution
  ├ Derived Projection
  └ Semantic Index
```

Change Feedが変更されたSourceを示し、reverse dependency lookupが影響Consumerを特定する。
Deterministic EvaluatorはFreshnessとRebuild要否だけを更新する。

許可されるPropagation Signalは`needs-reconciliation`だけである。FreshnessはConsumer
state、Build ActionはEvaluatorの作業指示として同じ列やSignalへ混ぜない。

```text
Propagation Signal: needs-reconciliation

Evidence Freshness: fresh | stale | source-missing | anchor-mismatch
                    | read-set-drift | unknown

Build Action: none | revalidate-exact | reanchor-candidate | resolve-only
              | recompile-only | rebuild-required | refresh-available | manual
```

禁止される伝播：

```text
semantic truth
automatic contradiction verdict
automatic retraction
automatic merge / split
automatic Domain delete
automatic Apply
```

### FreshnessはBuild Stateである

Gate C2 Dependency Index／Freshnessは、単なるMaintenance Panel用機能ではなく、
Narrative Semantic CoreのBuild Systemとして扱う。

少なくとも次のIncremental Invalidationを扱える設計にする。

- Domain Projection
- Narrative IR Embedding
- Raw Text／Hybrid Retrieval Index
- Related Scenes Candidate
- Chat Context Materialization
- Consistency Diagnostic
- Visualization Projection

Source編集時、全機能が原稿全体を読み直すのではなく、依存Consumerだけをstaleまたは
rebuild-requiredにする。

### Component変更

新しいModel、Prompt、Parser、Extractor versionが存在するだけで、既存のAccepted Dataを
invalidにしない。

Compatibilityを別軸で分類する。

```text
compatible
quality-refresh-available
compatibility-refresh-required
```

品質向上版が利用可能であっても、現在のProjectionをfalseまたは使用不能とみなさない。

## Narrative Retrieval Engine

Narrative Retrieval EngineはMulti-viewで構成する。Narrative IR EmbeddingはRaw Text
Retrievalを置き換えない。

概念的なCandidate Pipelineは次である。

```text
Query Interpretation
  ├ Raw Text lexical retrieval
  ├ Raw Text dense retrieval
  ├ Narrative IR dense retrieval
  ├ Entity / Relation Graph traversal
  ├ Temporal / Scope filtering
  └ Evidence reverse lookup
        ↓
Candidate Fusion
        ↓
Authority / Freshness / Scope weighting
        ↓
Context PackingまたはFeature Result
```

Raw Textが必要な領域：

- 文体
- Dialogue voice
- 情景描写
- Rhythm
- exact quote
- Extractionが見落とした意味

Narrative IRが強い領域：

- State change
- Relation change
- Causal／Temporal relevance
- Character Knowledge
- Plot／Foreshadow構造
- Cross-scene semantic navigation

### Context Packing

Chat ContextでScene全文を常にNarrative IRへ置き換えてはならない。

Task-aware Context Packerは、次を組み合わせる。

1. AcceptedかつFreshなNarrative IR
2. 明示的にlabelされた関連Unreviewed Candidate
3. Assertionを支えるEvidence excerpt
4. 現在編集中SceneのRaw Text
5. 必要な近傍SceneのRaw passage
6. Author-declared structured Source

Prose generation taskでは、現在Sceneと文体上関連するRaw Textを優先する。全体構造や
長距離関係を扱うtaskでは、Narrative IRを主な圧縮表現としてよい。

注入するAssertionには、Review status、Scope、Freshness、Evidence referenceを保持する。
そうしなければ、消費側ModelまたはUIがAI Candidateを作者確認済みFactと誤認する。

## Persistence classes

### Durable Asset

次はModel／Providerを変更しても残す。

- Provenanceに必要なSource identity／revision history
- Evidence Anchor／source basis
- Narrative IR／Proposal Revision
- 作者Decision／Rejection reason
- Application／Compensating Application
- Field Authority／Contribution ownership
- Dependency declaration／producer generation
- Audit history

### Rebuildable Asset

次は削除・再生成可能とする。

- Embedding
- Lexical Index
- Graph adjacency cache
- Ranking score
- Candidate Fusion cache
- Packed Chat Context
- Freshness Summary Read Model
- Reanchor Candidate
- UI Summary

BackupはRebuildable Cacheを省略してよい。ただし、外部Modelを再実行しなくてもIndexを
再構築できるだけのDurable Dataを保持する。元のSemantic Artifact自体を一度も保存して
いない場合はこの限りではない。

## Architectural module boundaries

Logical moduleは次のように分ける。

```text
Narrative Semantic Core
  ├ Source / Evidence Ledger
  ├ Narrative IR / Interpretation Ledger
  ├ Authority / Decision Ledger
  ├ Projection Runtime
  ├ Semantic Build Graph
  └ Rebuildable Semantic Index

Interpretation Pipeline
  ├ LLM Extractor
  ├ Import Parser
  ├ Rule-based Extractor
  ├ Manual Authoring
  └ Reconciler Strategy

Narrative Retrieval Engine
  ├ Query Interpretation
  ├ Hybrid Search
  ├ Graph Traversal
  ├ Candidate Fusion
  └ Context Packing
```

これはLogical Boundaryであり、直ちに全directoryをrenameする要求ではない。既存の
`narrative-extraction`、各Domain Feature、Search、Chat moduleは、共有Contractの背後へ
段階的に移行する。

## Iron Laws

1. **本文と明示的な作者宣言を一次Sourceとし、Narrative IRで置き換えない。**
2. **Narrative IRはEvidence-bound、source-basis-bound、scope付き、typed、revision付き
   でなければならない。**
3. **AIはInterpretation Producerの一つであり、暗黙のmutation authorityを持たない。**
4. **Accepted／AppliedはReviewとAuthorizationを表し、客観的なsemantic truthを表さない。**
5. **相互矛盾、viewpoint-relative、uncertain、worldline-relativeなAssertionを共存可能にする。**
6. **Review state、Evidence Freshness、Projection stateを別軸として管理する。**
7. **RejectionはRevision、source basis、scopeに限定され、永久的なnegative factではない。**
8. **Reconciler-originated mutationはDecision、Prepared Commit、source-basis OCC、
   Field Authority、Typed Writerを通る。**
9. **Dependency propagationはfreshness-onlyであり、semantic retract、merge、split、
   delete、Applyを実行しない。**
10. **Domain Projection、Derived Index、Query Service、UI stateを分離する。**
11. **Raw Text RetrievalをCanonical Retrieval Pathに残し、Narrative IR Embeddingで
    置き換えない。**
12. **Chat ContextはNarrative IRで選択・圧縮してよいが、Raw EvidenceとTask-relevantな
    本文を保持する。**
13. **Producer confidenceはdiagnosticであり、Authorityを与えずReviewを迂回しない。**
14. **DurableなEvidence、Decision、Application、Review HistoryはModel／Provider変更後も
    残し、Indexは再構築可能にする。**
15. **Domain ProjectionをSourceにする場合、generationとSelf-stale protectionを持つ明示的
    Dependencyを必須とする。**
16. **Coreは小さなEnvelopeとversioned typed payloadで拡張し、無制限な万能JSON Graphを
    作らない。**

## Non-goals

本ADRは次を許可・要求しない。

- Truth Maintenance System
- 単一で全知的な作品Truth
- 自動Semantic retraction
- AI Suggestionの自動Apply
- 即時の万能`narrative_claims` table導入
- 全既存Featureの一括移行
- Raw Text Embedding／Lexical Searchの撤去
- Domain Aggregateのgeneric graph node化
- UI-only stateのNarrative IR永続化
- CIでの継続的な有料Model実行

## Adoption plan

### Phase 0: Contract and registry

- versioned Narrative IR Envelope typeを導入する。
- Assertion Kind／Scope Registryを定義する。
- 既存Reconciliation Envelope fieldをShared Contractへmappingする。
- Durable AssetとRebuildable Assetを明文化する。
- AIからDomainへの直接書き込みを禁止するArchitecture Checkを追加する。

### Gate C0–C2: Semantic Build Graph

- C0：Change Feed Foundation
- C1：Canonical Native WriterをChange Feedへ配線
- C2：Dependency Index／Freshnessを一つのCanonical Build Graphへ統合
- IR Revision、Artifact、Application、Field Contribution、IndexをConsumerとして登録
- freshness-only propagationを維持

### First Retrieval Vertical Slice

全Featureを一度に移行せず、まず一つのbounded pathでShared Coreを利用する。

```text
Scene Source
  → Evidence-bound Assertion
  → IR Embedding / Graph Index
  → Related Scenes / Chat Candidate Selection
  → Evidence-backed Result
```

最初のSliceでもRaw Text Retrievalを維持し、Hybrid Retrievalを現行Baselineと比較する。

### Domain Projection Migration

Codex、Chronicle、Phase、Plot Thread、ForeshadowのExtractionを、Feature-privateな意味形式
からShared Narrative IR Envelope＋typed payloadへ移行する。

各FeatureのDomain Schemaは維持する。統一するのはInterpretation／Provenance Contractで
あり、Domain Aggregateをgeneric化することではない。

### Legacy cleanup

ParityとMigration Evidenceを確認した後に次を行う。

- 完全に導出可能になったFeature-private summaryを削除
- 重複したDependency／Freshness Storeを削除
- Context／RetrievalをShared Index経由へ移行
- Released Workspaceと保存済みArtifactが収束するまでCompatibility Adapterを保持

## Acceptance criteria

次をすべて満たしたとき、本ADRの実装が成立したとみなす。

- 一つのReviewed AssertionをSemantic再抽出なしに複数Featureで利用できる。
- 一つのSource編集が依存Artifact／Projection／Indexだけを無効化する。
- Scopedな矛盾AssertionをDeterministic Truth Resolutionなしに共存させられる。
- Author-confirmed AssertionとUnreviewed AI AssertionをStorage／Retrievalで区別できる。
- Semantic ResultからEvidenceへ遷移できるか、Evidence不在を明示できる。
- AI OutputがDomain Aggregateを直接mutationできない。
- Raw TextとNarrative IR Retrievalが一つのHybrid Candidate Pipelineへ参加する。
- AcceptedだがStaleなAssertionを暗黙にFreshとして扱わない。
- Rejected Interpretationがsource-basis-scopedなReview Historyとして残る。
- Model／Provider変更後もAuthor Review、Evidence、Applied Projection Historyが残る。
- Derived IndexをDurable Ledgerから再構築できる。
- 第二のAuthorityまたは並行Freshness Ledgerを作らない。

## Alternatives considered

### Feature-specific Semantic Model

各Featureが独自のExtraction Schema、Summary、Embeddingを保持する。

Interpretation、Review、Provenance、Invalidationが重複し、Feature間で意味がdriftするため
採用しない。

### Embedding-only Architecture

Raw Text Embeddingだけを保存し、Query時に各Consumerが意味を推論する。

EmbeddingはReview Decision、typed relation、source basis、Authority、Temporal Scope、
precise invalidationを保持できないため採用しない。Embeddingは重要なIndexだがSemantic
Coreではない。

### One Giant Knowledge Graph

Source、Assertion、UI Object、Domain Entityをすべてgeneric node／edgeへ変換する。

Authority Boundaryを曖昧にし、Schema Validationを弱め、単一Truth的な設計を誘発し、
UIと製品Domainの責務まで無制限Ontologyへ押し込むため採用しない。

### TaskごとにLLMが原稿全体を再読する

DurableなSemantic Stateを持たず、拡大するContext Windowへ依存する。

Author Reviewを捨て、Costを繰り返し、Interpretationを再現できず、ProvenanceとIncremental
Invalidationを解決せず、製品価値を特定Modelへ依存させるため採用しない。

### Domain AggregateをSemantic Coreそのものにする

Codex、Chronicle、Phase、Plot、Foreshadow rowを直接Shared Meaning Modelとして扱う。

Domain rowはApplied Projectionであり、Unreviewed Interpretation、Conflicting Scope、
Rejected Candidate、Full Read Set、Reusable Intermediate Artifactを表せないため採用しない。

## Consequences

### Positive

- Author ReviewをSearch、Chat、Planning、Visualizationで再利用できる。
- Model／Providerを変更しても最重要のSemantic Assetが残る。
- 小さいModelでも圧縮されたEvidence-backed Contextを利用できる。
- 新しいAssertion Kindが複数Featureを同時に強化できる。
- RetrievalがProse、Structured Meaning、Graph、Temporal Signalを統合できる。
- Source変更時に精密なIncremental Rebuildが可能になる。
- 「Writing IDE」がUI上の比喩だけでなく内部Architectureとして成立する。

### Costs and risks

- Semantic ContractがCore Compatibility Surfaceとなり、厳格なVersioningが必要になる。
- Review／Freshness Labelを無視すると、誤Interpretationが複数Featureへ波及する。
- Scope／Modality vocabularyの進化管理が必要になる。
- Dependency Index／Field-level Contribution trackingにPersistence／Migration Costが生じる。
- Hybrid RetrievalでReviewedだが不完全なIRを過剰評価しないためのEvaluationが必要になる。
- Feature-private Schemaを段階的にAdapter化・廃止する作業が必要になる。
- ObservabilityでSource、IR、Decision、Projection、Index、UI Failureを区別する必要がある。

これらのCostは、機能ごとの重複とSemantic Driftを継続するCostより小さいと判断する。

## Deferred decisions

具体的Consumerが揃った段階で、別ADRまたは本ADRのAmendmentとして決定する。

- mandatoryなstable `assertionId`／`claimUid` allocation
- Registry固有のWorldline分岐、Narrative Layer階層、集合Scope拡張
- Proposal payloadからdedicated typed storageへ昇格する基準
- Composite AssertionのField-level Review UI
- Canonical Assertion Kind RegistryのOwnership／Extension Policy
- ObsoleteなUnreviewed CandidateのRetention Policy
- Cross-project／Shared Universe Semantic Reference
- Portable Narrative IRのExport／Import Format
- RetrievalにおけるAuthority／Freshness／Confidence weighting policy

これらが未決定であることを理由に、Feature-privateなAuthorityを新設したり、本ADRの
Boundaryを迂回してはならない。

## Amendment — Gate C1.5 Semantic Contract Ratification

Accepted at Gate C1.5. This amendment ratifies the contract that C2 must use;
it does not start C2 persistence or runtime work.

### Canonical mutation paths

Interpretation and Reconciliation are distinct from authoring surfaces:

```text
Interpretation / Reconciliation Path
  Source
    → Interpreter / Reconciler
    → Evidence-bound Narrative IR Revision
    → Proposal / Review / Decision
    → Prepared Commit
    → Typed Writer
    → Domain Projection

Human Direct Authoring Path
  Human UI
    → Runtime Policy / Actor Context
    → OCC / Field Authority
    → Typed Writer
    → Domain Data

Interactive Agent Command Path
  User Turn / Standing knowledgeWrite Authority
    → Agent Tool Policy
    → OCC / Field Authority
    → Typed Writer
    → Domain Data
```

Human Direct Authoring and Interactive Agent Command may produce Domain Data
that is later used as an Interpretation Source. That fact does not make the
write itself an Accepted Narrative Assertion. Semantic Interpretation remains
Proposal-bound; Interactive Agent Command is governed by ADR 006.

### C1.5 implementation status and two directions

| Area | State at C1.5 |
| --- | --- |
| Source Snapshot / Evidence | Existing |
| Proposal Revision / Decision | Existing |
| Prepared Commit / OCC / Field Authority | Existing |
| Application-level Dependency | Existing but limited |
| Narrative Change Feed | C0 |
| Canonical Writer wiring | C1 |
| Generic Dependency Graph | New in C2 |
| Field Contribution | New in C2 |
| Semantic Index Freshness connection | C2+ |
| Feature-specific stale paths | Legacy Cutover |

The contract preserves both sides of the incremental build boundary:

```text
Producer-time
  Artifact / Proposal / Application generation
    → Dependency Declaration in the same transaction

Mutation-time
  Source mutation
    → Change Feed
    → Reverse Dependency Lookup
    → Freshness re-evaluation
```

Existing synchronous dependency registration and future Change Feed-driven
invalidation are therefore compatible. C1.5 does not introduce a Dependency
Edge table, Generic Freshness Store, Consumer Index, Evaluator, or Scheduler.

### Orthogonal state vocabulary

The following are separate axes and must not be stored in one enum or one
database column:

```text
Review State
  unreviewed | accepted | rejected | held | superseded

Evidence Freshness
  fresh | stale | source-missing | anchor-mismatch | read-set-drift | unknown

Reconciliation Signal
  needs-reconciliation

Build Action
  none | revalidate-exact | reanchor-candidate | resolve-only
  | recompile-only | rebuild-required | refresh-available | manual

Component Compatibility
  compatible | quality-refresh-available | compatibility-refresh-required

Projection Application State
  unapplied | applied | compensated | undone | stale | not-applicable
```

In particular, `accepted` is not `fresh`, `fresh` is not truth,
`applied` is not truth, `rejected` is not permanently false, and `stale` is
not retracted. `needs-reconciliation` is the only Reconciliation propagation
signal. Build Actions are downstream work descriptions, not Freshness or
Review states.

### Assertion and Projection state

An Assertion has one state per immutable revision:

```ts
interface NarrativeAssertionState {
  revisionId: string;
  review: ReviewState;
  evidenceFreshness: EvidenceFreshness;
}
```

Projection state is many-to-many with revisions:

```ts
interface NarrativeProjectionState {
  revisionId: string;
  projectionRef: string;
  projectionKind: string;
  applicationId: string | null;
  state: ProjectionApplicationState;
}
```

The same revision may therefore be `applied` for a Codex Relation,
`unapplied` for a Chronicle Event, `stale` for a Semantic Index, and
`compensated` for a Chat Context Index at the same time. A singular
`projection` field on Assertion state is not a valid C1.5 contract.

### Evidence, support, and scope

`modality` describes who or how something is stated. `supportClass` describes
what supports it:

```text
author-declared | direct-source | reported-source | single-source-inference
| multi-source-inference | imported-assertion | unresolved
```

An empty or omitted Scope is never an implicit global truth. ADR 009 owns the
canonical V2 shape: every axis is present and distinguishes intentional `any`
from constrained-but-`unresolved`. An unresolved Scope cannot be automatically
expanded to every time, character, or worldline. AI Inference and Reconciler Proposal require a non-empty Evidence
Set. Author Declaration may have an empty Evidence Set only with a Source
Basis. Import Metadata may use the Source Package as Evidence. Legacy
Migration may have an empty Evidence Set only with an explicit
`evidenceAbsenceReason` of `legacy-unbound`.

### Stable identity and Related Scenes

The First Retrieval Vertical Slice uses immutable `revisionId` as its Index
identity. Stable `assertionId` is optional until cross-run merge,
deduplication, partial retraction, long-lived history, or identity-based graph
traversal requires it. Deterministic Core must not invent identity with
heuristic matching.

The canonical implementation name is **Related Scenes**, not Relative Scenes.
Narrative IR retrieval inherits ADR 002 `PhaseResolutionMode` and the same
spoiler/secret policy. Semantic relevance never overrides disclosure.

### Retrieval disclosure contract

Candidate admission occurs before ranking. The context contains project,
current scene, phase mode, temporal anchor, viewpoint, knowledge holder,
audience, and `allowSecrets`. Candidate admission rejects future phases,
unreached story-time, secret Foreshadow before reveal, knowledge-holder
mismatch, Reader/Character knowledge confusion, Worldline/Timeline mismatch,
and Narrative Layer mismatch. `auto` uses the existing ADR 002 resolver and
does not create a second Phase authority. The policy contract and fixtures are
in `policies/narrative/retrieval-disclosure.json`; C1.5 does not connect the
policy to the Retrieval runtime.

### Authority matrix and C2 start condition

The canonical Authority Matrix is
`policies/narrative/semantic-core-authorities.json`. C2 must not create a
second durable Freshness authority. A Semantic Index may own only generation,
build timestamp, source digest, dependency-set digest, and a dirty-cache flag;
it may not assert that an Assertion is authoritative and fresh.

C2 begins only after these contracts are present and validated:

```text
Mutation Route       fixed
Source Event Contract fixed
Object Addressing     fixed
State Vocabulary      fixed
Authority Matrix      fixed
Disclosure Policy     fixed
Evidence / Scope      fixed
```

C2 then implements only Dependency Edge, Edge State, Consumer Freshness,
Application Contribution, Reverse Lookup, Incremental Evaluator, Cursor, and
Backfill persistence/runtime. The workspace schema remains **22** throughout
C1.5; no new C2 table or schema bump is part of this gate.
