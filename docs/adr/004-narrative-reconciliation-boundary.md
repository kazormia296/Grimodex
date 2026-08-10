# ADR 004: Narrative Reconciliation Boundary

## Status

Accepted — 2026-08-11（Gate B2）

## Context

Gate B Foundation（#507）と Domain Writer Native 化（Gate B2）は、Human UI／AI Apply／
Import／Maintenance の書き込みを同一の Native Aggregate Writer・OCC・Prepared Commit・
Undo・SQL 保護へ揃える。一方で、Phase／Plot Thread／Foreshadow の「成立」、State の
終了、意味的矛盾の撤回といった判断を Core の決定論規則に置くと、真偽を維持する厚い
TMS（Truth Maintenance System）になる。

モデルと Reconciler 実装は交換可能であるべきだが、出典・権限・投影・形式整合性は
永続資産として残す必要がある。

## Decision

Grimodex は **真偽を維持する TMS を持たない**。持つのは次の薄い増分レイヤーだけである。

| 層 | 責務 | 残す |
| --- | --- | --- |
| Evidence／出典 | 本文 revision、quote、anchor、digest、read-set | はい |
| Authority／投影 | Proposal、Revision、Decision、OCC、Apply、Undo | はい |
| Semantic truth maintenance | 旧 Claim が誤りか、Phase が終了したか、伏線が成立したか | いいえ |

論理台帳の分離（Evidence／Claim／Projection）は概念として採用するが、B2 では
`narrative_claims`／`justifications`／`belief_environments` などの新規 TMS 風 Schema
は導入しない。既存概念へ寄せる。

| 論理台帳 | 現在の概念 |
| --- | --- |
| Evidence Ledger | Snapshot、Evidence Anchor、Source revision |
| Claim Ledger | Proposal、Proposal Revision、Decision |
| Projection Ledger | Application、CommitMap、Journal、Domain Entity |
| Authority | Runtime Policy、Decision、Prepared Commit |
| Reconciliation history | Run、Task、ProposalSet、Revision |

必要になった時点で、Proposal Revision の payload／`metadata_json` に薄い
`ClaimEnvelope`（claimUid／schema／reconcilerId／basedOnSourceRevision 等）を足せばよい。

### Native Writer が判断してよいこと（Invariant）

違反を本文解釈なしで証明できるものだけを Rust Typed Writer／Schema／Prepared Plan
validator に置く。

- Evidence Ref の実在、引用と指定 revision の一致
- Project scope、ID／FK、enum、件数、サイズ制限
- Relation 両端の同一 Project、Phase の Entry／Anchor 存在
- Setup／Payoff の参照整合、Reading order の形式制約
- Temporal constraint の数理的可解性、Calendar 上の日付妥当性
- Locked／User-owned field の AI 上書き禁止
- version CAS、全 Operation の atomic success／rollback

### Native Writer が判断しないこと（Strategy）

作品の意味に関する判断は Chunked Reconciler／Prompt／Candidate planner へ置く。
Apply の許可条件にしてはならない。

- 新 State が旧 State を終了させるか
- 記述が旧 Claim を否定しているか
- Phase／Plot Thread／Foreshadow の成立
- 二つの Mention が同一人物か、関係の物語上の意味
- 親 Inference が stale なので子 Claim を retract すべきか

### Signal／Prefilter

候補生成・ranking に使う決定論処理は残してよいが、Apply 許可条件にはしない
（同一語の再登場、exact name／alias、時刻表現検出、Scene 間共起など）。

### 依存伝播

Change Feed／Dependency Index が伝播してよいのは **dirty／再評価候補
（needs-reconciliation）** までである。truth・retract・Domain delete の自動伝播は禁止する。

Semantic revision／retraction は必ず Proposal Revision／Decision を経由する。
Reconciler は DB Operation を直接返さない。Domain mutation は Prepared Plan／
Decision／Typed Writer 経由のみとする。

Execution DAG は永続 Authority ではなく、交換可能な Strategy である。

## Iron Laws

1. Grimodex は prose から Claim の真偽を決定しない
2. `derivedFrom` edge は Provenance であり論理 justification ではない
3. Dependency graph は dirty state を伝播できるが retraction を伝播しない
4. Semantic revision／retraction は必ず Proposal を生成する
5. Domain Compiler は構造・参照・形式制約だけを検証する
6. Temporal arithmetic 等の形式的矛盾は Core で検証できる
7. Locked／user-authored Claim は Reconciler が直接変更できない
8. Reconciler は DB Operation を返さない
9. Domain mutation は Prepared Plan／Decision／Writer 経由のみ
10. Execution DAG は永続 Authority ではなく交換可能 Strategy である

## Gate B2 への適用

- B2 ReStack／Domain Writer cutover は継続する（止めない）
- Writer を `active` にする前に、各 Slice の Gate／Validator／Matcher を
  Invariant／Strategy／Signal へ分類する
- Native Writer から意味ヒューリスティックと自動 semantic cascade を除外する
- #501 Maintenance ReStack 前に薄い `NarrativeReconciler` contract だけを導入する
- `contradicted`／`unsupported` を決定論的 Core が直接確定しない

## Consequences

- Domain Writer の責務が権限・形式・参照・OCC・atomic に限定され、テスト可能になる
- Chunked pipeline を維持しつつ、将来 FullCorpus Reconciler へ差し替えられる
- B2 中に汎用 Claim Ledger／TMS Schema を増やさないため、Schema 衝突と cutover 範囲が膨らまない
- Maintenance は EvidenceFreshness（Core）と SemanticAssessment（Reconciler 提案）を分離する

## Non-goals（本 ADR）

- Maintenance scheduler／Background AI の製品化
- 全 Extractor の単一汎用 Reconciler への即時統合
- Claim Ledger 正規テーブルの導入
- AI 抽出精度の本評価
