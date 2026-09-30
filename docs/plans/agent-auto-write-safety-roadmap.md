# Agent Auto / Write-Safety Roadmap

## Status

- **Lifecycle:** Active mutable roadmap
- **Last updated:** 2026-08-19
- **Current focus:** Gate A — 書き込み安全境界
- **North star:** **Chatを既定でAgentとして動作させつつ、Autoを書き込み同意にしない**

本書は、Agent既定モード（`agentPreference: "auto"`）の導入と、その前提となる
書き込み承認境界について、実装順序と投資判断を管理する可変Roadmapの正本である。

本書はAccepted ADRまたはmachine-readable policyを置き換えない。

- [ADR 007: Agent共同作業の実行・Task・投機的Workspace境界](../adr/007-agent-collaboration-execution-boundary.md)
  は実行、Task、Workspace、一貫性、承認、Verification境界を所有する。
- [ADR 008: Agent既定モードと書き込み承認境界](../adr/008-agent-default-mode-and-write-approval.md)
  は本書が実装するAgent既定モード、ツール効果分類、承認・Capability発行境界を所有する。
- [Agent Collaboration / Background Agent Roadmap](agent-collaboration-roadmap.md)
  はdurable AgentRun、SessionTasks、Agent Workspace、Semantic CI（本書のGate C／D相当）
  の実装順序を所有する。本書はその領域を再定義せず、第二のauthorityを作らない。

本書とAccepted ADRが衝突する場合、ADRが優先する。PR descriptionとChat historyは
Roadmap authorityではない。

## Product／investment principles

1. Agent Auto既定化はGate A（書き込み安全境界）完了を絶対的前提とする。
2. Autoが自動実行できるのは読み取りとステージングだけである（ADR 008）。
3. フルTask基盤の完成を待たない。個別承認だけでも安全なAutoは提供できる。
4. 承認は一時的なモーダルではなく、将来durableになる実行状態として設計する。
   初期のメモリ実装でも型・digest・main交換APIは永続形式へ合わせる。
5. UIは要求値ではなく実効値（effectiveMode / fallbackReason）を表示する。
6. 設定破損は書き込み許可へ変換されない（fail-closed）。
7. Gate C以降は[agent-collaboration-roadmap](agent-collaboration-roadmap.md)の
   Release順序・Decision Gateに従う。

Status語彙は[agent-collaboration-roadmap](agent-collaboration-roadmap.md)の
Status legendに従う。

## Current snapshot（2026-08-19検証済み）

| Area | State | Current fact |
| --- | --- | --- |
| Agent既定値 | **Planned** | `src/features/chat/chatStore.ts`は`agentMode: false`、`resetForProject`で`false`へ戻り、永続化されない。 |
| Thinking既定値 | **Complete（維持）** | `src/features/chat/types.ts`の`DEFAULT_AI_SETTINGS`は`thinkingEnabled: true`。変更しない。 |
| 確認フラグ配線 | **Planned** | `requiresUserConfirmation`は宣言のみ。renderer executor（`toolExecutors.ts`）もmain Capability発行（`electron/main/ipc.ts`）も参照しない。 |
| 変更系ツール | **Planned** | 変更系15ツール中、ステージングされるのは`propose_scene_body`のみ。`apply_ai_tree_plan`含む14個はポリシー通過後に即時実行。 |
| Capability発行時点 | **Planned** | mainはLLM応答受信時にポリシー判定のみでTTL 5分のCapabilityを発行（`electron/main/ipc.ts`）。人間承認は介在しない。 |
| RAG退避 | **Planned** | ツール非対応退避時に`ragActive = false`へ落ち、RAGは再評価されない（`src/application/chat/chatTurnRouting.ts`）。 |
| `agentToolsSuppressed` | **Complete（部分）** | route policy算出結果として既存。store／UIへは未露出。 |
| ツール能力不明時 | **Planned** | `modelLimits.ts`の`DEFAULT_CAPABILITIES`は`supportsTools: true`の楽観扱い。Ollamaのみ再プローブ＋退避あり（`chatOllamaPreflight.ts`）。 |
| AIポリシーparse | **Planned** | `parseAiPolicy()`は不正JSONでも`DEFAULT_AI_POLICY`（full）へfail-open（`src/features/ai-policy/parse.ts`）。 |

## Critical path

```text
Gate A: 書き込み安全境界（Agent Auto化の絶対的前提）
        ↓
Gate B: 安全なAgent Auto（既定auto化・退避・永続化）
        ↓
Gate C: Durable AgentRun / SessionTasks
        → agent-collaboration-roadmap Release A〜B が正本
        ↓
Gate D: Delta的Task Workspace / Semantic CI
        → agent-collaboration-roadmap Release C〜D が正本
```

Gate AとGate Bは、agent-collaboration-roadmapのRelease A（Background Agent）と
独立に完了できる。両者が並走する場合、ApprovalRequestの型契約
（ADR 007のAgentRunInteraction整合）だけを共有面とする。

---

# Gate A — 書き込み安全境界

**State:** Planned。即時着手可能。Agent Auto化の絶対的前提。

## Product promise

> Agentが正規状態を変更するのは、人間が承認したときだけになる。

## Scope

### A1 — Tool manifestの`effect` / `approvalMode`拡張

- `agent-tool-manifest.json`へ`effect: read | stage | mutate | destructive`と
  `approvalMode: none | task-scope | always`を追加。
- `propose_scene_body`は`stage`へ再分類。`delete_event`・`remove_event_relation`は
  `destructive / always`。`apply_ai_tree_plan`は`mutate`以上。
  現行confirm不要の変更系11ツールは`mutate / task-scope`。
- TS loader（`toolManifest.ts`）とRust build check（`grimodex-ai/build.rs`）を
  新分類の整合性検証へ拡張（`read`に`approvalMode: always`は不整合、等）。
- 移行完了後に`requiresUserConfirmation`を廃止。

### A2 — main側の承認検証とCapability発行時点の変更

- `mutate`・`destructive`ツールについて、LLM応答受信時のCapability発行を停止。
- ApprovalRequest（メモリ実装可、型は永続形式）を導入し、`approved`確定時に
  mainがdigest・Project・OCC・ポリシー・未使用性を再検証して一回限りの
  Capabilityへ交換する。
- renderer executorは`approvalMode`に応じて待機状態を管理する
  （二重ゲートのrenderer側）。

### A3 — ステージングの分離

- `stage`ツールは自動実行を維持し、正規状態への適用（accept）だけを
  承認対象とする。既存のproposal accept/reject＋auto-accept opt-in
  （`autoAcceptGate.ts`）の構造を維持する。

### A4 — AIポリシーparseのfail-closed化

- `ParsedAiPolicy`を`valid / missing / invalid`の3状態へ。
- `invalid`では`bodyWrite / structureWrite / knowledgeWrite`を`false`とし、
  UIに破損警告を表示。

## Exit criteria

1. 変更系15ツールすべてについて、無承認実行が不可能であることを機械的にテストする
   （manifest駆動で全ツールを列挙し、承認なし実行が拒否されることをexecutor層・
   main層の両方で検証）。
2. `destructive`はTask Grant相当のフラグがあっても個別承認なしに実行できない。
3. `stage`ツールは承認なしで実行でき、正規状態を変更しない。
4. 承認済みApprovalRequestの再利用（二重実行）が拒否される。
5. digest不一致・Project不一致・ポリシー失効時にCapability交換が拒否される。
6. 不正なポリシーJSONで書き込みトグルが全て`false`になる。
7. `read`ツールの既存挙動（応答時発行）に回帰がない。

---

# Gate B — 安全なAgent Auto

**State:** Gate AでBlocked。

## Product promise

> 初回起動から、AIは必要な情報を自律的に探索して答える。ただし書き込みは
> 承認したときだけ起こる。

## Scope

### B1 — `agentPreference`の導入と永続化

- `agentPreference: "auto" | "off"`をユーザー設定として永続化
  （グローバル設定。プロジェクトリセットで既定へ戻さない）。
- 既定は`auto`。Thinkingは`thinkingEnabled: true`のまま維持。
- 既存`agentMode`（要求値）からの移行。UIトグルは`agentPreference`を書く。

### B2 — 実効モード解決と退避

- Auto時の解決順: ツール対応 → Agent、非対応かつRAG可能 → RAG、それ以外 → 通常Chat。
- ツール非対応退避時、RAG適格性を`agentPreference`をOFF扱いした条件で再評価する
  （現行の`ragActive = false`固定を廃止）。
- `effectiveMode` / `fallbackReason`をroute policyから導出し、UIへ露出
  （「このモデルでは通常チャットとして動作」等）。新たなmutable stateは追加しない。

### B3 — ツール能力3値化と試行退避

- `toolSupport: supported | unsupported | unknown`。
- `unknown`はAgent試行を許可し、providerのツール非対応エラー時は通常Chatとして
  自動再試行（Gate C以降は同一Runの新Attemptとして記録）。
- `chatOllamaPreflight.ts`の再プローブ＋退避パターンを他OpenAI互換経路へ一般化。

### B4 — Auto時の効果制限

- Task Grant不在のAuto Turnでは、`read`と`stage`だけを自動実行する。
- `mutate`・`destructive`はApprovalRequestへ送られ、承認UIに現れる。

## Feature flag

agent-collaboration-roadmapのflag policyに従い、Release粒度の短命flagを1つだけ使う。

```text
agentAutoDefault.enabled
```

安定後に削除する。

## Exit criteria

1. 新規状態（設定なし）でAgentがAuto動作する。
2. 明示的OFFが再起動・プロジェクト切替・プロジェクトリセット後も保持される。
3. ツール非対応モデルで通常Chatへ退避し、RAG適格ならRAGが有効になる。
4. 退避時にUIが実効モードと理由を表示する。
5. 未知モデルのツール非対応エラーから通常Chatとして自動再試行できる。
6. Auto Turnで`mutate`ツールが承認なしに実行されない（Gate A invariantの回帰確認）。
7. `openrouter/fusion`・CLIプロバイダ等の既存除外条件に回帰がない。

---

# Gate C — Durable AgentRun / SessionTasks

**State:** [agent-collaboration-roadmap](agent-collaboration-roadmap.md)のRelease A〜Bが正本。
本書では再定義しない。

本書からの引き継ぎ事項（あちらのDecision Gate A／Release B設計への入力）:

- ApprovalRequestは`waiting_approval`のdurable interactionへ昇格する。
  Gate Aで定めた型・digest・交換APIをそのまま永続化する。
- Task Grant導入により、`mutate / task-scope`ツールが承認済みWorkPlan範囲内で
  連続実行可能になる。
- 通常チャットの単発質問をWorkTaskへ常設昇格させない。可視Task昇格の条件は
  複数ステップ計画・受け入れ条件・複数書き込み・承認待ち・サブエージェント・
  Session越え継続・明示指定に限る。`AgentRun.succeeded !== WorkTask.done`
  （ADR 007 §2）を維持する。
- Scene移動はdetachでありcancelではない（ADR 007 §3。実装はRelease AのR1／A4a）。

# Gate D — Delta的Task Workspace / Semantic CI

**State:** [agent-collaboration-roadmap](agent-collaboration-roadmap.md)のRelease C〜Dが正本。
本書では再定義しない。DeltaDBは導入せず、既存Change Feed・Undo Journal・OCC・
Provenance・Semantic Verificationの上にWorkspaceを構築する（ADR 007 §1）。

---

# Cross-cutting: 権限の層構造

ADR 008の層構造を実装全体で維持する。上の層は下の層を代替しない。

```text
1. AgentPreference (auto / off)        — Gate B
2. AiPolicy (project ceiling)          — 既存 + Gate A4 fail-closed
3. Task Grant                          — Gate C（Release B）
4. ApprovalRequest                     — Gate A（メモリ）→ Gate C（durable）
5. Main-issued Execution Capability    — 既存 + Gate A2 発行時点変更
```

# Test strategy

## Contract tests（Gate A）

- manifest全ツール列挙による無承認実行拒否（executor層・main層）。
- effect × approvalMode組み合わせの整合性（build check）。
- ApprovalRequest状態遷移・二重実行拒否・digest／OCC／ポリシー再検証。

## Routing tests（Gate B）

- 新規状態のAuto動作。
- 明示OFF永続化（再起動・リセット・切替）。
- 非対応退避＋RAG再評価。
- `effectiveMode` / `fallbackReason`導出。
- 未知モデルエラー再試行。
- 既存除外条件（fusion / CLI / のべりすと）の回帰。

## Browser tests

承認UI・実効モード表示が既存layout geometry invariantを変えない限り不要。
Header／パネル寸法へ影響する場合のみ`pnpm test:browser`をgateへ追加する。

# Roadmap maintenance protocol

1. active Gate変更時に`Last updated`と`Current focus`を更新する。
2. merged実装がexit criteriaを満たした後だけCompleteへ変更する。
3. 承認・Capability・効果分類のinvariant変更は、先にADR 008をamendする。
4. Gate C／D領域の変更は本書ではなくagent-collaboration-roadmap側で行う。
5. implementation Evidenceはmerged PR linkとして残し、Chat historyをauthorityにしない。
