# ADR 007: Agent共同作業の実行・Task・投機的Workspace境界

## Status

Accepted — 2026-08-18

本ADRは、Grimodexにおける長時間Agent作業の権限、寿命、一貫性、承認、
レビュー境界を確定する。対象はBackground Agent、SessionTasks、将来の
Delta型Speculative Workspace、およびCanonical適用後のSemantic Verificationである。

本ADR自体はDBテーブル、IPC command、UIを追加しない。可変な実装順序と投資Gateは
[`docs/plans/agent-collaboration-roadmap.md`](../plans/agent-collaboration-roadmap.md)
が正本となる。

本ADRは、以下のCanonical DBおよびmutation境界に従属する。

- [ADR 003: DB Authority and Schema Contract](003-db-authority-and-schema-contract.md)
- [ADR 005: Narrative Semantic Core Boundary](005-narrative-semantic-core-boundary.md)
- [ADR 006: Narrative Mutation Origin and Authority Routes](006-narrative-mutation-authority-routes.md)

## Context

現行Chat実装では、長時間Turnの寿命と、現在表示中のChat projectionの寿命が
ほぼ一体化している。Scene scopeの切替はactive generationを停止し得るほか、
ユーザーへの質問はrenderer memoryに置かれ、transport cleanupはtransport cancelも
兼ねている。この構造では、作者が別Sceneや別Sessionへ移動している間も数十分動く
Agentを安全に扱えない。

また、会話履歴は複数段階の作業状態を保持する正本として不適切である。履歴は要約・
圧縮され得るほか、モデル依存であり、child Agentから参照できない場合もある。目的、
Task状態、受け入れ条件、承認、EvidenceはTranscriptと独立して永続化する必要がある。

Delta / DeltaDBは有用な参照モデルを提供する。すなわち、人間の作業、Agentの作業、
会話、細粒度Operationを、Canonical commit間に存在する追跡可能な作業streamとして
扱う考え方である。Grimodexはこの作業モデルを採用するが、Canonical SQLite、
mutation authority route、OCC、Prepared Commit、Undo Journal、Change Feedは
置き換えない。

## Decision

### 1. Canonical SQLiteを唯一の作品状態authorityとして維持する

GrimodexはDeltaDBをCanonical DBとして採用せず、現時点のDeltaDB実装へ直接依存しない。

将来のSpeculative Workspaceは、Canonical SQLiteの上に置く隔離・レビュー層とする。

```text
Task / AgentRun
  → Speculative Workspace
  → Operation Group review
  → Prepared ChangeSet / Prepared Commit
  → OCC / Field Authority / Typed Writer
  → Canonical SQLite
  → Undo Journal / Change Feed
```

未承認のWorkspace OperationはCanonical mutationではなく、Canonical Change Feedへ
記録しない。全文CRDT共同編集は、実際の複数人共同編集またはoffline multi-device要件が
発生するまで明示的にDeferredとする。

### 2. WorkTask、AgentRun、Workspace、Evidenceを別authorityとして扱う

以下は同一の状態機械へ統合しない。

- **WorkTask** — 永続的な目的、状態、executor、受け入れ条件、完了policy。
- **AgentRun** — 一つのモデルまたは外部Agent runtimeによる一回の実行試行。
- **AgentRunInteraction** — 現在表示中のChat projectionより長く存続し得る質問、
  承認要求、permission要求。
- **AgentWorkspace** — 固定されたresource basisに基づく未承認mutation案。
- **AI Audit execution** — provider / transport request・responseの実行Evidence。
- **Canonical Change Feed transaction** — 実際にcommitされた変更。
- **Semantic Verification report** — 固定された変更Barrierに対して検証が観測した結果。

AgentRunの成功はWorkTask完了を意味しない。Workspace mergeもsemantic verification完了を
意味しない。製品上は以下を区別する。

```text
Generated → Reviewed → Applied → Verified → Done
```

### 3. Execution authorityとUI projection authorityを分離する

Scene移動、Session選択、panel非表示、layout変更は表示projectionを変更するが、
実行cancel権限ではない。

transport開始後のRunは、起点Sessionが表示されていなくても継続できる。結果はcaptureした
対象Sessionへ保存し、未読として表示する。inactive Sessionのdeltaを現在表示中Sessionへ
混入させてはならない。

cancel理由として残すものは以下である。

- ユーザーの明示的Stop。
- WorkspaceまたはProject authorityの喪失。
- AI policyまたはlicenseのrevocation。
- provider / transport failure。
- continuationを復元できないapplication shutdownまたはrenderer loss。
- typed safety / permission境界。

`detach`、`unsubscribe`、`cancel`は別操作とする。UI subscriberはprovider実行をabortせずに
離脱できる。

### 4. Runtime ownershipを層別化する

最初のReleaseでは、以下の責務分離を採用する。

- Native-owned SQLiteは、durable Run／Interaction状態、OCC version、idempotency、
  recovery dataを保持する。
- Electron mainは、CLI／Codex App Server process、cancel、timeout policy、trusted process
  eventを所有する。
- renderer application serviceは、当面、既存Agent tool loopとcontext組立てを所有してよい。
- React componentはprojectionとuser interactionだけを所有する。

Scene／Session移動でlive continuationを破棄してはならない。一方、renderer reloadやcrashでは
任意のJavaScript Promise／closureを復元できない。v1は孤児Runを`interrupted`へ遷移させ、
透明なresumeを装わずretryを提供する。provider threadまたはserialized continuation契約を
後から導入しても、このauthority境界は変えない。

### 5. Pending user interactionをdurable stateとする

`waiting_user`、`waiting_approval`、permission要求は第一級のAgentRunInteractionとする。
request payload、対象Session、status、OCC versionを永続化する。

同一renderer process内では、作者が起点Sessionへ戻って回答した後、live resolverが同じRunを
継続してよい。renderer loss後はdurable interactionをEvidenceとして保持するが、明示的な
continuation契約がない限り元Runのcontinuationをliveとはみなさない。

### 6. SessionTasksは自動計画し、重大なauthority変更だけ承認する

明示的なユーザー依頼を満たすための内部Session planについて、すべてのstepで確認を要求しない。
Agentは以下を自動実行できる。

- 依頼達成に必要なSessionTaskの作成。
- progress stateの更新。
- Evidenceの追加。
- read-onlyな内部subtaskの追加。
- blocked、waiting、reviewへの遷移。

以下はmaterial plan amendmentであり、明示的承認または既存grantを必要とする。

- 依頼scopeの拡張。
- read-onlyからmutation capabilityへの昇格。
- required acceptance conditionの削除・緩和。
- 内部Session作業のProject Taskへの昇格。
- 外部access、budget、delegationのgrant範囲超過。

Canonical authoring変更はDB row単位ではなく、意味のあるOperation GroupまたはChangeSet単位で
reviewする。destructive、external、publish、credential、広範なstructure effectは常に
明示的な人間承認を必要とする。reviewer modelは`allow`、`ask_user`、`deny`を提案できるが、
Project policyの拡張、新規capability取得、必須の人間承認の代替はできない。

### 7. Task種別ごとに一貫性policyを分ける

常に最新状態へ追随する単一policyは、作者が執筆中の場合にlivelockを生む。以下の一貫性modelを
採用する。

| Work kind | Consistency basis | 実行中のCanonical変更 |
| --- | --- | --- |
| Read-only analysis | capture-on-first-readによるper-source repeatable basis | 継続し、完了時にread setとdeltaの交差を評価 |
| Proposed rewrite | Workspaceのbase revision / digestを固定 | stageは継続し、merge時にrevalidateまたはconflict |
| Canonical mutation | fresh OCC / digest precondition | stale writeを拒否し、rebase / reviewを要求 |
| Semantic Verification | ChangeSet digestとcanonical-sequence Barrierを固定 | Barrierは完走し、current headへの適用可能性を別判定 |
| 明示的live monitor | follow-latest＋debounce／hysteresis | ユーザーが選択した場合だけrefresh |

#### Capture-on-first-read

read-only v1分析は、Project全体の同一時点snapshotを保証しない。各Sourceの最初のreadで、
immutable content、そのSourceのrevision、digest、該当する場合はsemantic epoch、観測時点の
Change Feed high-water markをcaptureする。同じRunでの後続readはcapture済みSourceを再利用する。

Source間でtorn snapshotになり得るため、成果物は「Project全体のsequence N時点」と主張せず、
per-source basisを開示する。完了時に各capture後の変更とRun read setを比較する。交差があれば
完了済み分析を破棄せず、delta recheckまたはfollow-up Taskを生成できる。

### 8. Speculative workはCanonical Semantic IRをStaleにしない

Workspace proposalはCanonical Sourceではない。将来advisory semantic previewを実行してもよいが、
Canonical Narrative IRまたはConsumer FreshnessをStaleにしてはならない。

Canonical mutationだけがChange Feed eventを発生させ、authoritative Semantic maintenanceを
駆動する。

### 9. 初期Semantic Verificationは決定的かつcoverage-boundedとする

Canonical適用後のSemantic Verificationは、特定のapplied ChangeSet、canonical sequence、
semantic epoch、snapshot digestへ固定する。Agentはprovider connectionを保持したまま待たず、
durable dependencyとして待機する。

初期の完了gateに含めてよいのは、実装・評価済みの能力だけである。

- 直接変更Sourceの再抽出。
- 既知dependency closureのFreshness評価。
- exact canonical fact conflict、temporal constraint、Source missing、削除参照、
  既知thread integrityなどの決定的check。

新規の暗黙dependency discovery、たとえば微細な伏線、motif解釈、modelによるProject-wide
semantic reviewは、precision／recallの計測によって完了gateへの昇格が正当化されるまで
experimental advisory laneとする。「Findingなし」と「十分なcoverage」は同義ではない。
Verification reportは、check済み、未実行、inconclusive、supersededを明示する。

### 10. UIはGlobal Task ManagerよりSession-local statusから始める

最初のBackground Agent Releaseでは、起点作業へ戻るために必要な状態だけを表示する。

- Session cardのrunning／waiting／unread／failure indicator。
- Chat scope selector横のcompact indicator。
- 起点Sessionを開いたときのpending interaction再表示。

Global WorkBeacon、Project task tree、progress percentage、Kanban、deadline、Project Focus UIは
Background Agentの前提にしない。dogfoodingで必要性が確認された後の投資判断とする。

## Invariants

1. Canonical SQLiteだけが承認済みmanuscriptおよびdomain stateのauthorityである。
2. 未承認Workspace OperationはCanonical Change Feedへ入らない。
3. WorkTask、AgentRun、AgentRunInteraction、Workspace、AI Audit、Change Feed、
   Semantic Verificationは独立して照会可能である。
4. navigationはprojection attachmentを変えるがexecution authorityを変えない。
5. inactive Sessionのdeltaはvisible message projectionを変更できない。
6. Runのcapture済みProject／Session target以外へ結果を保存できない。
7. Stopとprovider terminalのraceはterminal outcomeを一つだけ生成し、messageを二重保存しない。
8. pending interactionはOCCで保護され、一度だけresolveできる。
9. renderer lossを成功として扱わない。
10. read-only analysisはmoving manuscriptへ追随して無限restartせず、snapshot-based成果を保持する。
11. stale Workspace baseは新しいauthor editを上書きできない。
12. Agentは自分のrequired criterionまたはverification profileを弱められない。
13. Semantic interpretationとmodel reviewは、ADR 005／006に従うproposal-producingかつ
    non-authoritativeな活動である。
14. child Agentはparent grantに存在しないcapabilityを取得できない。
15. 製品表示はapplied、verified、complete、currentを区別する。

## Consequences

Background AgentはSessionTasks、Workspace、Semantic CIから独立して提供できる。狭く検証可能な
価値は、長時間作業が通常navigationを越えて継続し、正しいSessionへ戻ることである。

SessionTasksは、永続planと回復性の問題が実運用で観測された後に、製品上の回答として評価する。
WorkspaceとSemantic contractは、先行Releaseで実際のreview／provenance要件が判明してから固定する。

capture-on-first-readは、全分析RunでProject snapshotを作る方式より安価だが、成果へ正直な
per-source basis metadataを付与する必要がある。真のProject snapshotは将来のoptional consistency
modeとして残す。

本構造はdurable stateとrecovery義務を増やす。各状態機械はfail-closed transition、OCC、
idempotency、race test、startup reconciliationを必要とする。

## Rejected alternatives

- **SQLiteをDeltaDBで置換する。** 安定したGrimodex embedding契約がない段階でpersistence、
  recovery、mutation authorityを分散させる。
- **今すぐ全文書をCRDT化する。** 現在の主要caseは一人の作者＋Agentであり、isolated Workspace、
  OCC、reviewで必要な安全性をより低い複雑性で満たせる。
- **Task状態を会話履歴へ置く。** 履歴圧縮とモデル変更によりwork authorityとして不安定である。
- **Scene navigationをcancelとみなす。** 長時間作業を妨げ、UI attachmentとexecution authorityを
  混同する。
- **常に最新manuscriptへ追随する。** 執筆中に広範な分析が繰り返しStaleとなり完了できない。
- **Source変更ごとにread-only analysisを最初から再実行する。** 有用な完了済み作業を破棄し、
  livelockを生む。
- **未計測semantic discoveryで完了をgateする。** 低precision／recallの伏線・motif検出が
  blocking noiseになる。
- **別モデルにすべての変更承認を委ねる。** reviewer出力は確率的であり、typed capability、
  OCC、mutation route、必須の人間判断を代替できない。

## References

- [Delta introduction](https://zed.dev/blog/introducing-delta)
- [DeltaDB Early Access](https://zed.dev/deltadb)
- [Zed parallel Agents](https://zed.dev/blog/parallel-agents)
