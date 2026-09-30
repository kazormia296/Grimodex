# ADR 008: Agent既定モードと書き込み承認境界

## Status

Accepted — 2026-08-19

本ADRは、ChatのAgent実行を既定で有効化する際の、実行経路選択、ツール効果分類、
人間承認、Capability発行の境界を確定する。対象はChat Agentのツール実行経路全体、
すなわちrenderer executor、Electron mainのAgent Authority Capability、
AIポリシー、Tool manifestである。

本ADR自体はDBテーブル、IPC command、UIを追加しない。実装順序と投資Gateは
[`docs/plans/agent-auto-write-safety-roadmap.md`](../plans/agent-auto-write-safety-roadmap.md)
が正本となる。

本ADRは、以下のCanonical DBおよびmutation境界に従属する。

- [ADR 003: DB Authority and Schema Contract](003-db-authority-and-schema-contract.md)
- [ADR 006: Narrative Mutation Origin and Authority Routes](006-narrative-mutation-authority-routes.md)
- [ADR 007: Agent共同作業の実行・Task・投機的Workspace境界](007-agent-collaboration-execution-boundary.md)

ADR 007が定める承認invariant（destructive・external・broad structure effectは常に
明示的な人間承認を要する）に対し、本ADRはツールCapability層での強制手段を定める。
ADR 007と矛盾する場合はADR 007のamendmentを先行させる。

## Context

現代のAIチャット製品では、必要な情報を自律的に検索・横断参照して回答を組み立てる
ところまでが既定の体験である。GrimodexのAgent機能を知らないユーザーが横断的な質問を
して、現在Sceneへ注入済みの情報だけから浅い回答を得た場合、ユーザーはGrimodexの
AI連携そのものが弱いと判断する。初回体験の品質のため、Agentは既定で有効化したい。

しかし現行実装の検証により、単純な既定ON化を許容できない事実が確認された。

- `agentMode`は初期値`false`で永続化されない
  （`src/features/chat/chatStore.ts`、`resetForProject`で`false`へ戻る）。
- Agent要求時にツール非対応モデルへ当たると通常chatへ退避するが、
  `agentMode`はONのまま、かつRAGも`!agentMode`条件により無効のままとなる
  （`src/application/chat/chatTurnRouting.ts`の`ragActive`／`agentToolsSuppressed`）。
- モデル能力が不明な場合のフォールバックは`supportsTools: true`の楽観扱いである
  （`src/features/chat/agent/modelLimits.ts`の`DEFAULT_CAPABILITIES`）。
- Tool manifestの`requiresUserConfirmation`は宣言のみで、実行時には
  renderer executorもmain Capability発行も参照しない。変更系15ツールのうち、
  正規状態へ直接適用しないのは`propose_scene_body`（staged accept/reject）だけであり、
  `apply_ai_tree_plan`を含む14ツールはポリシー通過後に即時実行される。
- AIポリシーの既定は`full`（bodyWrite / structureWrite / knowledgeWrite全有効）で、
  保存値が壊れている場合も既定へfail-openする（`src/features/ai-policy/parse.ts`）。
- Electron mainのAgent Authority Capabilityは、LLM応答受信時点でポリシー判定のみを
  経て発行される（`electron/main/ipc.ts`）。sender、project、toolName、toolCallId、
  canonical input digest、provenanceを束縛するTTL 5分の強い技術的Authorityだが、
  人間による承認ではない。

つまり「AgentをONにする」ことが、現状では「AIに無確認の知識ベース書き込みと
即時構造変更を許す」ことと不可分になっている。既定ON化の前に、この結合を
切断しなければならない。

## Decision

### 1. Thinkingは既定ONを維持し、Agentは既定`auto`とする

AI設定の`thinkingEnabled: true`は現状維持する。

Agentモードはboolean既定値の反転ではなく、ユーザー設定
`agentPreference: "auto" | "off"`として導入し、既定を`auto`とする。

- `auto`はUI上Agent ONとして提示し、実行経路はモデル能力に応じて解決する。
- ユーザーの明示的`off`はプロジェクトリセット・再起動を越えて永続化する。
  現行のように`resetForProject`で既定へ戻さない。

### 2. Autoは実行経路の自動選択であり、書き込み同意ではない

`agentPreference: "auto"`が自動で許可するのは以下だけである。

- 読み取りツール（search / get / list系）の自律実行。
- Proposal・Artifactを作成するだけで正規状態を変更しないステージング。

正規状態（Canonical SQLite）への書き込みは、Task単位の承認（将来のTask Grant）
または個別承認を必要とし、破壊的操作は常に個別承認とする。
「Agentが既定ONだから」を理由に既存の書き込み権限を暗黙拡張しない。

### 3. Tool manifestを`effect`と`approvalMode`へ拡張する

`requiresUserConfirmation: boolean`は意味の異なる要求を混在させているため、
以下の2軸へ置き換える。

```ts
effect: "read" | "stage" | "mutate" | "destructive"
approvalMode: "none" | "task-scope" | "always"
```

- `read / none` — 自動実行可能。
- `stage / none` — Proposal・Artifact作成まで自動。正規状態への適用は別途承認。
- `mutate / task-scope` — 承認済みTask Grantの範囲内なら実行可能。範囲外または
  Grant不在時は個別承認。
- `destructive / always` — Task承認済みでも毎回個別確認。

再分類の要点:

- `propose_scene_body`は`effect: "stage"`とする。提案作成自体は自動でよく、
  承認対象は後段の本文適用である（既存のaccept/reject＋auto-accept opt-in構造を維持）。
- 現行`requiresUserConfirmation: true`の`apply_ai_tree_plan`は`mutate`または
  `destructive`とし、`delete_event`・`remove_event_relation`は`destructive / always`とする。
- 現行confirm不要の変更系11ツール（`create_codex_entry`等）は`mutate / task-scope`とする。

manifest（`agent-tool-manifest.json`）が引き続き正本であり、TS・Rust両側の
ビルド時整合性チェックを新分類へ拡張する。

### 4. Capabilityは承認確定後に発行し、二重ゲートで検証する

renderer executorのみの確認ダイアログは境界にならない。Capabilityを保持する
rendererが確認UIを迂回すれば実行できるためである。正しい境界は次の二重ゲートとする。

1. rendererが確認・待機状態を管理する。
2. mainが「承認済みであること」を検証してから、実行可能なCapabilityを発行する。

現行の「LLM応答受信時点でのCapability発行」は、`effect: "read"`および
`effect: "stage"`のツールに限って維持してよい。`mutate`・`destructive`については、
承認（またはTask Grantによる充足）が確定するまでCapabilityを発行しない。

承認待ちの間、既発行Capabilityを保存して延命してはならない。TTL 5分で失効し、
再起動を跨ぐ承認に使えないためである。承認時には保存された承認対象を再検証し、
新しい一回限りのCapabilityへ交換する。

### 5. 承認はdurableなApprovalRequestとして表現する

承認はモーダルの開閉状態ではなく、「Runがこの正規状態変更を提案し、人間の判断を
待っている」という実行状態である。ADR 007のAgentRunInteractionの一種として、
最低限以下を持つApprovalRequestを定義する。

- 対象: `toolName`、`toolCallId`、`effect`、canonical arguments、canonical args digest。
- スコープ: `projectId`、target scope、base versions（OCC）、read-set digest。
- 文脈: preview artifact参照、manifest version、policy digest、`runId`／`taskId`。
- 状態: `pending / approved / rejected / expired / superseded / executed`。

実行時にmainは、digest不変、対象Project不変、OCC versionが不変または安全に
rebase可能、ポリシーが現在も有効、Runが取り消されていない、承認が未使用、を
検証してから新Capabilityを発行する。

初期実装ではApprovalRequestをメモリ上に置いてよいが、型・digest・main交換APIは
最初から永続形式（ADR 007のdurable interaction）に合わせる。

### 6. ルーティングは要求と実効を分離し、退避時にRAGを再評価する

storeの要求値と実際の実行経路を分離する。

```ts
agentPreference: "auto" | "off"
effectiveMode: "agent" | "rag" | "chat" | "fallback-chat"
fallbackReason: "tools-unsupported" | "provider-unsupported"
  | "model-capability-unknown" | null
```

Auto時の解決順は「ツール対応ならAgent、非対応かつRAG利用可能ならRAG、
それ以外は通常Chat」とする。現行実装はツール非対応退避時に`ragActive = false`へ
落とすが、今後は`agentPreference`をOFF扱いした条件でRAG適格性を再評価する。

`agentToolsSuppressed`は既にroute policyの算出結果として存在するため、新たな
mutable stateを増やさず、route policyからUI projection（「このモデルでは
通常チャットとして動作」等の表示）を導出する。

### 7. ツール能力は3値とし、不明時は試行から退避する

```ts
toolSupport: "supported" | "unsupported" | "unknown"
```

`unknown`（現行の楽観フォールバック`supportsTools: true`に相当）はAgent経路を
試行してよいが、provider側のツール非対応エラーを受けた場合は、同一Runの新しい
Attemptとして通常Chatへ自動再試行する。Ollamaの選択モデル再プローブと会話モデル
退避（`src/application/chat/chatOllamaPreflight.ts`）は既にこのパターンの実装であり、
他のOpenAI互換経路へ一般化する際の参照とする。

### 8. Tool Catalog Snapshot・Run Grant・承認を分離する

Session単位のAgent Toolスナップショット（`sessionAgentToolsSnapshot`）は、
モデルへ提示したツール定義の版を記録する再現性のためのCatalog Snapshotであり、
権限セットではない。

```text
Session Tool Snapshot = このSessionでモデルに提示したツール定義の版
Run Tool Grant        = このRunが実際に使ってよい効果範囲
Approval              = この具体的操作を実行してよいという判断
```

Snapshotに変更ツールが含まれることは、その実行許可を意味しない。

### 9. AIポリシーのparseは書き込み権限をfail-closedにする

`parseAiPolicy()`は「未設定」と「壊れている」を区別する。

```ts
type ParsedAiPolicy =
  | { state: "valid"; policy: AiPolicy }
  | { state: "missing"; policy: AiPolicy }
  | { state: "invalid"; safePolicy: AiPolicy };
```

- `missing` — 新規Projectの明示された製品既定値を使ってよい。
- `invalid` — Chat・読み取りは許可してよいが、`bodyWrite / structureWrite /
  knowledgeWrite`は`false`とし、UIに「AIポリシーが壊れているため書き込みを
  停止した」と表示する。

Agent Auto既定化後、設定破損が自動書き込み許可へ変換される現行挙動は許容しない。

## 権限の層構造

上の層は下の層を代替しない。

```text
1. AgentPreference (auto / off)
     └─ どの実行経路を選びたいか
2. AiPolicy (chat / bodyWrite / structureWrite / knowledgeWrite)
     └─ そのProjectで許し得る最大権限
3. Task Grant
     └─ このWorkPlanで何を変更してよいかという人間の承認範囲
4. ApprovalRequest
     └─ Grant外、または常時確認対象の具体的操作
5. Main-issued Execution Capability
     └─ 検証済みの一回のtool callを実行する技術的Authority
```

- Agent Autoだから書いてよい、ではない。
- AiPolicyが`full`だから今回のTaskで書いてよい、ではない。
- Taskを承認したから破壊的操作も無確認、ではない。
- 人間が承認したから古いversionへそのまま適用してよい、ではない。

## Invariants

1. `agentPreference: "auto"`は読み取りとステージングだけを自動実行できる。
2. `effect: "mutate"`のツールは、有効なTask Grantまたは`approved`な
   ApprovalRequestなしに実行できない。
3. `effect: "destructive"`のツールは、Task Grantの有無にかかわらず個別承認なしに
   実行できない。
4. `mutate`・`destructive`のCapabilityは承認確定前に発行されない。
5. 承認はCapabilityの保存ではなくApprovalRequestとして保存され、実行時に
   再検証のうえ一回限りのCapabilityへ交換される。
6. ApprovalRequestは一度だけ`executed`へ遷移できる（idempotent・OCC保護）。
7. ユーザーの明示的`off`はリセット・再起動を越えて保持される。
8. ツール非対応による通常Chat退避時、RAG適格性は`agentPreference`をOFF扱いした
   条件で再評価される。
9. `effectiveMode`と`fallbackReason`はroute policyから導出され、UIは要求値では
   なく実効値を表示する。
10. Session Tool Snapshotは権限判定に使用されない。
11. AIポリシーのparse失敗は書き込みトグルをfail-closedにする。
12. renderer単独の確認UIは承認境界とみなさない。承認検証はmainのCapability
    発行時に行われる。

## Consequences

- Agent Auto既定化は、Gate A（書き込み安全境界）の完了を絶対的な前提とする。
  順序はRoadmapが管理する。
- 既存の`full`ポリシー利用者にとって、確認なしで実行されていた変更系ツールが
  承認要求へ変わる。これは意図した挙動変更であり、Task Grant（ADR 007 /
  agent-collaboration-roadmapのSessionTasks）導入により連続実行の利便性を回復する。
- `requiresUserConfirmation`は`effect`／`approvalMode`へ移行し、移行完了後に
  廃止する。移行期間中の二重定義はビルド時整合性チェックで検出する。
- ApprovalRequestの型とdigest検証を最初から永続形式に合わせるため、初期の
  メモリ実装にも設計コストがかかる。これはGate C（durable AgentRun）での
  再設計を避けるための投資である。

## Rejected alternatives

- **`agentMode`初期値の単純な`true`化。** 表示上ONだが実際は通常chatかつRAGも
  無効という中途半端な状態を生み、かつ無確認の書き込みツール14個を初回体験へ
  そのまま露出する。
- **renderer executorのみでの確認ゲート。** Capabilityを持つrendererが確認UIを
  迂回すれば実行できるため、境界にならない。
- **`requiresUserConfirmation` booleanの実行時配線だけで完了とする。** 応急処置
  としては有効だが、「ステージングの承認不要性」「破壊的操作の常時確認」
  「Task範囲承認」という異なる意味を1bitへ潰し続けることになる。
- **既発行Capabilityの保存による承認待ち。** TTLで失効し、再起動を跨ぐ承認に
  使えない。承認対象の再検証もできない。
- **Task基盤（SessionTasks）完成までAgent Auto導入を延期する。** Gate A完了後は
  個別承認だけでも安全に既定Auto化でき、初回体験の改善を先に提供できる。
- **すべての変更承認を別モデルへ委ねる。** ADR 007と同じ理由で、reviewer出力は
  確率的でありtyped capability・OCC・必須の人間判断を代替できない。

## References

- [ADR 007: Agent共同作業の実行・Task・投機的Workspace境界](007-agent-collaboration-execution-boundary.md)
- [Agent Auto / Write-Safety Roadmap](../plans/agent-auto-write-safety-roadmap.md)
- [Agent Collaboration / Background Agent Roadmap](../plans/agent-collaboration-roadmap.md)
