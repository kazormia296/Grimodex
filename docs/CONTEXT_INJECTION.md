# AI コンテキスト注入 — レイヤーマップ

Grimodex はチャットのシステムプロンプトに、プロジェクトの構造化メタデータを **L0〜L6** の 6 レイヤーで注入する。本ドキュメントは「どのデータソースがどのレイヤーに載るか」の**クイックリファレンス**である。

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

実装の中心: `src/features/chat/contextBuilder.ts`, `src/features/chat/chatStore.ts`

---

## レイヤー概要

| レイヤー | セクション | 主なデータソース | トリム時の挙動 |
|---------|-----------|----------------|--------------|
| L0 | ベース + エージェント指示 | 静的プロンプトカタログ | トリムしない |
| L1 | プロジェクト情報 | `projects`（ジャンル・視点・文体など） | 通常トリムでは**最後まで保護**（trimToFit 順で最終）。styleGuide→aiInstructions→genre/pov/tense の順で除去しタイトルは残す。damsel 等の縮退モードでは L2/L4 と共にゼロ化 |
| L2 | これまでの物語 + アウトライン + 未回収伏線 | シーン要約、フォルダ要約、`projects.outline`、未回収伏線 | 先頭エントリから削る。末尾の `projectOutline` は最後まで残る |
| L3 | 現在のシーン | シーン本文、ラベル、Beat、シーン伏線、story-time 隣接、`@scene` ピン | 本文は先頭から削る。ヘッダー・伏線ブロックは保護 |
| L4 | Codex / Note / Snippet / Sticky | メンションまたはピン留めされたエンティティ | 優先度（pri）に基づくブロック単位の削除（下記） |
| L5 | 会話要約 | `chat_summaries` | 予算超過時 RAG の次（**L4 より先**）に削る。古い要約ブロックから先頭削りし直近を残す |
| L6 | コマンド指示 | スラッシュコマンド等の一回限り指示 | エフェメラル（そのターンのみ） |

> **トリムには 2 つの独立した機構があり、混同しないこと**（実装: `contextBuilder.ts`）。
>
> 1. **`trimToFit` の貪欲順序** — 予算超過時、`RAG → L5 → L4 → L2 → L3 → L1` の固定順で各層を予算ぴったりまで削る。RAG（自動検索の投機的文脈）を最初に、L1（プロジェクト情報）と L3（現在シーン）を最後に犠牲にする。層内では価値考慮トリム（L4=pri スケール / L3=末尾保持の二分探索 / L2・L5・RAG=古い順 / L1=styleGuide 先）。
> 2. **縮退モードの予算配分** — `available = contextWindow − 応答予約` が input floor（4,500 tok）を割る極小窓モデル（例: AI のべりすと `damsel` = 2,400 tok）でのみ発動。L1/L2/L4 を**ゼロ**にし L3・L5 のみ確保する（`allocateLayerBudgets`）。

---

## L4 優先度スケール（0〜4）

L4 のトークン予算超過時、**数値が小さいブロックほど先に削除**される。

| pri | カテゴリ | 例 |
|-----|---------|-----|
| 0 | 自動派生（子孫） | Codex `children_budget` サブツリー |
| 1 | 自動派生（リレーション） | Codex relation BFS |
| 2 | メンション | シーン本文またはチャット入力で検出された Codex / Note |
| 3 | ユーザーピン（セッション） | Spotlight Codex、Snippet ピン、Sticky ピン |
| 4 | 常時注入 | Codex / Note の `context_mode=always` |

`l4pri` マーカーがない L4 ブロックはデフォルト **pri 2**（mentioned）として扱う。

---

## データソース → レイヤー対応

| ソース | レイヤー | 備考 |
|--------|---------|------|
| **Codex** | L4 | `context_mode`、別名、Spotlight ピン、メンション検出 |
| **Note**（`tree_nodes.node_type=note`） | L4 | Codex と同じモード。本文は `prosemirrorToText` 経由 |
| **Snippet** | L4（ピン時のみ） | セッションピンテーブル（`pinnedSnippets`）。同一 Snippet がアクティブタブの場合は L3（`activeTabContent`）にも別経路で載りうる（下記参照） |
| **Map Sticky** | L4（ピン時のみ） | セッションピンテーブル（`pinnedStickies`）。`<sticky>` ラッパー |
| **focus_subject**（スコープアンカー） | L3 と L4 の間（`<focus_subject>`） | Codex / Snippet スコープでアンカーした「この会話の主題」。`focusSubject` で渡す。Codex は Spotlight 相当のフル描画、Snippet は title + 抽出本文。**trim 対象外で常時注入**するため、呼び出し側は当該アンカーを L4 の `pinnedCodexEntries` / `pinnedSnippets` から除外して重複させない |
| **activeTabContent**（参照中のコンテンツ） | L3 | アクティブタブが Codex / Snippet のとき `## 参照中のコンテンツ` として L3 末尾に注入。type / title / 抽出本文 |
| **semantic recall（Layer4 RAG）** | RAG（`<related_scenes>`、L4 の直後） | `semanticRecall` で渡す意味検索ヒット（過去シーン抜粋）。クエリ依存で毎ターン変動するため `cacheSegments` には載せず `prompt` + `volatileTail` のみ。trim では全層に先んじて削られる |
| **Map board overlay** | L4（pri = PINNED） | `mapBoardMarkdown`：アクティブ Map board 全体を `<map board="…">…</map>` で囲んだ 1 ブロック（`l4pri:3` マーカー付きで `pinnedStickies` の直後に追加）。`includeMapBoard` 有効時のみ。スコープと直交し folder / project 経路でも注入される |
| **伏線（Foreshadow）** | L2（未回収一覧）、L3（シーン setup/payoff） | `deriveLabel` による派生ラベル。**L4 には載せない** |
| **Beat** | L3（`pendingBeatsSection` のみ） | 配置済み Beat はシーン本文内。未配置 Beat は pending セクション。**Beat 一括ダンプはしない**（過剰注入リスク） |
| **story_time_label** | L3（現在シーン + story-time 直前シーン） | 読み順の直前シーンは従来どおり |
| **Map User edge → Codex Relation** | L4 BFS | 両端が Codex であること。昇格後は derived edge として描画 |

> **`focus_subject` は独立スロット（L0〜L6 の外）**：プロンプト本文・トークン内訳・cacheSegments とも **L3 の直後・L4 の前**に置かれる擬似レイヤー（内訳ラベルは `FOCUS`）。L3 と同じ cache セグメントに統合され、trim では削られない（`hardeningOverhead` で本文ぶんを先取り予約）。
>
> **ピン留め Snippet の二経路**：同一 Snippet が「セッションピン」かつ「アクティブタブ」のときは、L4（`pinnedSnippets`）と L3（`activeTabContent` = 参照中のコンテンツ）の双方に注入されうる（両経路間の重複排除はしない）。一方、Snippet スコープのアンカーは `focusSubject` 側に集約し L4 の `pinnedSnippets` からは除外される。

---

## 明示的に除外するもの

- Linter ルール / 用語辞書
- 帰属（Attribution）スパン
- ゴミ箱の内容
- 他チャットセッションのタイトル

---

## Beat 注入設定

設定 → **Beat injection**（`beat.injectIntoContext`）を有効にすると、未配置 Beat と配置済み Beat のプレビューが `buildPendingBeatsSection` 経由で L3 に整形される。Beat の JSON 全文を一括注入することはない。
