# AI コンテキスト注入 — レイヤーマップ

Grimodex はチャットのシステムプロンプトに、プロジェクトの構造化メタデータを **L0〜L6** の 6 レイヤーで注入する。加えて **RAG / EPISODIC / PLOT_THREAD / CHRONICLE** の派生メタ層がある。本ドキュメントは「どのデータソースがどのレイヤーに載るか」の**クイックリファレンス**である。

> **詳細仕様は各設計書を参照すること。**
>
> | トピック | 参照先 |
> |---------|--------|
> | レイヤー全体・トークン予算・スコープ別適用 | [`Grimodex_Chatパネル設計書.md`](./Grimodex_Chatパネル設計書.md) §コンテキスト注入 |
> | 5 レイヤーモデル（概要・旧表記） | [`SPEC.md`](./SPEC.md) §4.3 |
> | Codex の context_mode・子孫 BFS・フェーズ解決 | [`Grimodex_Codexパネル設計書.md`](./Grimodex_Codexパネル設計書.md) §コンテキスト注入への影響 |
> | Beat の L3 注入 | [`Grimodex_Beatシステム設計書.md`](./Grimodex_Beatシステム設計書.md) §AI コンテキスト注入における Beat の扱い |
> | 伏線（L2 / L3） | [`Grimodex_伏線レジスタ設計書.md`](./Grimodex_伏線レジスタ設計書.md) §AI コンテキスト注入と secret フラグ |
> | Map User edge → Codex Relation | [`Grimodex_Mapパネル設計書.md`](./Grimodex_Mapパネル設計書.md) §Codex Relation 昇格 |
> | プロットスレッド注入 | [`docs/superpowers/specs/2026-06-26-plot-thread-phase3-ai-injection.md`](./superpowers/specs/2026-06-26-plot-thread-phase3-ai-injection.md) |
> | 作中年表（Chronicle）注入 | [`docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md`](./superpowers/specs/2026-06-28-chronicle-context-injection-design.md) |

実装の中心: `src/features/chat/contextBuilder.ts`, `src/features/chat/chatStore.ts`

---

## レイヤー概要

| レイヤー | セクション | 主なデータソース | トリム時の挙動 |
|---------|-----------|----------------|--------------|
| L0 | アプリ方針 + `<author_instructions>` + エージェント指示 | 静的プロンプト、`styleGuide`、`aiInstructions`、チャット追加指示 | アプリ方針とhard constraintは保護。作者方針は参照データタグの外に置き、他レイヤーが尽きた後に予算内へbounded trim |
| L1 | プロジェクト情報 | `projects`（タイトル・ジャンル・視点・時制） | 通常トリムでは**最後まで保護**（trimToFit 順で最終）。genre/pov/tense の順で除去しタイトルは残す。damsel 等の縮退モードでは L2/L4 と共にゼロ化 |
| L2 | これまでの物語 + アウトライン + 未回収伏線 | シーン要約、フォルダ要約、`projects.outline`、未回収伏線 | 先頭エントリから削る。末尾の `projectOutline` は最後まで残る |
| L3 | 現在のシーン | シーン本文、ラベル、Beat、シーン伏線、story-time 隣接、`@scene` ピン | 本文は先頭から削る。ヘッダー・伏線ブロックは保護 |
| L4 | Codex / Note / Snippet / Sticky | メンションまたはピン留めされたエンティティ | 優先度（pri）に基づくブロック単位の削除（下記） |
| CHRONICLE | 作中年表スナップショット | `events` 系から derive した世界状態（`<chronicle_snapshot>`） | **L3 cache セグメントに同梱**（`volatileTail` ではない）。独立 trim key。trim では PLOT_THREAD の次・L5 より先 |
| PLOT_THREAD | プロットスレッド構成 | 現在シーンが属する縦糸の位置づけ（本文なし） | **`volatileTail` のみ**。trim では RAG の次・CHRONICLE より先 |
| RAG | 意味的再呼出 | `scene_chunks` 意味検索ヒット（`<related_scenes>`） | クエリ依存・`volatileTail` のみ。trim では EPISODIC の次 |
| EPISODIC | チャット履歴 RAG（エピソード記憶） | `chat_message_chunks`（`<chat_history>`） | **最も投機的**。trim では**全層に先んじて最初** |
| L5 | 会話要約 | `chat_summaries` | 予算超過時 CHRONICLE の次（**L4 より先**）に削る |
| L6 | コマンド指示 | スラッシュコマンド等の一回限り指示 | エフェメラル（そのターンのみ） |

> **トリムには 2 つの独立した機構があり、混同しないこと**（実装: `contextBuilder.ts`）。
>
> 1. **`trimToFit` の貪欲順序** — 予算超過時、`EPISODIC → RAG → PLOT_THREAD → CHRONICLE → L5 → L4 → L2 → L3 → L1` の固定順で各層を予算ぴったりまで削る。EPISODIC を最初に、scene RAG をその次に、plot-thread / chronicle を L5 より先に犠牲にし、L1 と L3 本文を最後に残す。
> 2. **縮退モードの予算配分** — `available = contextWindow − 応答予約` が input floor（4,500 tok）を割る極小窓モデル（例: AI のべりすと `damsel` = 2,400 tok）でのみ発動。L1/L2/L4 を**ゼロ**にし L3・L5 のみ確保する（`allocateLayerBudgets`）。

---

## L4 優先度スケール（0〜4）

L4 のトークン予算超過時、**数値が小さいブロックほど先に削除**される。

| pri | カテゴリ | 例 |
|-----|---------|-----|
| 0 | 自動派生（子孫） | Codex `children_budget` サブツリー |
| 1 | 自動派生（リレーション） | Codex relation BFS |
| 2 | メンション | 現在シーン本文または現在ターンのチャット入力で検出された Codex / Note |
| 3 | ユーザーピン（セッション） | 手動Spotlight Codex、Snippet ピン、Sticky ピン |
| 4 | 常時注入 | Codex / Note の `context_mode=always` |

`l4pri` マーカーがない L4 ブロックはデフォルト **pri 2**（mentioned）として扱う。
`Pin with children` で選ばれた直下子は自動派生ではなく個別の明示 pin として扱い、タグ・カスタムディテール・全文を含む **pri 3** のブロックになる。

---

## データソース → レイヤー対応

| ソース | レイヤー | 備考 |
|--------|---------|------|
| **Codex** | L4 | `context_mode`、別名、現在シーン本文 / 現在ターンのチャット入力でのメンション検出。自動 child / relation / 選択 Codex 本文からの cross-mention では `mentioned` は identity-only、`always` は本文を含む。`Pin with children` の直下子は `mentioned` / `suppress` / `always` を明示 pin として全文注入し、`hidden` は全経路で除外 |
| **Note**（`tree_nodes.node_type=note`） | L4 | Codex と同じモード。本文は `prosemirrorToText` 経由 |
| **Snippet** | L4（ピン時のみ） | セッションピンテーブル（`pinnedSnippets`）。同一 Snippet がアクティブタブの場合は L3（`activeTabContent`）にも別経路で載りうる（下記参照） |
| **Map Sticky** | L4（ピン時のみ） | セッションピンテーブル（`pinnedStickies`）。`<sticky>` ラッパー |
| **focus_subject**（スコープアンカー） | L3 と L4 の間（`<focus_subject>`） | Codex / Snippet スコープでアンカーした「この会話の主題」。**trim 対象外** |
| **activeTabContent**（参照中のコンテンツ） | L3 | Scene / non-Scene とも、アクティブタブが Codex / Snippet のとき L3 末尾に注入。同じ Codex / Snippet が `focus_subject` の場合は重複させない |
| **semantic recall** | RAG（`<related_scenes>`） | クエリ依存・`volatileTail` のみ |
| **chat episodic recall** | EPISODIC（`<chat_history>`） | クエリ依存・trim 最優先で削る |
| **chronicle snapshot** | CHRONICLE（`<chronicle_snapshot>`） | L3 cache セグメント同梱（`volatileTail` ではない）。`aiPrompt.chronicle.enabled`（既定 ON）で gate |
| **plot thread scenes** | PLOT_THREAD（`<plot_thread_scenes>`） | `volatileTail` のみ。`buildPlotThreadScenesInput` |
| **Map board overlay** | L4（pri = PINNED） | `mapBoardMarkdown` |
| **伏線（Foreshadow）** | L2（未回収一覧）、L3（シーン setup/payoff） | **L4 には載せない** |
| **Beat** | L3（`pendingBeatsSection` のみ） | 配置済み Beat はシーン本文内 |
| **story_time_label** | L3（現在シーン + story-time 直前シーン） | 読み順の直前シーンは従来どおり |
| **Map User edge → Codex Relation** | L4 BFS | 両端が Codex であること |

> **`focus_subject` は独立スロット（L0〜L6 の外）**：L3 の直後・L4 の前。trim では削られない。
>
> **注入順序**（プロンプト配列、`contextBuilder.ts` 1667–1681）:
> `application policy → author_instructions → L1 → L2 → L3 → focus → CHRONICLE → L4 → PLOT_THREAD → RAG → EPISODIC → L5 → reminder → L6`
>
> **cache 配置**（`cacheSegments`）: `[L0+L1, L2, L3+focus+chronicle（有効時）, L4stable]`
>
> **volatileTail**（`cacheSegments` の直後・cache_control 無し）:
> `l4Volatile → PLOT_THREAD → RAG → EPISODIC → L5 → reminder → L6`
>
> CHRONICLE は scene アンカー依存のため L3 cache に同梱。PLOT_THREAD / RAG / EPISODIC は毎ターン変わりうるため volatileTail のみ。

---

## Timeline vs Chronicle（混同防止）

| 概念 | パネル | 時間軸 | AI 注入 |
|------|--------|--------|---------|
| シーン配置・Codex Phase ピン | Timeline (`scenes`) | story-time / reading / write | Phase 解決は L4 |
| プロット through-line | Timeline (`threads`) | reading-order | PLOT_THREAD 層 |
| 作中イベント（Event） | Chronicle | fabula（ordinal + 暦ライト） | CHRONICLE 層 |

`get_scene_timeline_neighbors` ツールは **Timeline の story-time 隣接**（`tree_nodes.story_time_order`）であり、Chronicle の `events` ではない。

---

## 明示的に除外するもの

- Linter ルール / 用語辞書
- 帰属（Attribution）スパン
- ゴミ箱の内容
- 他チャットセッションのタイトル
- effective `hidden` の summary / content
- effective `suppress` の自動注入（Spotlight / Codex スコープ、または `Pin with children` 直下子の明示選択時だけ許可）

---

## Beat 注入設定

設定 → **Beat injection**（`beat.injectIntoContext`）を有効にすると、未配置 Beat と配置済み Beat のプレビューが `buildPendingBeatsSection` 経由で L3 に整形される。Beat の JSON 全文を一括注入することはない。

---

## Chronicle 注入設定

設定 → AI → **年表を AI に渡す**（`aiPrompt.chronicle.enabled`、プロジェクトスコープ、既定 ON）。OFF 時は `chronicleSnapshotText` を組み立てない。
