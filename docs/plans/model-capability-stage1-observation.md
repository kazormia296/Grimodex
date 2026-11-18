# モデル能力の動的取得 段 1（観測）：Anthropic の live と今の表の差

- 状態：段 1 の記録（2026-11-18）。製品の挙動は変えていない。同日の独立点検の指摘を反映済み（§9）。
- 設計：[model-capability-discovery.md](model-capability-discovery.md) の §3、§4、§7。
- 枝：`claude/model-caps-dynamic`

## 1. 観測の対象と確かめたこと

- **入力**：Anthropic `GET /v1/models` の実応答。`anthropic-version: 2023-06-01` と `2026-10-21` の 2 つ。key は含まれない。
- **確かめたこと**
  - `2023-06-01` の版でも `capabilities` が返る（15 モデル全部）。
  - 両版の `data`（15 件）が JSON の深い比較で同一だったことは、**統合者が取得時に確かめた**。この worktree には元の 2 応答が残っておらず、fixture は 1 つ（`src/features/chat/agent/__fixtures__/anthropic-models-2023-06-01.json`）なので、独立には再確認できない。
  - 返る field：`id`、`display_name`、`created_at`、`line`、`max_input_tokens`、`max_tokens`、`capabilities`、`lifecycle`、`deprecated_at`、`retires_at`。`lifecycle`／`deprecated_at`／`retires_at` で値を持つのは claude-sonnet-4-5-20250929 だけ（§4.3）。
  - `capabilities` の key：`batch`、`citations`、`code_execution`、`context_management`、`effort`、`image_input`、`pdf_input`、`server_tools`、`structured_outputs`、`thinking`。
  - **tool use の可否と prompt cache の可否は返らない**（§4 の表のとおり。製品の判断で持ち続ける）。
- **実装**（どこからも呼んでいない）
  - `src/features/chat/agent/anthropicLiveCaps.ts`：`parseAnthropicLiveCaps(model: unknown)`。`{ contextWindow, maxOutput, thinking: { supported, types[], effortLevels[], canDisable }, imageInput, pdfInput, structuredOutputs, lifecycle, retiresAt }` を返す。応答に無い field は `undefined`、`supported:false` は `false`／空配列。**例外あり**：`types` があって `disabled` が無い場合の `canDisable` などは方針と合わない（§8）。`deprecated_at` は読まない（`AnthropicLiveCaps` に field が無い）。
  - `src/features/chat/agent/anthropicLiveCaps.test.ts`：parse の試験、15 モデルの「既知の差」の固定、lifecycle／`retires_at`／`deprecated_at` の固定、合成入力（今の挙動）の固定。
- **比較の相手**：`resolveModelCapabilities(id, { provider: "anthropic" })`。動的 meta は登録していないので、表（`modelLimits.ts` の `MODEL_CAPABILITIES`）の値がそのまま出る。

## 2. 差の要約

15 モデルのうち差がないのは `claude-opus-4-6` の 1 件。差は 21 件（モデル×field）。

| 分類                                          | 件数 | 内容                                                                                    |
| --------------------------------------------- | ---: | --------------------------------------------------------------------------------------- |
| product-decision（製品の判断）                |   11 | xhigh を持たない 10 件、haiku-4-5 に thinking を送らない 1 件                           |
| table-stale（表の誤り・古さ・欠落の**仮説**） |    5 | sonnet-4-6 の出力上限と max effort、opus-4-5 の出力上限と effort、sonnet-4-5 の出力上限 |
| not-modeled（製品の型に概念が無い）           |    5 | thinking を明示的に無効化できない（`disabled` 非対応）モデル                            |

**分類の注意**：product-decision と not-modeled は、製品の型・コード・表のコメントから根拠が取れる。**table-stale は「製品の判断でない差」の既定の分類で、表が古いという仮説にすぎない**（試験の `classify()` も、product-decision と not-modeled 以外を table-stale に落とす）。たとえば sonnet-4-6 の `supportsMaxEffort:false` は、表のコメント（`modelLimits.ts:155`「effort low〜max」）と型のコメント（`:45`「Opus 4.6 限定」）が食い違っており、意図的な判断だった可能性がある。出力上限の根拠も表のコメントには無い。直す前に、各件を意図の確認つきで扱う。

一致していたもの：

- **context window は 15 件全部が表と一致**（`max_input_tokens` と `contextWindow`）。
- thinking の方式（adaptive／budget）は、haiku-4-5 を除く 14 件が一致。
- tool 可否・prompt cache は live が返さないので比較なし。

## 3. モデルごと・field ごとの表

凡例：PD＝製品の判断、TS＝表の誤り・古さ、NM＝製品の型に無い。値は「live ／ 今の製品」。`—` は差なし。

| モデル                     | context | 最大出力                    | thinking の方式                                     | effort                                            | max effort                   | xhigh                  | thinking の無効化                                              |
| -------------------------- | ------- | --------------------------- | --------------------------------------------------- | ------------------------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------------------------- |
| claude-fable-5-2           | —       | —                           | —                                                   | —                                                 | —                            | PD（live 可／製品 無） | NM（live 不可）                                                |
| claude-haiku-5-5           | —       | —                           | —                                                   | —                                                 | —                            | PD                     | —（live 可）                                                   |
| claude-sonnet-5-5          | —       | —                           | —                                                   | —                                                 | —                            | PD                     | NM（live 不可。types は adaptive＋between_tools）              |
| claude-opus-5-5            | —       | —                           | —                                                   | —                                                 | —                            | PD                     | NM                                                             |
| claude-fable-5-1           | —       | —                           | —                                                   | —                                                 | —                            | PD                     | NM                                                             |
| claude-opus-5              | —       | —                           | —                                                   | —                                                 | —                            | PD                     | —                                                              |
| claude-sonnet-5            | —       | —                           | —                                                   | —                                                 | —                            | PD                     | —                                                              |
| claude-fable-5             | —       | —                           | —                                                   | —                                                 | —                            | PD                     | NM                                                             |
| claude-opus-4-8            | —       | —                           | —                                                   | —                                                 | —                            | PD                     | —                                                              |
| claude-opus-4-7            | —       | —                           | —                                                   | —                                                 | —                            | PD                     | —                                                              |
| claude-sonnet-4-6          | —       | **TS**（128,000 ／ 64,000） | —（live は enabled も可だが製品は adaptive を優先） | —                                                 | **TS**（live 可／製品 不可） | —                      | —                                                              |
| claude-opus-4-6            | —       | —                           | —                                                   | —                                                 | —                            | —                      | —                                                              |
| claude-opus-4-5-20251101   | —       | **TS**（64,000 ／ 未設定）  | —                                                   | **TS**（live 可：low／medium／high ／ 製品 不可） | —                            | —                      | —                                                              |
| claude-haiku-4-5-20251001  | —       | —                           | **PD**（live は budget 可 ／ 製品は送らない）       | —                                                 | —                            | —                      | —                                                              |
| claude-sonnet-4-5-20250929 | —       | **TS**（64,000 ／ 未設定）  | —                                                   | —                                                 | —                            | —                      | —（lifecycle は deprecated、`retires_at` は 2026-11-30。§4.3） |

live の effort の段階：5 系と opus-4-7／4-8 は low／medium／high／xhigh／max、sonnet-4-6 と opus-4-6 は low／medium／high／max、opus-4-5 は low／medium／high、haiku-4-5 と sonnet-4-5 は effort 非対応（`supported:false`）。

## 4. 分類の根拠

### 4.1 製品の判断（live に上書きさせない）

- **xhigh（10 モデル）**：live は xhigh を返すが、製品の `EffortLevel` は `low | medium | high | max`（`modelLimits.ts:11`）。`ANTHROPIC_GEN5_CAPABILITIES` のコメントにも「xhigh は製品の EffortLevel に無いので持たない」とある。live の `effortLevels` に xhigh が入っても、製品は使わない。
- **haiku-4-5 の thinking（1 件）**：live は `enabled`（budget_tokens）を許すが、表のコメントは「thinking は送らない。budget_tokens 方式に切り替えると費用と遅延が変わる」（`modelLimits.ts:100`）。live に上書きさせない。

### 4.2 表の誤り・古さ・欠落

- **sonnet-4-6 の出力上限**：表は 64,000、live は 128,000。**表の古さ**と見る（**仮説**。表のコメントに出力上限の根拠は無い）。context 1M は一致。
- **sonnet-4-6 の max effort**：表は `supportsMaxEffort:false`、live は `max` 対応。試験（`modelLimits.test.ts:75`）も「no max effort」を固定しているので、表を直すときはこの試験を同時に直す。**意図は未確認**（表のコメントは「effort low〜max」、型のコメントは「Opus 4.6 限定」で食い違う。上の分類の注意）。
  - `supportsMaxEffort` は `modelLimits.ts` の中でも型の定義（`:45`）と表の値だけで、**ロジックから読む箇所は `src`・`electron` 全体に無い**（`grep -rn supportsMaxEffort src electron`、試験を除く）。`buildThinkingParams` の adaptive 分岐（`modelLimits.ts:1028`）は `supportsMaxEffort` も `supportsEffort` も見ずに `taskEffort` を送るので、この差は**今の製品の request を変えない**。
- **opus-4-5 の effort**：表は「effort 非対応」、live は low／medium／high に対応。**表の古さ**と見る（仮説）。ただし採ると `buildThinkingParams` の budget 方式の分岐が `effort` を付ける（`modelLimits.ts:1041` の `caps.supportsEffort ? { effort: taskEffort }`）ので、request が変わる。`supportsEffort` をロジックから読むのは、この budget 方式の分岐（`:1041`）と最後の fallback（`:1053`）だけで、adaptive 分岐（`:1028`）は見ない。Rust は `output_config.effort` に載せる（`src-tauri/crates/grimodex-ai/src/lib.rs:3692` の `set_output_config_effort`）。`anthropic-beta` の effort 用の header は Rust には無い（同 `src-tauri/crates/grimodex-ai/src/lib.rs:3819` の `anthropic_request` の説明は prompt cache／interleaved thinking のみ）。**実際に送って通るかは未確認**。
- **opus-4-5 と sonnet-4-5 の出力上限**：表は未設定（`undefined`）、live は 64,000。**欠落**（これは事実。表に値が無い）。

### 4.3 製品の型に概念が無い（not-modeled）

- fable-5、fable-5-1、fable-5-2、opus-5-5、sonnet-5-5 は `thinking.types.disabled.supported` が無いか false（adaptive のみ、または adaptive＋between_tools）。製品の Anthropic 経路は「thinking を送らない」ことで OFF にし（`buildThinkingParams` の `enabled=false` は `{}`）、`disabled` の可否を持たない。
- **これらのモデルで thinking を送らなかったとき何が起きるかは、応答からは分からない**（always-on か、省略時 off かは未確認）。段 2 で扱う前に実 request で確かめる。
- 他に製品が持たない live 値：`image_input`、`pdf_input`、`structured_outputs`（全 15 件 true）、`lifecycle`、`deprecated_at`、`retires_at`。差としては数えていない。
- **lifecycle の観測**：15 件のうち **claude-sonnet-4-5-20250929 だけ**が `lifecycle: "deprecated"`、`deprecated_at: 2026-09-30T18:30:00Z`、`retires_at: 2026-11-30T17:00:00Z`（この記録の日付 2026-11-18 の 12 日後に退役）。残る 14 件は `active` で、`deprecated_at`／`retires_at` は null。この退役日は live でしか分からない（表にも製品の他の場所にも無い）。段 2 では使わない（§6）が、**観測として残す**。退役後に表の key と実際の挙動がどうなるかは未確認。`anthropicLiveCaps.test.ts` が `lifecycle`／`retiresAt`／`deprecated_at` の生の値を固定している。

## 5. 表に無いモデルの解決

- `claude-fable-5-2` は `MODEL_CAPABILITIES` に無い（5 系の key は fable-5-1、fable-5、opus-5-5 など。`modelLimits.ts:115-121`）。`resolveFutureAnthropicGeneration` が同 family の最新（fable-5-1）の能力に解決しており、この近似は live と一致する（context、出力上限、adaptive、effort、max）。差は xhigh と無効化の可否だけ。
- 15 件の解決の経路（`resolveHardcoded`、`modelLimits.ts`）：
  - **完全一致の key で解決**：claude-fable-5-1、fable-5、opus-5-5、opus-5、sonnet-5-5、sonnet-5、haiku-5-5、opus-4-8、opus-4-7、opus-4-6、sonnet-4-6、**haiku-4-5-20251001（`:168`）、sonnet-4-5-20250929（`:181`）**。haiku-4-5 は日付なしの `claude-haiku-4-5` の key（`:169`）も持つ。
  - **前方一致で解決**：`claude-opus-4-5-20251101` だけ（key は日付なしの `claude-opus-4-5`、`:171`）。
  - **`resolveFutureAnthropicGeneration` で解決**：`claude-fable-5-2` だけ（上記）。

## 6. 段 2 で採るべき値の提案

方針は設計 §3 のまま：**ユーザーの上書き ＞ 製品の判断 ＞ provider の live ＞ …**。live が返さない field は下の層に落とす。

| field                                     | 提案                                                                                                                                                    | 理由・注意                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contextWindow                             | live（`max_input_tokens`）を採る                                                                                                                        | 15 件全部が表と一致。変わるのは表に無い Claude（今は 200K の推定）だけ。`contextWindowSource` は `"dynamic"`                                                                                                                                                                                                                                                     |
| maxOutput                                 | live（`max_tokens`）を採る                                                                                                                              | 表に無いモデルの出力上限が分かる。表にある 3 件（sonnet-4-6 の 128K、opus-4-5／sonnet-4-5 の 64K）は挙動が変わるので、**表の更新を別 commit で明示し、試験も同時に直す**。応答予約は `min(maxOutput, context × 5%)`（`contextBuilder.ts:396-400`）で、sonnet-4-6 は 1M×5%＝50K で 64K を下回り、予約は変わらない見込み。`resolveTurnRoute.ts:271` の経路は未確認 |
| thinking の方式                           | 製品の判断（haiku-4-5 は送らない）を優先。表に無いモデルだけ live の `types` から決める：`adaptive` を含めば adaptive、それ以外は**送らない**（保守的） | `enabled` のみのモデルに budget_tokens を新しく送ると費用と遅延が変わる。段 2 の初回は変えない                                                                                                                                                                                                                                                                   |
| effort の段階                             | 製品の判断（xhigh を持たない）を優先。live は `max` の有無と、effort の可否の判定にだけ使う                                                             | xhigh を採る場合は `EffortLevel` の拡張（UI、Rust、設定）が要るので別 lane                                                                                                                                                                                                                                                                                       |
| effort の可否（opus-4-5）                 | **段 2 では採らない**（表のまま）                                                                                                                       | request が変わり、beta header 要否が未確認                                                                                                                                                                                                                                                                                                                       |
| max effort（sonnet-4-6）                  | 採ってよい。表と試験を同時に更新。ただし意図の確認（§4.2）を先に                                                                                        | `supportsMaxEffort` は**ロジックからの参照が無い**（型と表の値だけ）ので、request は変わらない。安全な理由は「参照が少ない」ではなく「参照が無い」こと                                                                                                                                                                                                           |
| thinking の無効化可否（canDisable）       | 段 2 では保存だけ（型に足さず、live の値を `AnthropicLiveCaps` に残す）                                                                                 | 製品に概念が無く、送らないときの挙動が未確認（§4.3）                                                                                                                                                                                                                                                                                                             |
| tool 可否・prompt cache                   | 製品の判断のまま（live が返さない）                                                                                                                     | §4 の表のとおり                                                                                                                                                                                                                                                                                                                                                  |
| image／pdf／structured_outputs／lifecycle | 段 2 では使わない                                                                                                                                       | 製品に使う箇所が無い。deprecated の表示などは別 lane。sonnet-4-5 の退役日（2026-11-30、§4.3）は live でしか分からないので、その lane の動機になる                                                                                                                                                                                                                |

段 2 の回帰試験（設計 §7-2）には次を足す：

- 15 モデルの解決結果が、live を merge した後も今と一致する（上の「表を更新する 3 件」を除く）。それを `EXPECTED_DIFFS` の更新として表す。
- 一覧取得の後も gen5 に adaptive＋effort が送られる。
- `mergeDynamicCaps` を Anthropic に通さない（thinking／adaptive／effort を false に固定する関数）。

## 7. 検証

`/home/grimodex/worktrees/Grimodex/model-caps` で次を実行した（`eval "$(fnm env --shell bash)"` の後）。点検の指摘（§9）の反映後に取り直した結果。

| command                                                                                                              | 結果                                                           |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm exec vitest run src/features/chat/agent/anthropicLiveCaps.test.ts src/features/chat/agent/modelLimits.test.ts` | 2 ファイル、146 件通過（`anthropicLiveCaps.test.ts` は 33 件） |
| `pnpm exec tsc --noEmit -p tsconfig.json`                                                                            | 約 50 秒、エラーなし                                           |
| `pnpm exec eslint`（`anthropicLiveCaps.ts`、`anthropicLiveCaps.test.ts`）                                            | 指摘なし                                                       |
| `pnpm exec prettier --check`（`anthropicLiveCaps.ts`、`.test.ts`、この文書）                                         | 通過                                                           |

未実行：`pnpm test` 全体、`verify:quality`、Quick／Full（この段は観測だけで、commit もしていない）。

### 試験が固定するもの・しないもの

- 固定するもの：15 件それぞれの live と表の差（`EXPECTED_DIFFS` の明示の期待値）、`lifecycle`／`retires_at`／`deprecated_at`（§4.3）、合成入力でのパーサの今の挙動（§8）。段 2 で表を直すと意図的に落ちるので、**観測の回帰基準**としては成立している。
- 固定しないもの（同語反復）：
  - **分類の正しさ**。`classify()` は field と id だけで決まり、既定が table-stale。`EXPECTED_DIFFS` の `category` を同じ関数が返すので、分類の独立した検証ではない（§2 の注意）。
  - 分類ごとの件数（11／5／5）は `EXPECTED_DIFFS` の再集計で、冗長。
  - xhigh の差は `push("xhigh", true, false)` と製品側を固定値で書くため、製品が xhigh を持つようになっても検出できない。
  - `Object.keys(EXPECTED_DIFFS)` と fixture の id の順が一致することを見る試験は、API の返却順に依存する。fixture は固定なので実害は無い。

## 8. パーサの今の挙動と方針の差（canDisable ほか）

`anthropicLiveCaps.ts` の冒頭の方針は「応答が返さない field は `undefined`、`supported:false` が明示されたときだけ `false`（空配列）」。次の入力ではパーサの挙動がこの方針と合わない。**パーサは変えず、今の挙動を合成入力の試験で固定した**（`anthropicLiveCaps.test.ts` の「合成入力（今の挙動の固定）」）。今の 15 件の fixture は `disabled` を必ず明示するので、実害は無い。

| 入力                                                                        | 今の挙動                                                           | 方針どおりなら                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `thinking.types` があり `disabled` の key が無い                            | `canDisable: false`                                                | `undefined`（返さない）                                   |
| `types.disabled` が形違い（`supported` が boolean でない、object でない）   | `canDisable: false`                                                | `undefined`（型の合わない値は返さない）                   |
| `types` が空 object                                                         | `types: []`、`canDisable: false`                                   | `types: []` までは方針どおり。`canDisable` は `undefined` |
| `effort.supported:true` で段階が 1 つも true でない（key 無し／全部 false） | `effortLevels: []`（`supported:false` と同じ形）                   | `undefined`（返さない）か、非対応と区別できる値           |
| `types` が object でない（配列・文字列・null）                              | `types`／`canDisable` とも `undefined`                             | 方針どおり                                                |
| `thinking`／`effort` が全部 `supported:false`                               | `{ supported:false, types:[], effortLevels:[], canDisable:false }` | 方針どおり                                                |

- 段 2 で `canDisable` を使うなら、`typesRaw.disabled` の有無を見て `undefined` を返すように**パーサを直す**か、利用側で「`types` が非空のときだけ `canDisable` を信じる」と決めてから使う（今は保存だけ。§6）。
- この修正は挙動の変更なので、この段では行っていない。直すときは上の表の「今の挙動」の期待値を意図的に書き換える。

## 9. 独立点検による訂正（2026-11-18）

独立点検（読み取りと vitest の再実行）の指摘のうち、確かめて採ったもの：

- §4.3 の「`retires_at`（全 15 件 null）」は誤り。sonnet-4-5 は `retires_at: 2026-11-30T17:00:00Z`（`node` で fixture を数えて確認）。§4.3 を直し、試験で固定した。
- §5 の「haiku-4-5、sonnet-4-5 は前方一致」は誤り。`MODEL_CAPABILITIES` に完全一致の key がある。前方一致は `claude-opus-4-5-20251101` だけ。§5 を直した。
- `supportsMaxEffort` は「`modelLimits.ts` の中だけが参照」ではなく、**ロジックからの参照が無い**。`supportsEffort` も adaptive 分岐では見られない（budget 分岐 `:1041` と fallback `:1053` だけ）。§4.2、§6 を直した。点検の指摘は adaptive 分岐を「`:1053` 付近」としていたが、実際は `:1028`（`:1053` は最後の fallback）。
- `lib.rs:3692`、`lib.rs:3819` は `src-tauri/crates/grimodex-ai/src/lib.rs` の行。path を明記した。
- table-stale は仮説（§2、§4.2）。
- 2 版の data の同一性は統合者が取得時に確かめた事実で、この worktree では独立に再確認できない（§1）。
- canDisable の「返さない」と「非対応」の区別が崩れる箇所、types 全部 false の合成入力の試験が無い点（§8）。
