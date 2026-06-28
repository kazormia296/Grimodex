# 作中年表（Chronicle）AI 文脈注入・設計

> 関連: 年表本体の出荷設計 = `docs/superpowers/specs/2026-06-26-chronicle-timeline-design.md`（P0〜P4g・全12 PR master merged）。
> 本 spec = その年表データ（events 系 5 表）を **AI（執筆チャット / エージェント / 外部 MCP）に食わせる注入レイヤ**の設計。
> 先行例 `2026-06-26-plot-thread-phase3-ai-injection.md` の「**派生メタの静的注入＋オンデマンド・ツール**」パターンを踏襲する。
> branch: `feat/chronicle-ai-injection`
>
> **2026-06-28 レビュー反映**: Claude + GPT 5.5 敵対レビュー指摘を統合（ordinal/startTime 分離、project-scoped bulk API、prompt 鮮度、contextBuilder 配線詳細、Hermes write block、composite undo、MCP/TS parity fixture）。

---

## 1. 背景・現状（recon ground-truth, 2026-06-28 監査）

並列エージェント監査（2 ワークフロー・敵対 verify=injected:no/high）で確定した事実：

1. **年表は AI 文脈に一切注入されていない。** `buildSystemPrompt`（`src/features/chat/contextBuilder.ts:828`）の L0〜L6＋FOCUS＋RAG/EPISODIC/PLOT_THREAD のどの層にも events 系は無く、`BuildSystemPromptInput`（同 L101-277）に年表フィールドが存在しない。年表 API（`listEvents` 等）の呼び出し元は chronicle feature 内（パネル描画・季節矛盾・抽出ダイアログ重複判定）に限定。
2. **AI と年表の唯一の接点は抽出ウィザード（P4f）**。これは **本文テキスト → events（抽出）の一方向**で、独自 `buildExtractEventsPrompt`＋`sendChatMessageWithThinking` 直叩き（`extractEventsApi.ts:107-147`）。`buildSystemPrompt` 経路は通らない。
3. **buildSystemPrompt の呼び出しは 2 経路**（plot-thread phase3 recon と同）:
   - `buildSceneCtx`（`chatStore.ts` scene 枝, **scene スコープ**。`semanticRecall` 入力もここ）→ **スナップショット注入の置き場**。
   - `refreshContextLayers` 非 scene 枝（folder/project/codex/snippet＋`focusSubject`）。
4. **cacheSegments = `[L0+L1, L2, L3+focus, L4stable]`**（`contextBuilder.ts:1599-1604`）、`volatileTail`（同 1610-1620, cache_control 無し末尾）。毎ターン変わる層（RAG/episodic/plot-thread）は cacheSegments に**絶対入れない**契約。
5. **ツール表面は 2 つ・両方とも年表ツール ゼロ**:
   - アプリ内 chat agent（TS）: `toolDefinitions.ts` の `AGENT_TOOLS`(30+)・`READ_ONLY_TOOL_NAMES`(16)・`MUTATING_TOOL_NAMES`（`toolProtocolParse.ts:111-119`, Hermes write block）。dispatch=`executeTool`/`executeReadOnlyTool`、`READ_ONLY_EXECUTORS`/`MUTATING_EXECUTORS`。
   - **Context Creator** は `CREATOR_TOOLS` 固定 4 件（`contextCreatorApi.ts:28-35`）のみ。**年表 tool は Phase 2a でも載せない**（chat agent / research subagent のみ）。
   - 外部 MCP `grimodex-mcp`（Rust 別クレート）: `server.rs` に 28 tools/21 read。`db.rs` に **SQL 再実装**（src-tauri import 不可）。events 表は db.rs スキーマに**存在すらしない**。
   - ⚠️ 両表面の `get_scene_timeline_neighbors` は `tree_nodes.story_time_order/label`（Codex 物語フェーズ＝reading-order 寄り）であって**作中年表(events) ではない**。
6. **agent executor はフィーチャ store を使わず** `useTreeStore.getState().projectId`＋Drizzle / `invoke("db_execute")` で実データに到達。store は UI ライフサイクルでアクティブ project とずれ得るため、**XPROJ は executor 側で必須**。
7. **年表 CRUD は change_event / undo_journal を一切発火していない**（`createEvent` / `updateEvent` / `deleteEvent` / `setEventParticipants` / `removeEventRelation` / `importExtractedEvents` すべてプレーン Drizzle 直書き）。＝現状は **UI の年表編集すら undo(Ctrl+Z) にも Linter 変更検知にも乗らない**。※ スナップショット scope には登録済（復元は安全, [[grimodex-snapshot-scope-registration]]）。
8. **既存 chronicle API の XPROJ ギャップ**（§5/C0 で解消必須）:
   - `listEventParticipants(eventId)` — projectId なし、`event_id` のみ WHERE。
   - `setEventParticipants` / `unlinkSceneFromEvent` — projectId gate なし。
   - `event_participants` / `scene_events` は `project_id` 列を持たない（JOIN scope 必須）。

### 年表 5 表スキーマ（`src/db/schema.ts:1325-1442`, XPROJ 評価の基礎）

| 表 | project_id 列 | scope 方法 | 二次 FK（漏洩注意） |
|---|---|---|---|
| `events` | **あり**(1329) | 直接 | `primary_codex_id`/`location_codex_id`→codex |
| `project_calendar` | **あり**(PK,1403) | 直接 | — |
| `event_relations` | **あり**(1427) | 直接 | `cause/effect_event_id`→events |
| `event_participants` | **なし**(PK: event_id+codex_entry_id) | events への JOIN | `codex_entry_id`→codex |
| `scene_events` | **なし**(PK: scene_id+event_id) | events/tree_nodes への JOIN | `scene_id`→tree_nodes(title) |

events 列: `title, note, ordinal`(fractional base62・**順序比較専用**), `primary_codex_id, location_codex_id, start_time, end_time, precision, kind`(generic/birth/death), timestamps。

**時刻二軸（重要）**:
- `ordinal` — fractional index。年表 x 軸順・前後関係の比較に使う。**日数ではない**。
- `startTime` / `endTime` — 紀元からの日数。季節・年齢・生死（`daysPerYear` 換算）は **こちらのみ** 使用。
- 既存 linter（`ageCheck.ts`, `seasonCheck.ts`, `eventCausality.ts`）も `startTime` ベース。`ordinal` と混同しない。

---

## 2. 目的（ユーザー確定・全採用）

- **A. 執筆時の時系列矛盾防止** — 死んだ人物を生かす/季節を間違える/未来の出来事に言及する等を防ぐ整合ガード。年表固有の価値が最大。
- **B. オフページ背景の補強** — 本文未描写の過去の出来事（戦争・誕生等）を前提知識として執筆に反映。
- **C. チャットでの年表 Q&A** — 「いつ何が起きた？」「今この人物は何歳？」に AI が答えられる。
- **（外部）MCP 公開** — Hermes Agent / Claude Desktop 等の外部 MCP クライアントからも年表を参照/編集できる。

---

## 3. 全体設計：3 配信チャネル ＋ Phase 3

| チャネル | 方向 | 担う目的 | 表面 | 本 spec での扱い |
|---|---|---|---|---|
| **① 静的スナップショット注入** | push | A ＋ B 一部 | `buildSystemPrompt`（ツール不要） | Phase 1 |
| **② アプリ内 agent ToolCall**（read+write） | pull | C ＋ 編集 | `toolDefinitions.ts`（**Context Creator 除外**） | Phase 2a |
| **③ 外部 MCP parity**（read+write） | pull | 外部エージェント | `grimodex-mcp` | Phase 2b |
| ④ events の RAG 索引化 | pull | B 残り（意味検索） | semantic index | **Phase 3（後回し）** |

**設計の背骨**:
1. **JSON intermediate を正本** — `ChronicleSnapshot` 構造体を TS で derive し、LLM 表示文はレンダリング層。MCP Rust は同 schema の fixture parity test で drift を gate。
2. ① static 注入と ②③ `get_chronicle_state` が **同じ derive + 同じ renderer** を再利用。push/pull でロジックを割らない。

---

## 4. Component 詳細

### C0. project-scoped bulk API（Phase 1 前提・XPROJ）

§1-8 の既存 API ギャップを解消。**Phase 1 の fetch も Phase 2 の write もこの API 経由のみ**（素の `listEventParticipants(eventId)` を AI 経路から呼ばない）。

`src/features/chronicle/api.ts` に追加:

```ts
// read — すべて events / tree_nodes JOIN で project gate
listEventParticipantsForProject(projectId, eventIds?: string[]): Promise<ParticipantRow[]>
listSceneEventsForProject(projectId, opts?: { eventIds?: string[]; sceneIds?: string[] }): Promise<SceneEventRow[]>

// write — projectId 必須（Phase 2、C6 tracked-write 経由）
setEventParticipants(projectId, eventId, codexEntryIds): Promise<void>  // 既存シグネチャを breaking 拡張
unlinkSceneFromEvent(projectId, sceneId, eventId): Promise<void>
linkSceneToEvent(projectId, sceneId, eventId)  // 既存。変更なしだが全経路で使用徹底
```

- UI / ChroniclePanel も bulk API に寄せる（N+1 回避・XPROJ 統一）。
- executor / MCP write も必ず projectId 付き API のみ呼ぶ。

### C1. 世界状態スナップショット（純関数・両用）

`src/features/chronicle/chronicleSnapshot.ts`（新規）:

```ts
/** C2 が解決した作中時刻アンカー。ordinal と startTime は別軸。 */
export interface ChronicleAnchor {
  ordinal: string;                    // 順序比較・直近イベント選定
  startTime: number | null;           // 季節/年齢/生死。null なら暦系セクション省略
  source: "stamped" | "proxy" | "none"; // none = D1 オフページのみ
  proxySceneId?: string;              // source=proxy のとき参考
}

export interface ChronicleSnapshotInput {
  anchor: ChronicleAnchor;
  events: ChronicleEvent[];
  participants: EventParticipant[];
  relations: EventRelation[];
  sceneEvents: SceneEventRow[];
  calendar: ProjectCalendar | null;
  /** スナップショットに載せる人物 codexId 集合（C4 で絞り込み済み） */
  characterIds: string[];
  codexNames: Map<string, string>;  // XPROJ 済み名前解決
}

/** 正本 = 構造化。LLM 文字列は renderChronicleSnapshot()。 */
export interface ChronicleSnapshot { /* sections: time, characters, recentEvents, unresolvedCausal, offpage */ }

export function deriveChronicleSnapshot(input: ChronicleSnapshotInput): ChronicleSnapshot;
export function renderChronicleSnapshot(snapshot: ChronicleSnapshot, lang: string): string;
```

#### 新規 pure fn（derive 内部）

| 関数 | 責務 |
|---|---|
| `deriveCharacterStateAt(anchor, characterId, ...)` | 生存（birth≤T<death）、年齢、`startTime=null` → `unknown` |
| `deriveLastKnownLocation(anchor, characterId, ...)` | 下記ルール |
| `deriveRecentEvents(anchor, K=8)` | `ordinal ≤ anchor.ordinal` 降順。birth/death は character state に畳み羅列抑制 |
| `deriveUnresolvedCausal(anchor, ...)` | **`ordinal` 比較**: 原因 event.ordinal ≤ anchor ∧ 結果 event.ordinal > anchor |
| `deriveOffpageEvents(anchor, ...)` | 下記 D1 定義 |

#### 既存関数の流用範囲（限定的）

| 流用 | 用途 |
|---|---|
| `seasonOf(time, calendar)`（`chronicleTime.ts`） | anchor.startTime があるとき季節ラベル |
| `cmpKeys(ordinal)`（fractional index） | 順序比較 |
| **流用しない** | `findAgeConflicts`（linter 用・scene text 矛盾）、`findCausalityConflicts`（startTime 矛盾検出のみ） |

#### 出力セクション（render 後 ≤600 トークン）

1. **現在の作中時刻** — ordinal 位置ラベル ＋ startTime あれば季節/日付。`startTime=null` → 「作中順序のみ（暦未設定）」。
2. **登場人物の状態** — C4 の `characterIds` 各員について:
   - 生存/死亡/不明（birth/death event + startTime）
   - 年齢（startTime ＋ calendar.daysPerYear）または `unknown`
   - **最後に判明する居場所**: `primaryCodexId === characterId` **または** participant に含まれる event のうち、`locationCodexId != null` かつ `ordinal ≤ anchor.ordinal` の**最新**（ordinal 降順）。群衆 event で全 participant に同 location を適用してよい。
3. **直近の重要イベント** — K=8（title＋短 note）。
4. **未回収の因果** — ordinal ベース（上記 derive）。
5. **オフページ背景** — D1 定義。

`startTime=null` の anchor でも §1・§4・§5（ordinal ベース）は出せる。§2 の暦依存行のみ省略/`unknown`。

### C2. アンカー解決

`src/features/chronicle/resolveSceneAnchor.ts`（新規）:

```ts
export function resolveSceneAnchor(
  sceneId: string,
  ctx: {
    sceneEvents: SceneEventRow[];   // C0 bulk（project 全体）
    events: ChronicleEvent[];
    readingOrder: Map<string, number>;  // computeGlobalSceneOrder(nodes) — ChroniclePanel と同じ正本
  },
): ChronicleAnchor;
```

**reading-order 正本**: `computeGlobalSceneOrder`（`src/features/codex/phaseResolver.ts`）。ChroniclePanel / Timeline と軸を揃える。

**解決規則**:
1. 現在シーンに stamp 済 `scene_events` あり → 紐づく event の **ordinal 最大**を採用（`stamped`）。対応 event の `startTime` もセット。
2. 無ければ reading-order 上 **現在シーンより前**（index 小）の stamp 済シーンを逆走査し、**最後（最も近い前方）** の stamp event の ordinal/startTime を代理採用（`proxy`）。**後方（未来）stamp は見ない**（フラッシュバック誤 anchor 防止）。
3. 前方にも stamp なし → `{ ordinal: "", startTime: null, source: "none" }`（null ではなく none。D1 オフページ専用モード）。

### C3. buildSystemPrompt への静的注入（push）

#### 発火条件

- scene スコープ（`buildSceneCtx` 枝）かつ設定トグル ON（C4）。
- `anchor.source !== "none"` → フルスナップショット（§1〜5）。
- `anchor.source === "none"` → **オフページ背景のみ**（§5 のみ。D1）。
- 非 scene 枝には載せない。

#### contextBuilder.ts 配線（plot-thread §3a と同粒度・**全サイト必須**）

- `PROMPT_DATA_TAGS`: `chronicleState: "chronicle_state"` / `RESERVED_TAG_RE` に追加（値一致必須）。
- `BuildSystemPromptInput.chronicleSnapshotText?: string`（render 済み文字列。contextBuilder は純粋）。
- 本文組立: `### {headers.chronicleState}` ＋ snapshot 本文。**セクション = `### ` ブロック**で trim がブロック単位末尾落とし可能に。
- `TrimInput.chronicleSnapshotText?` → `sumTokens` 加算 → `trimOrder` 挿入。
  - **trim 順 = EPISODIC → RAG → PLOT_THREAD → L5 → L4 → L2 → L3（chronicle は L3 本文と同梱）→ L1**。
  - chronicle は **L3 セグメント内**に連結（独立 trim key だが L3 と同じ運命＝scene 文脈の一部）。budget 逼迫時は L3 本文より先に chronicle ブロック末尾から落とす（`trimChronicleText` = `trimRagText` 流用）。
- wrap/hasDataLayers/token 計上/`layers.push({ layer: "CHRONICLE" })`。
- **cache 配置（D2 確定）**: `effectiveL3` に chronicle を連結 → `l3CacheSegment` 同梱。plot-thread が volatileTail なのは「毎ターン query 依存」だが、chronicle は scene アンカー依存で **scene 文脈と一体**のため L3 が自然。年表編集時は `chronicleRevision` bump で cache 無効化（下記）。
- **totalTokens** 固定要素カウント +1（chronicle 層追加）。
- i18n: `chat.context.layer.CHRONICLE` + `chatSystem.ts`（ja/en）`headers.chronicleState` / `chronicleTimeUnknown` / `chronicleOffpageIntro` 等。

#### prompt 鮮度（必須）

`contextPromptKey` に **`chronicleRevision`**（整数カウンタ）を join。

- `chatStore` / `chronicleStore` に `chronicleRevision: number`（monotonic bump）。
- bump タイミング: events CRUD、calendar 更新、scene stamp/unstamp、participants 更新、relations 更新、importExtractedEvents 完了。
- 年表パネル保存・agent write（Phase 2）の**全経路**で bump → stale `lastSystemPrompt` 流用を防止。
- 代替として bump 時 `refreshContextLayers()` を fire してもよいが、key join は必須（preview / send 両方）。

### C4. 配線・トークン予算・トoggle

#### buildSceneCtx データ取得（C0 bulk のみ）

```ts
// fast path: listEvents が [] なら chronicle 注入スキップ（revision bump も不要）
const events = await listEvents(projectId);
if (events.length === 0) return undefined;

const [participants, sceneEvents, calendar, relations] = await Promise.all([
  listEventParticipantsForProject(projectId),
  listSceneEventsForProject(projectId),
  getProjectCalendar(projectId),
  listEventRelations(projectId),
]);
const anchor = resolveSceneAnchor(sceneId, { sceneEvents, events, readingOrder: computeGlobalSceneOrder(nodes) });
const characterIds = pickSnapshotCharacters({ sceneId, events, participants, anchor, codexEntriesInScene });
const snapshot = deriveChronicleSnapshot({ anchor, events, participants, relations, sceneEvents, calendar, characterIds, codexNames });
const chronicleSnapshotText = renderChronicleSnapshot(snapshot, lang);
```

#### 人物スコープ `pickSnapshotCharacters`（Phase 1 固定）

1. 現在シーンに L4 注入済み codex entry id（scene 本文 seed / pinned 除外前の scene-linked codex）。
2. 直近 K=8 イベント（anchor 以前）の `primaryCodexId` と participants。
3. **Phase 1 では chat `@mention` 検出は含めない**（Phase 3 以降の follow-up）。

#### オフページ背景（D1 確定）

**定義**: プロジェクト内で **いずれの scene にも stamp されていない** event（`scene_events` に一度も出現しない id）のうち、`ordinal ≤ anchor.ordinal`（none 時は全 event）を **kind 優先**（birth/death > generic）＋ ordinal 降順で最大 **3 件**。

#### トークン上限

- スナップショット全体 ≤600 トークン（テスト gate）。
- 超過時は `deriveOffpageEvents` → `deriveRecentEvents` → character 詳細 note の順で短縮。

#### 設定トグル

- **キー**: `aiPrompt.chronicle.enabled`（project scope、`src/features/settings/types.ts` に登録）。
- **UI**: プロジェクト設定 → AI プロンプト（chat 追記指示の近傍）。ラベル「年表を AI に渡す」。
- **既定**: `true`。OFF 時は chronicle 注入完全スキップ。

#### パフォーマンス

- events 0 件 early return（上記）。
- bulk query で N+1 禁止。
- 同一ターン内 `projectId + chronicleRevision + sceneId + anchor.ordinal` で module-local memo（`buildSceneCtx` 内）可。

---

### C5. ツールセット（② アプリ内・③ MCP 共通の意味論）

**対象 surface**: chat agent 本体 + `run_research` サブエージェント（READ_ONLY 経由）。**Context Creator には載せない**。

**read（read-only）**:
- `list_events(filter?)` — 作中順イベント（participant/時刻窓/kind 絞り）。
- `get_event_detail(eventId)` — 単 event + participants + relations + stamped scenes。
- `get_character_timeline(codexId)` — 人物別経歴（年齢・出来事）。
- `get_chronicle_state(sceneId?)` — `deriveChronicleSnapshot` + JSON 返却（render 済み summary 文字列も可）。

**write**（C6 完了後）:
- `create_event` / `update_event` / `delete_event`
- `stamp_scene_event(sceneId, eventId)` / `unstamp_scene_event`
- `set_event_participants(eventId, [{codexId, role}])`
- `create_event_relation(causeId, effectId)` / `remove_event_relation`

**書き込み様式（D3 確定）**: 直接コミット型＋tracked/undo。propose 型は将来オプション。

#### 登録サイト（drift test gate・**全て更新**）

1. `toolDefinitions.ts` `AGENT_TOOLS`: read 4 + write 7 定義。
2. `READ_ONLY_TOOL_NAMES`: read 4 名追加。
3. **`MUTATING_TOOL_NAMES`**（`toolProtocolParse.ts`）: **write 7 名すべて追加**（Hermes body channel write block。tracked-write より前のセキュリティ前提）。
4. `toolExecutors.ts`: executor fn + `READ_ONLY_EXECUTORS` / `MUTATING_EXECUTORS`。
5. `toolExecutors.test.ts`: `EXPECTED_READ_ONLY_NAMES` / `MUTATING_TOOL_NAMES ↔ MUTATING_EXECUTORS` 同期 / XPROJ tests。
6. `toolDefinitions.test.ts`: research subagent tools 同期。
7. `aiLiveHarness.ts`: mock executor cases。
8. AiPolicy / license / `--readonly`（MCP）/ size validation — foreshadow write と同 checklist。

### C6. tracked-write 化（write の前提工程・PREREQUISITE）

§1-7 のとおり年表 CRUD は現状 change_event/undo 非発火。Phase 2a では **read tool 先行 → C6 → write tool** の順（D4 確定）。

#### 対象経路（全て）

UI 編集（ChroniclePanel / API）・抽出ウィザード `importExtractedEvents`・agent write・MCP write。

#### mutation 単位 = event graph

単一行 CRUD ではなく **graph mutation** として undo payload を設計:

| 操作 | undo payload に含めるもの |
|---|---|
| `create_event` | event 行 |
| `update_event` | 更新前 event 行スナップショット |
| `delete_event` | event 行 + cascade 前の participants / scene_events / relations（cause/effect 両方） |
| `set_event_participants` | 置換前 participant 行集合 |
| stamp/unstamp | 追加/削除前の scene_events 行 |
| relation create/delete | 追加/削除前の relation 行 |
| `importExtractedEvents` | **1 composite undo**（複数 event + links を 1 journal entry）— 部分成功を transaction で防ぐ |

- `change_event(domain='event')` + `undo_journal`。`globalHistoryStore` / codex・foreshadow tracked-write パターン踏襲（[[grimodex-globalhistory-leaf-import]]）。
- 完了時 **`chronicleRevision` bump**（C3 鮮度と連動）。
- C0 の project-scoped write API 内部で tracked-write を発火（素 Drizzle 直書き経路を残さない）。

### C7. MCP parity（③ 外部公開）

- `grimodex-mcp/src/db.rs` に events 系 SQL 再実装。read/write ツール = C5 と同名・同 schema。
- パターン: `tools/foreshadow.rs`（XPROJ → SQL → JSON → tracked_write）。
- **`get_chronicle_state` 返却 = TS `ChronicleSnapshot` と同 JSON schema**（文字列だけの返却は不可）。
- **parity gate**: `src/features/chronicle/fixtures/chronicle-snapshot/*.json` を TS derive + Rust derive の両方で通し、deep equal assert（CI）。
- `--readonly` call-time gate。設計書 parity 表更新。

---

## 5. セキュリティ（XPROJ scoping・必須）

- read-by-id: `WHERE id = ?1 AND project_id = ?2`。
- `event_participants` / `scene_events`: **C0 bulk API 経由のみ**。JOIN `events.project_id = ?` / `tree_nodes.project_id = ?`。
- 既存 `listEventParticipants(eventId)` 等は UI レガシーとして残してもよいが、**AI / MCP / write 経路からは禁止**。
- 二次 FK 読取（codex 名、scene タイトル）: スコープ済み行から辿っても project_id gate 再適用（[[grimodex-mcp-xproj-read-by-id-hole]] 教訓）。
- executor: `projectId` 未設定 → fail-closed（DB 0 件）。
- Hermes: write tool は `MUTATING_TOOL_NAMES` 登録必須（プロンプト注入 vector）。
- 回帰: cross-project event_id/codex_id/scene_id → not-found/空（MCP + in-app）。

---

## 6. テスト方針

### 純関数（`chronicleSnapshot.ts` / `resolveSceneAnchor.ts`）

- anchor: stamped / proxy（前方のみ）/ none
- `startTime=null` → 季節・年齢 `unknown`、ordinal セクションは存続
- 生存/年齢/季節/因果（ordinal）/ offpage 選定 / 所在地（participant vs primary）
- トークン ≤600 gate
- fixture JSON → derive → render スナップショット

### contextBuilder 統合

- `PROMPT_DATA_TAGS` / `RESERVED_TAG_RE` 偽装エスケープ
- L3 cache segment 同梱 / volatileTail に**入らない**
- trimOrder 位置 / toggle OFF でタグごと消失
- `chronicleRevision` 変更 → `contextPromptKey` 変化

### 鮮度

- 年表編集 → 送信/preview 前に snapshot 更新（stale 流用なし）

### ツール（in-app）

- `READ_ONLY_*` / `MUTATING_*` / `MUTATING_TOOL_NAMES` 1:1
- XPROJ cross-project
- Context Creator に chronicle tool が**無い**こと

### tracked-write

- 各 write + composite import undo
- `chronicleRevision` bump

### MCP（Rust）

- XPROJ + tracked write + `--readonly` reject
- fixture parity（TS vs Rust JSON）

### その他

- 幾何なし → browser test 不要
- ai-verification: tool 経路のみ transport 登録（[[grimodex-ai-path-verification]]）

---

## 7. フェーズ計画（PR 分割）

- **Phase 1（push・1 PR）**: **C0 bulk read API** → C1 derive/render → C2 anchor → C3 contextBuilder 配線 → C4 配線/トグル/`chronicleRevision` → テスト。目的 A＋B 一部。**ツール無し**で出荷可。
- **Phase 2a（in-app tool・1 PR）**: C5 read tools → **C6 tracked-write（UI+import+API 全面）** → C5 write tools + `MUTATING_TOOL_NAMES`。chat agent / research subagent のみ。
- **Phase 2b（MCP parity・1 PR）**: C7。Phase 2a と**同時並走**（同 PR スタック）。fixture parity CI。
- **Phase 3（後回し）**: ④ events RAG 索引化 ＋ `@mention` 人物スコープ拡張。

> ユーザー確定: MCP は in-app と同時スコープ。write 許可。Context Creator 除外。

---

## 8. 設計判断（レビュー確定）

| ID | 決定 | 理由 |
|---|---|---|
| **D1** | anchor `none` 時 = **オフページ背景のみ**（完全スキップしない）。offpage = **プロジェクト全体で未 stamp** event、最大 3 件。`startTime=null` 時は暦系を `unknown` 省略 | 年表初利用プロジェクトでも B に効く。時刻軸混同を防ぐ |
| **D2** | **L3 cache segment 同梱** + `chronicleRevision` で編集時 invalidation。plot-thread（volatileTail）との差 = scene アンカー固定メタ vs query 依存 | 作中時刻＝シーン文脈。編集反映は revision で担保 |
| **D3** | **直接 commit + tracked/undo** + `MUTATING_TOOL_NAMES` | foreshadow write と整合。Hermes 注入防御 |
| **D4** | C6 = Phase 2a 内 **read → tracked-write → write** 順。工数 = bulk API + graph undo + UI/import 全経路 | write を生やす前の安全土台。propose-only 代替は却下 |
