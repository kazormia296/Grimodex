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

## Amendment — Gate C1.5 terminology and route boundary

Gate C1.5 ratifies the following compatibility mapping without changing the
existing ADR 004 Decision:

- ADR 005 `Narrative Assertion` extends the ADR 004 conceptual Claim and
  Proposal vocabulary; it is not a new TMS table.
- `Prepared Plan` is the planning-stage name used by ADR 004. `Prepared
  Commit` is the commit-stage name used by ADR 005 for the same authority
  boundary.
- `needs-reconciliation` is the only Reconciliation propagation signal.
  Freshness, Build Action, and Component Compatibility are separate axes.
- Human Direct Authoring does not require a Proposal. It follows Runtime
  Policy, Actor Context, OCC, Field Authority, and Typed Writer.
- Interactive Agent Command is an authoring route governed by ADR 006. An
  explicit user command or standing `knowledgeWrite` authority may use it,
  but it still requires stable request identity, provenance, OCC, Undo Journal,
  Change Event, and Change Feed.
- Semantic Interpretation remains Proposal-bound and must use Decision and
  Prepared Commit before a Typed Writer.

The distinction is intentionally about mutation authority, not semantic truth:
`accepted` and `applied` remain authorization/projection states, while
`freshness` remains deterministic source-basis state. Semantic retraction is
still a forward compensating Application, never an Undo or an automatic
Dependency propagation.

## 追補（2026-11-23）：出来事の削除に連動する承認の撤回、作品の削除、AI・MCP による作者の出来事の更新・削除

本 ADR の本文と、上の Amendment は書き換えない。次の 2 本の起案が確認されたので、本文の文に対する例外と読みを、ここに記す。規則の正本は各起案である。この追補は、本文のどの文がどう読み替わるかを示すだけで、規則を足さない。実装の順番と公開の条件は、各起案による。

- 起案：SRD/1（[nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md](../plans/nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md)。draftRef `nir1-chronicle-scene-review-apply-delta/1`、下書きの SHA-256 `bb7bfbb90ca9dece6e409fc70c73ae7a378742f31b129da371419230b5518c4b`）と、AWA/1（[nir1-agent-event-write-approval-proposal-1-draft.md](../plans/nir1-agent-event-write-approval-proposal-1-draft.md)。draftRef `nir1-agent-event-write-approval-proposal/1`、下書きの SHA-256 `1dd0fdf64700393b0b8d6a9e5c7034f14edddf7be9dcf6dc87a4f8b31a650d0e`）。
- 確認の記録：`claude/nir1-contracts` の commit `2778cf5abbbc25114b40c9ce8e1233543515ddc8` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`。SRD/1-1（`#chronicle-event-existence-sync`）は確認 138、SRD/1-2（`#chronicle-applied-proposal-redecide`）は確認 139、SRD/1-3（`#chronicle-project-delete-with-applications`）は確認 140、AWA/1-1（`#agent-event-write-approval`）は確認 141、AWA/1-2（`#mcp-author-event-write`）は確認 142。確認 138 は、設計の記録（ADR 004・005・006、Gate B2）に例外・追補を足す文の置き場を、起案者の読みとして挙げている。どの文に足すかは、起案者の読みである。
- 確認 138〜142 は、それぞれの行だけに掛かる（ほかの行の確認にはならない）。この追補は、行ごとに、どの確認の範囲かを示す。

### 1. 出来事の削除に連動する承認の撤回（SRD/1 の X。SRD/1-1。確認 138）

本文の次の文に、例外を足す。

- 「Change Feed／Dependency Index が伝播してよいのは dirty／needs-reconciliation までである。semantic retract、Domain delete、merge、split の自動伝播は禁止する。」（「Provenance／依存伝播」の節）と、Iron Law 4。
- 末尾の Amendment の「Semantic retraction is still a forward compensating Application, never an Undo or an automatic Dependency propagation.」。

**例外。** 年表の出来事（Domain）が無くなったとき、本体（Domain Writer）が、同じ transaction の中で、その出来事を取り込んだ提案の承認を外す（却下の決定を 1 件追記する）。補償 Application は作らない。Dependency Index と Change Feed が行うのではなく、Domain Writer が行う。効果は、禁じる向きと同じ（Domain の削除が、承認の撤回に伝わる）ので、「読み」でなく、例外として明記する。

- 出来事を消す入口は、画面の削除・まとめ削除、元に戻す・やり直す、スナップショットの復元、取り込みの取り消しである。AI・MCP は、今は取り込んだ出来事を消せない見込みで、消せるようになっても、同じ規則が働く。
- 承認を外す記録が書けなければ、その操作を失敗させる。元に戻す・やり直すが失敗しても、履歴は保つ。
- Application・版・過去の決定は書き換えない。決定を追記するだけである。出来事が戻っても、承認は自動では戻らない（作者が承認し直す。SRD/1 の RA）。
- 外すのは、解釈の真偽ではなく、出来事が無い解釈を関連に使う許可である（Iron Law 3 と、本文の「`accepted` and `applied` remain authorization/projection states」と同じ向き）。この読みは起案者のものである。
- これは、作者・AI・MCP が呼べる撤回の入口ではなく、出来事の削除に連動して本体が書く内部の却下である。作者が呼べる却下の入口は作らない。
- 変えない：Iron Law 8（X の actor は `ai` で、override を付けられない）。「Undo を semantic truth correction として使用しない」（X は決定を書くだけで、Undo の部分の例外は要らない）。ADR 011 の Existing-Projection revision（X は retract を製品に繋がない）。

### 2. 作品の削除（SRD/1 の Z。SRD/1-3。確認 140）

本文の「適用済み Proposal Revision／Application は **監査履歴として不変**である」（「Semantic retraction と Undo の分離」の節。Iron Law 6 の前半）に、**作品の削除（「プロジェクトを削除」）に限る例外**を足す。取り込みの記録がある作品も削除でき、取り込みの記録（Application・版・決定）も作品ごと消え、戻せない。

- 例外は、個別の記録の削除、場面や根拠の削除に連動する削除、取り込みの取り消しに連動する削除には広げない。
- Source／Evidence の失効・削除から Domain への cascade delete を禁じる文（Iron Law 11 と、「Provenance／依存伝播」の節）は、変えない。作品の削除は、Source／Evidence の削除に連動しない。
- 削除の後も残るもの：AI の監査の記録（ハッシュ鎖を壊さないため）、送信の鍵の表、古いバックアップ。削除の記録は作らない。残る AI の監査の記録に、削除した作品の年表・取り込みの何が入りうるかは、実データで未確認である（実装の前の検査で確かめる）。
- 削除の所要時間、検索の cache の削除、実行中の検索・保守・別プロセスの MCP との競合は、未確認（実装の前に確かめる）。

### 3. Gate B2 への適用

「Gate B2 への適用」と「Gate B2 追加検証」は、次のように読む。

- B2-X04（「Provenance/Dependency は needs-reconciliation のみ伝播し、Domain delete/retract を伝播しない」）と、「Dirty-only propagation」「Immutable history」の gate、`004-narrative-reconciliation-boundary-checklist.md` の横断 Gate の対応する行は、上の 1・2 の例外を除いて読む。`gateB2Negatives.test.ts` は Reconciler の出力だけを検査するので、試験は落ちない。契約の文言には当たるので、この追補で例外として明記する。
- B2-X05 と「Cascade protection」（Source／Evidence の削除から Domain への FK cascade が存在しない）は、変えない。B2-X05 の証跡には、新しい試験を足す（既にある試験は改造しない。SRD/1-3 の実装の PR）。
- policy の JSON と試験（`gate-b2-adr-checklist.json`、`schema_contract.rs` の `immutable_history_contract_contains_retraction_guards` など）は、この追補では変えない。

### 4. 承認し直しの入口（SRD/1 の RA。SRD/1-2。確認 139）

NIR0-CERT の「the typed C2B Human writer is the only V2 review route」との間に、緊張が 1 つある。承認し直し（RA）は、人の review の入口を、もう 1 つ足す（型付きで、3 つの id だけを受け、内容は本体が組み立てる）。BAO/1 が既に足した入口と、同じ種類である。RA は、撤回の入口ではなく、承認し直す入口である。

### 5. AI・MCP が作者の出来事を更新・削除する（AWA/1。AWA/1-1 は確認 141、AWA/1-2 は確認 142）

本文の「Locked／user-authored **Domain projection または field** の、明示的 human-authorized override なしの AI／Reconciler 上書き禁止」（境界の節）と、Iron Law 8 の前半に、次を足す。Iron Law 8 の対象は、Reconciler 由来の plan のままで、その文は変えない。「Lock enforcement」の gate も、変えない。

- **アプリ内の AI（AWA/1-1）。** Interactive Agent Command の経路にも、この override の文を使う。作者の出来事に触れる更新・削除を、チャットのカードで 1 回ずつ承認することが、「明示的な human-authorized override」に当たる。AI が自分で作った出来事の更新は、承認なしである。
- **MCP（AWA/1-2）。** MCP の免除は、「AI／Reconciler の上書き禁止」の字義に反する（MCP の外部の AI は「AI」である）。そこで、この文に、ユーザーの選択による**例外**を書き足す。MCP は、設定で許した、1 つの作品に固定した接続だけ、作者の出来事を承認なしで更新・削除できる（全部の作品を扱える接続は、今までどおり拒む）。開示の場面を、承認なしで置いたり変えたりできる（秘密の印そのものは変えられない）。MCP が書いた項目の持ち主は、作者のままで、変更の記録に MCP の印を残す。
- Iron Law 8 の後半「Authority は caller metadata ではなく Decision／Runtime Policy／actor context から検証する」とは、免除の根拠を payload の `surface` の文字列にせず、型で渡す引数にして合わせる。ただし、根拠は、その引数を作る側のコード（MCP の `GrimodexServer`）で、Decision や actor context ではない。接続の固定の判定は MCP 側の 1 か所だけが持ち、Native は検証しない（残るリスク。AWA/1 の M2・§3）。
- 順番：文書の追補と policy の JSON の変更が、Native の PR より先である。MCP の削除は、SRD/1 の X（上の 1）が入ってから開ける（間に合わなければ、閉じたまま公開する。確認 74・77）。
