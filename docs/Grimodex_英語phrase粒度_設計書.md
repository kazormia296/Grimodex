# Grimodex 英語 phrase 粒度 — 設計書

> **ステータス**: 設計のみ（未実装）。word 粒度（`feat/en-word-reorder`）の次段階。
> 日本語の **文節（bunsetsu）** に相当する英語中間ティアを定義する。

---

## 1. 定義

**phrase（句）** とは、推敲リオーダーにおいて **内容語 head と、その直前に付着する機能語** をまとめた shallow chunk のこととする。

| 例 | phrase 分割のイメージ |
|----|----------------------|
| `She stood at the gate.` | `[She]` `[stood]` `[at the gate]` |
| `He waved from afar.` | `[He]` `[waved]` `[from afar]` |

- **sentence**: `. ! ?` 等で切った全文単位
- **phrase**: NP / PP / VP の**コア部分**（係り受け解析まではしない）
- **word**: 空白区切りの語（`splitWordsEn`、実装済み）
- **character**: 1 文字単位

**clause（節）ではない**。主節・従属節の境界は扱わず、並べ替えで非文が生じうることは日本語文節と同様に**手動推敲前提**とする。

---

## 2. 分割アプローチの比較

### 案 A: 純 TS ヒューリスティック（依存ゼロ）

- 品詞タグなしで、冠詞・前置詞・接続詞などの**機能語リスト**と、後続名詞/動詞への付着規則で chunk 化
- **長所**: 即時同期、オフライン、バンドル増なし、word 実装と同じ層
- **短所**: 精度は中程度（`New York`、複合名詞、関係詞節の誤分割）

### 案 B: 軽量 POS + チャンキング（Rust 推奨）

- `segment_bunsetsu` と同型の Tauri コマンド `segment_phrase_en`
- 入力: 段落プレーンテキスト → 出力: UTF-16 `[start, end)` + `surface`
- 内部: 軽量英語トークナイザ + ルールベース NP/PP chunker（例: 冠詞群 + 名詞列、前置詞 + 名詞句）
- **長所**: 日本語文節と対称、テスト fixture を Rust で固定可能、lint との共有可能
- **短所**: 新規 Rust crate または既存 `grimodex-lint` 拡張、初回実装コスト

### 案 C: フル依存解析（spaCy 等）

- **長所**: 最高精度
- **短所**: モデルサイズ、オフライン配布、Tauri バンドル制約に不合。非推奨。

### 推奨

**段階導入**: Phase 1 = 案 A（TS のみ、プロトタイプ）、Phase 2 = 案 B（Rust 正本化 + async キャッシュ）。案 C は YAGNI。

---

## 3. API 形状（案 B 正本）

```rust
// src-tauri/src/commands/reorder.rs
#[derive(Serialize)]
pub struct PhraseDto {
    start: u32,  // UTF-16
    end: u32,
    surface: String,
}

#[tauri::command]
fn segment_phrase_en(text: String) -> Result<Vec<PhraseDto>, String>
```

TS 側は `bunsetsuSegmenter.ts` を鏡写し:

- `phraseSegmenter.ts`: `fetchPhraseUnits`, `getCachedPhraseUnits`, `clearPhraseCache`
- `ReorderGranularity` に `"phrase"` を追加（英語のみ有効）
- `effectiveGranularity`: `phrase` + 日本語 → `sentence`

---

## 4. Whitespace / 句読点契約

英語 sentence バグ（leading whitespace が次 unit に付き swap で脱落）の教訓を踏襲:

1. **分割時**: 2 句目以降の leading whitespace を unit から除去（`splitSentencesEn` と同様）
2. **連結時**: `needsEnglishPhraseGap(prev, next)` — 境界に空白が無ければ 1 スペース補完
3. **phrase 内**には空白を含めない（surface は trim 済みトークン列の連結）

`englishUnitGap.ts` の `needsEnglishUnitGap` に `phrase` ケースを追加する。

---

## 5. UI / UX

| 言語 | Alt+Shift+G サイクル |
|------|----------------------|
| 日本語 | 文 → 文節 → 文字 → 文 |
| 英語（現状 + phrase） | 文 → **phrase** → word → 文字 → 文 |

- 推敲オーバーレイ: `phraseAvailable`（英語のみ有効）、`bunsetsuAvailable` と排他
- 装飾クラス: `reorder-unit-phrase`（word は dotted、bunsetsu は dashed で差別化）
- フッター: `editor.reorder.granularityPhrase`, `hint.switchToPhrase`

---

## 6. フォールバックチェーン

```
phrase 要求
  → cache hit & units > 1 → phrase で表示/swap
  → cache miss / 空 / Err → sentence へ即フォールバック（toast: phraseFallback）
  → word へは落とさない（bunsetsu と同じ：中間粒度失敗時は粗い方へ）
```

---

## 7. テスト戦略

- **TS/Rust parity**: 代表文 10〜20 件で chunk 境界を fixture 固定
- **回帰**: phrase swap 後の空白保持（sentence/word と同型の integration test）
- **browser**: 必要なら `reorder-unit-phrase` の幾何 invariant（word 実装後に判断）

---

## 8. リスクと非目標

**リスク**

- ヒューリスティック誤分割 → ユーザーが sentence / word に切替
- async 分割中の段落編集 → bunsetsu と同じ stale cache 破棄

**非目標**

- 係り受けに基づく助詞・冠詞の自動修正
- 段落をまたぐ phrase 移動
- リスト・テーブルセル内 phrase

---

## 9. 実装フェーズ

| Phase | 内容 | PR 目安 |
|-------|------|---------|
| P0 | word 粒度（本ブランチ） | `feat/en-word-reorder` |
| P1 | TS ヒューリスティック `splitPhrasesEn` + UI 配線 | `feat/en-phrase-reorder-ts` |
| P2 | Rust `segment_phrase_en` + cache + fixture | `feat/en-phrase-reorder-rust` |
| P3 | オーバーレイ・hint・locale 仕上げ | P2 に含めても可 |

---

## 10. 参照コード

- 日本語文節: `src-tauri/crates/grimodex-lint/src/bunsetsu.rs`
- 英語文: `src/features/editor/reorder/sentenceSplit.ts`
- 英語語: `src/features/editor/reorder/wordSplit.ts`
- 空白補完: `src/features/editor/reorder/englishUnitGap.ts`
- 段落内並べ替え全体: `docs/Grimodex_段落内並べ替え設計書.md`
