# 影響度レビュー (impact-review) 実装計画

## 目的

Codex エントリ（キャラ設定・世界観など）を**変更したとき**に、**既に書いた本文**の
どこが矛盾・影響を受けるかを検出する。consistency（シーン起点の矛盾検出）の**逆引き版**。

- **変更起点**: 「この設定を変えた」→ 影響シーンを逆引き。
- **二段フィルタ**: (a) embeddings で候補シーンを 1-2 桁に絞る → (b) 絞った候補だけ AI で
  「矛盾／無関係」を判定（全書 AI スキャンより安い）。
- **伏線再評価**: Codex 変更時に foreshadowCodexLinks 経由で setup↔payoff を stale 化。

## 既存資産（master 実測・流用前提）

- embeddings: scene_chunks / codex_chunks とも埋め込み済み。`semanticSearch(query)` は
  クエリ文字列を埋め込んで scene チャンクを返す＝**stage-a の候補絞りにそのまま使える**。
  hybrid RRF（`selectHybridRecallChunks` / `fuseCodexHybrid`）も流用可。
- post-effect: `call_post_effect_api`（Rust 窓口）＋ effect type 7種。`consistency` が
  既に Codex↔本文矛盾を AI 判定。**新 effect type 追加は約5箇所配線＋registry**。
- 注釈 UI: `PostEffectAnnotation`（category＋metadata＋dismiss/resolve＋passage jump）が正本。
  Kouetsu Issues タブに節追加で 95% 流用。
- 伏線: **既に完全 first-class**（foreshadows/foreshadowSetups/foreshadowCodexLinks、
  deriveLabel ステートマシン、staleness、専用パネル）。欠けるのは Codex 変更トリガのみ。

## 決定事項（2026-06-18 ユーザー確定）

- MVP 範囲: **新 effect type `impact_review`** ＋ **伏線再評価**（フル）。
- トリガ: **手動ボタン**（Codex 詳細「この変更の影響をチェック」）。自動は Phase 2 へ設計だけ残す。

## アーキテクチャ

### 差分の基準（baseline）
手動トリガなので「何と比較するか」が要る。**エントリ単位の baseline スナップショット**を持つ:
- 新テーブル `impact_review_baselines (entry_id PK, project_id, snapshot_json, content_hash, reviewed_at)`。
- ボタン押下時: diff = 現在のエントリ vs baseline。baseline 無し（初回）= 全文を「変更」扱いで広く判定。
- レビュー実行後に baseline を現在状態へ更新（＝「前回チェック以降の変更」を見る）。

### Stage-a 候補絞り（FE: impactReviewPayloadBuilder.ts）
1. 差分テキスト（変わった summary/content/detail と新値）を組み立て。
2. dense: `semanticSearch(diffText | newEntryText, {scope: project})` → 候補 scene chunk。
3. sparse: scene FTS で entry name/aliases マッチ（明示言及の取りこぼし救済）。
4. RRF 融合（`selectHybridRecallChunks` 流用、閾値は緩め: gate なし or floor 0.65）→ 候補 scene ID 上位 N（既定 ~30）。

### Stage-b AI 判定（Rust: 新 effect type `impact_review`）
consistency の process_*_scene パターンを踏襲:
- whitelist / prompt_version / spawn 追加（post_effect.rs）。
- `process_impact_review_scene`: `call_post_effect_api(.., Some(codex_diff_json), scene_text)`
  → extract_json → from_str → `extract_array_field(&p, "judgments")` → dedupe(strong_normalize)
  → hallucination 検証(entry_id) → find_text_position → `dismiss_key_impact_review(scene_id, change_id, found_text)`
  → is_annotation_previously_closed → INSERT category='impact_review_anchor'。
- prompts/ja(+en)/postEffect.ts に `IMPACT_REVIEW` system prompt ＋ JSON 契約（judgments[]）。
- aiPathRegistry.ts に `post_effect_impact_review` 登録（metatest が欠落を検出）。
- Rust `#[cfg(test)]` ライブテスト（OPENROUTER_API_KEY gate・既定 skip）。

### 注釈カテゴリ / メタ
- PostEffectCategory に `impact_review_anchor` 追加（TS types＋Rust 受理）。
- metadata: `impact_ref { change_id, entry_id, entry_name, change_summary, contradiction_score,
  reason, confidence, found_text, found_context, dismiss_key }`（consistency の codex_ref と分離）。

### UI
- Codex 詳細パネルに手動ボタン「この変更の影響をチェック」＋進捗トースト＋結果サマリ。
- Kouetsu Issues タブに `impact_review` 節（ConsistencySection と同型: Current/Project/Ignored、
  PostEffectAnnotationPanel に impact_review_anchor フィルタ）。passage jump は jumpToComment 流用。
- i18n（ja/en）。

### 伏線再評価（Phase 5）
- Codex 保存後（updateCodexEntry／codexStore.update）に foreshadowCodexLinks を引き、
  該当 foreshadow の `codexLinkDirtyAt = now` をセット（新カラム）。
- staleness を `codexLinkDirtyAt > lastEvaluatedAt` でも stale 判定するよう拡張。
- ForeshadowPanel の stale ドットで surface（理由: Codex 変更）。再評価で解消。

## フェーズ（commit 単位）

1. **基盤**: DB migration（impact_review_baselines 追加 / foreshadows.codexLinkDirtyAt 追加 /
   impact_review_anchor 受理）＋ schema.ts ＋ types（PostEffectCategory・ImpactReviewAnnotationMeta）。
2. **Rust effect type**: post_effect.rs 配線 ＋ process/run ＋ dismiss_key ＋ prompts ja/en ＋
   aiPathRegistry ＋ Rust ライブテスト。
3. **FE stage-a + 実行**: impactReviewPayloadBuilder（diff＋hybrid 絞り）＋ api/store
   `runImpactReview(entryId)` ＋ baseline capture/update ＋ 単体テスト。
4. **UI**: Codex ボタン ＋ Kouetsu 節 ＋ jump ＋ i18n。
5. **伏線再評価**: codex 保存トリガ ＋ staleness 拡張 ＋ パネル表示 ＋ テスト。
6. **検証＋敵対レビュー**: pnpm test / tsc / lint:fix / cargo check & test / live ＋ /review-code。

## 検証

各フェーズ: `pnpm test --run <files>` / `npx tsc --noEmit`。Rust 変更: `cargo check` ＋
`cargo test --no-default-features`。完了前に全体 `pnpm test` ＋ `lint:fix` ＋ 敵対レビュー。

## 非目標（Phase 2 以降）

- 保存時自動トリガ（フック点だけ用意）。
- Codex↔Codex 影響（別エントリへの波及）。
- リアルタイム（編集中）プレビュー。
