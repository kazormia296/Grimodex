# AI モデルの機能別（ロール単位）設定

## 背景 — なぜ作るか

Grimodex には LLM を実際に叩く経路が約 25 ある（正本は
`src/features/ai-verification/aiPathRegistry.ts` の `AI_PATHS`）。にもかかわらず、
ユーザーがモデルを選べるのは事実上 **既定チャットモデル 1 つだけ** だった。

監査（2026-06-21）で判明した現状:

- 22 経路（あらすじ / 要約 / 伏線 3 種 / ビート役割推論 / Map AI Branch /
  Tree scaffold / Codex 提案 / agent 本体 / 校閲 post-effect 6 種 / 本文チャット）は
  すべて `provider.model`（既定チャットモデル）に相乗り。個別指定不可。
- `ai.inlineModel` と `ai.sessionTitleModel` は **設定画面に ModelPicker があるのに
  値がどのコードからも読まれない死に設定**だった（`types.ts` の定義と
  `AiCategory.tsx` の書き込み UI 以外に参照ゼロ）。設定しても効かない。

つまり「もっと細かくモデルを指定したい」というニーズに対し、現状は名目すら破綻して
いた。本機能はこれを正す。

## 設計の核 — 粒度は「意味ロール (7)」

経路ごとに 25 個の ModelPicker を並べる案は UX が破綻する（10〜15 画面分のスクロール・
決定疲労・どの slot がどの経路かの暗記負荷）。代わりに、経路を **能力要件と品質/コスト
特性が近い 7 つの意味ロール**に束ねる。ロールは `aiPrompt.custom.*` の既存バケット前例と
同じ意味分類で揃え、プロンプト軸とモデル軸の語彙を一致させる。

| ロール | 性格 | 能力制約 |
|---|---|---|
| `conversation` | 本文チャット。最高品質要求・cacheSegments を最も使う | — |
| `agent` | エージェント（ツールループ） | **tool 対応必須** |
| `inline` | 本文への直接生成（補完 / beat） | — |
| `cheap` | 短い・高頻度・低品質要求（安価モデル誘導） | — |
| `structured` | JSON 構造化出力 | （構造化信頼性。ゲートは Phase 2） |
| `review` | 校閲 post-effect | （構造化信頼性。ゲートは Phase 2） |
| `reader` | 本文を読む最中の擬似／リアルタイム読者コメント | （構造化信頼性。ゲートは Phase 2） |

### 不変条件

1. **空 = 既定フォールバック。** ロールキーが未設定なら解決層は `undefined` を返し、
   呼び出し側は Tauri command の `model` 引数へ `undefined`/`null` を渡す。Rust 側が
   `model.filter(非空).unwrap_or(settings.model)` で既定モデルへ解決する。**未設定時は
   wire payload に一切差分が出ない（byte-identical 後方互換）。**
2. **能力ガードは解決層 1 箇所で強制。** ロールに必要な能力（agent = tool 対応）を
   満たさないモデルが指定された場合は override を無視して既定へフォールバックする
   （安全側）。UI で不適合モデルを選んでも agent / 校閲が壊れない。
3. **対象外の経路は UI に出さない。** 埋め込み / FTS（ローカル ONNX・BM25・LLM でない・
   別軸）、CLI（外部バイナリがモデルを決める）、relation eval（ユーザー導線でない）、
   agent_call_limit（トランスポートでなく予算ノブ）。

正本実装は `src/features/chat/modelRouting.ts`（`PATH_TO_ROLE` /
`resolveModelForPath` / `isModelCapableForRole`）。設定キーは
`aiModel.role.{conversation,agent,inline,cheap,structured,review,reader}`（global / 既定 `""`）。

## 経路 → ロール対応表（凍結。再分類は本ドキュメント更新を伴うこと）

| ロール | 経路 ID |
|---|---|
| conversation | `chat_stream_non_agent` |
| agent | `chat_agent_main`, `agent_research_subagent`, `context_creator` |
| inline | `inline_ai_stream` |
| cheap | `session_title`, `summarization`, `beat_role` |
| structured | `synopsis`, `foreshadow_audit_chapter`, `foreshadow_propose_past_setups`, `foreshadow_evaluate_setup_strength`, `map_branch`, `tree_scaffold`, `codex_judgment` |
| review | `post_effect_intent_drift`, `post_effect_review`, `post_effect_consistency`, `post_effect_timeline_consistency`, `post_effect_impact_review` |
| reader | `post_effect_pseudo_comment`（手動／リアルタイム共通） |
| （対象外） | `semantic_search`, `fts_search`, `cli_chat_stream`, `relation_injection`, `agent_call_limit` |

この対応の完全性（generation-layer の全経路が role か excluded のどちらか一方に属する）
は `modelRouting.test.ts` のメタテストが `aiPathRegistry` と突き合わせて保証する。
新しい AI 生成経路を足したら、registry に追加し、`PATH_TO_ROLE` か
`MODEL_ROUTING_EXCLUDED` のどちらかへ必ず登録する（さもなくばメタテストが落ちる）。

## 段階出荷

### Phase 1（本 PR）— 解決層と配線、機能は既定固定

- `modelRouting.ts`（解決層・能力ガード）＋単体テスト＋完全性メタテスト。
- ロール 7 キーを `settings/types.ts` に追加（既定 `""`）。**UI は未露出。**
- FE で送信点を `resolveModelForPath` 経由に配線。Rust が `model:Option` を受理済の
  経路のみ:
  - 配線済: `chat_stream_non_agent`, `inline_ai_stream`, `session_title`,
    `beat_role`, `synopsis`, `foreshadow_*`(3), `map_branch`, `tree_scaffold`,
    `codex_judgment`
  - Phase 2 へ繰延（Rust 変更が必要）: `chat_*`/`context_creator`（agent）,
    `post_effect_*`（校閲）, `summarization`（injected callback 配線）
- ロールキーが空のため挙動は現状と完全同一（byte-identical）。これにより「UI は設定
  できるのに効かない」死に設定の再生産を、UI 露出前に解決層メタテストで封じる。

### Phase 2 — ロール UI と能力フィルタ、旧キー吸収、Rust 配線（出荷済）

- `AiCategory.tsx` に 7 ロールの ModelPicker（`MODEL_ROLES.map`）。旧 2 死にピッカー
  （ai.inlineModel / ai.sessionTitleModel）は撤去し、`settings.ai.roleModel.*`（ja/en）を新設。
- ロール ModelPicker の options を `modelWhitelist ∩ ロールの能力適合モデル`（`isModelCapableForRole`）
  で絞る（whitelist 空なら全モデル）。
- 旧 `ai.inlineModel` → `role.inline` / `ai.sessionTitleModel` → `role.cheap` を
  `migrateModelRoleKeys`（migration.ts・`migrateCardLayoutKey` と同型の冪等シム）で吸収。
  ブート列は `migrateAppSettingsToScopedStores` の後・`loadAll` の前。
- Rust:
  - `send_agent_message` に `model:Option<String>` 追加（`send_chat_message` と同一の
    `filter(非空).unwrap_or(settings.model)` 解決）。agent ロールを配線。
  - review post-effect は **独立した `model_override` フィールド**を `StartPostEffectRun(Multi)Args`
    に追加し、登録済 6 effect の各 `process_*_scene` で `apply_model_override(read_ai_settings, override)`
    で実呼び出しモデルだけ差し替え（既存 `model` は input_hash / runs.model 記録用に温存）。
    非登録の typo / meta_structure / intra は不変（byte-identical）。
- `modelLimits.ts` に `supportsStructuredJson?:boolean`（absent ⇒ true）を deepseek-r1=false で
  curated 追加し（`mergeDynamicCaps` が継承）、`structured` / `review` ロールの JSON 構造化ゲートを有効化。

#### Phase 2 で判明・対処した不変条件の穴（敵対レビュー）

- **cache-key 一貫性**: post-effect の input_hash は `model` を含むため、FE の `model` 変数は
  `resolveModelForPath(pathId) ?? baseModel`（実効モデル）にし、ロールモデル変更で正しく
  キャッシュが無効化されるようにした。consistency と intra で `model` を共有する 2 view
  （CurrentSceneAnnotationsView / ProjectAnnotationsView）は consistency 専用の実効モデルを
  別途算出し、intra を汚さない。`countOpenByOtherModel` は単一モデルでなく「今回使った
  モデル集合」で判定（別モデル警告の誤発火を防止）。
- **thinking パラメータ整合**: agent / conversation / context_creator は
  buildThinkingParams を**実効モデルから**算出するよう修正（変数 currentModel / chatModel /
  effectiveModel を実効モデルに）。これで override モデルと thinking/variant/予算/記録が一致する
  （未設定なら既定モデル = byte-identical）。単発経路（session_title 等）は Phase 1 で既に実効モデル算出済。

### Phase 3（任意・需要があれば）

- `<details>` 折りたたみ内に per-path エスケープハッチ（`ai.modelOverrides` JSON 1 キー）。
- ティアプリセット（balanced / quality / budget の 3 ボタンでロールキー一括設定）。

## やらないこと（過剰設計の回避）

- 25 個の個別 ModelPicker を平置きで出すこと（UX 破綻）。per-path は必ず折りたたみ＋
  ロールへの後付けに留める。
- Phase 1 で UI を先に出すこと（配線漏れ 1 箇所で死に設定を再生産する）。
- 埋め込み / FTS / CLI をロールやセレクタに露出すること（モデル軸が別 / 外部制御）。
- ロール跨ぎでプロバイダを変えられる前提のまま cache 分断の注記を省くこと（Anthropic→
  非 Claude でその経路の prefix cache が分断＝課金 / レイテンシ劣化。Phase 2 で注記）。
