# ADR 010: Narrative Dependency Role and Granularity Contract

## Status

Accepted — 2026-08-20（NIR-0 contract）

本ADRは[ADR 005](005-narrative-semantic-core-boundary.md)のSemantic Build Graphを
具体化し、Dependencyの役割、選択範囲、効果写像、集合の原子性を
`policies/narrative/narrative-dependency-role-registry.json`へ固定する。

本ADRの契約状態は`declared`である。現行C2 GraphはSource単位の
`narrative_dependency_edges`と`read_set_json`を持ち、Change Feedには
`position-map`／`canonical-diff`／`whole-document`の変更表現が存在する。しかし、第一級の
`dependency_role`、Selector V2、`dependency_key`、sealed Declaration Set、
Context Set、独立したBuild Action集合はまだ永続化・配線されていない。
本ADR自体はWorkspace Schemaまたはruntime behaviorを変更しない。

## Context

ADR 005は、Evidence SetとRead Setを分離し、Producer-timeのDependency Declarationと
Mutation-timeのReverse Lookup／Freshness evaluationを定めた。C2-1はこの基礎を実装したが、
現在のEdgeは「どのSourceを読んだか」をSource単位で表すだけで、次を第一級に表せない。

- Assertionの直接根拠として読んだ。
- 人物や場所の実体同定に使った。
- Story TimeやScopeの解決に使った。
- 既存Projectionとの照合だけに使った。
- Modelへ提示したが、意味上の使途を限定できない。
- 現在成果物を無効化せず、品質向上だけに使える。
- RankingまたはIndex生成だけに使った。

役割を持たないSource単位Edgeは安全だが、Sceneの一部変更やCatalogの軽微な変更でも
広いConsumerを`stale`にしやすい。逆にProducerが自由な「軽い依存」を申告できるように
すると、実際にModelへ見せた入力を後から非依存扱いし、必要な無効化を失う。

また、Consumer Freshnessの最悪値と単一`build_action`だけを集約すると、
`fresh + revalidate-exact`や`fresh + refresh-available`の作業が別のFresh Edgeに
マスクされ得る。新しいFreshness語彙を増やすのではなく、既存の直交軸を保ったまま
作業集合を独立集約する必要がある。

## Decision

### 1. Evidence、Dependency、Contextを分離する

```text
Evidence Set
  Assertionを直接支える引用または構造化根拠

Dependency Set
  変化した場合、現在のConsumerを再評価する必要がある入力

Context Set
  Modelまたは決定的処理段階へ実際に提示した動的入力
```

すべてのEvidenceは`direct-evidence` Dependencyを持つ。Model-visibleな動的Source入力は
すべてContext Setに存在し、用途を決定的に証明できない入力は
`opaque-model-context` Dependencyとして保守的に扱う。

概念上のEnvelopeは次の形になる。

```ts
interface ContextSetEntry {
  readonly contextId: string;
  readonly inputRef: string;
  readonly stageId: string;
  readonly exposure:
    | "model-visible"
    | "deterministic-stage"
    | "author-supplied";
  readonly selector: DependencySelector;
}

interface DependencySetEntry {
  readonly dependencyId: string;
  readonly inputRef: string;
  readonly contextIds: readonly string[];
  readonly role: DependencyRole;
  readonly selector: DependencySelector;
}

interface ReconciliationEnvelopeV2 {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly taskId: string;
  readonly sourceBasis: SourceBasis;
  readonly contextSet: readonly ContextSetEntry[];
  readonly contextSetDigest: Sha256Digest;
  readonly dependencySet: readonly DependencySetEntry[];
  readonly dependencySetDigest: Sha256Digest;
  readonly evidenceSet: readonly EvidenceSetEntry[];
  readonly changeKind: ProposalChangeKind;
}
```

### 2. PromptはContext Setから決定的に構築する

Modelへ送る動的Source入力は、Context Set外の経路から追加してはならない。

```ts
const contextSet = buildContextSet(retrievalResult);

const modelRequest = buildModelRequest({
  componentContract,
  taskInstruction,
  contextSet,
});
```

静的Prompt Template、Parser Schema、Tool Contract、Model設定は
`component-contract` Dependencyとして記録する。AI Auditは少なくとも次を関連付ける。

```text
contextSetDigest
componentContractDigest
finalRequestDigest
```

これにより、記録されたContext Setと実際の送信内容の対応を監査できる。

### 3. Dependency Role Registry

初期Roleは次の十個とする。

| Role                   | 用途                                              |
| ---------------------- | ------------------------------------------------- |
| `direct-evidence`      | Assertionの直接根拠                               |
| `opaque-model-context` | Modelへ見せたが用途を決定的に限定できない文脈     |
| `entity-resolution`    | 人物、場所、物品などの実体同定                    |
| `temporal-resolution`  | Story TimeまたはReading Orderの解決               |
| `scope-resolution`     | Narrative Scopeの解決                             |
| `projection-match`     | 既存Domain Projectionとの照合                     |
| `author-correction`    | 作者訂正規則またはReview履歴の適用                |
| `component-contract`   | Prompt、Parser、Normalizer、Tool Schema等の互換性 |
| `quality-context`      | 現在成果物を有効なまま品質改善できる補助入力      |
| `ranking-only`         | Semantic Indexまたは候補順位そのものの生成入力    |

ProducerはRoleを宣言するが、Freshness、Reason、Build Action、Impact Classを自由に
上書きできない。効果はRole Registryが次の三次元で決定する。

```text
dependency role
× consumer kind
× source change class
```

```ts
interface DependencyEffectRule {
  readonly role: DependencyRole;
  readonly consumerKind: NarrativeConsumerKind;
  readonly changeClass: SourceChangeClass;
  readonly result: {
    readonly freshness: EvidenceFreshness;
    readonly reasonCode: FindingReasonCode | null;
    readonly buildAction: BuildAction;
    readonly actionRequirement: "required" | "advisory" | "none";
  };
}
```

未知Role、未知Consumer、未定義の組み合わせはfail-closedする。

### 4. 新しいFreshnessまたはReason語彙を作らない

効果は既存の三軸へ写像する。

```text
EvidenceFreshness
  fresh | stale | source-missing | anchor-mismatch | read-set-drift | unknown

FindingReasonCode
  narrative-finding-contract.jsonの既存値

BuildAction
  none | revalidate-exact | reanchor-candidate | resolve-only
  | recompile-only | rebuild-required | refresh-available | manual
```

`unknown`は安全に評価できない場合だけに温存する。Catalogの通常変更は評価不能ではなく、
解決入力の内容変更である。

| Role／変更                             | Freshness         | Reason                    | Action                                |
| -------------------------------------- | ----------------- | ------------------------- | ------------------------------------- |
| `direct-evidence`の内容変更            | `stale`           | `source-revision-changed` | required `rebuild-required`           |
| `direct-evidence`の引用消失            | `anchor-mismatch` | `quote-not-found`         | required `reanchor-candidate`         |
| `entity-resolution`入力の通常変更      | `stale`           | `source-revision-changed` | required `resolve-only`               |
| `projection-match`入力の通常変更       | `stale`           | `source-revision-changed` | required `resolve-only`               |
| 解決対象の削除または選択集合崩壊       | `read-set-drift`  | `read-set-drift`          | required `resolve-only`               |
| Resolver／Componentが評価不能          | `unknown`         | `component-incompatible`  | required `resolve-only`または`manual` |
| `quality-context`のみ変更              | `fresh`           | `null`                    | advisory `refresh-available`          |
| `ranking-only`からSemantic Indexを生成 | `stale`           | `source-revision-changed` | required `recompile-only`             |

```text
stale
  入力内容が変化した

read-set-drift
  何を参照していたかという宣言自体が現状と合わない

unknown
  Resolver、Registry、Componentなどが利用できず安全に評価できない
```

新しい`resolution-input-changed`のようなReason Codeは導入しない。Roleと既存
`source-revision-changed`の組み合わせで説明する。

### 5. `ranking-only`と`quality-context`を混同しない

`ranking-only`はRanking成果物にとって必須依存である。

```text
ranking-only × semantic-index
  stale / source-revision-changed / required recompile-only
```

意味解釈Consumerへ`ranking-only` Edgeを付けない。Rankingは独立したSemantic Indexまたは
Materialization Consumerとして持つ。

`quality-context`は現在成果物を無効化せず、品質改善版を作れる入力である。

```text
quality-context
  fresh / no reason / advisory refresh-available
```

### 6. Build ActionをFreshnessから独立して集合集約する

Consumer単位のV2集約結果は次の形とする。

```ts
interface ConsumerBuildSummary {
  readonly requiredActions: readonly BuildAction[];
  readonly advisoryActions: readonly BuildAction[];

  /**
   * V1単一列との互換表示用。
   * Schedulerまたは修復処理の唯一のAuthorityにしてはならない。
   */
  readonly compatibilityPrimaryAction: BuildAction;
}
```

必須作業は`revalidate-exact`、`reanchor-candidate`、`resolve-only`、
`recompile-only`、`rebuild-required`、`manual`、任意作業は`refresh-available`、
不要は`none`である。

```text
requiredActions
  全Edgeのrequired Actionの重複なし集合

advisoryActions
  全Edgeのadvisory Actionの重複なし集合
```

したがって、Consumer Freshnessが`fresh`でも`revalidate-exact`または
`refresh-available`は失われない。現行`narrative_consumer_freshness.build_action`は
V1互換列として残り、V2 cutoverまでは現行runtimeのAuthorityを変更しない。

### 7. Selector V2

```ts
type DependencySelector =
  | { readonly kind: "whole-source" }
  | {
      readonly kind: "text-range";
      readonly unit: "utf16";
      readonly from: number;
      readonly to: number;
      readonly anchorDigest?: Sha256Digest;
      readonly normalizerVersion: string;
    }
  | {
      readonly kind: "field-path";
      readonly objectIdentity: string;
      readonly fieldPath: string;
    }
  | {
      readonly kind: "exact-object-set";
      readonly objectIdentities: readonly string[];
      readonly setDigest: Sha256Digest;
    }
  | {
      readonly kind: "component-contract";
      readonly contractId: string;
      readonly contractDigest: Sha256Digest;
    };
```

`exact-object-set`だけでは、宣言時に存在しなかった新しい一致候補の追加を検出できない。
検索条件に対応するCatalog Sliceを決定的に再現できるまでは、Catalog照合を
`whole-source`へ保守的に倒してよい。見かけ上の細粒度化のために新規候補を無視しない。

`text-range`の座標はJavaScript文字列と一致するUTF-16 code unitの半開区間`[from, to)`である。
Byte、Unicode scalar、grapheme clusterを暗黙採用しない。

#### Producer／共有Source View

本文を保持する境界が次を検証する。

- `from`と`to`がUTF-16境界である。
- サロゲートペアの途中を指さない。
- 範囲が対象文書内に収まる。
- `anchorDigest`が対象範囲と一致する。

#### Native Dependency Writer

本文を持たない境界は構造だけを検証する。

- `unit === "utf16"`。
- `from`と`to`が非負の安全な整数で`from < to`。
- `normalizerVersion`が存在する。
- Selector SchemaとCanonical Digestが一致する。

#### Evaluator

Source解決時のUTF-16境界不正は`anchor-mismatch`／`quote-not-found`／
`reanchor-candidate`へ写像する。`source-missing`または一般的`stale`へ潰さない。

### 8. 位置対応がない場合は保守的に全文変更とする

C2-1のChange Feedは`position-map`、`canonical-diff`、`whole-document`を理解するが、すべてのWriterが
常に精密な位置対応を生成するわけではない。細粒度Dependencyが効果を持つためには、
次の両方が必要である。

```text
Producerが処理段階ごとのRoleとSelectorを宣言する
Change Feed Writerが十分なposition-mapを生成する
```

位置対応を生成できないWriterは`mapping.kind = whole-document`を記録する。対応情報が
ないのに範囲外編集だったと推測して`fresh`を維持してはならない。

### 9. ModelにDependencyを自己申告させない

Modelが見た入力のうち、決定的処理系がRoleを証明できないものはすべて
`opaque-model-context`として扱う。Model出力に「実際に使ったのはこの一文だけ」と
書かれていても、その申告だけでDependencyを狭めない。

Dependencyを狭める正当な方法は、決定的に記録可能な入力構築である。

- 処理段階の分割
- 決定的な検索候補選択
- 明示的な文書範囲抽出
- 独立した実体、時間、Scope解決段階
- Catalog照合入力集合の固定
- FeatureごとのContext Packer

細分化による抽出品質低下を避けるため、不要なStale率だけでなく、見逃し率、実体誤結合率、
出来事抽出再現率、作者確認件数、作者修正率も測定する。

### 10. `dependencyKey`は意味上のRoleとSelectorだけから作る

```text
dependencyKey = SHA-256(dependency role + canonical selector)
```

Role Contract Version、Source Identity、Freshness、Source Revisionを含めない。保存項目は分ける。

```text
dependency_key
dependency_role
role_contract_version
selector_json
selector_digest
```

Registryの版が上がっても、同じRoleとSelectorのEdge identityは変化しない。Roleの意味を
後方互換なく変える場合はRole ID自体を変更するか、明示的Migrationを行う。

V2の一意性は概念上次である。

```text
project
+ consumer kind
+ consumer key
+ source object identity
+ dependency key
```

現行V1 tableのSource単位一意制約はV2 cutoverまで変更しない。

### 11. Declaration Setはsealedな完全集合だけを永続化する

`building`はTransaction内部またはメモリ上の概念であり、合法な永続状態ではない。

```text
Declaration Set IDを生成
  → 全V2 EdgeをDeclaration Set ID付きでINSERT
  → Dependency Set Digestを計算
  → sealed Declaration SetをINSERT
  → Consumer Declaration HeadをCAS更新
  → COMMIT
```

途中で失敗した場合はTransaction全体をRollbackする。複数Transactionにまたがる巨大集合が
必要になった場合は別の契約改訂で扱う。

### 12. Active HeadとProducer Generationで競合を防ぐ

```ts
interface DependencyDeclarationHead {
  readonly projectId: string;
  readonly consumerKind: string;
  readonly consumerKey: string;
  readonly activeDeclarationSetId: string;
  readonly producerId: string;
  readonly producerGeneration: number;
  readonly version: number;
}
```

Head更新は次の両方を満たす場合だけ成功する。

```text
incoming producer generation > current producer generation
かつ
Head version == expectedVersion
```

同一または古いGenerationはHeadを上書きできない。同世代の並行実行も一方だけがCASに
成功し、他方は再利用または明示的失敗となる。

D1のProposal Revision writerは、V1互換Edgeの文字列
`proposal-revision-dependency/v1`とは別に、sealed Declaration Set用の数値
`declarationSetGeneration = 1`を予約する。これはwriter側のコンパイル済み
`PROPOSAL_REVISION_D1_PRODUCER_GENERATION: i64`とregistryのcross-field validationで
一致を確認し、`/v1`の解析、親Generationのコピー、Revision番号からの導出を行わない。
Legacy Application producerはこのD1フィールドを宣言しない。この段階は契約のprelude
だけをratifyし、child declarationのmaterialization、Current Revision promotion、
Freshness初期化、その他のC2B activationを開始しない。

### 13. Declaration Set Digest

V2 Declaration Set Digestは、正規化・ソート済みの次の組から計算する。

```text
sourceObjectIdentity
dependencyKey
selectorDigest
```

```ts
dependencySetDigest = sha256(
  sort(
    edges.map((edge) => [
      edge.sourceObjectIdentity,
      edge.dependencyKey,
      edge.selectorDigest,
    ]),
  ),
);
```

次を含めない。

- Evidence Freshness、Finding、Build Action
- 現在のSource Revision、最終評価時刻
- Consumer Freshness、Cursor位置

現行`narrative_consumer_freshness.dependency_set_digest`はV1 Source identity集合のDigestで
あり、V2 sealed Declaration Set Digestとは別の互換段階にある。V2 cutover時に
Consumer契約とMigrationを同時更新し、同名Digestの意味を無言で変更しない。

### 14. V1／V2の優先規則

```text
Active HeadがsealedなV2 Declaration Setを指す
  そのV2 Setだけを評価し、V1はVerify比較用にする

Active Headが存在しない
  V1 Edgeを評価する

不完全なV2 Edgeだけが存在する
  Contract corruptionとして報告する
  V1を継続利用し、不完全V2を正本にしない
```

一件のV2 Edgeが存在するだけでV1全体を無視してはならない。

### 15. 旧Edgeは保守的に扱う

旧`read_set_json`からRoleやSelectorを推測しない。移行時の既定は次である。

```text
role = opaque-model-context
selector = whole-source
```

したがって契約導入だけでは無効化範囲は狭くならない。ProducerのRole／Selector宣言と
Writerの精密なposition-mapが揃って初めて増分性を主張できる。

### 16. Durable identityのないIRをConsumerにしない

`narrative-ir-revision`は、Durable Revision Row、Stable Revision ID、Producer-time
Dependency Declaration、再生・移行・Verify規則が揃うまでConsumerにしない。現時点では
`proposal-revision`、`narrative-extraction-run`、必要に応じて`extraction-artifact`を
既存Consumer Registryの粒度で使用する。Payloadからheuristic IDを作ってはならない。

### 17. 実装状態は契約の一部である

```text
declared
  PolicyとSchemaのみ。V2 production entry pointはない。

shadow
  V1とV2を同一入力で評価し、V2は本番判断を書かない。

wired
  sealed V2 Setと独立Action集合が正式なruntime authorityになる。
```

`declared`なのにV2 production markerが存在する場合、または`shadow`／`wired`なのに
宣言Entry Pointが存在しない場合は品質Validatorを失敗させる。

## Interaction with ADR 009

訂正記憶を自動再利用するには、訂正Scopeが候補Scopeを`equal`または`contains`し、
material Dependency Digestと訂正Rule Revisionが一致しなければならない。Scope Relationが
`unknown`なら自動適用せずReview候補にする。

過去Reviewの自動継承はさらに厳しく、Scope `equal`、material Dependency Digest一致、
Payload Schema互換、同一Revision系列を要求する。Scope `contains`だけでは過去判断を
広い範囲へ拡張しない。

矛盾診断は、意味内容が排他的でScopeが`disjoint`ではなく、関連するmaterial Dependencyが
Freshな場合だけ明確な矛盾候補にする。Scope `unknown`は適用範囲未解決の競合候補である。

## Adoption plan

```text
Policy / Schema / Validator
  → Scope V2 / Disclosure shadow（ADR 009）
  → Producer position-map coverageの測定
  → Envelope V2 / Context Set / Prompt Builder
  → Role Registry / Selector V2
  → sealed Declaration Set / Edge V2 shadow
  → Chronicle vertical slice
  → Codex / Correction Memory
  → verified V2 cutover
```

Chronicle vertical sliceでは、出来事引用を`direct-evidence / text-range`、人物同定入力を
`entity-resolution`、時間解釈入力を`temporal-resolution`、用途を限定できないModel文脈を
`opaque-model-context`として宣言する。

## Consequences

### Positive

- Evidence、無効化Dependency、Model-visible Contextを監査可能に分離できる。
- Roleごとの再解決、再固定、再構築を既存状態語彙で表現できる。
- `fresh`を維持したまま必要なBuild Actionを失わず集約できる。
- 完全なDeclaration Setだけを有効化し、部分V2によるDependency欠落を防げる。
- Rangeとposition-mapが揃ったConsumerだけを安全に細粒度化できる。

### Costs and risks

- Envelope、AI Audit、Edge、Head、Declaration Set、Action集約のMigrationが必要になる。
- Role × Consumer × Change ClassのRegistry維持が必要になる。
- Model-visible入力を保守的に`opaque-model-context`とすると、初期は広い無効化が残る。
- Contextを狭め過ぎると抽出品質やRecallを損なう可能性がある。

## Non-goals

- Dependency変更からsemantic retraction、merge、split、delete、Applyを実行する。
- Modelの自己申告だけでDependencyを狭める。
- 契約追加だけで性能改善を主張する。
- Durable identityのないNarrative IR Revisionをheuristic Consumerへ昇格する。
- V1 runtimeを本ADRだけでcutoverする。

## Acceptance criteria

- Evidence、Dependency、Context Setが別のDigestと責務を持つ。
- Model-visibleな動的Source入力がContext Setからだけ構築される。
- 未分類Model入力が`opaque-model-context`として保守的に記録される。
- Role × Consumer × Change Classが既存Freshness／Reason／Actionへ写像される。
- Catalogの通常変更が`unknown`または`read-set-drift`へ誤写像されない。
- `unknown`が評価不能専用である。
- required／advisory Build ActionがFreshnessとは独立した集合として集約される。
- `text-range.unit`が`utf16`で、Producer、Writer、Evaluatorの検証責務が分かれる。
- 位置対応がないWriterが`whole-document`へ保守的に倒れる。
- `dependencyKey`がRoleとCanonical Selectorだけを含み、Contract Versionを含まない。
- 永続Declaration Setの合法状態が`sealed`だけである。
- Active HeadがVersion CASと単調なProducer Generationで更新される。
- V2 Declaration Set DigestがSource Identity、Dependency Key、Selector Digestを含む。
- sealed V2 Active Headがない限りV1 Edgeが正本であり続ける。
- `declared`／`shadow`／`wired`とproduction entry pointが機械検証される。
