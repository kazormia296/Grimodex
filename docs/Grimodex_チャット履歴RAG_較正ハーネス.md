# チャット履歴RAG 較正ハーネス

エピソード recall の品質パラメータ（重み係数 α/β/cap/plain と gate/floor 閾値）を
**実埋め込み**で較正するためのハーネス。本体の [チャット履歴RAG](Grimodex_チャット履歴RAG.md)
の「残ゲート: α/β・閾値のライブ較正」に対応する。

## 設計

- **本番ロジックをそのまま使う**: 較正は本番の `selectChatRecallMessages` を import して
  呼ぶ（重み係数を options 注入できるよう `ChatRecallWeights` 化済み）。eval と production が
  ドリフトしない。
- **実埋め込み**: production と同一の int8 ONNX（ruri-v3-30m / bge-small-en-v1.5）を
  `onnxruntime-node` でこの環境で回す（Rust ort は glibc 不整合で不可）。doc/query prefix も
  `semantic/spec.rs` と一致（ruri は「検索文書: 」「検索クエリ: 」、bge は前置なし）。golden
  fixture と突き合わせて再現性を検証する。
- **precision-first の目的関数**: 無関連クエリで何も注入しない（fpRate=0）を最優先、次に
  F1 / R@1 / MRR。repo の「迷ったら何も注入しない」規律に合わせる。

## 構成

| ファイル | 役割 |
|---|---|
| `src/features/chat/calibration/corpus.json` | 評価コーパス（committed）。ja/en の過去メッセージ プール（role/効果信号付き）＋クエリ事例（gold / no-match）。 |
| `scripts/chatRecallLiveEmbed.mjs` | corpus を実 ONNX で埋め込み → `embeddings.generated.json`（gitignore）。golden 検証付き。 |
| `src/features/chat/calibration/chatRecallCalibration.eval.test.ts` | gate/floor/α/β/cap/plain をグリッド sweep し、本番 select で metrics 集計＋推奨構成を出力。`describe.skipIf` で embeddings 不在なら skip（CI は壊さない）。 |
| `scripts/eval-chat-recall-gen.mjs` | **OpenRouter** で corpus を拡張（小説執筆チャットの事例を schema どおり生成）。 |

## 実行手順

較正本体（embed + sweep）は LLM 不要・ローカルで完結する:

```sh
# 1. （任意）OpenRouter でコーパス拡張 — 較正を硬くする
OPENROUTER_API_KEY=sk-... node scripts/eval-chat-recall-gen.mjs
# 2. 実埋め込み（モデルが worktree 未取得なら EMBED_RES_DIR で本体 checkout を指す）
EMBED_RES_DIR=/workspace/src-tauri/resources/semantic node scripts/chatRecallLiveEmbed.mjs
# 3. sweep + レポート
pnpm test --run src/features/chat/calibration/chatRecallCalibration.eval.test.ts
```

## 知見（seed + OpenRouter拡張コーパス: ja 31メッセージ/14クエリ, en 21/12）

OpenRouter(gpt-4o-mini)でコーパスを拡張して実埋め込みで計測したところ、**重大な precision
バグ**が浮かび、ハーネスがそれを捕まえて修正に導いた。

### 1. 重み付きスコアをゲートにかけると precision が壊れる → **raw cosine ゲートへ修正**

実装当初は `weight = cos × (1+α·inserted+β·extracted)` を gate/floor の score にしていた。
拡張コーパスで無関連クエリ(税金/プログラミング/スポーツ)の最良マッチを見ると:

| ja 無関連クエリ | max RAW cos | max **weighted** |
|---|---|---|
| プログラミング | 0.782（gate0.85 未満=正しく弾ける） | **0.982**（突破） |
| 税金の申告 | 0.807 | **0.998** |
| スポーツニュース | 0.789 | **1.034** |

raw cosine は正しくゲート未満なのに、信号付きメッセージ(cos×1.15)が weighted でゲートを
突破して無関連注入を起こしていた。候補プールが大きいほど(max-of-N が上がる)悪化する。
**修正: gate/floor/選別は RAW cosine で行い、重み付けは選別後の並べ替えにのみ使う**
(`selectChatRecallMessages`)。「効いた発話を上位に・素 assistant を下位に」は順位付けで
担保しつつ、ゲート突破による混入を断つ。これは作者自身の「迷ったら何も注入しない」規律に整合。

| lang | 構成 | R@1 | recall | precision | fpRate |
|---|---|---|---|---|---|
| ja | weighted-gate(旧・バグ) | 0.11 | 0.52 | 0.33 | **1.00** |
| ja | **raw-gate(修正後)** gate0.85/floor0.80 | 0.67 | 0.65 | 0.44 | **0.00** |
| en | raw-gate, scene gate0.51 | 0.71 | 0.71 | 0.52 | 0.80 |
| en | **raw-gate + 較正 gate0.66/floor0.60** | 0.71 | 0.71 | 0.71 | **0.00** |

### 2. en の gate 0.51(scene 由来)はチャットには低すぎる → **0.66 へ**

bge は短い無関連クエリでも raw cosine が 0.5〜0.64 に座るため、scene gate 0.51 では
税金(raw0.64)等を弾けず fpRate=0.80。**chat 専用に en gate を 0.66 / floor 0.60 へ引き上げ**
ると fpRate=0 / R@1 0.71 / precision 0.71。ja(ruri)は raw-gate 化だけで scene 既定 0.85/0.80
が fpRate=0 になるため据え置き(`chatRecallParamsForLang`)。

### 3. コーパス品質の注意

gpt-4o-mini の自動生成は「友情/勇気/テーマ」等の汎用的な執筆チャットに偏り、シナリオ間の
意味的分離が弱い(gold の絶対 recall が伸びにくい)。また insertedToEditor を付け過ぎる傾向が
あり、結果として **weighted-gate バグを強く可視化した**(=テストとしては好都合)。より精密な
α/β 較正には、より強いモデル(gpt-4o / claude)や鋭いプロンプトで**分離の良い**コーパスが要る。

## 結論・適用

- **適用済み(本ブランチ)**: ①raw-cosine ゲート化(precision バグ修正・robust)、
  ②en chat gate 0.66/floor 0.60。両言語とも本番構成で fpRate=0・recall/R@1≥0.6。
- **未適用(データ不足)**: α/β/cap/plain の微調整。raw-gate 化で重みは順位付けのみに効くため
  影響は小さく、現状の既定(α0.15/β0.10/plain0.8)を維持。plain<1 は self-reference 抑制の
  質的安全側として保持。
## v2: 強モデル(gpt-4o)で larger/cleaner コーパス → 本番構成を scale 検証

固有名詞ベースの具体シナリオを gpt-4o で生成(ja 55メッセージ/19gold+7no-match, en 35/12+7)し
再較正。**本番構成(ja 0.85/0.80・en 0.66/0.60)は scale でも fpRate=0 を維持**:

| lang | gate/floor | R@1 | recall | precision | fpRate |
|---|---|---|---|---|---|
| ja | 0.85/0.80 | **1.00** | **0.94** | 0.63 | **0.00** |
| en | 0.66/0.60 | 0.92 | 0.64 | 0.79 | **0.00** |

- ja gate カーブ: fpRate=0 が 0.84〜0.88 で維持・recall 0.94、0.90 で recall 0.76 へ落ちる →
  **gate 0.85 が sweet spot**(55メッセージで確認)。en 0.66 も 35メッセージで fpRate=0 を確認。
- **α/β は raw-gate 下で inert**: 重みは注入確定後の ≤3 件の並べ替えにしか効かず、R@1 は重みに
  依らず ja1.00/en0.92。→ **α/β 微調整は metrics を動かさない・既定維持で確定**。precision の
  レバーは per-model gate(と最終的には reranker)。
- **較正の教訓(gen prompt 修正)**: no-match ケースに対応する**メッセージを生成してはいけない**。
  当初 gpt-4o は no-match 話題(Python/税金等)を**メッセージとしても**プールに入れ、その結果
  no-match クエリが正しくそれに当たって fpRate≈0.71 に見えた(=ラベルの罠・実 precision ではない)。
  no-match は**クエリのみ**でプールに不在、を prompt に明記。

## v3: フロンティアモデル(Claude Opus 4.8)でクロス検証

コーパス品質が較正の信頼性を左右するため、最新フロンティア(`anthropic/claude-opus-4.8`)でも
生成し直してクロス検証(ja/en 各 88メッセージ/24gold+8no-match。Opus は en も full に生成し、
gpt-4o の en 偏り[35]も解消)。committed fixture はこの Opus 版。

| lang | gate/floor | R@1 | recall | precision | fpRate |
|---|---|---|---|---|---|
| ja | 0.85/0.80 | **1.00** | 0.83 | 0.76 | **0.00** |
| en | 0.66/0.60 | 0.88 | 0.51 | 0.77 | **0.00** |

- **3モデル(gpt-4o-mini → gpt-4o → Opus 4.8)が一致**して本番構成で fpRate=0。設定は frontier
  モデル横断で robust。
- ja gate カーブ: R@1=1.0 が 0.83〜0.85・0.86 で落ち始める → **gate 0.85 が R@1 sweet spot**。
  en は gate **0.60 で fpRate=0.12(leak)**、0.62+ で fpRate=0 → 本番 0.66 はマージンあり。
- Opus は**より難しい gold** を生成するため en recall=0.51(top-3 で gold の半分を拾う)だが、
  R@1=0.88 で最良ヒットは当たる。**主要指標 fpRate=0 / R@1 は堅牢**。eval の品質ゲートも
  recall ではなく fpRate=0 + R@1≥0.6 に置く(recall はコーパス難度依存の情報項目)。
- α/β は Opus コーパスでも inert(R@1 は重みに依らず ja1.00/en0.88)。

## 結論

- 本番構成(raw-gate + ja 0.85/0.80 + en 0.66/0.60)は **3つの frontier モデルで生成した
  larger・分離の良いコーパスでクロス検証済み・変更不要**。α/β/cap/plain は raw-gate 下で inert の
  ため既定維持(plain<1 は self-reference 抑制の質的安全側)。reranker は依然 precision の最終解。
