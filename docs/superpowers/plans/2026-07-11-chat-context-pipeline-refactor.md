# Chat Context Pipeline Refactor Implementation Plan

> **For agentic workers:** Implement this plan PR-by-PR. Each PR must keep the
> application runnable and must not combine a structural move with an unrelated
> semantic change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Planned

**Goal:** Chat のコンテキスト収集・時点解決・可視性判定・予算選択・
provider payload 構築を、型付き `ContextPlan` パイプラインへ段階移行する。
実送信 payload のコンテキスト上限を保証し、preview / copy / send / Agent、
scene / folder / project / codex / snippet / thread の全経路を同じ正本へ統合する。

**Architecture:** 最初に `ResolvedTurnRoute` と `SystemDelivery` を導入して、
実モデル・実送信本文・出力上限を送信単位で固定する。その後、既存ロジックを
Application Service へ移し、L4 から `ContextItem` 化する。最終形は
`Sources -> TemporalResolver -> VisibilityPolicy -> BudgetSelector -> Renderer ->
ExactPayloadVerifier`。Zustand は UI / session / streaming state に限定する。

**Tech Stack:** TypeScript 6 / React 19 / Zustand / Drizzle ORM / Tauri v2 / Rust /
Vitest / tiktoken / SQLite FTS5。

**Predecessor:**
`docs/superpowers/plans/2026-06-15-chat-prompt-builder-unification.md`。
先行計画で scene scope の preview / copy は共通 helper へ寄せられたが、
send / Agent / non-scene scope、provider cache payload、時点解決、予算の正本は
まだ統合されていない。本計画はその後続である。

---

## 1. 現状調査で確認した問題

### 1.1 `chatStore` と `contextBuilder` の責務集中

- `src/features/chat/chatStore.ts` は約 5,600 行あり、session state に加えて
  model routing、Agent loop、Codex、Phase、Chronicle、Plot Thread、Map、Beat、
  Foreshadow、semantic/chat recall、prompt snapshot、transport を直接扱う。
- scene scope は `buildSceneContextPrompt`、non-scene scope は
  `refreshContextLayers` 内の別ロジックで構築され、同じ仕様が二重化している。
- `src/features/chat/contextBuilder.ts` は DB 非依存だが、DTO、render、trim、
  L4 priority、prompt hardening、tokenizer、cache segmentation、UI breakdown を
  1 ファイルで扱う。

### 1.2 trim 後の表示と cache 経路の実送信が一致しない

- stable L4 は trim 前に `l4StableSegment` へ保存される。
- `trimToFit` が削るのは `effectiveL4` だけである。
- cache payload は `l4StableSegment || effectiveL4` を選ぶため、prompt 側で
  消えたエントリが cache 経路で復活し得る。
- `totalTokens` と ContextBar は trim 後の `effectiveL4` を数えるため、
  実送信量を過小表示する。
- `contextBuilder.test.ts` の
  `keeps cache-side stable L4 ... when trim empties prompt-side L4` が、この挙動を
  現行仕様として固定している。

### 1.3 provider adapter が fallback prompt を置換する

- TypeScript は `prompt`、`cacheSegments`、`volatileTail` を別々に渡す。
- Anthropic / OpenRouter Claude では Rust の `build_system_payload` /
  `build_openai_chat_messages` が fallback system 本文を content blocks へ置換する。
- 現在の prompt snapshot は fallback prompt を保存しており、cache provider に
  実際に渡った blocks を再現できない。

### 1.4 予算に使う route と実送信 route がずれる

- `buildSceneContextPrompt` は composer override / default model から能力を解決する。
- 通常送信はさらに conversation role routing、Agent は agent role routing を使う。
- cross-provider override 時も、builder が active provider 側の settings を参照する
  余地がある。
- ContextBar も実効 route ではなく既定 model を見る経路がある。

### 1.5 final payload budget check がない

現行計測には次が含まれない、または別契約になっている。

- provider message framing / envelope
- Agent tool schema、tool result、assistant tool call
- Hermes の `<tools>` system XML
- CLI の role tag 付き flatten 後テキスト
- build 後に追加される RAG 安全指示
- wire 上の `max_tokens` と同じ出力予約
- tokenizer 差異に対する safety margin

focus は trim 対象外であり、focus または L0 単独で context window を超えても
明示的に reject されない。

### 1.6 Phase 解決値が Chat 注入へ一貫して反映されない

- mention / always / hidden 判定は Base `contextMode` で行われる。
- detected entry は主に `summary` と `phaseLabel` だけが解決値へ置換される。
- pinned entry の `content`、直接子、custom details は Base 値から構築される。
- project/global scope の Codex も多くが Base 値のままである。
- 設計書は `summary / content / details / contextMode` のすべてを Phase 解決後の
  値で注入すると定義しており、実装と乖離している。

### 1.7 mixed story-time が未来 Phase を過去シーンへ漏らし得る

- `story` と `auto` は現在同じ実装である。
- `storyTimeOrder` 設定済みシーンを先に並べ、未設定シーンを reading order で
  末尾へ追加する。
- 第 8 章だけ時刻設定した場合、未設定の第 1 章が内部的に第 8 章より後ろになり、
  第 8 章 anchor の Phase が第 1 章へ適用され得る。
- `ADR-002` は部分設定時の現挙動を妥当と説明する一方、Codex 詳細設計は
  `SceneTimeIndex` と all-or-nothing fallback を将来仕様としている。先に ADR を
  更新して意味を一本化する必要がある。

### 1.8 Codex 本文を毎ターン全件ロードする

- `listCodexEntriesForContext` は icon / notes / readings を除くが、全 entry の
  ProseMirror `content` を返す。
- generic `db_execute` IPC で全行を JSON 化するため、数千 entry で転送量と
  plain text 抽出が支配的になる。
- Phase / details query が seed と descendants で重複し、pin API も full row を
  再取得する。
- relation は depth 1 しか使わない場面でも全 project edge を取得する。

---

## 2. 採用する設計判断

### 2.1 優先順位

1. **P0:** 実 route と実 payload を固定し、context window 超過を止める。
2. **P0/P1:** Phase の時間軸と effective visibility を安全側へ修正する。
3. **P1:** 既存挙動を保ったまま Application Service へ抽出する。
4. **P1:** L4 から型付き `ContextItem` へ移行する。
5. **P1:** 全 scope / surface を同じ Planner へ統合する。
6. **P1/P2:** Codex を二段階ロードへ変更する。
7. **P2:** diagnostics、snapshot、旧経路削除を完了する。

### 2.2 Phase resolution mode

本計画では次を推奨仕様とする。実装開始前に `docs/adr/002-phase-resolution-modes.md`
を更新して採用を明文化する。

| Mode | Semantics |
|---|---|
| `reading` | 常に tree DFS の reading order を使う |
| `auto` | live scene の全件に非空 `storyTimeOrder` が揃うまでは project 全体を reading。揃ったら story |
| `story` | explicit / inherited story time を使う。current または当該 entry の Phase anchor が同じ軸で引けない場合、その entry 全体を reading へ fallback |

`story` は部分設定中でも作中時系列を明示的に使いたい power user 向け、`auto` は
既定値として未来情報を漏らさない安全側とする。

### 2.3 effective `contextMode`

Phase 解決後に次の順で policy を適用する。

1. `hidden`: pin 済みでも注入しない。
2. `always`: mention の有無にかかわらず注入する。
3. `mentioned`: matcher で言及された場合に注入する。
4. `suppress`: explicit pin がある場合のみ注入する。
5. children も親とは独立して effective mode を評価する。

### 2.4 relation-derived entry

初期 refactor では現在の安全契約を維持する。relation discovery だけで引き込んだ
entry は「名前 + 関係ラベル」のみを出し、未解決 summary / content は出さない。
resolved summary の追加は別評価・別 PR とする。

### 2.5 prompt cache

- cacheability は「trim 免除」を意味しない。
- cache split は BudgetSelector の後に行う。
- plain と cached delivery は同じ ordered item 列から render する。
- cache は semantic order を変更せず、content block の境界だけを加える。
- cache hit 率より context window 安全性を優先する。

### 2.6 `lastSystemPrompt`

`lastSystemPrompt` は UI preview cache としてのみ残す。実送信では必ず、その送信時点の
immutable `TurnRequest` から `FinalizedTurnPayload` を作る。stale key が一致したから
過去 prompt を送る経路は廃止する。

### 2.7 「exact」の定義

Budget Guard は、provider に渡す exact content blocks / messages / tool schemas /
tool results を対象にする。provider 固有 tokenizer をローカルで完全再現できない場合は、
現行 tokenizer に provider envelope と safety margin を加える。provider が返す actual
input usage を保存し、planned/actual drift を観測可能にする。

---

## 3. 不変条件

### 3.1 Payload budget

```text
count(exact delivered system)
+ count(exact delivered conversation)
+ count(tool schemas and tool protocol)
+ provider envelope
+ safety margin
+ wire output reservation
<= resolved model context window
```

- 通常送信は IPC 直前に検査する。
- Agent は LLM iteration ごとに再検査する。
- cached candidate だけが超過する場合は plain delivery へ downgrade できる。
- plain delivery も超過する場合は再選択し、それでも不可能なら deterministic error を
  ユーザーへ返す。黙って送信して provider error に委ねない。

### 3.2 Temporal / secrecy

- current scene より未来の Phase 値を注入しない。
- effective `hidden` entry は、pin / mention / child / relation / scope anchor のどの経路でも
  payload に存在しない。
- pinned / detected / descendants / project scope は同じ resolver 結果を使う。

### 3.3 Reproducibility

- snapshot は送信時に確定した immutable payload と route を保存する。
- snapshot の system delivery と IPC DTO が一致する。
- 同じ `TurnRequest` は同じ `ContextPlan.digest` を返す。

### 3.4 Explainability

- 全 candidate は `selected / trimmed / excluded / unavailable` の decision を持つ。
- selected item は source、authority、selection reason、as-of scene、token count を持つ。
- removed item は trim / policy / duplicate / missing / source failure の理由を持つ。

### 3.5 Performance

- 通常 turn で未選択 Codex の ProseMirror `content` を転送しない。
- query は project-scoped である。
- details / phases / overrides / contents は選択 ID の union に対して batch 取得する。
- entry、Phase、detail、tree order、resolution mode の変更で cache が正しく無効化される。

---

## 4. Target Types

```ts
export type ScopeTarget =
  | { kind: "scene"; sceneId: string }
  | { kind: "folder"; folderId: string }
  | { kind: "project" }
  | { kind: "codex"; entryId: string }
  | { kind: "snippet"; snippetId: string }
  | { kind: "thread"; threadId: string };

export interface ResolvedTurnRoute {
  provider: AiProvider;
  model: string;
  apiVariant?: string;
  endpointId?: string;
  contextWindow: number;
  wireMaxOutputTokens: number;
  supportsPromptCache: boolean;
  toolProtocol: "native" | "hermes" | "none";
}

export interface TurnRequest {
  requestId: string;
  projectId: string;
  sessionId: string | null;
  scope: ScopeTarget;
  route: ResolvedTurnRoute;
  mode: "chat" | "agent";
  messages: PreparedMessage[];
  outgoingUserMessage: string;
  commandInstruction?: string;
  settings: TurnContextSettings;
  revisions: ContextRevisionSnapshot;
}
```

```ts
export type ContextAuthority =
  | "author_instruction"
  | "canonical"
  | "derived"
  | "retrieved"
  | "episodic";

export type ContextPayload =
  | ProjectPayload
  | ScenePayload
  | CodexPayload
  | NotePayload
  | SnippetPayload
  | ChroniclePayload
  | PlotThreadPayload
  | ForeshadowPayload
  | RecallPayload
  | InstructionPayload;

export interface ContextItem {
  key: string;
  kind: ContextPayload["kind"];
  authority: ContextAuthority;
  priority: number;
  stability: "session-stable" | "turn-volatile";
  temporal?: {
    asOfSceneId?: string;
    axis?: "reading" | "story";
    phaseId?: string;
    fallbackReason?: string;
  };
  trim: {
    mode: "atomic" | "head" | "tail" | "blocks" | "list";
    minTokens: number;
    maxTokens: number;
  };
  provenance: {
    sourceType: string;
    sourceId: string;
    sourceVersion?: string | number;
  };
  payload: ContextPayload;
}

export interface ContextDecision {
  key: string;
  status: "selected" | "trimmed" | "excluded" | "unavailable";
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ContextPlan {
  requestId: string;
  items: ContextItem[];
  decisions: ContextDecision[];
  usage: PlannedTokenUsage;
  digest: string;
}
```

```ts
export interface SystemTextBlock {
  text: string;
  cacheControl: "ephemeral" | null;
}

export interface SystemDelivery {
  plainText: string;
  blocks: SystemTextBlock[];
  mode: "plain" | "cached-blocks";
}

export interface FinalizedTurnPayload {
  route: ResolvedTurnRoute;
  plan: ContextPlan;
  system: SystemDelivery;
  messages: PreparedMessage[];
  tools?: PreparedTool[];
  usage: PlannedTokenUsage;
}
```

### `SceneTimeIndex`

```ts
export interface SceneTimeIndex {
  readingOrder: Map<string, number>;
  explicitStoryOrder: Map<string, string>;
  inheritedStoryOrder: Map<string, string>;
  liveSceneCount: number;
  scheduledSceneCount: number;
  revision: number;
}

export type TemporalAnchor =
  | { kind: "scene"; sceneId: string }
  | { kind: "latest" }
  | { kind: "base" };
```

`latest` は Codex scope で全 valid Phase を適用する用途、`base` は Base 状態のみを
参照する用途として明示し、`currentSceneId=null` と `applyAllPhases` の二重意味を廃止する。

---

## 5. Proposed File Structure

```text
src/features/ai-context/
  types.ts
  tokenCounter.ts
  budgetSelector.ts
  cachePlanner.ts
  finalizeTurnPayload.ts
  renderers/
    systemPromptRenderer.ts
    providerPayloadRenderer.ts

src/features/chat/context/
  turnContextRequest.ts
  chatContextPlanner.ts
  contextPlannerDeps.ts
  legacyPromptAdapter.ts
  sources/
    projectSource.ts
    sceneSource.ts
    codexSource.ts
    noteSource.ts
    chronicleSource.ts
    plotThreadSource.ts
    foreshadowSource.ts
    semanticRecallSource.ts
    episodicRecallSource.ts
    mapSource.ts

src/features/chat/turn/
  resolvedTurnRoute.ts
  turnCoordinator.ts

src/features/codex/context/
  sceneTimeIndex.ts
  resolveApplicablePhases.ts
  resolvedCodexContext.ts
  codexContextRepository.ts
```

`src/features/ai-context` は pure core、`src/features/chat/context` は Chat 固有の
source adapter とする。Codex の時間解決・取得は Codex feature 内へ置き、Chat から
再利用する。

---

## 6. Dependency Graph

```text
PR 0 Baseline contracts
  ├─> PR 1 Route / SystemDelivery / final budget guard
  └─> PR 2 SceneTimeIndex / temporal semantics
                    └─> PR 3 ResolvedCodexContext / visibility

PR 1 + PR 3
  └─> PR 4 Application Service extraction
        └─> PR 5 L4 ContextItem
              └─> PR 6 All sources / scopes / surfaces
                    └─> PR 7 Two-stage Codex loading
                          └─> PR 8 Diagnostics / snapshot / cleanup
```

PR 1 と PR 2 は、PR 0 後に別 worktree で並行実装できる。PR 2 の時間軸変更と
PR 3 の Chat visibility 変更はレビュー可能性のため分ける。

---

## PR 0: Baseline Contract Tests

**Purpose:** コード移動前に、維持する挙動と修正する不具合をテストで区別する。

**Files:**

- Create: `src/features/chat/context/contextPipelineFixtures.ts`
- Create: `src/features/chat/context/contextDelivery.contract.test.ts`
- Create: `src/features/chat/context/contextSurfaceParity.test.ts`
- Modify: `src/features/chat/contextBuilder.test.ts`
- Modify: `src/features/chat/chatStore.test.ts`
- Modify: `src-tauri/src/ai.rs` tests only

### Steps

- [ ] Route fixture を定義する。
  - Anthropic direct
  - OpenRouter Claude chat-completions
  - OpenRouter non-Claude
  - Responses API
  - CLI
  - Hermes agent
- [ ] 通常 / Agent、cache / non-cache の現在の exact delivery shape を固定する。
- [ ] scene / project / codex の代表 scope fixture を作る。
- [ ] preview / copy / send の system prompt、layer、token estimate の差を可視化する。
- [ ] 現行の stable L4 復活テストは `known-bug` と明記し、PR 1 で期待値を反転する。
- [ ] oversized focus / custom L0 が現在 reject されないことを再現する。
- [ ] role routing と builder の capability model が異なり得るケースを再現する。
- [ ] prompt snapshot が cache blocks ではなく fallback prompt を保存するケースを再現する。

### Verification

```bash
pnpm test --run src/features/chat/contextBuilder.test.ts
pnpm test --run src/features/chat/chatStore.test.ts
pnpm test --run src/features/chat/context/contextDelivery.contract.test.ts
cd src-tauri && cargo test ai::tests::build_system_payload
```

**Expected:** 新しい characterization tests を含め green。既知不具合はテスト名と
コメントで明示され、PR 1 / PR 2 / PR 3 のどこで期待値を変更するかが分かる。

**Suggested commit:**

```text
test(chat): context pipeline の現行 delivery 契約を固定
```

---

## PR 1: P0 Route SSOT and Exact Payload Guard

**Purpose:** 実モデル・実送信本文・wire output 上限を 1 turn の immutable contract にする。

**Files:**

- Create: `src/features/chat/turn/resolvedTurnRoute.ts`
- Create: `src/features/ai-context/finalizeTurnPayload.ts`
- Create: corresponding `*.test.ts`
- Modify: `src/features/chat/chatStore.ts`
- Modify: `src/features/chat/contextBuilder.ts`
- Modify: `src/features/chat/chatApi.ts`
- Modify: `src/features/chat/agent/agentLoop.ts`
- Modify: `src/features/chat/agent/modelLimits.ts`
- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/ai.rs`

### Red tests

- [ ] cross-provider / per-role route で builder、transport、ContextBar が同じ model を使う。
- [ ] `contextWindow=500` で trim された stable entry が cache blocks にも存在しない。
- [ ] cached delivery だけ超過した場合、trim 済み plain delivery へ downgrade する。
- [ ] oversized focus は body を policy に従って trim する。
- [ ] custom L0 単独超過は deterministic error を返す。
- [ ] RAG safety instruction を追加した後の値で budget を検査する。
- [ ] CLI flatten / Hermes tool XML / Agent tools を含める。
- [ ] Agent は tool result 追加後の各 iteration で再検査する。
- [ ] 送信中に store を更新しても finalized payload の route / token / prompt が変化しない。

### Implementation

- [ ] `ResolvedTurnRoute` を send 開始時に一度だけ構築する。
- [ ] wire `max_tokens` と planner の output reservation を同じ値から導出する。
- [ ] `buildSceneContextPrompt` 内部の model 再解決を削除し、route を引数で受ける。
- [ ] L4 stable / volatile split を trim 後の surviving item/block から行う。
- [ ] `SystemDelivery` を生成し、route に応じて plain / cached blocks を選ぶ。
- [ ] `finalizeTurnPayload()` で exact delivered values を計測する。
- [ ] output reservation と safety margin を含めて invariant を検査する。
- [ ] Agent loop の `sendToLLM` 直前にも finalizer を通す。
- [ ] P0 では既存 IPC 引数を内部で組み立ててもよいが、finalizer の immutable result を
  transport と snapshot の両方へ渡す。

### Acceptance

- [ ] `SystemDelivery` に存在しない文字列が Rust 側で復活しない。
- [ ] route table の全ケースで budget invariant が成立する。
- [ ] stable L4 の既知不具合テストが安全側の期待値へ反転する。
- [ ] provider cache 無効化は正常な fallback として扱われ、ユーザー入力を失わない。

### Verification

```bash
pnpm test --run src/features/ai-context/finalizeTurnPayload.test.ts
pnpm test --run src/features/chat/contextBuilder.test.ts
pnpm test --run src/features/chat/chatStore.test.ts
pnpm test --run src/features/chat/agent/agentLoop.test.ts
cd src-tauri && cargo test ai::tests
```

**Suggested commit:**

```text
fix(chat): 実送信 payload の route と token budget を一本化
```

---

## PR 2: SceneTimeIndex and Safe Phase Semantics

**Purpose:** mixed story-time の意味を確定し、Phase 適用順を入力配列順から独立させる。

**Files:**

- Modify first: `docs/adr/002-phase-resolution-modes.md`
- Modify: `docs/Grimodex_Codexパネル設計書.md`
- Create: `src/features/codex/context/sceneTimeIndex.ts`
- Create: `src/features/codex/context/sceneTimeIndex.test.ts`
- Create: `src/features/codex/context/resolveApplicablePhases.ts`
- Create: corresponding tests
- Modify: `src/features/codex/phaseResolver.ts`
- Modify: `src/features/codex/phaseStore.ts`
- Modify: `src/features/tree/treeStore.ts`
- Modify: `src/features/tree/api.ts`
- Modify direct phase-order consumers under Codex / Editor / post-effect

### Specification first

- [ ] ADR に `reading / auto / story` の新 semantics を記録する。
- [ ] auto coverage の対象を「削除されていない scene node 全件」と定義する。
- [ ] empty / whitespace `storyTimeOrder` は未設定として扱う。
- [ ] story inherited、leading unscheduled、deleted anchor、latest/base の意味を定義する。
- [ ] same story key の tie-break を reading order -> phase createdAt -> phase id とする。

### Red tests

- [ ] 第 8 章だけ scheduled、第 1 章 unscheduled の auto で未来 Phase を適用しない。
- [ ] 全未設定 auto は reading と同じ。
- [ ] 全設定 auto は story と同じ。
- [ ] explicit story mode で current/anchor の軸不足時は entry 全体を reading fallback。
- [ ] 同じ story key でも入力 nodes / phases の permutation で結果が変わらない。
- [ ] deleted anchor は skip する。
- [ ] `updateStoryTime(id, null)` 後、DB reload しても null のまま。
- [ ] `latest` は全 valid Phase、`base` は Phase なしを返す。

### Implementation

- [ ] mode に依存しない `SceneTimeIndex` を構築する。
- [ ] `resolveApplicablePhases()` を sort / gate の唯一の公開 API にする。
- [ ] `resolveCodexState()` は applicable phases の適用だけを担当する。
- [ ] `ResolvedCodexState` に `activePhaseId`、`activePhaseLabel`、`axisUsed`、
  `fallbackReason` を追加する。
- [ ] UI migration 中だけ legacy display map を derived value として残す。
- [ ] DetailsTab / PhaseIndicator / TimelineTab / Editor / TabBar / spoiler flags /
  consistency payload の直接 `Map <=` 比較を共通 API へ置換する。
- [ ] Related Scenes の linear display order は Phase semantics と分け、専用関数に残す。
- [ ] temporal revision / phase revision を prompt invalidation に反映する。

### Acceptance

- [ ] UI、Chat、post-effect が同じ applicable phase IDs を返す。
- [ ] Phase resolution が DB 行順や配列順に依存しない。
- [ ] ADR と Codex 設計書の記述が一致する。

### Verification

```bash
pnpm test --run src/features/codex/context/sceneTimeIndex.test.ts
pnpm test --run src/features/codex/context/resolveApplicablePhases.test.ts
pnpm test --run src/features/codex/phaseResolver.test.ts
pnpm test --run src/features/codex/phaseStore.test.ts
pnpm test --run src/features/tree/treeStore.storyTime.test.ts
```

**Suggested commit:**

```text
fix(codex): mixed story-time の Phase 解決を安全側へ統一
```

---

## PR 3: Resolved Codex Context and Visibility Policy

**Purpose:** Chat へ渡す Codex の summary / content / details / contextMode を、
すべて同じ時点解決結果から生成する。

**Files:**

- Create: `src/features/codex/context/resolvedCodexContext.ts`
- Create: corresponding tests
- Create: `src/features/chat/context/codexVisibilityPolicy.ts`
- Create: corresponding tests
- Modify: `src/features/chat/chatStore.ts`
- Modify: `src/features/codex/childrenBudget.ts`
- Modify: `src/features/chat/contextBuilder.ts` integration tests

### Red tests

- [ ] Base mentioned -> Phase hidden: anchor 以降は prompt に存在しない。
- [ ] Base hidden -> Phase mentioned: anchor 以降、mention 時だけ存在する。
- [ ] Base mentioned -> Phase always: anchor 以降、mention 無しでも存在する。
- [ ] Base always -> Phase suppress: pin 無しでは除外、pin 有りでは注入する。
- [ ] effective hidden は DB pin / input pin / scope anchor / child 経路でも除外する。
- [ ] detected / pinned の summary、content、custom details に Phase override が反映される。
- [ ] descendants は resolved summary/content を使い、未来 marker を含まない。
- [ ] relation discovery は引き続き label のみで、生 summary/content を出さない。
- [ ] project / folder / codex scope も scene scope と同じ policy を使う。

### Implementation

- [ ] `TemporalAnchor` を受ける batch `resolveCodexContexts()` を作る。
- [ ] Base details と Phase detail overrides を同時に解決する。
- [ ] `ResolvedCodexContext` から lightweight / spotlight / child render payload を作る。
- [ ] visibility policy を temporal resolution の後へ移す。
- [ ] suppress と hidden を区別する。
- [ ] children は個別 mode を評価し、親 mode を伝播しない。
- [ ] codex scope の `applyAllPhases` を `TemporalAnchor.latest` へ置換する。

### Acceptance

- [ ] Codex 注入経路に Base row から直接 `content` を組み立てる分岐が残らない。
- [ ] `hidden` / future marker regression tests が全 scope で green。
- [ ] relation label-only safety test が維持される。

### Verification

```bash
pnpm test --run src/features/codex/context/resolvedCodexContext.test.ts
pnpm test --run src/features/chat/context/codexVisibilityPolicy.test.ts
pnpm test --run src/features/chat/contextBuilder.test.ts
pnpm test --run src/features/chat/chatStore.test.ts
```

**Suggested commit:**

```text
fix(chat): Phase 解決済み Codex state で visibility と注入を統一
```

---

## PR 4: Extract Turn Context Application Service

**Purpose:** 挙動と prompt bytes を維持したまま、コンテキスト構築を Zustand から外す。

**Files:**

- Create: `src/features/chat/context/turnContextRequest.ts`
- Create: `src/features/chat/context/contextPlannerDeps.ts`
- Create: `src/features/chat/context/chatContextPlanner.ts`
- Create: `src/features/chat/context/legacyPromptAdapter.ts`
- Move/extract helpers from `src/features/chat/chatStore.ts`
- Modify: `src/features/chat/chatStore.ts`
- Create: planner tests with injected fake repositories

### Red tests

- [ ] planner は `TurnRequest` と fake deps だけで scene plan を構築できる。
- [ ] planner 内から Zustand / `getCurrentProjectId()` を参照しない。
- [ ] old builder と extracted service が同じ prompt / cache segments / tail / layers を返す。
- [ ] source failure は全体を throw せず diagnostic を返す。ただし必須 source failure は
  explicit fatal error にする。
- [ ] project isolation: request project と異なる row を返しても policy が拒否する。

### Implementation

- [ ] `TurnRequestFactory` が store state を一度だけ snapshot する。
- [ ] `ContextPlannerDeps` に repository / matcher / tokenizer / clock を注入する。
- [ ] `buildSceneContextPrompt`、scope aggregation、Chronicle、Map、Plot Thread helper を移す。
- [ ] planner から global store read を除去する。
- [ ] `chatStore` は request 作成、service 呼び出し、UI state 適用、transport 起動だけにする。
- [ ] dev/test shadow mode で legacy / extracted result digest を比較できるようにする。

### Acceptance

- [ ] この PR では user-visible prompt semantics を変更しない。
- [ ] golden fixture で byte parity が取れる。
- [ ] `chatStore.ts` から context source の DB query が消える。

### Verification

```bash
pnpm test --run src/features/chat/context/chatContextPlanner.test.ts
pnpm test --run src/features/chat/context/contextSurfaceParity.test.ts
pnpm test --run src/features/chat/chatStore.test.ts
npx tsc --noEmit
```

**Suggested commit:**

```text
refactor(chat): context planning を Application Service へ抽出
```

---

## PR 5: Typed L4 Context Items

**Purpose:** 文字列化前に L4 の選択・優先順位・trim・cacheability を決める。

**Files:**

- Create: `src/features/ai-context/types.ts`
- Create: `src/features/ai-context/tokenCounter.ts`
- Create: `src/features/ai-context/budgetSelector.ts`
- Create: `src/features/ai-context/cachePlanner.ts`
- Create: corresponding tests
- Modify: `src/features/chat/context/chatContextPlanner.ts`
- Modify: `src/features/chat/contextBuilder.ts`
- Modify: `src/features/codex/childrenBudget.ts`

### L4 items in scope

- Codex detected / always / explicit pin
- Codex children
- relation label item
- Note
- Snippet
- Sticky
- Map board

### Red tests

- [ ] priority が marker や見出し regex に依存しない。
- [ ] `episodic < retrieved < derived < canonical < explicit focus/instruction` の保持順を検証する。
- [ ] atomic item は途中で壊れず、block/list item は policy 単位で縮む。
- [ ] stable item も budget 超過時は trim/drop される。
- [ ] focus は identity/summaryを保持し、full bodyだけ縮められる。
- [ ] plain/cached delivery の ordered item keys が一致する。
- [ ] duplicate item は provenance を統合し、本文を二重注入しない。

### Implementation

- [ ] L4 candidate を `ContextItem` へ変換する。
- [ ] item ごとに render 前 token estimate を持つ。
- [ ] `BudgetSelector` が decision record を返す。
- [ ] `CachePlanner` は selected items だけを stable / volatile に分類する。
- [ ] `<!-- l4pri:n -->` marker と marker regex を削除する。
- [ ] `childrenBudget.ts` の Chat tokenizer 直接 import を shared token counter へ移す。
- [ ] relation、children、pin の dedup を key ベースにする。

### Acceptance

- [ ] final prompt / blocks に `l4pri` marker が存在しない。
- [ ] ContextPlan から、各 L4 item が残った/消えた理由を説明できる。
- [ ] legacy renderer との内容 parity fixture が green。

### Verification

```bash
pnpm test --run src/features/ai-context/budgetSelector.test.ts
pnpm test --run src/features/ai-context/cachePlanner.test.ts
pnpm test --run src/features/chat/contextBuilder.test.ts
pnpm test --run src/features/codex/childrenBudget.test.ts
```

**Suggested commit:**

```text
refactor(chat): L4 context を typed item selection へ移行
```

---

## PR 6: Unify All Context Sources, Scopes, and Surfaces

**Purpose:** L1-L6 と recall 系を `ContextItem` 化し、全 scope / surface を 1 planner へ寄せる。

**Files:**

- Add source adapters under `src/features/chat/context/sources/`
- Create: `src/features/ai-context/renderers/systemPromptRenderer.ts`
- Create: `src/features/ai-context/renderers/providerPayloadRenderer.ts`
- Modify: `src/features/chat/context/chatContextPlanner.ts`
- Modify: `src/features/chat/turn/turnCoordinator.ts`
- Modify: `src/features/chat/chatStore.ts`
- Modify: `src/features/chat/chatApi.ts`
- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/ai.rs`

### Sources

- Project / author instructions
- Story so far / project and chapter outline
- Current or aggregated scene
- Previous reading/story scene
- Beat / Foreshadow / labels
- Codex / Note / Snippet / Sticky / Map
- Chronicle
- Plot Thread
- Semantic scene recall
- Episodic chat recall
- Conversation summary
- One-turn command instruction

### Red tests

- [ ] `ScopeTarget` の全 variant が同じ planner entry point を使う。
- [ ] scene / folder / project / codex / snippet / thread の representative fixture が通る。
- [ ] preview / copy / send は同じ TurnRequest から同じ plan digest を返す。
- [ ] Agent initial turn も同じ ContextPlan を使い、tool loop では messages/toolsだけ更新する。
- [ ] cache/plain provider は同じ semantic item order を使う。
- [ ] source unavailable は Context diagnostics に表示される。
- [ ] `lastSystemPrompt` が stale でも send payload に使われない。

### Implementation

- [ ] 各 source を `collect(request, deps)` の独立 adapter にする。
- [ ] independent sources は `Promise.allSettled` で並列取得する。
- [ ] source result を temporal -> policy -> budget の順で処理する。
- [ ] renderer は selected items だけを文字列化する。
- [ ] prompt hardening / reserved tag escape を renderer boundary へ残す。
- [ ] provider payload は TypeScript の `SystemDelivery` DTO を Rust がそのまま消費し、
  Rust 側で fallback と segments から意味内容を再構築しない。
- [ ] preview / copy / send / Agent の個別 builder 分岐を TurnCoordinator へ置換する。
- [ ] rollout は scene -> codex/snippet -> folder/project/thread の順で行う。
- [ ] 内部 feature flag / shadow compare は全 scope 切替後に削除する。

### Acceptance

- [ ] 1 つの `prepareTurn(request)` が全 surface の正本になる。
- [ ] `lastSystemPrompt` は UI cache 以外で参照されない。
- [ ] non-scene scope でも cache/予算/snapshot 契約が scene と同じ。
- [ ] old `buildSystemPrompt` は compatibility adapter 以外から呼ばれない。

### Verification

```bash
pnpm test --run src/features/chat/context/contextSurfaceParity.test.ts
pnpm test --run src/features/chat/chatStore.test.ts
pnpm test --run src/features/chat/ChatPanel.test.tsx
pnpm test --run src/features/chat/components/ContextBar.test.tsx
cd src-tauri && cargo test ai::tests
```

**Suggested commit:**

```text
refactor(chat): 全 scope と送信 surface を ContextPlanner へ統合
```

---

## PR 7: Two-stage Codex Loading and Resolved State Cache

**Purpose:** 毎 turn の全件本文 IPC を廃止し、候補選択後に必要 ID だけ hydrate する。

**Files:**

- Create: `src/features/codex/context/codexContextRepository.ts`
- Create: corresponding repository tests
- Modify: `src/features/codex/api.ts`
- Modify: `src/features/codex/codexCrossMentions.ts`
- Modify: `src/features/codex/childrenBudget.ts`
- Modify: `src/features/codex/codexRelationApi.ts`
- Modify: `src/features/chat/chatApi.ts` pin projections
- Modify: `src/features/chat/context/sources/codexSource.ts`
- Optional, only after measurement: dedicated Tauri batch command

### Stage 1: Catalog

`listCodexContextCatalog(projectId)` は本文を含めず、次だけを返す。

```text
id, parentId, type, name, aliases, excludedAliases,
baseContextMode, childrenBudget, version, updatedAt
```

Phase visibility 用に `entryId / anchorId / contextModeOverride / updatedAt` の軽量行を
取得し、本文 hydration 前に effective mode を判断する。

### Stage 2: Candidate closure

```text
effective visibility
-> mention / always
-> pin refs
-> descendants via childrenByParent index
-> project-scoped direct relation neighbors
-> explicit scope anchor
```

### Stage 3: Hydration

候補 ID union に対して次を batch 取得する。

```text
entry summary/content/tags/version
phases
base details
phase detail overrides
context detail definitions
```

### Red tests

- [ ] 5,000 entry catalog でも未選択 entry の `content` を返さない。
- [ ] hydrate IDs が candidate closure と一致する。
- [ ] hidden entry は hydration 前に除外できる。
- [ ] explicit pin / suppress / hidden の policy が二段階でも変わらない。
- [ ] reverse mention は FTS/LIKE で候補を絞った後、既存 exact matcher で確定する。
- [ ] direct child が grandchild より常に先で、同 level order が決定的。
- [ ] cycle / multiple seed / duplicate relation で無限 loop や重複がない。
- [ ] relation query は project + seed IDs に限定される。
- [ ] pin API は full Codex row でなく refs を返す。
- [ ] project switch で catalog / resolved cache が漏れない。

### Implementation

- [ ] Catalog API と batch hydration API を追加する。
- [ ] reverse mention を FTS candidate -> exact verify の二段階にする。
- [ ] `childrenByParent` index を一度作り、O(ND) filter を廃止する。
- [ ] BFS 後の全体 ID sort を削除し、level order を保持する。
- [ ] relation touching IDs API に projectId を必須化する。
- [ ] pin API の重複 full row fetch を削除する。
- [ ] `ResolvedCodexContext` cache を導入する。

### Cache key

```text
projectId
+ entryId
+ entryVersion
+ phase/detail fingerprint (or contextRevision)
+ temporalIndexRevision
+ TemporalAnchor
+ resolutionMode
```

entry version は Phase / detail 更新では上がらないため、単独では使わない。

### Performance acceptance

- [ ] normal scene turn の full content rows は selected closure のみ。
- [ ] catalog query、hydrate query、relation query の件数を perf log で確認できる。
- [ ] 100 / 1,000 / 5,000 entry fixture で transferred content bytes を記録する。
- [ ] generic Drizzle bulk query で十分か計測し、IPC が支配的な場合だけ dedicated bundle
  command を別 commit で追加する。

### Verification

```bash
pnpm test --run src/features/codex/context/codexContextRepository.test.ts
pnpm test --run src/features/codex/apiProjections.test.ts
pnpm test --run src/features/codex/codexCrossMentions.test.ts
pnpm test --run src/features/codex/childrenBudget.test.ts
pnpm test --run src/features/chat/context/chatContextPlanner.test.ts
```

**Suggested commit:**

```text
perf(codex): context candidate と本文 hydration を二段階化
```

---

## PR 8: Diagnostics, Exact Snapshots, and Legacy Cleanup

**Purpose:** ContextPlan の説明可能性を UI と履歴へ接続し、旧実装を削除する。

**Files:**

- Modify: `src/features/chat/components/ContextBar.tsx`
- Modify: `src/features/chat/components/PromptPreviewModal.tsx`
- Modify: `src/features/chat/chatApi.ts`
- Modify: `src/db/schema.ts`
- Modify: `src-tauri/crates/grimodex-db/src/migrate.rs`
- Modify: `src/features/chat/chatStore.ts`
- Delete or reduce: `src/features/chat/contextBuilder.ts`
- Delete: legacy adapters / feature flags after cutover
- Update: relevant design docs and ADR links

### Snapshot schema

既存 `system_prompt / layers / total_tokens / model` は backward compatibility のため残し、
少なくとも次を追加する。

```text
route_json
delivery_json
context_plan_json
planned_input_tokens
output_reservation_tokens
```

`delivery_json` は exact system blocks、`context_plan_json` は selected items と decisions を
含む。actual provider usage は assistant usage / ledger と関連付けて表示し、planned 値を
後から上書きしない。

### Red tests

- [ ] snapshot の delivery JSON と transport に渡した DTO が一致する。
- [ ] store を送信中に変更しても snapshot が混成しない。
- [ ] agent role / cross-provider route が snapshot model/providerへ反映される。
- [ ] ContextBar が system / conversation / tools / output reserve / headroom を分離表示する。
- [ ] item detail に reason / authority / as-of / token / decision を表示できる。
- [ ] past message preview は DB snapshot だけで exact delivery を再現する。
- [ ] migration は fresh / legacy DB の両方で idempotent。

### Implementation

- [ ] snapshot schema と Drizzle/Rust migration mirror を追加する。
- [ ] finalized payload を user message 永続化後にそのまま保存する。
- [ ] ContextBar を ContextPlan diagnostics から描画する。
- [ ] planned input と actual usage の用語を分ける。
- [ ] old `buildSceneContextPrompt` を削除する。
- [ ] `refreshContextLayers` 内の inline non-scene planner を削除する。
- [ ] `trimL4Text` / marker regex / old cache split を削除する。
- [ ] `lastSystemPromptKey` の send correctness 用途を削除する。
- [ ] shadow mode / internal feature flag / legacy adapter を削除する。
- [ ] `chatStore.ts` の domain source imports を削除する。

### Acceptance

- [ ] Chat Store は UI/session/stream state と coordinator invocation だけを持つ。
- [ ] `chatStore.ts` から Codex / Chronicle / Map / Plot Thread / Foreshadow DB API の
  direct import がない。
- [ ] provider payload の意味内容を構築する正本が 1 箇所だけである。
- [ ] prompt snapshot の「実際に送った内容」という DB comment と実装が一致する。
- [ ] old pipeline を検索して dead callsite がない。

### Verification

```bash
pnpm test --run src/features/chat/chatApi.test.ts
pnpm test --run src/features/chat/components/ContextBar.test.tsx
pnpm test --run src/features/chat/components/ContextBar.browser.test.tsx
pnpm test --run src/db/schema.test.ts
pnpm test --run src/db/schema.version.test.ts
cd src-tauri && cargo test --workspace
```

**Suggested commit:**

```text
refactor(chat): ContextPlan diagnostics を接続し旧 pipeline を削除
```

---

## 7. Cross-cutting Test Matrix

### Provider / transport

| Route | System delivery | Required checks |
|---|---|---|
| Anthropic direct | cached blocks + volatile tail | max 4 cache breakpoints、exact snapshot、budget |
| OpenRouter Claude chat | cached OpenAI content blocks | fallback置換、tail、budget |
| OpenRouter non-Claude | plain system string | blocksを誤送信しない |
| Responses API | instructions/plain | cache fieldsを二重適用しない |
| CLI | flattened role-tag prompt | flatten後でbudget |
| Hermes Agent | tools XML + text protocol | XML/tool results込みでiteration budget |

### Surface / scope

最低限、次の pairwise fixture を持つ。

| Surface | Scope |
|---|---|
| preview | scene with RAG |
| copy | scene with mention + eco |
| normal send | scene / project |
| Agent | scene / codex / project |
| prompt history | cache route / plain route |

追加で folder / snippet / thread の scope-specific focus / aggregation fixture を持つ。

### Temporal / visibility

| Base | Phase effective | Trigger | Expected |
|---|---|---|---|
| mentioned | hidden | mention + pin | excluded |
| hidden | mentioned | mention | selected after anchor |
| mentioned | always | none | selected after anchor |
| always | suppress | none | excluded after anchor |
| always | suppress | explicit pin | selected after anchor |

summary、content、details の各 override と、future Phase marker 非露出を全 trigger で確認する。

### Performance

- 100 / 1,000 / 5,000 Codex entries
- 0 / 10 / 100 selected entries
- deep hierarchy / wide hierarchy
- 0 / dense relation edges
- cold cache / warm cache
- scene / project scope

Wall-clock の絶対値だけで gate せず、query count、hydrated row count、transferred content
bytes、plan item count を記録する。

---

## 8. Rollout and Rollback

### Rollout

1. PR 0 で baseline fixtures を固定する。
2. PR 1 は全送信経路へ同時適用する。budget safety は feature flag で無効化しない。
3. PR 2 / 3 の semantics 変更は ADR と migration note を含める。
4. PR 4 / 5 は shadow comparison を test/dev build で有効にする。
5. PR 6 は scene -> codex/snippet -> folder/project/thread の順で切り替える。
6. PR 7 は query/byte telemetry を比較してから旧 full-load API の Chat 利用を削除する。
7. PR 8 で旧経路と flag を削除する。

### Rollback boundary

- PR 1: `SystemDelivery` は保持しつつ cache を plainへ downgrade可能。
- PR 2: project の保存 mode 値は変更しない。resolver 実装だけを切り戻せる。
- PR 4-6: scope 単位で legacy adapter へ戻せる期間を設ける。
- PR 7: catalog/hydration API は追加型なので、旧 full projectionを一時的に残せる。
- PR 8 実施後は legacy rollback を終了する。

---

## 9. Non-goals

この refactor には次を含めない。

- `codex_assertions` / claim model の追加
- relation 自体の Phase 化
- AI Write Gateway / OCC / provenance / Undo の再設計
- MCP `get_writing_context` の同時置換
- 新しい RAG ranking algorithm
- provider pricing / model registry 全体の再設計
- Phase の reveal anchor / truth anchor 二重化

MCP 共有は、app pipeline 完了後に shared golden fixtures を用意して別計画で行う。

---

## 10. Final Verification

各 PR では対象テストを先に実行し、最終 PR で以下をすべて通す。

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test --run
pnpm test:browser --run
(cd src-tauri && cargo check)
(cd src-tauri && cargo clippy --all-targets)
(cd src-tauri && cargo test --workspace)
```

必要に応じて Electron contract tests も実行する。

```bash
pnpm test:electron --run
```

### Definition of Done

- [ ] 全 route / Agent iteration で payload budget invariant が成立する。
- [ ] preview / copy / send / Agent が同じ `ContextPlan` 正本を使う。
- [ ] 全 scope が同じ temporal / visibility / budget policy を使う。
- [ ] effective hidden / future Phase の内容が payload に存在しない。
- [ ] cached/plain delivery の semantic item order が一致する。
- [ ] snapshot が exact delivery と route を再現する。
- [ ] 通常 turn で未選択 Codex 本文を全件ロードしない。
- [ ] ContextBar が token 内訳と item selection reason を説明できる。
- [ ] `chatStore.ts` が domain context の application kernel ではなくなっている。
- [ ] legacy builder、L4 marker trim、stale prompt send path が削除されている。
- [ ] TypeScript / lint / frontend tests / browser tests / Rust checks が green。
