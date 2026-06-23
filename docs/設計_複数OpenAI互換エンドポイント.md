# 複数 OpenAI 互換エンドポイント対応（設計メモ）

作成: 2026-06-23 / branch: `feat/ai-multi-compat-endpoints`（base: `feat/chat-multiprovider-model-picker` 186a44fa）

## 背景・課題

現状 OpenAI 互換プロバイダ (`AiProvider::OpenaiCompatible`) は **エンドポイントを 1 つしか**
持てない。`AiSettings.openaiCompatible.baseUrl` 単一・keyring も
`grimodex-openai-compatible` × `grimodex-user` の 1 エントリのみ。
ローカル llama.cpp + クラウド互換 gateway + 別 vLLM …を**複数登録し**、
さらに直近で出荷した「クロスプロバイダ・チャットピッカー / A-B 枠別プロバイダ /
ロール別ルーティング」と**同時に横断利用**したい、というのが要望。

## 採用方針: Approach B（orthogonal endpointId）

`AiProvider` の閉じた enum は**温存**し、`endpointId` を provider と直交する
**新しい 1 軸**として、直近のクロスプロバイダ実装が敷いた override レール
（chat override / A-B 枠 / per-role）にもう一度通すだけ。

- 利点: 20 箇所の Rust dispatch arm（auth/trust gate/tool protocol 等の安全クリティカル層）と
  `Record<AiProvider>` / `never` 網羅ガード / 完全性メタテストを**割らない**。
  解決は送信直前の `endpoints()` / `resolve_api_key()` に上げるだけ。
- 不採用: A（active 切替のみ＝同時利用不可で A-B/per-role の意味が薄い）、
  C（`openai-compatible:<id>` で enum をパラメトリック化＝全 29 サイト改修・XL/高リスク）。

## データモデル

```
OpenaiCompatibleEndpoint { id, label, baseUrl, customMaxContext?, customMaxOutput?,
                           enableStructuredTasks?, apiVariant? }
AiSettings += openaiCompatibleEndpoints: OpenaiCompatibleEndpoint[]
           += activeOpenaiCompatibleEndpointId?: string
（legacy `openaiCompatible` フィールドは round-trip / downgrade 用に温存）
```

- 移行用既定 ID は固定文字列 `"default"`（`LEGACY_OPENAI_COMPAT_ENDPOINT_ID`）。
  新規エンドポイントは `crypto.randomUUID()`。
- `id` は keyring user / override 参照キー。`apiVariant` はそのエンドポイント既定の API 経路。

## keyring（per-endpoint・load-bearing）

scheme (a): service 名は `grimodex-openai-compatible` のまま、**keyring user に endpointId** を載せる
（`KEYRING_USER` 軸が現状空いている）。

- `save/get/delete_api_key(provider, endpoint_id)`。
- **legacy fallback**: `get_api_key` が endpoint_id == `"default"` の場合のみ
  `NoEntry` 時に旧 user `grimodex-user` を試す（移行ユーザーの既存キーを無入力で継続）。
  新規追加エンドポイントの欠落キーを**マスクしない**よう default のみ対象。

## migration

- `read_ai_settings` で normalize: `openaiCompatibleEndpoints` が空かつ legacy
  `openaiCompatible.baseUrl` が非空なら `{id:"default", ...legacy}` を 1 件合成し、
  `activeOpenaiCompatibleEndpointId="default"`。
- legacy フィールドは削除しない（downgrade 互換）。FE も保存時に default を legacy へミラー。

## endpointId を通す経路（Stage2/3）

`sendChatMessageStream` / `sendAgentMessage`（`+apiEndpointId`）→ 3 sendToLLM callsite →
chat override quartet（`chatEndpointIdOverride`）→ `getCrossProviderChatOverride` が
`{provider,model,variant,endpointId}` → 5 consumer。A-B `AbConfig += endpointId`。
カタログ/ピッカーは `(provider,endpointId)` で cache key。Rust 送信コマンド群に
`endpoint_id: Option<String>` を追加し `settings_for_call.active... = endpoint_id`、
`resolve_api_key(provider, endpoint_id)`。

`resolve_api_variant` に「解決済みエンドポイント既定の apiVariant」段を追加（SSOT）。

## 罠（既知メモから）

- endpointId を 1 サイトでも落とすと**無言で active 既定に fallback**（`run_research` provider-drop と同型）。
  → 完全性メタテスト（`aiPathRegistry`）を endpointId 糸通しに拡張して gate。
- 新 provider 追加ではないので `match/switch/Record<AiProvider>` の網羅は割れない（B の肝）。
- Rust typed struct 往復で未知 field drop → TS/Rust 両 struct に新フィールドを必ず対で持つ。

## 検証

worktree(ext4) で tsc / vitest full / eslint / `cargo check`+`clippy --no-default-features`。
全 green 後に並列敵対レビュー workflow（endpointId drop / migration / keyring fallback /
exhaustiveness / A-B 同時利用）→ 指摘修正。実機 GUI / live LLM は残ゲート。
