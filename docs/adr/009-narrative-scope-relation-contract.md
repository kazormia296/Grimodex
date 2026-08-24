# ADR 009: Narrative Scope Relation Contract

## Status

Accepted — 2026-08-20（NIR-0 contract）

本ADRは[ADR 005](005-narrative-semantic-core-boundary.md)のScope定義を具体化し、
物語上の適用範囲を表す唯一の正本を
`policies/narrative/narrative-scope-relation-contract.json`へ移す。
ADR 005のAuthority、Review、Evidence、Projection、Freshnessの境界は変更しない。

本ADRの契約状態は`declared`である。現行の
`src/features/narrative-semantic-core/contracts/scope.ts`とDisclosure evaluatorは
互換用の旧契約を使用しており、`NarrativeScopeV2`、共通比較器、Order Oracle、
本番Entry Pointはまだ存在しない。本ADR自体はDB migration、runtime cutover、
作品世界のTruth Authorityを追加しない。

### NIR-0 capability-status amendment (2026-08-21)

NIR-0 keeps Scope adoption capability-specific. The machine-readable Scope
contract records separate status for:

- `structuralValidation` — structural V2 validation and canonical digest;
- `relationComparison` — strongest-established Relation and Order Oracle use;
- `disclosureAdmission` — admission gating at the Disclosure consumer.

Each capability follows the `declared → shadow → wired` lifecycle independently.
For this contract-freeze slice all three remain `declared`, with empty production
entry points and explicit blockers. A status change must update the policy,
validator evidence, and the owning implementation atomically.

Scope Disclosure is an ADR 009-owned adoption track, independent from the
Narrative IR contract in ADR 011. Its first likely consumer is NIR-1
pre-ranking disclosure, but NIR-1 does not own the lifecycle. This amendment
does not add a Scope V2 runtime, a schema/table migration, or a Disclosure
runtime connection; it only prevents a future Narrative IR activation from
silently claiming Scope adoption.

### Historical run-relative scope basis (NIR-0 / C2B)

`narrative-scope-authority-basis/2` is a sealed, historical basis for one
`snapshot:<runId>`. It records the document-to-scene mapping and the
independent Reading Order and Story Time projections used by that run. It is
not a live Scope Registry, a current-project Order Oracle, or a producer or
resolver of scope authority. Duplicate Story keys remain explicitly
unresolved; a unique key must resolve to its UTF-16 lexical rank. Neither case
falls back to Reading Order.

The carrier token `source.snapshot@2` is reserved to the typed snapshot-task
writer/reader. The Electron coordinator supplies a closed basis companion;
Native independently re-derives it from the durable Run scope and tree rows
before it stores one shadow artifact. Generic artifact input cannot mint this
carrier. The existing `source.snapshot@1` source identity authority remains
unchanged, and the shadow artifact is not promoted into live Scope authority.
V1 data has no implicit upgrade path; a rebuild is required.

The historical producer/reader is a `shadow` foundation only. Until C2B
ScopeOverride wiring and a separate project-scope order authority establish a
live/current Oracle, runtime ScopeOverride handling continues to stop with the
exact `NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE` code. This slice adds no new IPC
command, persistence migration, or current-Revision promotion.

## Context

ADR 005の旧`NarrativeScope`は、Timeline、Worldline、Scene、Viewpoint、
Knowledge Holder、Audience、Narrative Layer、開始・終了参照を保持できる。
しかし、二つのScopeを比較する共通演算がなく、省略された軸について次を区別できない。

```text
この軸では意図的に制約しない
この軸には制約があるが具体値を解決できない
```

この区別がないと、未解決な世界線や知識保持者を暗黙の全範囲として扱い、Disclosure、
矛盾診断、訂正記憶、Review再利用が過剰適用され得る。逆に、Evidenceが見つかったSceneを
そのままScopeへ写すと、Sceneを越えて継続する人物状態などを誤って局所化する。

また、作中時間と読者が読む順序は独立している。章の並べ替えはReading Orderを変えるが、
Story Timeを必ずしも変えない。参照の順序は整数に限らず、日時、Fractional Index、
作中暦、複合識別子で表され得るため、固定的な数値比較も正本にできない。

## Decision

### 1. Scopeは出所ではなく適用範囲である

Scopeは、Assertionが**どこで成立するか**を表す。Assertionが観測・抽出された場所は
Evidenceが保持する。

たとえばScene 1の記述から「人物Aは負傷している」を抽出した場合、次のように分ける。

```text
Evidence
  Scene 1の該当引用

Scope
  storyTime = 負傷開始から回復まで
  scene = any
```

`scene = exact`を使用するのは、そのSceneで発生した出来事、Scene内の描写、
Scene固有の語り手など、意味自体がScene局所である場合に限る。

### 2. Canonical Scope V2

全軸を必須の明示的制約として保持する。

```ts
type ScopeUnresolvedReason =
  | "not-provided"
  | "ambiguous"
  | "missing-reference"
  | "unsupported-axis"
  | "legacy-axis-unknown";

type ReferenceScopeConstraint =
  | { readonly kind: "any" }
  | { readonly kind: "exact"; readonly ref: string }
  | {
      readonly kind: "unresolved";
      readonly reason: ScopeUnresolvedReason;
      readonly constraintId?: string;
    };

interface TemporalBoundary {
  readonly ref: string;
  readonly inclusive: boolean;
}

type TemporalScopeConstraint =
  | { readonly kind: "any" }
  | {
      readonly kind: "interval";
      readonly from?: TemporalBoundary;
      readonly until?: TemporalBoundary;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: ScopeUnresolvedReason;
      readonly constraintId?: string;
    };

interface NarrativeScopeV2 {
  readonly schemaVersion: 2;
  readonly registryVersion: string;

  readonly timeline: ReferenceScopeConstraint;
  readonly worldline: ReferenceScopeConstraint;
  readonly scene: ReferenceScopeConstraint;
  readonly viewpoint: ReferenceScopeConstraint;
  readonly knowledgeHolder: ReferenceScopeConstraint;
  readonly audience: ReferenceScopeConstraint;
  readonly narrativeLayer: ReferenceScopeConstraint;

  readonly storyTime: TemporalScopeConstraint;
  readonly readingOrder: TemporalScopeConstraint;
}
```

`reader`はAudience Registryの予約識別子とする。V2のKnowledge Holderは一つを基本とし、
「AとBの双方が知る」は二つのAssertionで表す。集合制約は将来の契約改訂まで導入しない。

### 3. `any`と`unresolved`は非同値である

```text
any
  この軸では意図的に制約しない

unresolved
  この軸には何らかの制約があるが、具体値を解決できない
```

`unresolved`は、後から`any`へ解決される仮状態ではない。実際には制約がなかったと判明した
場合は、Scope Revisionを変更して`any`を記録する。

同じ`reason`を持つ二つの`unresolved`は、同じ未知の制約とは限らない。次の場合だけ
同一性を確立できる。

- 同じScope Revisionを自分自身と比較する。
- 同じ安定`constraintId`を共有する。

理由文字列の一致だけで`equal`を返してはならない。

### 4. Assertion種別ごとに軸の制約種を定義する

Reference軸とTemporal軸では合法な制約種が異なるため、`requiredExactAxes`のような
一律語彙は使用しない。

```ts
type ReferenceConstraintKind = "any" | "exact" | "unresolved";
type TemporalConstraintKind = "any" | "interval" | "unresolved";

type ScopeResolutionGate = "none" | "before-review" | "before-apply";

interface ReferenceAxisProfile {
  readonly axisKind: "reference";
  readonly allowedKinds: readonly ReferenceConstraintKind[];
  readonly resolutionRequiredBy?: ScopeResolutionGate;
}

interface TemporalAxisProfile {
  readonly axisKind: "temporal";
  readonly allowedKinds: readonly TemporalConstraintKind[];
  readonly resolutionRequiredBy?: ScopeResolutionGate;
}

interface AssertionScopeProfile {
  readonly assertionKind: string;
  readonly axes: Partial<
    Record<ScopeAxis, ReferenceAxisProfile | TemporalAxisProfile>
  >;
}
```

`character-state`では`scene: exact`と`storyTime: any`を禁止し、抽出直後の
`storyTime: unresolved`は保存できるが、Apply前に解決を要求する。

```json
{
  "assertionKind": "character-state",
  "axes": {
    "scene": {
      "axisKind": "reference",
      "allowedKinds": ["any", "unresolved"]
    },
    "storyTime": {
      "axisKind": "temporal",
      "allowedKinds": ["interval", "unresolved"],
      "resolutionRequiredBy": "before-apply"
    }
  }
}
```

`scene-event`ではSceneをReview前に解決する。

```json
{
  "assertionKind": "scene-event",
  "axes": {
    "scene": {
      "axisKind": "reference",
      "allowedKinds": ["exact", "unresolved"],
      "resolutionRequiredBy": "before-review"
    }
  }
}
```

`unresolved`を保存できることと、ReviewまたはApplyへ進めることは別のGateである。

### 5. Relationは確立された知識を表す

Scope Relationは真の集合関係を完全分類する値ではない。現在利用できるScope、Registry、
Order Oracleから、どの関係まで安全に確立できたかを表す。

```ts
type ScopeRelation =
  | "equal"
  | "contains"
  | "contained-by"
  | "overlaps"
  | "disjoint"
  | "unknown";
```

| Relation       | 確立されたこと                                     |
| -------------- | -------------------------------------------------- |
| `equal`        | 左右の適用範囲が同一である                         |
| `contains`     | 左側が右側を含み、逆方向の包含は確立されていない   |
| `contained-by` | 左側が右側に含まれ、逆方向の包含は確立されていない |
| `overlaps`     | 交差が非空で、どちら向きの包含も確立されていない   |
| `disjoint`     | 交差が空である                                     |
| `unknown`      | 上記のどれも安全に確立できない                     |

`contains`と`contained-by`は厳密な真包含を主張しない。実際には等しい可能性が残っていても、
片方向の包含だけが確立できた場合はその方向を返す。両方向の包含が確立した場合は
集合の外延性から`equal`を返す。

各軸比較器は、確立できた関係のうち最も強いものを返す。`equal`を確立できるのに
`contains`を返してはならない。RegistryまたはOracleが互いに矛盾する関係を証明した場合は、
任意に一つを選ばず契約違反としてfail-closedする。

### 6. 基本比較規則

```text
any 対 any
  equal

any 対 exact / interval / unresolved
  contains

exact / interval / unresolved 対 any
  contained-by

unresolved 対 exact / interval / 別のunresolved
  原則unknown
```

同じ参照は構造的`equal`である。異なる世界線は自動的に`disjoint`ではない。分岐前の
適用範囲を共有し得るため、Registryが排他を証明した場合だけ`disjoint`を返す。
Narrative Layerの親子、排他、同一性もRegistryが判定する。

合法な`any`、`exact`、`interval`、`unresolved`は非空の適用対象を表す。解決結果が
空集合になる場合は`disjoint`ではなくScope Validationの失敗である。

### 7. 作中時間と語り順を分離する

```text
storyTime
  作品世界内でいつ成立するか

readingOrder
  読者へいつ提示・開示されるか
```

順序比較は整数変換ではなく、Revision付きの全順序Oracleを介する。

```ts
interface ScopeOrderOracle {
  readonly axis: "story-time" | "reading-order";
  readonly revisionToken: string;

  compare(leftRef: string, rightRef: string): -1 | 0 | 1 | "unresolved";
}
```

世界線、Narrative Layer、異なる参照の等値性も、対応するRevision付きRegistryを介する。

### 8. 構造的正規化とOracle依存検証を分離する

Scope Digestは純粋に構造的なCanonical JSONから計算する。次を含める。

- JSONキー順と必須フィールドの明示
- `inclusive`の明示
- `interval`に少なくとも一方の境界が存在すること
- 空文字列参照の拒否
- 軸種別と制約種の整合

次を正規化またはDigestへ含めない。

- `from < until`の順序判定
- 世界線の包含・排他
- Narrative Layerの親子関係
- 異なる参照同士の等値性

これらはRevisionに依存する再構築可能なValidationまたはComparisonである。場面の並べ替えで
以前は有効だった区間が空または逆転し得るため、書き込み時のOrder lintとScope Digestを
同一視しない。

```ts
type ScopeOrderValidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly reason: "reversed-interval" | "empty-interval";
    }
  | { readonly status: "unresolved"; readonly reason: string };
```

### 9. Oracleを使用した結果はRelationにかかわらずBasisを持つ

```ts
interface ScopeComparisonBasis {
  readonly scopeRegistryVersion: string;
  readonly storyTimeOrderRevision?: string;
  readonly readingOrderRevision?: string;
  readonly worldlineRegistryRevision?: string;
  readonly narrativeLayerRegistryRevision?: string;
}

interface ScopeRelationResult {
  readonly relation: ScopeRelation;
  readonly axes: Readonly<Record<ScopeAxis, ScopeRelation>>;
  readonly basis: ScopeComparisonBasis | null;
  readonly oracleUsed: boolean;
  readonly unresolvedReasons: readonly string[];
}
```

OracleまたはRegistryを一度も参照せず、構造的一致だけで確立した結果はBasisなしで
永続できる。OracleまたはRegistryを一度でも参照した結果は、`equal`を含めてBasis必須とする。
BasisなしのOracle依存結果は一時的計算結果としてのみ使用する。

Basisなしで構造的`equal`にできるものは、少なくとも次に限定する。

- `any`同士
- 同じ`exact.ref`
- 同じ時間境界と`inclusive`
- 同じRegistry予約値
- 同じScope Revisionまたは同じ安定`constraintId`

### 10. 軸結果を直積として合成する

1. 一軸でも`disjoint`なら全体は`disjoint`。
2. `disjoint`がなく、一軸でも`unknown`なら全体は`unknown`。
3. 全軸が`equal`なら`equal`。
4. 全軸が`equal`または`contains`で、一軸以上が`contains`なら`contains`。
5. 全軸が`equal`または`contained-by`で、一軸以上が`contained-by`なら`contained-by`。
6. 全軸で交差の非空性が確立され、両方向の全体包含が成立しないなら`overlaps`。
7. それ以外は`unknown`。

`overlaps`は消去法で返さない。交差の非空性が確立した場合だけ返す。

### 11. ConsumerはRelationをTruth Verdictに変換しない

| 利用目的               | 既定方針                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| Disclosure             | 候補ScopeがContextを`equal`または`contains`する場合だけAdmission候補にする   |
| 過去Reviewの自動再利用 | 原則`equal`のみ                                                              |
| 訂正規則の自動適用     | 訂正Scopeが候補Scopeを`equal`または`contains`し、依存Basisも一致する場合だけ |
| 明確な矛盾候補         | 意味内容が排他的で、Relationが`disjoint`でも`unknown`でもない場合            |
| Scope未解決の競合警告  | `unknown`。矛盾と断定しない                                                  |
| Assertion同一性        | Scopeだけでは決定しない                                                      |

Disclosureを最初の接続先にするが、`shadow`比較と差分検証を経てから`wired`へ移す。
Semantic RelevanceはDisclosure Policyを上書きしない。

### 12. 実装状態は契約の一部である

機械可読Policyは次を区別する。

```text
declared
  契約のみ。V2のproduction entry pointはない。

shadow
  本番データを変更せず旧経路と並行評価する。

wired
  本番ConsumerがV2比較結果を正式利用する。
```

`declared`なのにV2 production markerが存在する場合、または`shadow`／`wired`なのに
宣言されたEntry Pointが存在しない場合は品質Validatorを失敗させる。

## Compatibility and adoption

これは保存済みV1データの一括移行ではない。現時点でCanonicalな
`NarrativeScopeV2` rowやruntime writerは存在しない。旧TypeScript契約を読むAdapterが
必要な場合は短期互換層とし、旧`validFromRef`／`validUntilRef`をStory Timeまたは
Reading Orderへ推測で振り分けない。判定できなければ該当軸を`unresolved`にする。

導入順序は次とする。

```text
Policy / Schema / Validator
  → Scope V2 structural validation / digest
  → axis comparator / Order Oracle
  → Disclosure shadow comparison
  → verified cutover
```

## Consequences

### Positive

- 無制約と未解決を区別し、Scope omissionのfail-openを防げる。
- Story TimeとReading Orderの変更を独立に扱える。
- 訂正記憶、矛盾診断、Disclosure、Review再利用が共通Relationを利用できる。
- Oracle依存結果をBasis付きの再構築可能な判定として扱える。

### Costs and risks

- Assertion KindごとのScope Profileと各軸Registryが必要になる。
- 順序や世界線RegistryのRevision変更でComparisonの再計算が必要になる。
- `unknown`を保守的に扱うため、解決前の候補は自動利用できない場合がある。
- V1 DisclosureとのShadow差分を測定せずに切り替えるとAdmission回帰を起こし得る。

## Non-goals

- 作品世界の客観的Truthを決定する。
- 矛盾を自動解決、撤回、統合、分割する。
- Scope RelationだけでAssertion identityを決定する。
- Worldline集合制約やKnowledge Holderの`one-of`をV2へ先取りする。
- 本ADRだけでDB schemaまたはproduction runtimeを変更する。

## Acceptance criteria

- 全軸が明示され、`any`と`unresolved`が非同値である。
- `any`対`unresolved`は`contains`、逆方向は`contained-by`である。
- 同じ未解決理由だけでは`equal`にならない。
- `contains`は厳密包含を過剰主張しない。
- `overlaps`は非空交差を確立した場合だけ返す。
- 一軸でも`disjoint`なら、ほかの軸が`unknown`でも全体は`disjoint`になる。
- Structural DigestへOracle依存情報を混ぜない。
- Oracleを使った`equal`を含む全RelationがBasisを持つ。
- Assertion Scope Profileが軸種別ごとの合法な制約種と解決Gateを表す。
- `declared`／`shadow`／`wired`の状態とproduction entry pointが機械検証される。
