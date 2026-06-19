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

## 予備的知見（seed コーパス: 各言語 16 メッセージ / 8 クエリ）

実埋め込みでの実測:

| lang | 構成 | R@1 | recall | precision | fpRate |
|---|---|---|---|---|---|
| ja | scene 既定 (gate0.85/floor0.80) | 0.83 | 0.58 | 0.39 | 0.00 |
| ja | sweep 最良 (gate0.82/floor0.76) | **1.00** | **0.83** | 0.56 | 0.00 |
| en | scene 既定 (gate0.51) | 0.83 | 0.78 | 0.56 | 0.50 |
| en | sweep 最良 (gate0.54) | 0.83 | 0.81 | 0.67 | 0.50 |

**読み取り:**
- **scene 由来の既定はチャットに最適ではない**。とくに ja は **floor 0.80 が高すぎ**、
  チャットメッセージ（シーン本文より短い＝cosine が低めに出る）の recall を 0.58 に抑えていた。
  floor を 0.76 へ下げると recall 0.83 / R@1 1.00 へ、しかも fpRate=0 のまま。
- 話題隣接の **ハード負例**（晩餐会↔貴族街）は ruri/bge の高ベースラインでは gate 単独で
  完全分離できない（設計既知・真の解は reranker）。クリーンな無関連（プログラミング）は
  ゲートで弾ける。弱 recall の leak は **Codex > chat RAG 順序**で正典を上書きしないので許容範囲。
- plain-assistant 減点（0.8）は本 recall コーパスでは recall/precision を犠牲にしない一方、
  この指標では押し上げ効果も小さい。**その価値は self-reference 抑制（モデル自身の過去の
  憶測を等倍で戻さない）という質的な安全側にある**ため、recall 指標が報いなくても維持する。

## 結論・次アクション

- **本番定数はまだ変更しない**。seed は 8 クエリと小さく、過適合のリスクがある
  （repo の閾値較正は 36 ペア規模で確定してきた）。
- **次アクション**: `eval-chat-recall-gen.mjs`（OpenRouter）でコーパスを数十シナリオ規模へ
  拡張 → 再 sweep → データ裏付けのある定数（とくに ja の chat 専用 floor）を適用。
  方向性（chat は floor を下げる余地大）はこの予備計測で既に robust。
