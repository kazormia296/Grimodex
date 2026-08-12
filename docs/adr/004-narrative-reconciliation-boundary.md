# ADR 004: Narrative Reconciliation Boundary

## Status

Accepted — 2026-08-11（Gate B2）  
Amended — 2026-08-11（review: APPROVE WITH REQUIRED AMENDMENTS）

## Context

Gate B Foundation（#507）と Domain Writer Native 化（Gate B2）は、Human UI／AI Apply／
Import／Maintenance の書き込みを同一の Native Aggregate Writer・OCC・Prepared Commit・
Undo・SQL 保護へ揃える。一方で、Phase／Plot Thread／Foreshadow の「成立」、State の
終了、意味的矛盾の撤回といった判断を Deterministic Core の Invariant に置くと、真偽を
維持する厚い TMS（Truth Maintenance System）になる。

禁止したいのは意味判断そのものではない。禁止したいのは、

> **意味判断が Core の決定論的 Invariant になり、Apply 権限を直接獲得すること**

である。Reconciler は意味的 Assessment を生成してよいが、それは非権威的な Proposal で
あり、Domain mutation を直接許可してはならない。

モデルと Reconciler 実装は交換可能であるべきだが、出典・権限・投影・形式整合性・
Commit 履歴は永続資産として残す必要がある。

## Decision

Grimodex は **semantic belief／自動 truth maintenance を持たない**。持つのは次の薄い
増分レイヤーだけである。

### Concern と Authority

| Concern                     | Authority／実行主体         | 永続 Artifact                                              |
| --------------------------- | --------------------------- | ---------------------------------------------------------- |
| Evidence freshness          | Deterministic Core          | Snapshot、source revision、anchor、quote digest、read-set  |
| Semantic assessment         | Reconciler Strategy         | Proposal payload／diagnostic として保存可。ただし非権威的  |
| Apply authority             | Runtime Policy／Decision    | Decision、actor authority、override                        |
| Projection execution        | Prepared Plan／Typed Writer | Application、CommitMap、Journal、Domain Entity             |
| Semantic belief maintenance | Core には置かない           | 自動 truth state／auto-retraction state machine は持たない |

定義：

- **Freshness** — Artifact が参照した source basis と現在の source revision の決定論的な関係
- **Semantic Assessment** — 本文の意味に関する交換可能な Reconciler の判断
- **Authority** — 変更を適用してよいかという権限であり、意味的真偽ではない
- **Projection** — 承認された Proposal を Domain Entity へ反映する処理

**Accepted／Applied は、変更が権限上許可され投影されたことを意味し、その Claim が
客観的に真であることを意味しない。** `Decision` は truth verdict ではなく
**mutation authorization** である。

### 論理台帳と既存概念（TMS Schema は作らない）

論理台帳の分離は概念として採用するが、B2 では `narrative_claims`／`justifications`／
`belief_environments` などの first-class Claim／TMS Schema は導入しない。

| 論理台帳               | 現在の概念                                                     |
| ---------------------- | -------------------------------------------------------------- |
| Evidence Ledger        | Snapshot、Evidence Anchor、Source revision、read-set           |
| Claim（概念）          | Proposal payload 内の semantic assertion。Core Entity ではない |
| Projection Ledger      | Application、CommitMap、Journal、Domain Entity                 |
| Authority              | Runtime Policy、Decision、Prepared Plan、actor context         |
| Reconciliation history | Run、Task、ProposalSet、Revision                               |

#### ClaimEnvelope／source basis 方針

B2 では first-class な Claim Aggregate／Claim Ledger Schema を導入しない。Claim は
Proposal payload 内の概念的 semantic assertion であり、Core Entity ではない。

`claimUid` は後回しでよい。ただし増分 Reconciliation と EvidenceFreshness のため、
各 Proposal Revision は次を **B2 contract から不変にリンク**しなければならない。

- Run／Task identity
- **source basis**（複数入力の revision vector／read-set、単一 `basedOnSourceRevision` ではない）
- **read-set digest**
- **evidence set**（提案を直接支える本文箇所）と **read set**（判断時に読んだ全入力）の分離
- reconciler identity／version
- schema id／version
- changeKind（add／revise／retract／merge／split）と任意の target projection ref

`claimUid` が cross-run identity、部分 retraction、依存検索の FK／一意制約に使われる
段階では、`metadata_json` から typed／indexed storage への昇格を別 ADR で判断する。

Evidence／source-basis 検証は Prepared Plan 作成時だけでは不十分である（TOCTOU）。
**Commit 時に Writer が source revision／digest を CAS または read-set precondition
として再確認**する。

### Native Writer が判断してよいこと（Invariant）

違反を本文解釈なしで証明できるものだけを Rust Typed Writer／Schema／Prepared Plan
validator に置く。未分類の Gate／Validator／Matcher は Writer に入れない。

- Evidence Ref の実在、引用と指定 revision／digest の一致、Commit 時 read-set precondition
- Project scope、ID／FK、enum、件数、サイズ制限
- Relation 両端の同一 Project、Phase の Entry／Anchor 存在
- Setup／Payoff の参照整合、Reading order の形式制約
- 明示 Schema の日付／時刻形式、固定の開始≦終了など
- **明示的に提出され、同一 authority scope／timeline／worldline に属し、`hard` と
  宣言された** Temporal constraint の形式的不整合
- Locked／user-authored **Domain projection または field** の、明示的 human-authorized
  override なしの AI／Reconciler 上書き禁止
- version CAS、全 Operation の atomic success／rollback

Authority は caller が任意に付与する metadata ではない。**Decision／Runtime Policy／
actor context から検証される Commit precondition** である。

### Native Writer が判断しないこと（Strategy）

作品の意味に関する判断は Chunked Reconciler／Prompt／Candidate planner へ置く。
Apply の許可条件にしてはならない。

- 新 State が旧 State を終了させるか
- 記述が旧 Claim を否定しているか
- Phase／Plot Thread／Foreshadow の成立
- 二つの Mention が同一人物か、関係の物語上の意味
- Soft／inferred Temporal constraint の意味的不成立、本文からの Constraint 導出
- 親 Inference が stale なので子を retract すべきか

### Signal／Prefilter

候補生成・ranking に使う決定論処理は残してよいが、Apply 許可条件にはしない
（同一語の再登場、exact name／alias、時刻表現検出、Scene 間共起など）。

混合 Validator は分類だけで済ませず、物理的に分割する。

```text
structural branch → Invariant
semantic branch   → Strategy
ranking branch    → Signal
```

### Provenance／依存伝播

Provenance edge（可能なら `provenanceSources`／`observedFrom`／`generatedFrom` 等の
名称を優先。既存 `derivedFrom` を残す場合も kind と
`propagation: "freshness-only"` で隔離する）は **論理 justification ではない**。

Change Feed／Dependency Index が伝播してよいのは **dirty／needs-reconciliation**
までである。semantic retract、Domain delete、merge、split の自動伝播は禁止する。

Source／Evidence の削除、anchor 不一致、revision 失効は、Domain Entity／Application／
Decision への **FK cascade delete を発生させてはならない**。Evidence は tombstone
または source-missing として保持し、Projection は stale 化する。

### Semantic retraction と Undo の分離

適用済み Proposal Revision／Application は **監査履歴として不変**である。過去
Revision の書き換えや、semantic truth correction としての Undo は禁止する。

```text
Proposal Revision R1 → Decision → Application A1 → Domain mutation
  ↓ 後に「旧解釈を撤回」
新 Proposal Revision R2 → 新 Decision → Compensating Application A2 → Domain 修正
```

- **Undo** — ユーザー操作の取り消し、誤操作回復、直前 Commit の反転
- **Semantic retraction** — 新しい解釈に基づく前向きな補償 Commit

**Reconciler-originated** な semantic add／revise／retract／merge／split は必ず新しい
Proposal または Proposal Revision を生成する。Human UI による通常の Codex／Phase 等の
直接編集は、Runtime Policy 下で Prepared Plan／Typed Writer へ直接入れてよい
（その経路を Proposal 必須にする場合は別途明記する）。

### Stale と読み取り側 Policy

```text
stale ≠ false
stale ≠ retracted
stale = source basis との対応を再検証する必要がある
```

Freshness は semantic truth ではないが、**自動消費 Policy に使用してよい**。
stale／needs-reconciliation な Projection は、Runtime Policy により自動コンテキスト
投入、自動 Apply、自動派生処理から除外または明示的に注記できる。

概念上は少なくとも三軸に分ける。

| 軸                 | 例                                   |
| ------------------ | ------------------------------------ |
| Evidence freshness | fresh／stale／source-missing（Core） |
| Authority          | proposed／accepted／rejected         |
| Projection         | unapplied／applied／compensated      |

`unsupported`／`contradicted` は Core の Freshness に入れず、Reconciler の
Semantic Assessment に留める。

### Execution DAG

chunking、ranking、matcher、prompt 構成、Execution DAG は交換可能 Strategy であり、
永続 Authority ではない。

## Iron Laws

1. **Deterministic Core／Typed Writer は、prose から意味的妥当性を推論または権威的に確定しない**
2. **Reconciler は意味的 Assessment を生成できるが、それは非権威的な Proposal である**
3. **Accepted／Applied は mutation authorization を表し、semantic truth を表さない**
4. **Provenance／Dependency edge は freshness または `needs-reconciliation` だけを伝播でき、semantic retract、Domain delete、merge、split を伝播しない**
5. **Reconciler-originated な semantic add／revise／retract／merge／split は必ず新しい Proposal または Proposal Revision を生成する**
6. **適用済み Proposal Revision／Application は不変であり、semantic retraction は新しい補償 Proposal／Application として行う。Undo を semantic truth correction として使用しない**
7. **Core は明示された構造・参照・形式 Constraint だけを検証する。Apply を拒否できる意味的 Constraint は、同一 scope／timeline／worldline 内で明示的に `hard` とされたものに限る**
8. **Locked／user-authored Domain projection または field は、明示的な human-authorized override なしに Reconciler-originated plan から変更できない。Authority は caller metadata ではなく Decision／Runtime Policy／actor context から検証する**
9. **Reconciler は宣言的な Proposal Draft を返し、SQL、DB Operation、Prepared Plan、Domain Writer command を返さない**
10. **Domain mutation は検証済み Decision、Prepared Plan、OCC（含む source-basis／read-set precondition）、Typed Writer を経由する**
11. **Source／Evidence の失効または削除は Projection を stale にできるが、Domain mutation や cascade delete を発生させない**
12. **Execution DAG、chunking、ranking、matcher、prompt 構成は交換可能 Strategy であり、永続 Authority ではない**

## Gate B2 への適用

- B2 ReStack／Domain Writer cutover は継続する（止めない）
- Writer を `active` にする前に、各 Slice の Gate／Validator／Matcher を
  Invariant／Strategy／Signal へ分類する。**未分類は Writer に入れない**
- 混合 Validator は structural／semantic／ranking へ物理分割する
- Native Writer から意味ヒューリスティックと自動 semantic cascade を除外する
- Proposal Revision contract に source basis／read-set digest／evidence／reconciler
  version を必須化する（`claimUid` は任意）
- Commit 時 source-basis OCC／read-set precondition を Writer に配線する
- #501 Maintenance ReStack 前に薄い `NarrativeReconciler` contract だけを導入する
- `contradicted`／`unsupported` を決定論的 Core が直接確定しない

### Gate B2 追加検証

Gate B2 Contract v8 の正式証跡はcredential-free Engineering Certificationに限定する。
以下のWriter／Authority／OCC／Apply／Undo／Persistence／Consent／Journey contractを
GitHub Actionsで検証し、実provider executionとmodel qualityは保証範囲外として
Report／Decisionの`assuranceScope`へ記録する。Production Chronicle等の実モデル品質は
maintainer-local Live Model Qualificationで別に評価し、Gate B2 PASSやmerge条件へ流用しない。

| Gate                    | 検証内容                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Semantic gate exclusion | 意味的には奇妙でも、構造・参照・Authority が有効な Plan を Writer が受理する               |
| Dirty-only propagation  | source revision 変更で `needs-reconciliation` になるが、Domain Entity は変更・削除されない |
| Immutable history       | 適用済み Projection の撤回が、過去 Revision の変更ではなく新 Application になる            |
| Lock enforcement        | AI 由来 Decision で locked／user-authored field を書き換える Plan が Writer で拒否される   |
| Source-basis OCC        | Proposal 作成後に source revision が変わった場合、古い Prepared Plan の Commit が失敗する  |
| Contract boundary       | Reconciler の公開型が SQL／DB Operation／Typed Writer command へ依存していない             |
| Cascade protection      | Source／Evidence 削除から Domain Entity への FK cascade が存在しない                       |
| Mixed validator split   | Invariant と semantic heuristic が混在する Validator は分類だけで済ませず処理を分割する    |

## Consequences

利点：

- Domain Writer の責務が権限・形式・参照・OCC・atomic に限定され、テスト可能になる
- Chunked pipeline を維持しつつ、将来 FullCorpus Reconciler へ差し替えられる
- B2 中に汎用 Claim Ledger／TMS Schema を増やさないため、Schema 衝突と cutover 範囲が膨らまない
- Maintenance は EvidenceFreshness（Core）と SemanticAssessment（Reconciler 提案）を分離する

意図的に受け入れるトレードオフ（TMS を持たないことによる）：

- Semantic consistency は即時ではなく **eventually reconciled** になる
- stale な Projection や互いに矛盾する Projection が一時的に共存し得る
- UI と Context Assembly は freshness を表示・考慮する必要がある
- Semantic retraction が補償 Commit になるため、履歴と Application 数が増える
- Core が自動修復しないため、Reconciler 失敗時には `needs-reconciliation` が残る
- 汎用 Claim Ledger を持たない間は、細粒度な cross-run claim identity や依存検索に制限がある

## Non-goals（本 ADR）

- Maintenance scheduler／Background AI の製品化
- 全 Extractor の単一汎用 Reconciler への即時統合
- Claim Ledger 正規テーブルの導入（`claimUid` 昇格は別 ADR）
- AI 抽出精度の本評価
- Human UI 直接編集の全面 Proposal 化（必要なら別途明記）
