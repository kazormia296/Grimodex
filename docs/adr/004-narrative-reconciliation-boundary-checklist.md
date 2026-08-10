# Gate B2 — Invariant / Strategy / Signal 分類チェックリスト

ADR 004 の運用メモ。各 Aggregate を `active` にする PR レビューで埋める。

## 使い方

対象 Slice の Gate／Validator／Matcher／Compiler を列挙し、次のいずれかへ振り分ける。
Strategy が Native Writer／Prepared Plan validator に残っていたら merge しない。

| 分類 | 配置先 | Apply 許可条件にしてよいか |
| --- | --- | --- |
| Invariant | Rust Typed Writer／Schema／Prepared Plan validator | はい |
| Strategy | Reconciler／Prompt／Candidate planner／Ranking | いいえ |
| Signal／Prefilter | Signal index／cheap prepass | いいえ（候補生成のみ） |

## Slice テンプレート

### Chronicle

- [ ] Invariant: Project 所属、Scene／participant 存在、時刻形式、version CAS、atomic child
- [ ] Strategy: 同一 Event か、嘘／回想／誤認、意味的重要度
- [ ] Signal: （任意）時刻表現検出、共起

### Codex Entity／Relation

- [ ] Invariant: exact ID／alias 参照の存在、両端同一 Project、directionality enum、semantic key 一意、OCC
- [ ] Strategy: Mention 同一性、物語上の関係意味、Alias vs 別 Entity
- [ ] Signal: exact-name／alias 候補

### Phase／Detail

- [ ] Invariant: Entry／Anchor 参照、開始・終了順序の形式、Detail 型一致、OCC
- [ ] Strategy: major／moderate transition 件数、持続 Scene 数、State 変化回数による成立
- [ ] Signal: transition 語検出など（候補のみ）

### Temporal

- [ ] Invariant: constraint 集合の数理的可解性、Calendar 日付妥当性、version／calendar OCC
- [ ] Strategy: 「翌日」の付着先、「春」＝4月、夢／現実の区別
- [ ] Signal: 時刻表現の検出

### Plot Thread

- [ ] Invariant: Thread／Marker／Branch Schema、Scene 参照、Graph／semantic key、atomic update
- [ ] Strategy: 二 Scene なら Thread、Goal 再出、完了判定、分類の物語判断
- [ ] Signal: Goal／Conflict／Question 形の検出

### Foreshadow

- [ ] Invariant: Setup／Payoff Evidence 参照、多対多 link、Project／Scene、Reading order、Root CAS、Atomic Undo
- [ ] Strategy: 機能的接続、object-use vs Q&A、misdirection 解消、resolved 判定
- [ ] Signal: 同一語再登場、物品共起

### Import／Maintenance（#501 前）

- [ ] Invariant: Capture vs Apply の Runtime guard、sealed plan、参照整合
- [ ] Core が決めてよい: EvidenceFreshness のみ
- [ ] Reconciler 提案: SemanticAssessment（unchanged／revision／retraction／conflict）
- [ ] 禁止: 親 stale → 子 retract／Proposal 削除／Domain 自動削除
- [ ] Change Feed は `needs-reconciliation` まで
