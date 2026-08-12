# Gate B2 — Invariant / Strategy / Signal 分類チェックリスト

ADR 004 の運用メモ。各 Aggregate を `active` にする PR レビューで埋める。

## 使い方

対象 Slice の Gate／Validator／Matcher／Compiler を列挙し、次のいずれかへ振り分ける。

**デフォルト: 未分類は Writer／Prepared Plan validator に入れない。**
Strategy が Native Writer に残っていたら merge しない。
混合 Validator は分類だけで済ませず、structural／semantic／ranking へ物理分割する。

| 分類 | 配置先 | Apply 許可条件にしてよいか |
| --- | --- | --- |
| Invariant | Rust Typed Writer／Schema／Prepared Plan validator | はい |
| Strategy | Reconciler／Prompt／Candidate planner | いいえ（Proposal Draft のみ） |
| Signal／Prefilter | Signal index／cheap prepass／Ranking | いいえ（候補生成のみ） |

## 横断 Gate（全 Slice）

- [ ] Proposal Revision に source basis（read-set／digest）、evidence set、reconciler id／version、schema version がある
- [ ] Commit 時に source-basis／read-set precondition（TOCTOU 防止）がある
- [ ] Reconciler-originated retract は補償 Proposal／Application（過去 Revision 不変、Undo ではない）
- [ ] Provenance／Dependency は `needs-reconciliation` のみ伝播（Domain delete／retract なし）
- [ ] Source／Evidence 削除 → Domain への FK cascade がない
- [ ] Locked／user-authored **projection／field** の override は Decision／actor context 由来（caller metadata 不可）
- [ ] stale／needs-reconciliation な Projection の自動コンテキスト投入・自動 Apply 抑止または注記
- [x] Reconciler 公開型が SQL／DB Operation／Writer command に依存しない

## Slice テンプレート

### Chronicle

- [ ] Invariant: Project 所属、Scene／participant 存在、時刻**形式**、version CAS、atomic child、read-set OCC
- [ ] Strategy: 同一 Event か、嘘／回想／誤認、意味的重要度
- [ ] Signal: （任意）時刻表現検出、共起

### Codex Entity／Relation

- [ ] Invariant: exact ID／alias 参照の存在、両端同一 Project、directionality enum、semantic key 一意、OCC
- [ ] Strategy: Mention 同一性、物語上の関係意味、Alias vs 別 Entity
- [ ] Signal: exact-name／alias 候補

### Phase／Detail

- [ ] Invariant: Entry／Anchor 参照、開始・終了順序の**形式**、Detail 型一致、OCC
- [ ] Strategy: major／moderate transition 件数、持続 Scene 数、State 変化回数による成立
- [ ] Signal: transition 語検出など（候補のみ）

### Temporal

- [ ] Invariant: 明示 Schema の日付／時刻形式、開始≦終了など固定規則；**同一 scope／timeline／worldline の `hard` constraint** の形式的不整合のみ Apply 拒否
- [ ] Strategy: Constraint の本文導出、「翌日」の付着先、「春」＝4月、夢／現実／回想、Soft／inferred 矛盾
- [ ] Signal: 時刻表現の検出

### Plot Thread

- [ ] Invariant: Thread／Marker／Branch Schema、Scene 参照、Graph／semantic key、atomic update
- [ ] Strategy: 二 Scene なら Thread、Goal 再出、完了判定、分類の物語判断
- [ ] Signal: Goal／Conflict／Question 形の検出

### Foreshadow

- [ ] Invariant: Setup／Payoff Evidence 参照、多対多 link、Project／Scene、Reading order、Root CAS、Atomic Undo（操作取り消し）
- [ ] Strategy: 機能的接続、object-use vs Q&A、misdirection 解消、resolved 判定、semantic retract（補償 Commit）
- [ ] Signal: 同一語再登場、物品共起

### Import／Maintenance（#501 前）

- [x] Invariant: Capture vs Apply の Runtime guard、sealed plan、参照整合、source-basis OCC
- [x] Core: EvidenceFreshness のみ（fresh／stale／source-missing 等）
- [x] Reconciler: SemanticAssessment（unchanged／revision／retraction／conflict）— 非権威的
- [x] 禁止: 親 stale → 子 retract／Proposal 削除／Domain 自動削除／Evidence→Domain cascade（contract: propagation は `needs-reconciliation` のみ）
- [x] Change Feed は `needs-reconciliation` まで（contract-level）
- [ ] stale Projection の自動コンテキスト投入抑止
