# Agent Collaboration / Background Agent Roadmap

## Status

- **Lifecycle:** Active mutable roadmap
- **Last updated:** 2026-08-18
- **Current focus:** Release A — Background Agent
- **North star:** **AIとの会話を、途中状態・承認・来歴・検証を保持できる持続的な仕事へ変える**

本書は、Background Agent、SessionTasks、Delta型Agent Workspace、Canonical適用後の
Semantic Verificationについて、実装順序と投資判断を管理する可変Roadmapの正本である。

本書はAccepted ADRまたはmachine-readable policyを置き換えない。

- [ADR 003: DB Authority and Schema Contract](../adr/003-db-authority-and-schema-contract.md)
  はCanonical DB authorityを所有する。
- [ADR 005: Narrative Semantic Core Boundary](../adr/005-narrative-semantic-core-boundary.md)
  はNarrative IR、Semantic Build Graph、Freshness、Interpretation境界を所有する。
- [ADR 006: Narrative Mutation Origin and Authority Routes](../adr/006-narrative-mutation-authority-routes.md)
  はCanonical mutation authority routeを所有する。
- [ADR 007: Agent共同作業の実行・Task・投機的Workspace境界](../adr/007-agent-collaboration-execution-boundary.md)
  は本書が用いる実行、Task、Workspace、一貫性、承認、Verification境界を所有する。
- [Narrative Semantic Core / Living Story Bible Roadmap](narrative-semantic-core-roadmap.md)
  はSemantic Coreのcritical pathを所有する。本書はそのstable surfaceを利用し、
  第二のSemantic authorityを作らない。

本書とAccepted ADRまたはvalidated policyが衝突する場合、ADR／policyが優先する。
PR descriptionとChat historyはRoadmap authorityではない。

## Product／investment principles

1. 後段の投機的system contractを固定する前に、確実なユーザー価値を持つ最小Releaseを出す。
2. Task進捗を表示する前にBackground executionを成立させる。
3. WorkTask、AgentRun、pending interaction、Workspace、AI Audit、Change Feed、
   Semantic Verificationは別recordとして保持する。
4. Scene／Session navigationはUI projectionをdetachするが、Runをcancelしない。
5. Read-only analysisは、連続更新される本文へ追随してlivelockせず、記録済みper-source readに
   対して完走する。
6. Agent変更は、適切なreview、authority route、OCC、typed writerなしにCanonical SQLiteへ
   入らない。
7. 未承認Workspace変更はCanonical Semantic IRをStaleにしない。
8. 初期Semantic完了gateには、決定的または既にratifyされたcheckだけを使う。
   未計測semantic discoveryはadvisoryに留める。
9. 実装帯域ではなくreview帯域を律速とみなし、同時active laneは2〜3本に制限する。
10. feature flagはRelease粒度、短命とし、安定後に削除する。
11. Project management UIは、Session-local statusだけでは不足するとdogfoodingで判明した後に追加する。
12. 後発の確率的Findingだけで、完了済み創作Taskを黙って再openしない。

## Status legend

| State | Meaning |
| --- | --- |
| **Complete** | merged実装が記載したexit criteriaを満たす。 |
| **Active** | 具体的branchまたはPRが実装中。 |
| **Planned** | 順序とscopeは確定したが未着手。 |
| **Decision Gate** | 以降の投資にdogfoodまたは評価Evidenceが必要。 |
| **Blocked** | named dependencyが完了するまで安全に着手できない。 |
| **Experimental** | 別途計測し、production completion pathをblockしない。 |
| **Deferred** | 現在のcritical path外へ意図的に遅延。 |

## Current snapshot

| Area | State | Current fact / next condition |
| --- | --- | --- |
| CLI long-run policy | **Planned** | `electron/main/cliAi.ts`には290秒の既定total stream deadlineが残る。 |
| Transport detach | **Planned** | `src/features/chat/chatStreamTransport.ts`と`src/features/chat/cliApi.ts`のcleanupはabort要求も兼ねる。 |
| Scene navigation | **Planned** | `src/application/chat/chatScopeStoreActions.ts`はScene-scope resetでactive generationを停止する。 |
| Turn authority | **Planned** | `src/application/chat/chatTurnStoreActions.ts`はactive Session／scope／anchor driftをabort条件として扱う。 |
| Durable AgentRun | **Planned** | Background AgentのCanonicalなdurable Run／Interaction authorityは未実装。 |
| Session status UI | **Planned** | Session cardとscope selectorにはbackground run／question／unread statusがない。 |
| SessionTasks | **Release A後のDecision Gate** | Background Agent dogfoodingでpersistent plan価値が確認された場合だけ実装する。 |
| Agent Workspace | **Gate BでBlocked** | Background Agent／SessionTasksの利用知見前にcontractを固定しない。 |
| Deterministic Semantic CI | **Workspace merge receiptとSemantic Core readinessでBlocked** | 既存Narrative Run／Freshness authorityを利用し、複製しない。 |
| Implicit semantic discovery | **Experimental** | annotated corpusでprecision／recallを測定するまで完了へ影響させない。 |
| Project Focus / WorkBeacon | **Deferred** | まずSession-local statusを提供する。 |

## Critical path

```text
Release A: Background Agent
  R0 timeout policy
  F0-lite contracts
  R1 detach / cancel transport contract
  Durable AgentRun + durable interaction
  Execution authority / projection split
  Scene detach + original Session persistence + unread
  Minimal Session-local status UI
  Race / recovery hardening
        ↓
Decision Gate A: persistent planは実際に必要か
        ↓
Release B: SessionTasks Minimal
        ↓
Decision Gate B: staged mutationと richer reviewへ投資するか
        ↓
F0b: 実運用知見に基づくWorkspace contract
        ↓
Release C: One-Scene Delta-style Workspace
        ↓
Release D: Deterministic post-merge Semantic CI
        ↓
Release E: Session-local statusで不足する場合だけProject Focus

Experimental Lane Xはproduction gateの前へ出ない。
annotated corpus → candidate retrieval → reviewer benchmark → advisory report
```

---

# Release A — Background Agent

## Product promise

> AIを実行したまま別のSceneへ移動でき、完了・質問・失敗を元のSessionで見失わない。

Release AはSessionTasks、Agent Workspace、Semantic CI、Project Focusから独立して提供する。

## Scope

### Included

- 健全な長時間Runをtotal durationだけで停止しないCLI timeout policy。
- UI detachとprovider cancelを分離するtransport handle。
- durable AgentRunおよびdurable pending user interaction。
- Scene／Session navigationを越えるsame-process continuation。
- 起点Sessionへのcompletion persistence。
- Session card／scope selectorでのunread、running、waiting-user、failure indicator。
- resume不能なlive stateを`interrupted`へ遷移させるstartup reconciliation。

### Excluded

- 永続Task planまたはTask progress UI。
- 同一Project内の複数root Run並列実行。
- renderer reload／crash後の任意Agent loop透明resume。
- Header WorkBeaconまたはProject-wide Drawer。
- Agent Workspaceおよびstaged manuscript mutation。
- Semantic Verificationまたはrepair proposal。
- 外部usage telemetry。

## R0 — CLI timeout policy

**State:** Planned。即時着手可能。

### Goal

固定total stream deadlineを、trusted main-process timeout policyへ置換する。

### Required policy axes

```text
connect timeout
idle warning
optional idle cancellation
optional hard deadline
force-kill delay after explicit cancellation
```

### Default behavior

- connect timeoutはbounded。
- idle warningは表示するが、既定ではcancelしない。
- provider heartbeatを保証できない経路ではidle cancellationを既定OFF。
- user-started desktop Runのhard deadlineは既定OFF。
- 明示StopのSIGTERM → SIGKILL safety pathは維持する。

### Exit criteria

- 65分相当のfake-timer Runがtotal durationだけでcancelされない。
- activity updateはidle観測をresetするが、Stop semanticsを変えない。
- warningとcancellationが別eventである。
- 現行のprocess byte、line、output capを維持する。

## F0-lite — Release Aが消費するcontract

**State:** Planned。R0と並列着手可能。

F0-liteはRelease Aと最小Task integrationが実際に使うcontractだけを固定する。
Workspace／Semantic contractは明示的にscope外とする。

### Contracts

```text
TransportExecutionHandle
  subscribe / detach / cancel / result

AgentRunStatus
AgentRunInteractionStatus
ExecutionAuthority
ProjectionAttachment

WorkTaskStatus
minimal TaskContractSnapshotV1

AnalysisReadBasisEntryV1
AnalysisReadBasisV1
  consistencyModel = capture-on-first-read
```

### Conformance focus

- OCC conflict。
- idempotent replay。
- duplicate terminal rejection。
- invalid transition rejection。
- cancel／provider-terminal race。
- renderer-loss reconciliation。
- Project／Workspace authority mismatch。

production実装で判明したcontract amendmentは、小さなfocused PRとして通常運用する。
F0-liteをimmutableなBig Design checkpointとはしない。

## R1 — StreamHandle: detach, cancel, result

**State:** F0-liteのtransport contract安定後にPlanned。

### Goal

subscriber disposalとtransport abortを混同するcleanup callbackを置き換える。

### Required behavior

```text
subscribe / unsubscribe
  → 一つのprojection subscriberだけへ作用

detach
  → 旧projectionへのUI deliveryを停止するがprovider実行は停止しない

cancel
  → provider / process terminationを要求

result
  → terminal transport outcomeで一度だけresolve
```

### Exit criteria

- detachはabort commandを呼ばない。
- detach後もAI Audit observationがterminalまで継続する。
- provider completionとStopはterminal resultを一つだけ生成する。
- detached inactive Sessionのdeltaがactive Session projectionへ入らない。

## A3 — Durable AgentRun and durable interactions

**State:** R1およびF0-lite state contractでBlocked。

### Durable records

- AgentRun identity、対象Project／Session、model／transport snapshot、execution authority、
  status、activity、terminal reason、OCC version。
- transport historyを複製せず、既存AI Auditの`operationId`／`executionId`へlink。
- user question、approval request、permission request用AgentRunInteraction。

### Interaction contract

- v1ではroot Runごとのpending interactionは最大1件。
- request payloadと対象Sessionをdurableにする。
- resolutionはOCC-protectedかつidempotent。
- same-process live resolverは既存Agent loopをresumeできる。
- renderer loss時はInteractionをEvidenceとして残すが、明示的continuation contractがない限り
  Runを`interrupted`へ遷移する。

### Exit criteria

- Run／Interaction rowがnavigationとapplication restartを越えて残る。
- startupで孤児`running`を成功扱いしない。
- pending questionを起点Sessionで再表示できる。
- 二重回答、Stop＋回答、terminal＋遅延回答がInteractionを二度resolveしない。

## A4a — Execution authority / projection refactor

**State:** A3でBlocked。

### Goal

Run継続を許可する条件と、deltaを一つのrenderer projectionへ表示する条件を分離する。

### Execution authority retains

- captured Workspace identity。
- captured Project／target Session。
- route、policy、license、capability snapshot。
- 明示的user cancellation state。

### Projection attachment owns

- active window。
- visible Session／scope。
- attached Run。
- unread／waiting indicator。

A4aはproduct behavior変更を最小にし、Background Agentをrelease flagの後ろに置く。

## A4b — Background Session vertical slice

**State:** A4aでBlocked。

Scene detach、起点Session persistence、unread、pending interaction projection、最小UIを
一体として検証する最初のuser-visible sliceである。

### Flow

```text
Scene A / Session XでRun開始
  → Scene B / Session Yへ移動
  → Xをvisible projectionからdetach
  → capture済みexecution authorityでRun継続
  → XのdeltaをYへ表示しない
  → terminal messageをXへ保存
  → Xへunread / question / failure stateを付与
  → Xを開いてunread clearとInteraction surface復元
```

### Release A acceptance criteria

1. 65分相当のsynthetic CLI Runがtotal durationだけで停止しない。
2. Scene Aで開始したRunが同一Project内のScene B移動後も継続する。
3. Scene Aのstreaming deltaがScene Bのactive Sessionへ混入しない。
4. 最終assistant messageが起点Sessionへ保存される。
5. 起点Sessionだけにunreadが付く。
6. 明示Stopだけがtransport cancelを要求する。
7. `waiting_user` interactionがScene移動後も残り、同一renderer processでは同じRunをresumeできる。
8. renderer reload後の孤児Runを`succeeded`ではなく`interrupted`へreconcileする。
9. Stop／provider terminal raceでmessage二重保存またはterminal二重発行が起きない。

## A6 — Minimal Background Agent UI

**State:** A4b product sliceの一部。focused child PRとしてreview可能。

### Included UI

- Session cardのrunning、waiting-user、unread answer、failure indicator。
- Chat scope selector横のcompact dot／badge。
- 起点Sessionを開いた際のpending interaction。

### Explicitly excluded

- Header WorkBeacon。
- Project-wide run counter。
- Task list／Task progress。
- Drawer。
- Workspace review state。
- Semantic check progress。

## AH — Hardening and recovery

**State:** A4bでBlocked。

### Required race suites

- detach versus provider completion。
- Stop versus provider completion。
- question表示 versus navigation。
- answer versus Stop。
- duplicate answer。
- renderer loss during running／waiting-user。
- completed-turn persistence failure。
- old Session completion versus new Session projection update。

### Required recovery behavior

- stale Runは別Project／Sessionへ書き込めない。
- pending completed-turn persistenceを回復可能に保つ。
- `interrupted`は旧execution attemptのterminalであり、retryはhistoryを書き換えず新Runを作る。

## Release A implementation lanes

active workはreview帯域に合わせて2〜3 laneに制限する。

### Initial parallel work

```text
Lane Runtime A: R0 timeout policy
Lane Contracts: F0-lite
Lane Runtime B: R1 transport handle
```

R1後のproduction critical pathは主に直列である。

```text
A3 → A4a → A4b → A6 / AH
```

### Hot-file ownership

| Path | Release A owner |
| --- | --- |
| `electron/main/cliAi.ts` | Runtime |
| `src/features/chat/chatStreamTransport.ts` | Runtime |
| `src/features/chat/cliApi.ts` | Runtime |
| `src/application/chat/chatTurnStoreActions.ts` | Runtime |
| `src/application/chat/chatScopeStoreActions.ts` | Runtime |
| `src/application/chat/chatUserQuestionRuntime.ts` | Runtime |
| Native migration / schema registry | Integration owner |
| `electron/shared/ipcContract.ts` | Integration owner |
| Session card / scope selector UI | projection contract後のUI child PR |

他laneはRuntime hot fileを直接編集せず、port／contract変更を要求する。

## Decision Gate A — SessionTasksは必要か

**State:** Release A dogfooding後のDecision Gate。

GrimodexはこのGateのために外部telemetryを追加しない。以下を含む、およそ10件の実作業Runを
定性的に記録する。

- 10分以上のRun。
- 複数Sceneを跨ぐnavigation。
- user questionを出すRun。
- 明示Stop。
- providerまたはrenderer interruption。
- 別作業後にunread結果へ戻るcase。

### Qualitative questions

- Agentが現在何をしているか理解できたか。
- 未完了項目を理解できたか。
- planを覚えるため外部memoが必要だったか。
- model switch、retry、interruptionで意図したplanが変質したか。
- 後から正しい結果を容易に見つけられたか。
- 承認点またはblockerが不明確だったか。
- Session card statusとunreadだけで十分だったか。

### Gate outcome

persistent plan、progress、acceptance、Evidence問題が繰り返し発生した場合にRelease Bへ進む。
Session-local statusだけで十分なら、従来のfull SessionTasks設計を既定実装せず縮小または延期する。

---

# Release B — SessionTasks Minimal

**State:** Decision Gate AでBlocked。

## Product promise

> 長い依頼の目的、現在位置、未完了項目、確認待ちを会話履歴の外に保持する。

## Initial domain

- Session WorkPlan。
- `ready`、`in_progress`、`blocked`、`review`、`done`、`cancelled`を持つWorkTask。
- Completion policyは`manual`と`agent_proposes`だけ。
- required criterionはplain text。metric／predicate engineは作らない。
- AI Audit execution、Run、message、将来ArtifactへのEvidence link。
- 圧縮された会話履歴と独立して注入するTask Contract。

## Approval rules

Agentは内部SessionTaskを自動作成・更新できる。scope拡張、permission昇格、required criterion緩和、
Project Task昇格には明示authorityが必要である。

## UI

- Chat内SessionTask strip。
- Work progressとexecution telemetryを分離表示。
- Session cardにcurrent Task／review／blocked stateを表示可能。
- Global Project task managerは作らない。

## Exit criteria

- model switchまたは会話要約後も同じobjective／required criterionを参照する。
- 主観Taskは`review`へ進めるが、Agentの自己申告だけで`done`にならない。
- stale Task updateをOCCで拒否する。
- Task管理が恒常的なmanual cleanupを要求しない。

## Decision Gate B — staged mutationへ進むか

以下を評価する。

- 分析だけでなくCanonical内容変更を依頼する頻度。
- 現行proposalのreview granularityが粗すぎるか。
- author並行編集が上書き不安を生むか。
- 実際に有用だったprovenance fieldは何か。
- 複数Runが一つのproposal resultを共有する必要があるか。

このGate後に初めてWorkspace contractを固定する。

---

# F0b — 実運用後のWorkspace contract

**State:** Decision Gate BでBlocked。

F0bは最初のproduction sliceに必要なものだけを定義する。

```text
AgentWorkspace
WorkspaceResourceBasis
OperationGroup
ResolvedSceneOperation
WorkspaceDecision
PreparedChangeSet
WorkspaceMergeReceipt
```

Task／Run／approvalの実利用を反映する。Codex、Chronicle、Timeline、CRDTの汎用Operationを
先に設計しない。

---

# Release C — One-Scene Delta-style Workspace

**State:** F0bでBlocked。

## Product promise

> AIの本文変更を正規Sceneから隔離し、作者の編集を失わず、意味のある単位で採否を選べる。

## Scope

- 一人のauthor。
- 一つのroot AgentRun。
- 一つのScene resource。
- 一つのWorkspace。
- 一つ以上のOperation Group。
- CRDTなし。
- divergenceしたScene revisionのautomatic semantic mergeなし。

## Flow

```text
Scene version / digestをcapture
  → Agentがvalidated proposalをWorkspaceへstage
  → authorはCanonical編集を継続
  → Base / Current / Agent resultをreview
  → Operation Groupをaccept / reject
  → fresh OCC / digest validation
  → Prepared ChangeSet
  → Typed Writer transaction
  → Undo Journal / Change Feed / merge receipt / provenance link
```

## Exit criteria

- stageはCanonical Sceneを変更しない。
- replayが同じresult digestを生成する。
- Canonical base変更時はsilent overwriteではなくconflict／rebase-neededになる。
- accepted groupだけ一度applyされ、rejected groupはCanonicalへ入らない。
- crashでhalf canonical mergeを残さない。
- commitされた変更からTask、Run、prompt message、tool call、AI Audit executionへ遡れる。
- 既存Editor Save／Undo semanticsを維持する。

---

# Release D — Deterministic post-merge Semantic CI

**State:** Release Cおよび必要なSemantic Core production surfaceでBlocked。

## Product promise

> Agent変更を適用して終わりにせず、固定変更境界のSemantic検査を待ち、問題があれば根拠付き修正案を返す。

## Consistency basis

Verificationを以下へ固定する。

- applied ChangeSet digest。
- canonical sequence interval。
- semantic epoch。
- snapshot／material basis digest。
- affected Sourceおよびknown Consumer set。

後から本文が変わっても、このBarrierに対する検証は完走する。後続変更はreportのcurrent headへの
適用可能性を決めるが、historical reportを消さない。

## Initial completion-gating checks

- direct changed-Source re-extraction。
- known dependency closure evaluation。
- Consumer Freshness publication。
- exact canonical-fact conflict。
- deterministic temporal-constraint conflict。
- Source missing／deleted-reference check。
- 決定的contractが存在する既知Foreshadow／Plot Thread参照integrity。

未実装checkをPASSにせず、coverage上`inconclusive`または明示的未実行とする。

## Finding flow

```text
Verification Finding
  → declarative repair proposal
  → user review
  → optional new Workspace
  → merge
  → new Verification barrier
```

FindingはCanonicalへ直接書き込まない。model reviewerはread-onlyでありauthorityを拡張できない。

## Creative Task invalidation

後発deterministic Findingだけでauthor-approved creative Taskを黙って再openしない。
Taskはdoneのまま`verification_invalidated`等のattention stateを持ち、authorが以下を選ぶ。

- Taskをreopen。
- follow-up Taskを作成。
- intentionalとして扱う。
- ignore。

客観的に条件が破れたmechanical Taskは、reasoned event付きpolicyで再openできる。

---

# Experimental Lane X — Implicit semantic discovery

**State:** Experimental。Release A〜Dをblockしない。

## Research questions

- 新しい微細なForeshadow setup／payoffを有用なrecallで発見できるか。
- motif、人物動機、knowledge state、causal driftをfalse positive過多なしに提示できるか。
- Narrative IR retrievalはRaw Textだけよりcandidate rankingを改善するか。

## Evaluation corpus

小規模なannotated fiction corpusへ以下を含める。

- explicit setup／payoff。
- 異なる語彙によるimplicit setup／payoff。
- incidental motif repetition。
- deliberate misdirection。
- unresolved atmosphere-only detail。
- ambiguous multiple payoff。
- accidental word overlapのnegative example。

## Metrics

```text
candidate recall@K
candidate precision@K
false positives per 10,000 characters
reviewer acceptance rate
runtime / model cost
human-rated usefulness
```

## Promotion stages

```text
X0 developer-only report
X1 explicit user-run report
X2 background advisory
X3 candidate for required verification
```

model自己評価だけで昇格しない。計測されるまでopt-in report surfaceへ置き、Task review／completionを
blockしない。

---

# Release E — Project Focus

**State:** Session-local status不足が確認されるまでDeferred。

## Initial scope if justified

- Current。
- Next。
- Blocked。
- optional Open Questions。

compact Header beaconとoverlay Drawerでprojectionしてよい。初期Releaseではprogress percentage、
Kanban、deadline、Sprint、complex dependency editingを追加しない。

Header／Drawer変更はreal Chromium geometry testを必要とし、closed stateでEditor寸法を変えない。

---

# Cross-cutting consistency policy

| Task / operation | Basis | Completion behavior |
| --- | --- | --- |
| Read-only analysis | capture-on-first-read per Source | 完走しbasisを開示。交差時にdelta recheckを提案。 |
| Workspace rewrite | pinned resource version／digest | stageは完走し、mergeでconflict／rebase。 |
| Canonical write | current OCC／digest／policy | mutation前にstale writeを拒否。 |
| Semantic Verification | fixed barrier | historical reportを完走し、current-head適用性を別判定。 |
| Follow-latest monitor | explicit opt-in＋hysteresis | 編集quiet period後にrefresh。 |

## Analysis read basis

v1 read basisは単一Project sequenceではなくper Sourceである。各capture entryはSource identity、
revision token／version、digest、observed Change Feed high-water mark、該当する場合Semantic Epoch、
immutable content refを記録する。search resultはquery digest、index／resolver version、ordered result
identity、result revisionと共にcaptureする。

完了時にcapture後のChange Feed変更とRun read setを交差判定し、no action、delta recheck、follow-up
Taskのいずれかを選ぶ。完了済み分析は破棄しない。

---

# Cross-cutting approval／capability policy

```text
Project AI Policy
  → hard ceiling
Session autonomy preset
  → current interaction preference
Run capability grant
  → concrete capability set
Action risk decision
  → allow / ask / deny
```

## Per-step approval不要

- internal Session plan作成。
- progress update。
- Evidence attachment。
- read／search。
- granted budget内のread-only child work。
- Workspace draft生成。
- deterministic Semantic verification。

## Explicit approval必要

- material scope expansion。
- capability escalation。
- required criterion weakening。
- default proposal modeでのCanonical ChangeSet適用。
- deletion、broad replacement、structural mutation。
- external file、publishing、credential、irreversible side effect。

reviewer modelはadvisoryである。typed writer admission、policy、OCC、provenance、required human decisionが
security boundaryとなる。

---

# Parallel implementation policy

- lane内のdependent workはStacked PRを利用できる。
- independent laneはmasterから分岐し、OFF release flagの後ろで逐次mergeする。
- active laneは最大2〜3本。
- laneごとのreview待ちPRは最大1本。
- integration PRはwiring／contract adaptationに限定し、hidden domain logicを追加しない。
- migration、`src/db/schema.ts`、N-API command registration、
  `electron/shared/ipcContract.ts`は一人のintegration ownerが扱う。
- integrationで判明したcontract correctionは正常なfocused PRであり、fixture-first abstractionを
  不自然に維持しない。

# Feature flag policy

Release粒度のflagだけを許可する。

```text
backgroundAgent.enabled
sessionTasks.enabled
agentWorkspaces.enabled
semanticVerification.enabled
```

Rules:

- 同時に開発中のflagは最大2つ。
- internal combinationをpublic settingにしない。
- unsupported combinationへtest matrixを作らない。
- Release安定後、rollback不要になったflagを削除する。

# Test／certification strategy

## Unit／contract tests

- state-machine transition。
- capability／material amendment decision。
- idempotency／OCC。
- terminal uniqueness。
- immutable read-basis serialization。
- report／digest determinism。

## Runtime race tests

- detach／completion。
- cancel／completion。
- answer／Stop。
- duplicate answer。
- navigation／pending interaction。
- retry／old terminal。
- inactive Session delta isolation。

## Native persistence tests

- migration／foreign key。
- Project／Session ownership。
- startup reconciliation。
- transaction rollback。
- Release Cのinterrupted merge recovery。
- Release DのSemantic barrier supersession。

## Browser tests

後段のHeader、Drawer、layout geometry変更では必須とする。Release AのSession card／scope indicatorが
既存geometry invariantを変更しない限り、通常component testでよい。

## Dogfood evidence

Release A／Bの投資Gateは実際のauthoring作業から明示的な定性noteを残す。存在しないcloud telemetryを
待たない。

# Deferred capabilities

- DeltaDB直接依存。
- 全文CRDT。
- realtime multi-author collaboration。
- Project内の複数root Run並列実行。
- 任意renderer-crash continuation。
- divergenceしたproseのautomatic semantic rebase。
- bounded reviewed experimentを超えるautomatic repair loop。
- Project-wide implicit semantic discoveryのcompletion gate化。
- full Project task manager。
- gamified Task completion。

# Roadmap maintenance protocol

1. active Release変更時に`Last updated`と`Current focus`を更新する。
2. merged実装がexit criteriaを満たした後だけCompleteへ変更する。
3. implementation Evidenceはmerged PR linkとして残し、Chat historyをauthorityにしない。
4. authority、lifetime、consistency、approval、verification invariant変更は、先にADR 007をamendする。
5. architectural invariantを変えない実装順序／investment gate変更は本Roadmapだけを更新する。
6. Experimental Lane Xは黙ってproduction completion gateへ昇格できない。評価EvidenceとRoadmap更新を
   必要とする。
