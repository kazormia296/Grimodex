# 作中年表（Chronicle）AI 文脈注入・設計

> 関連: 年表本体の出荷設計 = `docs/superpowers/specs/2026-06-26-chronicle-timeline-design.md`（P0〜P4g・全12 PR master merged）。
> 本 spec = その年表データ（events 系 5 表）を **AI（執筆チャット / エージェント / 外部 MCP）に食わせる注入レイヤ**の設計。
> 先行例 `2026-06-26-plot-thread-phase3-ai-injection.md` の「**派生メタの静的注入＋オンデマンド・ツール**」パターンを踏襲する。
> branch: `feat/chronicle-ai-injection`

---

## 1. 背景・現状（recon ground-truth, 2026-06-28 監査）

並列エージェント監査（2 ワークフロー・敵対 verify=injected:no/high）で確定した事実：

1. **年表は AI 文脈に一切注入されていない。** `buildSystemPrompt`（`src/features/chat/contextBuilder.ts:828`）の L0〜L6＋FOCUS＋RAG/EPISODIC/PLOT_THREAD のどの層にも events 系は無く、`BuildSystemPromptInput`（同 L101-277）に年表フィールドが存在しない。年表 API（`listEvents` 等）の呼び出し元は chronicle feature 内（パネル描画・季節矛盾・抽出ダイアログ重複判定）に限定。
2. **AI と年表の唯一の接点は抽出ウィザード（P4f）**。これは **本文テキスト → events（抽出）の一方向**で、独自 `buildExtractEventsPrompt`＋`sendChatMessageWithThinking` 直叩き（`extractEventsApi.ts:107-147`）。`buildSystemPrompt` 経路は通らない。
3. **buildSystemPrompt の呼び出しは 2 経路**（plot-thread phase3 recon と同）:
   - `buildSceneCtx`（`chatStore.ts` ~2452-2520, **scene スコープ枝**。`semanticRecall` 入力もここ）→ **スナップショット注入の置き場**。
   - `refreshContextLayers` 非 scene 枝（`chatStore.ts:4798` 付近, folder/project/codex/snippet＋`focusSubject`）。
4. **cacheSegments = `[L0+L1, L2, L3+focus, L4stable]`**（`contextBuilder.ts:1599-1604`）、`volatileTail`（同 1610-1620, cache_control 無し末尾）。毎ターン変わる層（RAG/episodic）は cacheSegments に**絶対入れない**契約。
5. **ツール表面は 2 つ・両方とも年表ツール ゼロ**:
   - アプリ内 chat agent / contextCreator（TS）: `toolDefinitions.ts` の `AGENT_TOOLS`(30+)・`READ_ONLY_TOOL_NAMES`(16, L516-533)・`CREATOR_TOOLS`(4, `contextCreatorApi.ts:28-35`)。dispatch=`executeTool`(`toolExecutors.ts:1736`)/`executeReadOnlyTool`(:1777)、`READ_ONLY_EXECUTORS`(:1457-1475)/`MUTATING_EXECUTORS`(:1717-1726, 7 write)。
   - 外部 MCP `grimodex-mcp`（Rust 別クレート）: `server.rs` に 28 tools/21 read。`db.rs` に **SQL 再実装**（src-tauri import 不可）。events 表は db.rs スキーマに**存在すらしない**。
   - ⚠️ 両表面の `get_scene_timeline_neighbors` は `tree_nodes.story_time_order/label`（Codex 物語フェーズ＝reading-order 寄り）であって**作中年表(events) ではない**。
6. **agent executor はフィーチャ store を使わず** `useTreeStore.getState().projectId`＋Drizzle / `invoke("db_execute")` で実データに到達。store は UI ライフサイクルでアクティブ project とずれ得るため、**XPROJ は executor 側で必須**。
7. **年表 CRUD は change_event / undo_journal を一切発火していない**（`createEvent`:71 / `updateEvent`:119 / `deleteEvent`:145 / `setEventParticipants`:180 / `removeEventRelation`:354 / `importExtractedEvents`:163 すべてプレーン Drizzle 直書き）。＝現状は **UI の年表編集すら undo(Ctrl+Z) にも Linter 変更検知にも乗らない**。※ ただしスナップショット scope には登録済（復元は安全, [[grimodex-snapshot-scope-registration]]）。

### 年表 5 表スキーマ（`src/db/schema.ts:1325-1442`, XPROJ 評価の基礎）

| 表 | project_id 列 | scope 方法 | 二次 FK（漏洩注意） |
|---|---|---|---|
| `events` | **あり**(1329) | 直接 | `primary_codex_id`/`location_codex_id`→codex |
| `project_calendar` | **あり**(PK,1403) | 直接 | — |
| `event_relations` | **あり**(1427) | 直接 | `cause/effect_event_id`→events |
| `event_participants` | **なし**(PK: event_id+codex_entry_id) | events への JOIN | `codex_entry_id`→codex |
| `scene_events` | **なし**(PK: scene_id+event_id) | events/tree_nodes への JOIN | `scene_id`→tree_nodes(title) |

events 列: `title, note, ordinal`(fractional base62), `primary_codex_id, location_codex_id, start_time, end_time, precision, kind`(generic/birth/death), timestamps。

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
| **② アプリ内 agent ToolCall**（read+write） | pull | C ＋ 編集 | `toolDefinitions.ts` | Phase 2a |
| **③ 外部 MCP parity**（read+write） | pull | 外部エージェント | `grimodex-mcp` | Phase 2b |
| ④ events の RAG 索引化 | pull | B 残り（意味検索） | semantic index | **Phase 3（後回し）** |

**設計の背骨**: Component 1 の「世界状態スナップショット」を**純関数で 1 本だけ**書き、① の static 注入と ②③ の `get_chronicle_state` ツールの**両方が再利用**する。push と pull で実装を割らない。

---

## 4. Component 詳細

### C1. 世界状態スナップショット（純関数・両用）

`src/features/chronicle/chronicleSnapshot.ts`（新規・整合チェック純関数群の隣）:

```ts
export interface ChronicleSnapshotInput {
  anchorOrdinal: string;            // C2 が解決した作中時刻アンカー（events.ordinal）
  events: ChronicleEvent[];
  participants: EventParticipant[];
  relations: EventRelation[];
  calendar: ProjectCalendar | null;
  codexNames: Map<string, string>;  // codexId→表示名（XPROJ 済みの名前解決結果）
}
export function buildChronicleSnapshot(input: ChronicleSnapshotInput): string;
```

出力（anchor 時点に畳んだ派生状態・概ね ≤600 トークン上限）:
1. **現在の作中時刻** — ordinal 位置＋（calendar あれば）季節/日付ラベル。
2. **登場人物の状態** — 各人物につき「生存か（birth≤T<death）/年齢（`daysPerYear` 換算）/最後に判明する居場所（`location_codex_id` 付き event の T 以前最新）」。
3. **直近の重要イベント** — `ordinal ≤ anchor` を降順 K 件（既定 8・title＋短縮 description）。birth/death は 2 に畳むので羅列から抑制。
4. **未回収の因果** — `event_relations` で「原因 ≤anchor ∧ 結果 >anchor」→「X が起きたのでいずれ Y」伏線。
5. **オフページ背景**（B） — `scene_events` に出てこない event のうち anchor 付近の重要なもの。

→ 既存の年齢/季節/因果の純関数（chronicle の整合チェック・`issueIds` 統合済）を**最大限流用**。

### C2. アンカー解決（最大の論点）

`src/features/chronicle/resolveSceneAnchor.ts`（新規）:

```ts
export function resolveSceneAnchor(
  sceneId: string,
  ctx: { sceneEvents: SceneEvent[]; events: ChronicleEvent[]; readingOrder: string[] },
): { ordinal: string; source: "stamped" | "proxy" } | null;
```

- 現在シーンに stamp 済 `scene_events` あり → その event の `ordinal`（複数なら最大）を採用（`stamped`）。
- 無ければ reading-order を辿り、**最も近い stamp 済シーンの ordinal を代理採用**（`proxy`）。
- プロジェクト内に stamp ゼロ → `null`。

**graceful degradation**: `null` のとき時刻ベース注入はスキップし、**グローバルなオフページ背景のみ**注入（= 設計判断 D1, §7）。

### C3. buildSystemPrompt への静的注入（push）

- `BuildSystemPromptInput` に `chronicleSnapshot?: string` を追加。
- `<chronicle_state>` タグで **L3（current_scene）近傍**に配置（"いまの作中時刻の文脈"なので L3 が自然）。`PROMPT_DATA_TAGS` に新タグ追加。
- **発火条件**: scene スコープ（`buildSceneCtx` 枝, §1-3）かつアンカー解決成功時のみ。非 scene 枝には載せない。
- **キャッシュ配置**: L3 セグメント同梱（= 設計判断 D2, §7）。年表編集で L3 無効化されるが「文脈が実際に変わった」＝正しい。

### C4. 配線・トークン予算・トグル

- `buildSceneCtx`（`chatStore.ts` scene 枝）で `listEvents`/`listEventParticipants`/`listSceneEvents`/`getProjectCalendar`/`listEventRelations`（既存 `chronicle/api.ts`）で取得 → `resolveSceneAnchor` → `buildChronicleSnapshot` → 入力へ。
- **トークン上限**: 直近イベント K=8、関連人物（シーン登場/言及＋直近 event の primary）に絞り description 短縮。スナップショット ≤600 トークンに固定（テストで gate）。
- **設定トグル**: 「年表を AI に渡す」（既定 ON, 単一トグル）。細粒度設定は YAGNI。
- ゲートは既存 chat 送信のまま（AiPolicy=chat、追加ゲート不要）。

### C5. ツールセット（② アプリ内・③ MCP 共通の意味論）

**read（read-only）**:
- `list_events(filter?)` — 作中順イベント（participant/時刻窓/kind 絞り）。
- `get_character_timeline(codexId)` — 人物別経歴（年齢・出来事）。
- `get_chronicle_state(sceneId?)` — **C1 スナップショットをそのままツール化**（push の中身を pull でも引ける）。

**write**（ユーザー確定=許可。詳細層は C6）:
- `create_event` / `update_event` / `delete_event`
- `stamp_scene_event(sceneId, eventId)` / `unstamp_scene_event`
- `set_event_participants(eventId, [{codexId, role}])`
- `create_event_relation(causeId, effectId)` / `remove_event_relation`

**書き込み様式の判断**: 既存 agent write は直接コミット型（`create_codex_entry`/`create_foreshadow`）と propose 型（`propose_scene_body`）が混在。年表 write は **直接コミット型＋tracked/undo**（C6）を採用し、propose 型は将来オプション（= 設計判断 D3, §7）。

### C6. tracked-write 化（write の前提工程・PREREQUISITE）

§1-7 のとおり**年表 CRUD は現状 change_event/undo 非発火**。write ツールをこのまま生やすと「agent/MCP が取り消し不能・Linter 不可視の編集を行う」危険がある。よって:

- **年表 CRUD を tracked-write インフラに通す**（`change_event(domain='event')`＋`undo_journal`）。UI 編集・抽出ウィザード import・agent/MCP write の**全経路が等しく追跡される**ようにする。`globalHistoryStore`／既存 codex/foreshadow の tracked-write を範とする（[[grimodex-globalhistory-leaf-import]]）。
- これにより undo(Ctrl+Z)・Linter 変更検知・将来の差分表示が年表にも効く（副次的に UI 体験も改善）。

### C7. MCP parity（③ 外部公開）

- `grimodex-mcp/src/db.rs` に events 系の **SQL を rusqlite で再実装**（src-tauri import 不可）。read: `list_events`/`get_event_detail`/`get_character_timeline`/`get_chronicle_state`。write: 上記 write 群。
- 実装パターンは `tools/foreshadow.rs` を範とする: read=①`server.project_id()` で XPROJ→②`db::` SQL→③JSON。write=read-only check→license→policy(knowledgeWrite)→sanitize→`tracked_write`(change_event/undo)。
- `--readonly` は write を call-time gate（list には載るが呼ぶとエラー）。pinned/`--all-projects` の current_project 機構に従う。
- `docs/Grimodex_MCPサーバー設計書.md` の parity 表・差分に年表ツールを追記。

---

## 5. セキュリティ（XPROJ scoping・必須）

- read-by-id は `WHERE id = ?1 AND project_id = ?2` の二項条件。
- `events`/`project_calendar`/`event_relations` は project_id 列で直接スコープ。`event_participants`/`scene_events` は events/tree_nodes への JOIN でスコープ（§1 表）。
- **二次 FK 読取の漏洩注意**（`get_foreshadow_detail` の title-leak 教訓 [[grimodex-mcp-xproj-read-by-id-hole]]）: event が参照する `primary_codex_id`/`location_codex_id`/participant codex の**名前解決**、`scene_events→scene` の**タイトル**は、スコープ済み行から辿っても **project_id gate を再適用**する（別 project の FK を指していれば title/name が漏れる）。
- アプリ内 executor も同様に `useTreeStore.projectId` 未設定時は fail-closed（DB query なし）。
- 回帰テスト: cross-project な event_id/codex_id/scene_id を渡して not-found/空を assert（MCP・in-app 双方）。

---

## 6. テスト方針

- **純関数**（`buildChronicleSnapshot`/`resolveSceneAnchor`）: happy-dom 単体で 生存/年齢/季節/因果/オフページ選択、stamped/proxy/null、トークン上限を網羅。
- **静的注入統合**: トグル ON/OFF・未アンカー時にスナップショットが正しく出る/消える。
- **ツール（in-app）**: `toolDefinitions`＋executor＋`READ_ONLY_EXECUTORS`/`MUTATING_EXECUTORS`＋`READ_ONLY_TOOL_NAMES`＋`EXPECTED_*`（`toolExecutors.test.ts:75-151`）を **1:1 更新**（不変条件 test が gate）。XPROJ test（同 :416-509）に年表ツールを追加。read-only は `run_research` サブエージェント／`CREATOR_TOOLS` に自動/任意で乗る。
- **tracked-write**: 年表 write 後に change_event/undo_journal が記録され undo で巻戻ることを assert。
- **MCP（Rust）**: `cargo test`（XPROJ cross-project 回帰＋ tracked write）。`--readonly` で write 拒否。
- 幾何なし → browser test 不要。
- AI 経路: ① static は system prompt 増分なので transport 登録不要。②③ tool は tool プロトコルに触れるので ai-verification メタテスト（transport 層網羅 [[grimodex-ai-path-verification]]）の登録確認。AiUsageSurface= read tool は既存 agent surface 内、MCP は surface='mcp'。

---

## 7. フェーズ計画（PR 分割）

- **Phase 1（push・1 PR）**: C1 スナップショット純関数＋C2 アンカー解決＋C3 静的注入＋C4 トグル＋テスト。目的 A＋B 一部。**ツール無し**で出荷可。
- **Phase 2a（in-app tool・1 PR）**: C5 read ツール → C6 tracked-write → C5 write ツール。in-app agent / contextCreator。目的 C＋編集。
- **Phase 2b（MCP parity・1 PR）**: C7。Phase 2a と**同時並走**（ユーザー確定）。同じツール意味論を Rust 再実装＋XPROJ＋設計書 parity。
- **Phase 3（後回し）**: ④ events の RAG 索引化（B 残り）。

> ユーザー確定: MCP は in-app と同時スコープ（Phase 2a/2b を同 PR スタックで）。write も許可。

---

## 8. 未決・設計判断（spec レビューで確認したい点）

- **D1（アンカー未確定時）**: 推奨 = **オフページ背景のみ注入**（完全スキップではなく）。
- **D2（キャッシュ配置）**: 推奨 = **L3 セグメント同梱**（noisy なら volatileTail 退避が fallback）。
- **D3（write 様式）**: 推奨 = **直接コミット型＋tracked/undo**（propose 型は将来オプション）。
- **D4（tracked-write の作業量）**: C6 は年表全 CRUD を触る前提工程。Phase 2a の頭に置く（write ツールの安全性の土台）。これを嫌うなら write を「propose 型のみ（UI 確認必須）」に縮め C6 を後回しにする代替もある。
