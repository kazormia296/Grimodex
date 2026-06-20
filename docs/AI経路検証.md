# AI 経路の横断検証

アプリ内の **全ての AI 呼び出し経路** を実モデルで検証できるようにするための仕組み。
「どの経路が、どの手段で検証されるか」の正本は
[`src/features/ai-verification/aiPathRegistry.ts`](../src/features/ai-verification/aiPathRegistry.ts)
で、完全性は通常テストスイートの
[`aiPathRegistry.test.ts`](../src/features/ai-verification/aiPathRegistry.test.ts)
が機械チェックする（経路を足して検証手段を割り当て忘れると CI が落ちる）。

## 設計の核心 — 「JS 経路か Rust 経路か」で検証手段が決まる

ライブハーネス [`aiLiveHarness.ts`](../src/features/chat/agent/aiLiveHarness.ts) は
OpenRouter を `fetch` で**直接**叩き、本番の `invoke("send_chat_message")` →
Rust `ai::send_chat()` というトランスポートを**意図的にバイパス**する。
つまり検証するのは **挙動（プロンプト × ツール × モデル応答 × パーサ）** であって、
Rust トランスポートそのもの（provider routing / prompt cache / streaming イベント /
usage 台帳 / session_id routing）ではない。

この境界から、経路は次の層に分かれる:

| 層 | 例 | 検証手段 |
| --- | --- | --- |
| **① agent loop** (JS が全オーケストレーション) | Chat Agent 本体・run_research サブエージェント・Context Creator | `runLiveAgent` で忠実再現（ループは JS、`sendToLLM` のみ差し替え）|
| **② 単発** (JS でプロンプト構築→Rust で 1 往復) | synopsis / セッションタイトル / 要約 / 伏線監査ほか / beat role / map / tree | `runLiveSingleShot` ＋**本番のプロンプトビルダーと本番パーサ**|
| **③ post-effect** (Rust が全オーケストレーション) | 校閲 graders（intent drift / review / consistency / timeline / pseudo_comment / impact review）| **Rust 側ライブテスト**（`call_post_effect_api` を実プロバイダに直接）|
| **④ CLI** | claude/codex/opencode サブプロセス | 自動検証不可（stub・実機 smoke のみ）|
| **➖ 埋め込み/検索** | semantic_search / fts_search | LLM 生成でない（n/a・決定的 eval で別途）|

ドリフト防止: ②③ は**本番のビルダー/パーサを import して使う**（プロンプト文字列を
テストに再構築しない）。② のビルダー（map/tree の `buildSystemPrompt`/`buildUserPrompt`、
`parseCards`）は本検証のため production で `export` 済み。

## 実行方法

すべて既定 SKIP（キー未設定なら skip / 即 return）。実トークン課金あり。

### JS（① agent loop / ② 単発 / streaming）

```sh
# agent loop（既存）
OPENROUTER_API_KEY=sk-... pnpm test --run \
  src/features/chat/agent/agentToolCall.live.test.ts

# 単発サーフェス一式（synopsis/title/要約/伏線×3/beat/map/tree/streaming）
OPENROUTER_API_KEY=sk-... pnpm test --run \
  src/features/ai-verification/singleShot.live.test.ts

# relation 注入 eval（既存）
OPENROUTER_API_KEY=sk-... pnpm test --run \
  src/features/codex/relationInjectionEval.live.test.ts
```

モデル上書き: `OPENROUTER_MODEL`（既定 `openai/gpt-4o-mini`）。

### Rust（③ 校閲 post-effect graders）

```sh
OPENROUTER_API_KEY=sk-... cargo test --no-default-features \
  post_effect_live -- --nocapture
```

`--no-default-features` は CLAUDE.md の方針（default features 有効だと libort_sys の
glibc symbol mismatch でローカルリンク失敗）。テスト本体は
[`post_effect.rs` 末尾の `post_effect_live_tests`](../src-tauri/src/commands/post_effect.rs)。

### 完全性メタテスト（キー不要・通常スイート）

```sh
pnpm test --run src/features/ai-verification/aiPathRegistry.test.ts
```

レジストリの全生成経路に検証手段が割り当たっていること、`js-live`/`rust-live`/
`covered-by-agent-loop` の参照テストが**実在**することを assert する。

## 範囲外（意図的な gap）

- **Rust トランスポート層**: prompt cache breakpoint・streaming イベント配信
  （`chat:stream-*` / `inline-ai:stream-*`）・usage/cost 台帳・session_id routing・
  Anthropic native tool 形式・ローカル LLM チャネル。これらは Rust/IPC の責務で、
  OpenRouter 直叩きのハーネスでは再現しない。
- **CLI プロバイダ**: 外部バイナリ + 認証 + PATH 依存のため自動検証不可。
- **各 effect のプロンプト文言の同一性**: ③ の Rust テストは到達経路（transport →
  extract_json → parse）を検証する。プロンプト文言の権威は FE
  (`src/prompts/*/postEffect.ts`) 側にあり、文言の回帰は別途 FE で扱う。

## 経路を追加したら

1. 本番に AI 呼び出しサーフェスを追加する。
2. `aiPathRegistry.ts` の `AI_PATHS` にエントリを 1 つ足す（layer / transport /
   verifier / testRef / note）。
3. verifier に応じて検証を追加:
   - `js-live` → 単発なら `singleShot.live.test.ts` に 1 ケース（本番ビルダー＋パーサ）。
   - `rust-live` → `post_effect_live_tests` に 1 ケース。
   - `covered-by-agent-loop` → agent ループの構成違いなら testRef を既存 E2E に。
   - `stub` → 自動検証不可の理由を note に明示。
4. `aiPathRegistry.test.ts` が green であることを確認（穴・参照切れを検出）。
