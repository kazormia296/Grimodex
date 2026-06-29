# 作中年表イベントの AI 秘匿（reveal アンカー方式）設計

- 起票: 2026-06-29
- レビュー反映: 2026-06-29（コードベース照合・未解決事項の確定）
- 状態: **実装完了**（branch `feat/chronicle-event-secrecy`・P1〜P3 全フェーズ・未PR）
- 関連:
  - `docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md`（注入レイヤ正本）
  - PR#210 / #211 / #214（年表コンテキスト注入）
  - 伏線 `foreshadows.secret`（既存・類比の正本）
  - `docs/superpowers/specs/2026-06-18-codex-now-truth-badge-design.md`（`computeGlobalSceneOrder` / sceneOrder 共有）

---

## 1. 背景・動機

作中年表（Chronicle）のコンテキスト注入は出荷済みで、静的スナップショット・in-app read ツール（5 種）・
`search_events` RAG・MCP parity の複数経路で年表データが AI に渡る。しかし**作者が任意のイベントを
「AI には秘匿」にする軸が存在しない**。これは伏線（`foreshadows.secret`）と同じ理由——真相をまだ明かしていない
シーンを AI に書かせる際にネタバレが漏れるのを防ぐ——で必要になる。

### 1.1 既存の伏線秘匿（類比の正本）

| 観点 | 伏線 |
|---|---|
| 列 | `foreshadows.secret: boolean`（`schema.ts:1636`、default **true**） |
| TS ゲート | `listOpenForeshadowsForContext()`（`foreshadow/api.ts:563`）が `secret = false` のみ通す |
| MCP ゲート | `grimodex-mcp/src/db.rs:1553` `WHERE ... secret = 0` |
| 方式 | **クエリ時点での完全除外**（ラベルのみ残す部分秘匿ではない） |

### 1.2 年表が伏線より難しい理由：2 つの時間軸

- **作中時間（fabula）** = `events.ordinal` / `startTime`。「いつ起きたか」。`atOrBefore`
  （`chronicleSnapshot.ts:93`）が使う軸。
- **読む順（reading order）** = シーンの並び。「読者がどこまで知ったか」。**開示はこの軸で起こる。**

裏設定（例: 20 年前の毒殺）は作中時間では常に過去 → `atOrBefore` を毎シーンすり抜けるため、
**既存の fabula フィルタだけでは守れない**。開示は読む順の特定シーン（例: 20 章）で起こる。
フラットな boolean だけでは「5 章を再生成すると漏れる／毎回トグルを戻す footgun」を生む。
**年表固有の読む順構造を使った自動開示**が要る。

---

## 2. 確定設計

### 2.1 データモデル（`events` テーブルに 2 列追加）

```ts
secret: boolean          // default false（表示）。伏線（default true）とは逆。
revealSceneId: text | null  // DB 列名 reveal_scene_id。読む順の開示アンカー。
```

| 列 | 既定 | 意味 |
|---|---|---|
| `secret` | **false** | 年表注入の存在意義は AI に背景を渡すことなので、**隠すのはオプトイン** |
| `reveal_scene_id` | null | 明示上書き。null なら §2.3 の自動導出に委ねる |

- FK: `reveal_scene_id` → `tree_nodes.id`（`ON DELETE SET NULL`）。削除された reveal シーンは
  自動導出へフォールバック（スタンプが残っていれば再導出、無ければ恒久秘匿）。
- migration 既存行: `secret = 0`, `reveal_scene_id = NULL`（後方互換・挙動不変）。

### 2.2 読む順インデックス（正本）

**`computeGlobalSceneOrder(nodes)`**（`src/features/codex/phaseResolver.ts`）を唯一の正本とする。
`resolveSceneAnchor`・`getChronicleStateTool`・ChroniclePanel・Codex 未開示警告（`globalSceneOrder`）と
**同一源**。

> **レビュー修正**: `getDescendantScenesInOrder` は **folder 配下限定**の DFS であり、
> プロジェクト全体の読む順には使えない。誤参照は古典的バグの温床。

```ts
type ReadingOrder = Map<string, number>; // sceneId → 0-based index（小さいほど前方）

function readingPos(order: ReadingOrder, sceneId: string): number {
  return order.get(sceneId) ?? Number.POSITIVE_INFINITY;
}
```

- 現在シーン `s` が order に無い（削除済等）→ `readingPos(s) = ∞` → **fail-safe で秘匿側**（開示しない）。
- reveal シーン `X` が order に無い → `readingPos(X) = ∞` → **未開示扱い**（伏線 payoff 削除時と同型）。
- 実装では `Infinity` 比較だけに頼らず、`!readingOrder.has(currentSceneId)` / `!readingOrder.has(revealSceneId)` を
  明示的に fail-closed 分岐にする（`∞ < finite` が `false` になって開示される事故を防ぐ）。

### 2.3 reveal アンカーの effective 値（動的算出・確定）

**保存列 `reveal_scene_id` は上書き専用**。ゲート時は毎回 effective reveal を算出する（スナップショット保存しない）。

```ts
function effectiveRevealSceneId(
  event: EventRow,
  sceneEvents: SceneEventRow[],
  readingOrder: ReadingOrder,
): string | null {
  if (event.revealSceneId != null) return event.revealSceneId;

  // secret=true のときのみ自動導出。secret=false なら null（未使用）。
  const stampedSceneIds = sceneEvents
    .filter((se) => se.eventId === event.id)
    .map((se) => se.sceneId);
  if (stampedSceneIds.length === 0) return null;

  // scene_events の INSERT 順ではなく、readingOrder 上の最小 index のシーン。
  let best: string | null = null;
  let bestPos = Infinity;
  for (const sid of stampedSceneIds) {
    const pos = readingPos(readingOrder, sid);
    if (pos < bestPos) {
      bestPos = pos;
      best = sid;
    }
  }
  return best; // スタンプ先がすべて order 外なら null → 恒久秘匿
}
```

| 条件 | effective reveal | 意味 |
|---|---|---|
| `secret=false` | （評価しない） | 常に表示 |
| `secret=true`, 明示 `reveal_scene_id` | その id | 作者上書き |
| `secret=true`, 未指定, スタンプ有 | 読む順最小スタンプシーン | 初出シーンで自動開示 |
| `secret=true`, 未指定, スタンプ無 | null | **恒久秘匿**（純粋裏設定） |

シーン移動・スタンプ追加/削除・ツリー並べ替えは **次回ゲート時に自動追従**（動的算出の利点）。

### 2.4 ゲート判定（全経路共通の純関数）

新規モジュール **`src/features/chronicle/chronicleSecrecy.ts`**（仮）に集約:

```ts
function isEventHiddenFromAi(
  event: EventRow,
  currentSceneId: string,
  ctx: {
    readingOrder: ReadingOrder;
    sceneEvents: SceneEventRow[];
  },
): boolean {
  if (!event.secret) return false;
  if (!ctx.readingOrder.has(currentSceneId)) return true; // 現在位置不明は fail-closed
  const reveal = effectiveRevealSceneId(event, ctx.sceneEvents, ctx.readingOrder);
  if (reveal == null) return true; // 恒久秘匿
  if (!ctx.readingOrder.has(reveal)) return true; // reveal 位置不明は未開示扱い
  return readingPos(ctx.readingOrder, currentSceneId)
      < readingPos(ctx.readingOrder, reveal);
}
```

- `secret=false` → 常に表示（既存挙動）。
- `secret=true`, reveal 確定 → **reveal シーンを書く時点（`readingPos(s) >= readingPos(reveal)`）で開示**。
  5 章再生成では隠れ、reveal 章以降では見える。
- **fabula の `ordinal` とは別軸**——関数名・コメント・テスト名で明示する。

#### 2.4.1 イベント集合の前処理

hidden 判定は raw `events` + raw `sceneEvents` から effective reveal を算出するが、AI 用の後続処理には
**visible projection** だけを渡す。

```ts
const visibleEventIds = new Set(
  events
    .filter((e) => !isEventHiddenFromAi(e, currentSceneId, { readingOrder, sceneEvents }))
    .map((e) => e.id),
);

const visibleEvents = events.filter((e) => visibleEventIds.has(e.id));
const visibleSceneEvents = sceneEvents.filter((se) => visibleEventIds.has(se.eventId));
const visibleParticipants = participants.filter((p) => visibleEventIds.has(p.eventId));
const visibleRelations = relations.filter(
  (r) => visibleEventIds.has(r.causeId) && visibleEventIds.has(r.effectId),
);
```

`resolveSceneAnchor` / `pickSnapshotCharacters` / `deriveChronicleSnapshot` / ツール応答の**すべて**に
`visible*` を渡す。derive 直前だけの filter では、secret event が anchor を決めたり、
secret event の participant から人物が snapshot に載ったりする二次漏洩を防げない。
これにより birth/death 秘匿時の年齢・生死推定、offpage/recent/causal からのタイトル漏洩も一括で防ぐ。

#### 2.4.2 因果関係の二次漏洩

`event_relations` は filter 後の events だけでは**相手イベントのタイトル**が relations 経由で残りうる。
`get_event_detail` の relations 節と `deriveUnresolvedCausal` では:

- cause / effect の**どちらかが hidden** → そのペアは**丸ごと省略**（部分マスクしない）。
- 伏線と同様、**完全除外**が原則。

#### 2.4.3 AI 向け read 出力

read ツール / スナップショット JSON に **`secret` / `reveal_scene_id` は出さない**
（メタから「隠しイベントの存在」を推測させない）。write ツール（create/update）の schema には露出可。

#### 2.4.4 write-by-id oracle 対策

AI tool / MCP tool の write は read secrecy と同じ境界を守る。既存 event id を受ける操作は、対象 event が
現在シーンで hidden なら **存在しないものとして扱い、内容も mutation 成否も漏らさない**。

対象:

- `update_event`, `delete_event`
- `stamp_scene_event`, `unstamp_scene_event`
- `set_event_participants`
- `add_event_relation`, `remove_event_relation`（cause/effect のどちらかが hidden なら generic not found）

`create_event` は新規作成なので例外。`secret` / `revealSceneId` を受け取れるが、返却は既存どおり
`{ id, title }`（モデル自身が渡したタイトル）に留める。

MCP write は現在シーンを持たないため、既存 `secret=true` event への write-by-id は fail-closed。
外部 AI から秘匿 event を管理したい場合は、reveal 後に操作するか、作者 UI で編集する。

### 2.5 現在シーン `s` の解決（in-app 経路）

| 経路 | 現在シーン `s` |
|---|---|
| 静的注入 `buildChronicleSnapshotTextForScene` | 引数 `sceneId`（= `buildSceneCtx` の `sceneCtx.id`） |
| in-app read 5 種 + `search_events` | **scene スコープ chat** → chat の sceneId。**それ以外** → `useTreeStore.activeSceneId`（`getChronicleStateTool` と同型）。`s` が空 → **fail-closed**（`secret=true` をすべて隠す） |
| MCP / 外部 | 読む順非評価（§3） |

---

## 3. 経路別の強制

| 経路 | 現在シーン | 強制方法 |
|---|---|---|
| 静的スナップショット（`chatStore` → `assembleChronicleSnapshotText`） | 有 | visible projection → anchor / pick / derive（§2.4.1） |
| in-app read: `list_events`, `get_event_detail`, `get_character_timeline`, `get_chronicle_state`（`chronicleReadTools.ts`） | §2.5 | 各ツールで filter + §2.4.2 |
| in-app read: **`search_events`**（`toolExecutors.ts` → `events_search.rs`） | §2.5 | **limit より多めに取得 → hidden filter → slice(limit)**。索引は全件のまま。返却は `eventId, title, kind, score` なので **hidden の title 漏洩に注意** |
| MCP read 4 種（`grimodex-mcp/tools/chronicle.rs`） | **無** | **fail-closed = `secret=true` を一律除外**（現行伏線 MCP と同型） |
| MCP / agent write（create/update_event 等） | §2.5 / 無 | `secret` / `reveal_scene_id` を schema に追加しつつ、既存 hidden event への write-by-id は §2.4.4 で fail-closed |

**重要**: どこか 1 箇所だけ塞ぐと他経路から漏れる。`isEventHiddenFromAi` は TS 単一正本とし、
Rust 側はスナップショット注入用に必要なら `chronicle_snapshot.rs` へ移植 + fixture parity。
MCP は fail-closed のみで **reading-order 判定の全面移植は不要**。

`search_events` は filter 後に件数が減るため、backend へは `requestedLimit = min(limit * 3, backendMax)` などで
over-fetch し、visible に絞ってから `limit` 件へ slice する。hidden が多数上位に来る場合は返却数が limit 未満でもよいが、
hidden title を補填目的で露出してはならない。

### 3.1 非対象（隠すのは「AI に渡るか」だけ）

secret イベントも以下には**通常どおり出す**（伏線が作者パネルに見えるのと同じ）:

- ChroniclePanel / タイムライン UI / 抽出ウィザード（作者操作・一方向抽出）
- 整合チェック 4 種（季節 / 年齢 / 2 か所同時 / 因果）——作者は警告を受け取りたい
- プロジェクトスナップショット復元 round-trip（列はそのまま保持）

---

## 4. UI（P1）

ChroniclePanel / ChronicleInspector（イベント編集）に:

- **「AI に秘匿」トグル**（`secret`）
- **「開示シーン（任意）」** — シーン picker。空 = 自動導出（§2.3）。恒久秘匿を明示したい場合は
  「スタンプを外し、開示シーンも空」の組み合わせ（または将来「恒久秘匿」ヘルプテキスト）。

トグル ON 時のみ開示シーン欄を表示。reveal 自動導出の preview（「第 N 章で開示予定」）は v1 任意。

---

## 5. 実装時の必須チェック（chronicle memory）

- **schema 4 層 mirror**: `schema.ts` / `migrate.rs`（`add_column_if_missing` 2 列）/ `browser-mock.ts` DDL /
  `projectSnapshotApi`（create + restore。NOT NULL は coalesce）。round-trip 回帰 test で gate。
- **tracked-write は forward + revert 両方**（`agent_writes.rs` payload / INSERT / UPDATE / snapshot / UPSERT、
  Rust テスト payload リテラル）。revert 漏れで undo bail。
- **MCP は `add_column_if_missing` なし**。本番列はアプリ `migrate.rs` 所有。MCP CREATE は test fixture のみ更新。
- **既存 chronicle agent tools**: read 5 + write 8（新ツール追加なし）。`toolDefinitions.ts` の create/update schema
  に `secret` / `revealSceneId` を追加。
- **cargo test/clippy は `--no-default-features`**（libort link）。

### 5.1 触るファイル（想定）

| 層 | ファイル |
|---|---|
| 正本ロジック | `src/features/chronicle/chronicleSecrecy.ts`（新規）+ `*.test.ts` |
| 注入 | `src/features/chronicle/chronicleSnapshot.ts`, `src/features/chat/chatStore.ts` |
| read tools | `src/features/chat/agent/chronicleReadTools.ts`, `src/features/chat/agent/toolExecutors.ts`（search_events） |
| write schema | `src/features/chat/agent/toolDefinitions.ts`, `chronicleWriteTools.ts` |
| UI | `ChroniclePanel.tsx`, `ChronicleInspector.tsx` |
| schema | `src/db/schema.ts`, `src-tauri/src/database/migrate.rs`, `src/lib/browser-mock.ts`, `projectSnapshotApi.ts` |
| MCP | `grimodex-mcp/src/tools/chronicle.rs`, `grimodex-mcp/src/db.rs` |
| tracked-write | `src-tauri/src/commands/agent_writes.rs` |
| Rust 注入（必要時） | `grimodex-mcp/src/chronicle_snapshot.rs` |

---

## 6. フェーズ計画

### P1 — 主要経路 + UI（出荷可）

- schema 2 列 + migration + 4 層 mirror
- `chronicleSecrecy.ts`（effective reveal + `isEventHiddenFromAi`）
- 静的スナップショット + in-app read **5 種** + **`search_events`** に visible projection / filter 適用
- MCP read 4 種 fail-closed（UI/schema を出す同フェーズで塞ぐ。P1 単体で外部経路から漏れないこと）
- write-by-id oracle 対策（agent/MCP の既存 hidden event 操作は generic not found）
- UI（secret トグル + reveal 上書き）
- 単体テスト: 読む順開示境界（`<` / `>=`）、恒久秘匿、スタンプ自動導出、因果ペア省略、
  scene 未解決 fail-closed、anchor/pick が hidden event を使わないこと

### P2 — 外部 parity + undo

- MCP create/update schema の `secret` / `reveal_scene_id` 露出（P1 で read/write fail-closed 済み）
- tracked-write 2 列配線（forward + revert）
- TS↔Rust fixture parity（スナップショット Rust 経路を使う場合）

### P3 — eval

- ライブ LLM eval 3 アーム: off / secret-hidden / past-reveal
  （`chronicleInjectionEval.live.test.ts` 同型）

---

## 7. テスト計画（P1 gate）

1. **純関数**: `effectiveRevealSceneId` — 明示上書き > スタンプ最小 > null。
2. **純関数**: `isEventHiddenFromAi` — reveal 章の直前で hidden、reveal 章で visible、以降も visible。
3. **純関数**: current / reveal scene が order 外なら hidden（`Infinity` 比較で開示しない）。
4. **スナップショット**: secret birth を visible projection 後 derive → 年齢 null / 生死が秘匿に整合。
5. **スナップショット**: secret event が anchor / `pickSnapshotCharacters` に使われない。
6. **因果**: hidden effect を持つ relation が JSON / テキストに出ない。
7. **search_events**: hidden イベントがヒットから除外される（title 漏洩なし）+ over-fetch 後 slice。
8. **MCP read**: `secret=true` は read 4 種すべてで出ない。
9. **write-by-id**: hidden event id を指定した update/delete/stamp/relation が generic not found で mutation しない。
10. **スナップショット round-trip**: `secret` / `reveal_scene_id` 保持。
11. **回帰**: `secret=false` 既存プロジェクトの derive 出力が byte-level で不変（filter が no-op）。

---

## 8. レビューで確定した判断（旧「残課題」）

| 論点 | 決定 |
|---|---|
| `readingPos` の算出源 | **`computeGlobalSceneOrder` のみ**（§2.2） |
| reveal 自動導出 | **常に動的算出**。`reveal_scene_id` 列は上書き専用（§2.3） |
| secret を read 出力に含めるか | **含めない**（§2.4.3） |
| `search_events` の優先度 | **P1**（既出荷・title 返却あり。放置すると即漏洩経路） |
| 因果の hidden 端 | **ペアごと完全省略**（§2.4.2） |
| 現在シーン未解決 | **fail-closed**（§2.5） |
| P1 の MCP read | **P1 に含める**（secret UI/schema を出す同フェーズで外部 read も塞ぐ） |
| write-by-id hidden event | **generic not found**（存在確認 oracle を作らない） |

---

## 9. 実装結果（2026-06-29）

全フェーズ実装完了（branch `feat/chronicle-event-secrecy`）。検証=tsc 0 / eslint 0err /
vitest 7235+ pass / cargo test --no-default-features（mcp139・host agent_writes14・migrate40）/
clippy 0。ライブ LLM eval 実測（gen=gpt-4o-mini, judge=gpt-4o）= leaks_secret は
**off=0 / secretHidden=0 / pastReveal=1** で reveal アンカー方式を実証。

**敵対レビュー（10 agent・反証検証）で確定 5 件 → 対応**:
- [high] projectSnapshotApi 復元で `reveal_scene_id` の FK 未検証（codex/payoffScene と同パターン欠落）
  → **修正済**: body 未選択かつ参照先シーン非 live なら null 化（`eventRevealSceneCleared`）。
- [med] `apply_event_composite_snapshot`（undo/redo）が `reveal_scene_id` を未検証
  → **修正済**: tree_nodes 存在確認し無ければ NULL フォールバック（spec §2.1）。
- [low] create ツールの whitespace `revealSceneId` を TS 層で未正規化
  → **修正済**: `str() || null` で TS 層に契約を明示。
- [med] **deferred**: read ツール複数呼び出し時の `listSceneEventsForProject` 重複フェッチ
  （perf のみ・正当性影響なし・request 単位キャッシュ機構が無いので将来課題）。
- [low] **deferred**: `visibleEventIds` の readingOrder が呼び出し時点 snapshot
  （ツール実行中のツリー再配置で 1 呼び出し分 stale・既存注入と同 getState() 流儀で次回自己修正）。
