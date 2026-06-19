# Grimodex 英語対応検討（2026-06-13 調査）

8 領域並列の codebase 調査（embedding / lint・校閲 / FTS / フォント / メトリクス / AIプロンプト / i18n / JP特化機能）＋抜け漏れ検証 3 件の結果。

## TL;DR

**「箱は出来ているが中身が未充填」**。per-project `language` 列（ja/en/zh/ko, `src/db/schema.ts:19`）、UI 言語切替（`uiLanguage` → i18next, 3箇所のUI＋永続化済み）、en.json 2,290 キー、決定論 lint の en ルールセットまで基盤は配線済み。真のブロッカーは 4 つ:

1. ~~**AI プロンプトカタログの en 版がほぼ未実装**~~ → **実装完了**（EN_CATALOG で全カテゴリ実装済み。残課題は LLM 校閲 8 種の ja ハードコード化、trim マーカー同期、読者ペルソナ日本語固定。2026-06-20 追記）
2. ~~**embedding が日本語特化 ruri-v3-30m 固定**~~ → **per-language embedding 実装完了**（en は bge-small-en-v1.5 を `spec_for_language()` で選択。RAG 沈黙は解消。2026-06-20 追記）
3. **word count が一級市民でない**（英語小説の標準単位が欠落、全表示が char）
4. **LLM 校閲 8 種が `getPromptCatalog("ja")` ハードコード**（決定論 lint は対応済み、LLM 側が未対応）

## 既に出来ていること（追加作業ほぼ不要）

- **per-project language**: `projects.language`（NOT NULL default "ja"）、作成/設定 UI、`document.documentElement.lang` 反映（`projectStore.ts:95-96`）、チャット経路への lang 配線（`chatStore.ts` → `getPromptCatalog(lang)`）。
- **UI 言語切替**: `App.tsx:131-136` が `uiLanguage` を購読し `changeLanguage()`。設定画面（DisplayCategory）・オンボーディング（LanguageStep）・WelcomeScreen の 3 箇所＋Rust `workspace.rs` 永続化。`lng:"ja"` はブートストラップ既定値にすぎない。
- **決定論 Linter**: `Language::English` enum、`rules/en/`（double-space/ellipsis/em-dash/straight-quotes の 4 ルール）、`resolveLintLanguage()` が project.language に追従。**lindera は en では起動しない**（`engine.rs:61-80` の needs_morph 判定）。クラッシュも誤検出もない。
- **en.json**: 2,290 キーで翻訳品質も自然（サンプル確認済み）。複数形 `_one/_other` も正しい。
- **smartQuotes/smartDashes**: TipTap 標準 Typography 配線済みで英語の弯曲引用符・em dash を正しく生成できる（既定 OFF なだけ）。
- **同梱フォント 4 書体すべて latin-400/700 サブセット同梱**（`main.tsx:14-32`）— 英字描画は可能。
- **timelapse / change_events**: char delta 列なし・diff ベースで言語非依存。tiktoken も CJK/非CJK 分岐済み。
- **日付**: dayjs/date-fns 非依存、`toLocaleString()` のみ（ただしロケールピン問題は後述）。

## ギャップ一覧（severity / effort）

### A. AI プロンプト（blocker・本丸）

| Gap | Sev/Eff | 内容 |
|---|---|---|
| ~~en カタログ未実装~~ → 実装完了 | ✅complete（2026-06-20 追記） | `getPromptCatalog("en")` は EN_CATALOG（`prompts/index.ts:97-131`）で全カテゴリ実装済み。EN_CHAT_SYSTEM, EN_AGENT_CONTROL, buildBeatSystemPromptEn, buildMentionRolesPromptEn, buildInlineAiSystemPromptEn, buildGenerateBeatsMessagesEn, buildProposePastSetupsPromptEn, buildSynopsisFromContentPromptEn, buildCandidateJudgmentPromptEn, EN_POST_EFFECT が実装済み。`src/prompts/en/` に 11 プロンプトファイル（agentControl/beat/beatGenerate/chatApi/chatSystem/codexJudgment/foreshadow/inferMentionRoles/inlineAi/postEffect/summarization）完備 |
| trim マーカー同期 | blocker/M | `JA_L1/L3_TRIM_MARKERS`（`chatSystem.ts:3-15`）は日本語見出しに regex マッチ。en 見出しと**必ず同期**しないとコンテキスト圧縮が無効化（`contextBuilder.ts:590,631,701-702`） |
| LLM 校閲 8 種が ja 固定 | blocker/L | kouetsu 全 view が `getPromptCatalog("ja")` ハードコード（CurrentSceneTypoView:111 等 8 ファイル）。typoSystem は送り仮名/助詞/同音異義語前提で英語に無意味。出力も "in Japanese" ロック（`postEffect.ts:122,137,159,181,189,204`） |
| 読者ペルソナ日本語固定 | blocker/M | ラベル（'一般読者' 等）が DB の annotation.persona キー兼 input_hash 構成要素（`pseudoCommentPayloadBuilder.ts:158`）。単純翻訳すると既存 ja プロジェクトのキャッシュ/dismiss と非互換 → 内部 enum 化＋表示名分離の再設計 |
| カタログ外プロンプト 2 経路 | degraded/M | tree scaffold（`aiScaffold/generate.ts:101,160,164,175`）と Map アイデア生成（`mapAiApi.ts:55,98,143,150`）は lang 引数なしの日本語直書き |
| 分量指定が文字数基準 | degraded/M | 「100〜200文字」「500文字程度」等 → 英語版は word ベースに換算（機械置換不可、意図確認要） |
| 出力言語ディレクティブ不在 | degraded/S | project.language に追従する汎用の出力言語指示が無い。en baseText に明示すべき |
| zh/ko が選べるのに全部日本語 | cosmetic/S | セレクタから外すか「未対応」明示 |

### B. embedding / セマンティック検索（blocker）

| Gap | Sev/Eff | 内容 |
|---|---|---|
| ~~ruri-v3-30m 固定~~ → per-language embedding 実装完了 | ✅DONE（2026-06-20 追記） | per-language embedding モデルを実装済み（`src-tauri/src/semantic/spec.rs`）。ja プロジェクトは `SPEC_JA`（ruri-v3-30m, dim=256, MeanWithMask, prefix「検索クエリ: 」「検索文書: 」, max_seq_len=8192）、en プロジェクトは `SPEC_EN`（bge-small-en-v1.5, dim=384, CLS pooling, prefix なし, max_seq_len=512）。`spec_for_language()`（lines 151-157）が project.language で spec を選択。chunker version も独立（`CHUNKER_VERSION_EN`）。RAG 閾値は `SEMANTIC_RECALL_MIN_SCORE_EN=0.51`（`semanticRecall.ts:52`）。golden fixture は両モデル分存在。`embedding.rs:31-38` の旧定数は回帰テスト用 |
| dim 変更とインデックス | blocker/L(同上に含む) | `scene_chunks` は dim 可変スキーマで migration script 不要。モデル切替→全 chunk stale→`semantic_reindex_all` で作り直し。per-project にするなら `current_model_id()` の project 設定化＋ `SemanticEmbedderState`（単一 Mutex）のモデル別拡張 |
| chunker 日本語前提 | degraded/M | 会話判定=「『 先頭、文分割=。！？、SPEECH_VERBS=日本語動詞（`chunker.rs:75-205`）。英語は全段落 Prose・dialogue_ratio 常に 0。言語別 chunker 分岐＋CHUNKER_VERSION bump で再インデックス切替可能 |
| RAG 閾値 0.5 が ruri 前提 | degraded/S | モデル別閾値化が必要（`semanticRecall.ts:23`）。MAX_CHUNK_CHARS=600 も和文密度前提 |
| golden test 再構築 | degraded/M | `generate-ruri-golden.py`/fixture が ruri 専用。新モデルの pooling/prefix 検証基盤を再構築（silent skip なので CI は赤くならない点に注意） |

### C. メトリクス / 統計（blocker）

| Gap | Sev/Eff | 内容 |
|---|---|---|
| word count が一級市民でない | blocker/L | 主要表示 7+ 箇所（ステータスバー/ツリー/グリッド/リニア/スニペット/帰属）が全て char。words は詳細ポップオーバー 1 箇所の近似のみ（`charCountStats.ts:28`）。per-project 計数モード切替＋DB は char_count 列のみ（words はオンデマンド再計算 or 新列＋全 save/mount/rename 経路の二重更新） |
| 原稿用紙 400 字・読速 500cpm | degraded/M | `charCountStats.ts:7-20` 固定。en.json:2180 も「400 chars」露出。英語標準は 250 words/page・200-250 wpm |
| 'chars' リテラル直書き | degraded/S | 7 ファイルで単位サフィックスが i18n 非経由。計数モード対応の前提作業 |
| UTF-16 code unit 計数 | degraded/M | `.length` 計数で codex search の code-point と非整合。`Intl.Segmenter` 書記素統一の好機（既存 char_count の数値変動に注意。timelapse hash には未焼き込み確認済み） |
| sortMode "wordcount" が char 実体 | cosmetic/S | en ラベル "By word count" で char ソートする嘘表示（`useScenesDerivedData.ts:69-71`）。title ソートの `localeCompare(,"ja")` ピンも同所 |
| targetCharCount の単位齟齬 | degraded/S | en ラベル "Target word count" で char 進捗評価。milestone は ratio ベースで流用可 |

### D. Codex コンテンツの日本語焼き込み（critic 発見・content-level）

i18n でもプロンプトカタログでも救済されない:

| Gap | Sev/Eff | 内容 |
|---|---|---|
| ~~BUILTIN_TYPES の label~~ → 実装完了 | ✅resolved（2026-06-20 追記） | `ensureBuiltinTypes`（`typeApi.ts:96-145`）は既に language-aware。signature（line 98）に `lang?: string \| null`、`builtinTypesForLang(lang)`（line 100）で言語別 builtin セットを選択。`BUILTIN_TYPES_EN`（lines 51-56, Character/Location/Item/Lore & Worldbuilding）を定義し、`builtinLabelRelabel`（lines 133-134）でトリガが ja で seed した未カスタマイズ既定ラベルのみ en へ relabel（rename 済みは温存・冪等）。呼び出し元は lang を渡しており migration 不要 |
| ~~detail プリセット~~ → 実装完了 | ✅COMPLETED（2026-06-20 追記） | `BASE_DETAIL_PRESETS_EN`（`detailPresets.ts:124-172`, Role/Age/Appearance 等）/`GENRE_DETAIL_PRESETS_EN`（lines 175-235, 全 8 ジャンルの英語フィールド名）を実装済み。`presetsForLang()`（lines 238-245）が ja/en を選択し、`applyDetailPreset`（line 279）/`resolvePresetFields`（line 258）は lang パラメータ対応済み。このギャップは既に解決しているため重複実装不要 |
| chatSystem.typeLabels | blocker/M | `contextBuilder.ts:971` の `s.typeLabels` が en でも JA のまま → L4 に「(キャラクター)」混入。EN_CHAT_SYSTEM 丸ごと整備（A 項と統合すべき） |
| formatTimelineContext | degraded/S | `phaseResolver.ts:247-272` がライブで type slug 生出力＋「現在の状態」「## 変遷」日本語直書き。※`contextBuilder.ts:1472` の JA_TYPE_LABELS は**呼び出し元ゼロの dead code**（critic 初期主張の訂正） |
| Map AI の TYPE_LABELS | degraded/S | `mapAiApi.ts:41-48`（scene→シーン等）＋「(無題)」が AI Branch 生成プロンプトに混入 |
| post-effect の detail 名往復 | cosmetic/S | `post_effect.rs:279` が LLM の返す detail 名を照合 → プリセット英語化で連動解消（独立対応不要） |

### E. UI i18n 残ギャップ

| Gap | Sev/Eff | 内容 |
|---|---|---|
| 生ハードコード日本語 UI | blocker(量)/L | t() 非経由 ≈ 600 行 / 38 ファイル。集中: kouetsu 全 view（137行）、map UI、settings（AiCategory 29 行等）、lint パネル、post-effect、RenamePropagationDialog |
| inline default 107 キー | degraded/M | `t("key","日本語デフォルト")` 形式で en/ja 両 json に不在 → en で日本語露出。grid 49・settings 17・foreshadow 13・timeline 13・labels 10。**en.json への 107 キー追加だけで解消（コード変更不要）** |
| 日本語 toast 65 件 | degraded/M | kouetsu views に集中＋treeStore.ts:1011 等 |
| en.json 実欠落 5 キー | cosmetic/S | beat 生成系（alternativeSaved/generateFromSynopsis 等、実使用中）。※tree.synopsis.generateFromBeats* 4 件は **dead key**（使用箇所ゼロ）、codex.detail 系は複数形化の表面差分で実害なし |
| localeCompare "ja" ピン | cosmetic/S | codexSort.ts:30,43,45 / CodexManagementPanel / PinEntryDialog / useScenesDerivedData 等 |
| 日時/数値ロケール | cosmetic/S | 'ja-JP' ピン 5 箇所（ChatHistoryPanel:367 等）＋ロケール引数欠落の日時 4・数値 36 箇所。`src/lib/` に formatNumber/formatDateTime ヘルパ新設（i18next.language 参照）で一括対処、工数 S |

### F. FTS / 検索

| Gap | Sev/Eff | 内容 |
|---|---|---|
| 全 4 FTS テーブルが trigram 固定 | degraded/L | `migrate.rs:507-530`。英語では rank 品質劣化＋1-2 文字クエリ（'AI','go'）が `%q%` LIKE 全走査に退化（`fts.rs:31-33`）。unicode61 切替はテーブル再作成＋rebuild 必須、**FTS5 tokenizer はテーブル単位なので同一 DB の ja/en プロジェクト混在を綺麗に解くには言語別テーブルが要る**（設計判断） |
| Rust マッチャ境界の Latin↔Digit 非対称 | degraded/M | `codex_matching.rs:115-141` は char-class 隣接近似で、'Art' が 'Art2' に誤マッチ（JS `\b` とは弾く）。Latin/Digit を word クラス統合する補正。mention/共起/rename に波及 |
| FTS excerpt がスニペット非生成 | cosmetic/S | snippet()/highlight() 未使用。英語特有ではないが英語で目立つ |

### G. フォント / タイポグラフィ / エディタ既定値

| Gap | Sev/Eff | 内容 |
|---|---|---|
| 英文 serif 未同梱 | degraded/S | EB Garamond / Source Serif 等の追加。作法確立済み: @fontsource 追加→main.tsx に latin import→bundledFonts.ts に 1 要素 |
| 言語連動デフォルト | degraded/S | lineHeight=2.0（英文は 1.4-1.6 が標準）、fontSize=18、smartQuotes/smartDashes OFF、spellCheck OFF、本文 Noto Serif JP。project.language=en 時の既定値出し分け |
| フォント列挙の日本語名優先 | cosmetic/S | `fonts.rs:31-43` が Japanese_Japan 名優先。en UI 時は English_UnitedStates 優先分岐 |

### H. エクスポート / JP 特化機能

| Gap | Sev/Eff | 内容 |
|---|---|---|
| 英語圏標準出力形式が皆無 | degraded/L | プリセットは日本投稿サイト 8 種＋generic-md/word-html のみ。Shunn standard manuscript / DOCX / EPUB なし。最低限 word-html を英文マニュスクリプト体裁に寄せる案も |
| 縦書き MODE 言語ゲートなし | cosmetic/S | en で選べてしまう（壊れない）。設定 UI で非表示/無効化 |
| .novel 露出 | cosmetic/S | 非 ja でメニューから隠す程度（任意・優先度最低） |

## 推奨ロードマップ

- **Phase 1（コア体験の英語成立）**: en プロンプトカタログ全実装（trim マーカー同期込み）＋ kouetsu views の lang 配線＋ペルソナ enum 化 ＋ Codex シード（BUILTIN_TYPES/detailPresets）の language 別化。→ A + D 群
- **Phase 2（執筆基盤）**: word count 一級市民化（計数モード per-project）＋換算定数の言語別化＋英文 serif 同梱＋エディタ既定値の言語連動。→ C + G 群
- **Phase 3（検索/RAG）**: 多言語 embedding モデル差し替え（dim 変更→reindex_all、golden 再構築）＋chunker 英語分岐＋RAG 閾値＋FTS unicode61 設計判断。→ B + F 群
- **Phase 4（磨き）**: 生日本語 UI 600 行の i18n 化＋toast＋inline default 107 キー＋locale ヘルパ＋エクスポート英語形式。→ E + H 群

Phase 1 だけでも「英語で書ける AI 小説エディタ」として成立する（lint 決定論側・UI 大半・smartQuotes は既に動くため）。Phase 3 は工数最大だが、RAG が沈黙していても チャット/Codex のコア体験は損なわれない。

## 実装済み機能（文書作成後に納品）

### Codex 内部整合チェッカー (CodexIntegrityReport)（2026-06-20 追記）

Codex のデータ自身の整合性を検出するコンポーネント。別名衝突（同一表記が複数エントリ）、重複リレーション（同一無向ペア+type の二重定義）、自己参照リレーション（from===to）を検出し、一覧表示する。各指摘は非表示(dismiss)可能で、状態をプロジェクト単位で永続化する（意図的な別名共有などを毎回警告されないため）。read-only — 検出のみで自動修正はしない。実装：`src/features/codex/CodexIntegrityReport.tsx` + `codexIntegrity.ts` + `codexIntegrityDismissals.ts`（+ `codexRelationApi.ts`）。納品：PR #119（2026-06-19）。

## 調査時の訂正事項（再調査不要）

- `contextBuilder.ts:1472` の `JA_TYPE_LABELS` ハードコードは **dead code**（formatTimelineEntry は呼び出し元ゼロ）。ライブの timeline 漏れは `phaseResolver.ts:247` の formatTimelineContext。
- `StaticDemoCards.tsx` の日本語 11 箇所は**孤児コード**（WelcomeDialog は commit 20b17b56 で削除済み、消費側ゼロ）。対処は dead code 削除であり英語化ではない。ChatDemoCard は REPLIES_JA/EN 分岐済みで対応不要。
- 「ja-only 5 キー」のうち tree.synopsis.generateFromBeats* 4 件は dead key。実欠落は beat 生成系 5 キー。
- lindera 辞書（+200-250MB）は en プロジェクトでも同梱されるが実行時には起動しないので無害（配布サイズ最適化は別論点）。
