# モデル能力の動的取得（設計草稿）

- 状態：草稿（2026-11-18）。Mastra への移行と並行している。置き場所（§5）は Mastra の spike の後で確定する。
- 基点：origin/master `01dd6821`
- 枝：`claude/model-caps-dynamic`

## 1. 目的と現状

モデルの能力（tool use の可否、context window、最大出力、thinking／reasoning の方式、prompt cache の可否）を、手書きの表だけに頼らず実行時に解決する。

**現状**
- 動的に取っているのは OpenRouter と Ollama だけ（`src/features/chat/store.ts:113` の `DYNAMIC_CAPS_PROVIDERS`）。localStorage に 24 時間 cache する（`src/features/chat/agent/dynamicModelCaps.ts`）。
- 他の provider は `src/features/chat/agent/modelLimits.ts` の静的な表で決まる。
  - 表に無い Claude は context 200K と見積もる。表に無い 5 系以降は、同じ系列の最新の値を使う。
  - それ以外の未知モデルは context 8K の既定（`DEFAULT_CAPABILITIES`）に落ちる。
- Anthropic の一覧取得（#796）は `max_input_tokens`／`max_tokens` を `AiModel` に読み込むが、能力の解決では使っていない（`src-tauri/crates/grimodex-ai/src/lib.rs:586`）。
- prompt cache の可否と reasoning モデルの判定は、Rust がモデル名で行っている：
  - `supports_prompt_cache`（`lib.rs:2024`）：Anthropic、または OpenRouter で名前に `claude` を含むとき。
  - `is_openrouter_reasoning_model`（`lib.rs:1230`）。

  renderer の能力情報は Rust に届かない。

## 2. ユーザーの決定（2026-11-18）

- この lane を進める。
- 共有 registry を**実行時に取得する経路を持つ**。
- 取得先は 2 つ：
  - **既定は Grimodex の GitHub 上の写し**。CI が models.dev から定期的に生成・検証する。
  - 設定で **models.dev の直接取得**にも切り替えられる。
- **既定で有効**、設定で止められる。止めると、同梱の写しだけを使う。
- 段 1（観測）は Anthropic の実応答を待たず、**公式文書の例で進める**。実値との差分は、実応答が手に入った後に取る。

**Mastra の判断（同日）**：agent loop と tool の実行は Electron main へ移す。送信は Rust（`grimodex-ai`）を使い続け、AI SDK の LanguageModel adapter で包む。Mastra の telemetry は止める。会話履歴は Mastra の memory を使う（別設計）。

## 3. 解決の順序

上にあるものほど優先する。各値は出所（source）と取得日時を持つ。

1. **ユーザーの上書き**（field 単位）
   - 既存の `customMaxContext`／`customMaxOutput`（OpenAI 互換）と `ollamaContextLengths`（Ollama）を一般化する。
2. **製品の判断**（live に上書きさせない curated の値）
   - 例：haiku-4-5 に thinking を送らない、`xhigh` を持たない（製品の `EffortLevel` に無い）、`supportsStructuredJson`、`canDisableReasoning`、`reasoningEffortValues`。
3. **provider の live API**：§4 の表。
4. **共有 registry**：実行時の取得（§6）→ 同梱の写しの順。
5. **静的な表**：今の `modelLimits.ts`。live と registry が無いときの事実の予備。
6. **既定**：未知モデル向けの保守的な値。

**守ること**
- 「返さない」と「非対応」を区別する。field が無ければ `undefined` のまま下の層へ落とす。
  - 今の登録は、parameter の一覧があれば tools／reasoning を 0 にしている。context だけ返す server（Groq、vLLM、Gemini）に同じ規則を当てない。
- thinking／reasoning は boolean にしない。`{ supported, types[], effortLevels[], canDisable }` の形で持ち、request の形は provider の adapter が決める（Rust の `apply_thinking_to_body` など）。
- Anthropic の値を `mergeDynamicCaps` に通さない。この関数は thinking／adaptive／effort を false に固定する（OpenRouter の unified reasoning 向け）。merge は provider 別にする。

## 4. provider ごとの live の出所

| provider | context | 最大出力 | tool | thinking／reasoning | prompt cache |
|---|---|---|---|---|---|
| Anthropic `/v1/models` | `max_input_tokens` | `max_tokens` | 返さない（Claude は全部対応として製品の判断で持つ） | `capabilities.thinking.types.*`、`capabilities.effort.*` | 返さない（製品の判断で持つ） |
| OpenAI `/v1/models` | 返さない | 返さない | 返さない | 返さない | 返さない |
| OpenRouter `/api/v1/models` | `context_length`（※1） | `top_provider.max_completion_tokens` | `supported_parameters`（※2） | 同左 | `pricing.input_cache_read`／`input_cache_write` |
| Ollama `/api/show`、`/api/ps` | 最大は `model_info.*.context_length`、実確保は `/api/ps` | 返さない | `capabilities` | `capabilities`、`thinking` | 返さない |
| OpenAI 互換 | server による（LM Studio、llama.cpp、vLLM、LiteLLM、Groq、Mistral、DeepSeek） | server による | server による | server による | LiteLLM proxy だけ |
| Sakana | 返さない | 返さない | 返さない | 返さない | 返さない |
| AI のべりすと | 公開文書なし | 同左 | 同左 | 同左 | 同左 |
| CLI | CLI に委譲（今は 200K と仮定） | — | — | — | — |

- ※1：`:free` などの変種では、top-level が親モデルの値になる例がある（VS Code #332917）。`top_provider.context_length` と比べて小さい方を採る。
- ※2：全 provider の和集合（OpenRouter の公式の注記、LobeChat #9649）。Provider pin があるときは、`/api/v1/models/{author}/{slug}/endpoints` の pin 先の値を使う。

## 5. 置き場所（Mastra の調査の後で確定）

能力の知識が renderer と Rust の 2 か所にある。registry をどこに置くかで、Rust の判定（cache、reasoning）を一本化できるかが決まる。

- **案 R**：registry を Rust（`grimodex-ai`）に置き、renderer へは IPC で能力の解決結果を渡す。MCP と抽出の経路にも届く。`AiModel` の拡張は Rust → N-API → `ipcContract` → renderer にまたがる。
- **案 M**：Mastra を Electron main に入れる場合は、main に置く。Mastra の provider registry（models.dev 由来の同梱と override）を使えるか、調査の結論を待つ。

Mastra の判断の後の見通し：送信が Rust に残るので、cache の可否と reasoning の判定を一本化するには、能力の解決結果が Rust に届く必要がある。案 R が有力。Mastra の registry の能力は attachment／temperature／structuredOutput／reasoning だけなので、この lane の正本にはしない。確定は spike の後。

参照：Mastra 移行の実装計画 [`mastra-migration-plan.md`](mastra-migration-plan.md)（調査は [`mastra-migration-survey.md`](mastra-migration-survey.md)）。

## 6. 実行時の registry の取得（§2 の決定の具体化）

- **送信者**：main か Rust（§5）。renderer からは送らない。renderer は CSP で `connect-src 'self'`、RS-1 の封じ込めの対象。
- **既定の取得先**：Grimodex の GitHub 上の写し。
  - repo `kazormia296/Grimodex` は public。updater の `GrimodexReleases` は private。
  - URL の候補は raw の配信か release asset。host は §8 で確認する。
- **任意の取得先**：`https://models.dev/api.json`。
- **送るもの**：認証なしの GET だけ。小説の本文・設定・key は送らない。届くのは IP と User-Agent。User-Agent は一般の名前にし、利用者を特定しうる情報を入れない。
- **周期**：起動時は cache か同梱を先に使い、背景で取得する。取得は最大 1 日 1 回、失敗時は古い値を残す。
- **検証**：schema、値の範囲（context > 0 など）、件数の急減（前回の半分未満なら捨てる）を確かめ、通らなければ捨てる。
- **保存**：app の data 領域の 1 ファイル。版の番号を付ける。workspace の DB には入れない。
- **設定**：「モデル情報の自動更新」（既定は有効）と「取得先」（Grimodex／models.dev）の 2 項目。説明文で取得先を開示する。
- **CI**：models.dev から定期的に生成し、検証を通ったものだけ写しとして公開する。workflow は `update-route-watch.yml` と同じく secrets を使わない。license は models.dev の MIT（README で確認済み）。

この経路は external egress と background の追加にあたる。実装の前に、GDX-PRECHECK-001 の owner／lifecycle の表を作る：
- 開始、再試行、取消、待ちの上限、終了の証拠。
- 起動と終了の順序（app の終了の前に取得が残らないこと）。
- 設定を止めたときに、走行中の取得を閉じること。

## 7. 段の順

1. **観測**：Anthropic の実応答を fixture にして、live と今の表の差分を出す。挙動は変えない。
   - 今の `anthropic-version: 2023-06-01` で `capabilities` が返るかも確かめる。
   - 対象は gen5、haiku-4-5、Fable の 3 種。
2. **Anthropic の live 採用**：provider 別の merge、保存形式の版上げ、回帰試験。
   - 回帰試験は「一覧取得の後も gen5 に adaptive＋effort が送られる」を固定する。
   - 既知モデルは今の値と一致することを試験で固定し、表に無いモデルだけ挙動が変わる。
3. **OpenAI 互換の拡張 field**：endpoint ごとに分けて保存し、ユーザーの上書きを最優先のまま残す。
4. **同梱の写しと、実行時の registry の取得**（§6）：CI の生成、設定、取得の lifecycle。
5. **prompt cache の可否を能力に入れる**：Rust の名前判定と一本化する（§5 の結論が要る）。
6. **OpenRouter の穴の修正**（※1、※2）と、全 provider での field 単位の上書き UI。

## 8. 未確認と確認待ち

- Anthropic の実応答（`max_input_tokens` の実値、`capabilities` の有無と形）。公式の例は数値がプレースホルダ。
- GitHub の写しの配信 host と、その host を通信の一覧・開示の文面にどう載せるか。
- Mastra を採る場合の置き場所（§5）。
- Together、Fireworks、Gemini の OpenAI 互換の応答 field。
- 先行事例の issue は、OpenRouter の 2 件（VS Code #332917、LobeChat #9649）だけを照合した。他は二次情報。

## 9. 出典

- Anthropic Models API: https://platform.claude.com/docs/en/api/models/list
- OpenRouter models: https://openrouter.ai/docs/guides/overview/models
- Ollama show: https://docs.ollama.com/api-reference/show-model-details
- LM Studio REST: https://lmstudio.ai/docs/developer/rest/list
- models.dev: https://github.com/sst/models.dev
- opencode models: https://opencode.ai/docs/models/
- Mastra provider registry: https://github.com/mastra-ai/mastra/blob/a7bbe773/packages/core/src/llm/model/provider-registry.ts
- Vercel AI Gateway reasoning: https://vercel.com/docs/ai-gateway/models-and-providers/reasoning
- VS Code #332917: https://github.com/microsoft/vscode/issues/332917
- LobeChat #9649: https://github.com/lobehub/lobe-chat/issues/9649
- LiteLLM cost map incident: https://docs.litellm.ai/blog/model-cost-map-incident
