# Grimodex Linter 設計書

## 概要

Grimodex のテキスト Linter は、執筆中の文章に対して**確定論的（AI非依存）** に問題を検出し、エディタ上でリアルタイムにフィードバックする機能。

日本語・英語両方をサポートし、小説執筆に特化したルール群を備える。Codex と連動して、登場人物名や固有名詞の表記ゆれを検出できる点が独自価値。

### 設計の柱

1. **Rust ネイティブ実装**: Tauri アプリの軽量性を保ち、Codex DB との連携を直接的に
2. **確定論的に保つ**: AI 連携は本機能から除外。判定が常に再現可能で説明可能
3. **段階的なルール追加**: regex で済むものから始め、形態素解析・Codex 連動へ拡張
4. **既存資産の活用**: textlint エコシステムから**辞書データのみ**を抽出して取り込む（ランタイムは取り込まない）

---

## アーキテクチャ

### 全体構成

```
┌─────────────────────────────────────────────────────────┐
│ TipTap Editor (React)                                    │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Decoration Layer (squiggly underlines)              │ │
│  └────────────────────────────────────────────────────┘ │
│           ↑                          ↓                   │
│  Diagnostic[]                  serialized text + range  │
│           ↑                          ↓                   │
│  ProseMirror ↔ String offset 変換層 (TS)                │
└─────────────────────────────────────────────────────────┘
           ↑                          ↓
   Tauri Command (invoke "lint_text")
           ↑                          ↓
┌─────────────────────────────────────────────────────────┐
│ Rust Linter Engine (src-tauri/src/lint/)                │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ LintRule     │  │ LintRule     │  │ LintRule     │  │
│  │ (regex)      │  │ (morpho)     │  │ (codex)      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│           ↓                ↓                ↓            │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Diagnostic Aggregator                               │ │
│  └────────────────────────────────────────────────────┘ │
│           ↑                ↑                ↑            │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Static Dicts   │  │ lindera      │  │ Codex DB   │  │
│  │ (include_str!) │  │ (morpho)     │  │ (rusqlite) │  │
│  └────────────────┘  └──────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### モジュール構成

```
src-tauri/src/lint/
├── mod.rs              # 公開 API、エンジン
├── rule.rs             # LintRule trait, Diagnostic, Severity
├── context.rs          # LintContext (Codex データへのアクセス等)
├── offset.rs           # UTF-16 offset 計算ユーティリティ
├── rules/
│   ├── ja/
│   │   ├── ellipsis.rs              # 三点リーダー
│   │   ├── dash.rs                  # ダッシュ
│   │   ├── consecutive_punct.rs     # 連続句読点
│   │   ├── halfwidth_kana.rs        # 半角カナ
│   │   ├── quote_period.rs          # カギ括弧内末尾句点
│   │   ├── sentence_length.rs       # 一文長
│   │   ├── sentence_ending_repeat.rs # 同文末連続
│   │   └── ...（particle_no_chain.rs は Phase 2）
│   └── en/
│       ├── smart_quotes.rs
│       ├── em_dash.rs
│       ├── ellipsis.rs
│       └── double_space.rs
├── dicts/              # 静的辞書（include_str!）
│   └── (Phase 2 以降)
└── tests/
    └── fixtures/
        └── <rule_id>/
            ├── input.txt
            └── expected.json

src-tauri/data/lint/
├── LICENSES.md         # 取り込んだ辞書の出典・ライセンス
└── (各種 JSON 辞書)

scripts/
└── extract-lint-dicts.ts   # 辞書抽出スクリプト（手動実行）
```

### ビルド方針（重要）

- **CI に Node を持ち込まない**。`build.rs` から npm/node を呼ばない
- 辞書抽出は `scripts/extract-lint-dicts.ts` を**開発者が手動で実行**し、結果を `src-tauri/data/lint/*.json` にコミット
- Rust 側は `include_str!` でビルド時に静的に埋め込む
- 辞書元の更新があれば差分コミット運用

---

## 型定義（Rust）

```rust
// src-tauri/src/lint/rule.rs

pub enum Severity {
    Error,   // 明確な誤り（半角カナ、連続句読点など）
    Warning, // 改善推奨（一文長超過、冗長表現）
    Info,    // 提案（助詞連続、文末単調など）
}

pub enum Language {
    Japanese,
    English,
}

pub struct Diagnostic {
    pub rule_id: String,         // "ja/ellipsis"
    pub severity: Severity,
    pub message: String,         // ユーザー向けメッセージ
    pub range: Utf16Range,       // UTF-16 コードユニット単位
    pub fix: Option<Fix>,        // 自動修正候補（あれば）
}

pub struct Utf16Range {
    pub start: u32,
    pub end: u32,
}

pub struct Fix {
    pub label: String,           // "「……」に置き換える"
    pub replacement: String,     // 挿入する文字列
    pub range: Utf16Range,       // 置換範囲（Diagnostic.range を包含）
}

pub struct LintInput<'a> {
    pub blocks: &'a [LintBlock], // Lint 対象のブロック配列
    pub language: Language,
    pub scope: LintScope,        // Scene / Chapter / Project
}

pub struct LintBlock {
    pub id: u32,                 // フロントの位置マップと対応
    pub kind: BlockKind,
    pub text: String,            // プレーンテキスト（UTF-8）
    pub str_offset_start: u32,   // シーン全体テキスト内での開始 UTF-16 offset
}

pub enum BlockKind {
    Paragraph,
    Heading,
    Blockquote,
    ListItem,
    TableCell,
}

pub enum LintScope {
    Scene { scene_id: String },
    Chapter { chapter_id: String },
    Project,
}

pub struct LintContext<'a> {
    pub codex: &'a CodexReader,  // Codex DB 読み取り用（Phase 2 以降）
    pub config: &'a LintConfig,
}

pub struct LintConfig {
    pub rules: HashMap<String, RuleConfig>,
}

pub struct RuleConfig {
    pub enabled: bool,
    pub severity_override: Option<Severity>,
    pub options: serde_json::Value,  // ルール固有のオプション
}

pub trait LintRule: Send + Sync {
    fn id(&self) -> &'static str;
    fn default_severity(&self) -> Severity;
    fn supported_languages(&self) -> &'static [Language];

    // 注: Result を返さない。ルールが失敗し得るのは構築時のみ。
    // 不変条件: 返される Diagnostic.range は同一ブロック内に収まる。
    fn check(
        &self,
        input: &LintInput,
        ctx: &LintContext,
    ) -> Vec<Diagnostic>;
}
```

### Tauri Command インタフェース

```rust
#[tauri::command]
async fn lint_text(
    blocks: Vec<LintBlock>,
    language: String,            // "ja" | "en"
    scope: LintScope,
    config: LintConfig,
) -> Result<LintResponse, LintError>;

pub struct LintResponse {
    pub diagnostics: Vec<Diagnostic>,
    pub warnings: Vec<RuleWarning>,  // 致命的ではない問題
    pub computed_at: i64,             // epoch ms
}

pub struct RuleWarning {
    pub rule_id: String,
    pub kind: WarningKind,
    pub message: String,
}

pub enum WarningKind {
    Skipped,          // 設定やランタイム条件で実行を見送り
    InvalidOption,    // ルールオプションが不正、デフォルトで継続
    InitFailed,       // 構築失敗（ユーザー辞書の regex 不正等）
}
```

---

## 位置オフセットの取り扱い（最重要）

3つのインデックス系が存在し、混同するとズレが発生する:

| 系 | 単位 | 用途 |
|---|---|---|
| Rust 文字列 | UTF-8 バイト | `&str` 内部 |
| JS 文字列 | UTF-16 コードユニット | `string.length`, `substring` |
| ProseMirror | 独自ポジション（ノード境界含む） | TipTap Decoration |

### 採用方針

1. **Rust → フロント返却時は UTF-16 コードユニット単位**に統一
   - Rust 側で UTF-8 バイトオフセット→UTF-16 オフセットへ変換
   - フロント側ではそのまま `string.substring(start, end)` で扱える
2. **フロントでエディタ→文字列変換時に「位置マップ」を保持**
   - シリアライズ時に区間テーブルを構築（下記参照）
   - Diagnostic 受け取り時にこのテーブルで ProseMirror 位置に逆引き
3. **変換層は最初の PR でユニットテストを充実**
   - CJK、絵文字（サロゲートペア）、改行、ノード境界（hardBreak、paragraph）の境界ケース

### 位置マップの構築方針

全 ProseMirror ポジションをキーにするスパースマップは長文で重くなるため、**区間テーブル + 二分探索**を採用:

```typescript
type PosInterval = {
  pmPosStart: number;    // ProseMirror ポジション開始
  strOffsetStart: number; // 文字列（UTF-16）オフセット開始
  length: number;         // この区間の長さ（UTF-16 コードユニット数）
};

// doc を walk して各 TextNode ごとに 1 エントリ収集
// hardBreak / paragraph 終端も "\n" として 1 エントリ
const intervals: PosInterval[] = [];
```

逆引きは二分探索で O(log n):

```typescript
function strOffsetToPmPos(offset: number): number {
  // intervals を strOffsetStart で二分探索
  // 該当区間内のローカルオフセットを pmPosStart に加算
}
```

この区間テーブルはシーン全体のシリアライズ時に 1 回構築し、Diagnostic 受け取り時に使い回す。TipTap トランザクションで doc が変わったら破棄して再構築。

### Fix の適用経路

`Fix.range`（UTF-16）→ ProseMirror 位置への変換 → `tr.replaceWith()` でトランザクション発行:

```typescript
const pmStart = strOffsetToPmPos(fix.range.start);
const pmEnd = strOffsetToPmPos(fix.range.end);
editor.view.dispatch(
  editor.state.tr.replaceWith(pmStart, pmEnd, schema.text(fix.replacement))
);
```

置換後は位置マップを破棄して再構築。

### TipTap シリアライズ規則

- `paragraph` 終端 = `\n`
- `hardBreak` = `\n`
- `text` ノード = そのまま
- 装飾 mark は無視（textContent 相当）
- 位置マップは `Map<number, ProseMirrorPos>` 形式で保持

---

## リッチコンテンツの扱い

TipTap のドキュメントはパラグラフ以外に表・コードブロック・画像・ルビ等のリッチコンテンツを含む。Linter は**プレーンテキスト抽出後のブロック配列**を受け取り、ブロックごとに独立して判定する。

### ノード種別の振り分け

| ノード種別 | Lint 対象 | 備考 |
|---|---|---|
| `paragraph` | ✅ | 1 ブロック |
| `heading` | ✅ | 1 ブロック |
| `blockquote` | ✅ | 1 ブロック |
| `bulletList` / `orderedList` の `listItem` | ✅ | item ごとに 1 ブロック |
| `table` 内の `tableCell` | ✅ | cell ごとに独立したブロック |
| `codeBlock` | ❌ スキップ | 散文ルール不適用（コード内は Lint しない） |
| `image` | ❌ スキップ | `alt` / キャプションは Phase 2 で別ルールを検討 |
| `horizontalRule` | ❌ スキップ | ブロック境界扱い |
| `hardBreak` | 段落内改行として扱う | |
| `ruby` | ✅ 基底テキストのみ | ふりがな部分（`rt`）は除外 |

### ブロック境界をまたがない判定

以下のルールは**ブロック境界をまたいだ判定をしない**:

- `ja/sentence-ending-repeat`（同文末連続）
- `ja/consecutive-punct`（連続句読点）
- 同語近接反復（Phase 2）
- 助詞「の」連続（Phase 2）

Rust 側は `Vec<LintBlock>` として受け取るため、ルール実装は**自然にブロック内に閉じる**。制御文字による境界マーキングは誤爆リスクがあるため採用しない。

### 位置マップへの統合

位置マップの各区間にブロック情報を持たせる:

```typescript
type PosInterval = {
  pmPosStart: number;
  strOffsetStart: number;
  length: number;
  blockId: number;                                                  // 同一ブロックかの判定用
  blockKind: 'paragraph' | 'heading' | 'blockquote' | 'listItem' | 'tableCell';
};
```

`codeBlock` / `image` / `horizontalRule` は位置マップに含めない。これらのノードの ProseMirror 位置には Lint Decoration が一切描画されない。

### Diagnostic の不変条件

- `Diagnostic.range` は**常に同一ブロック内に収まる**
- `Fix.range` も同様
- この不変条件はゴールデンファイルテストで検証する

---

## Diagnostic と Fix の関係

### `Diagnostic.range` と `Fix.range` の使い分け

| フィールド | 意味 |
|---|---|
| `Diagnostic.range` | **ユーザーに見せる範囲**。下線が引かれる箇所 |
| `Fix.range` | **実際に置換する範囲**。通常は `Diagnostic.range` と同じだが異なる場合もある |

**不変条件**: `Fix.range` は `Diagnostic.range` を**包含**する（`fix.range.start <= diag.range.start` かつ `diag.range.end <= fix.range.end`）。

**使い分け例**:

- 連続句読点 `、、`: `Diagnostic.range` は `、、` 全体、`Fix.range` は `、、`、`Fix.replacement` は `、`
- 前後の空白込みで修正したいケース: `Diagnostic.range` は対象語のみ、`Fix.range` は前後の空白を含める

### 複数ルールが同一範囲に重なった場合

- **下線表示**: 重なる Diagnostic のうち**最重度の Severity**（Error > Warning > Info）の色で下線。重ね描画はしない（視覚的ノイズを避ける）
- **ホバー時**: 該当範囲に重なる**全 Diagnostic を縦に並べて表示**。ルール ID とメッセージを各行に
- **Fix 適用**: 一度に 1 つの Fix のみ適用可能。他 Fix と範囲が重なる場合、UI 上で「先に他の警告を確認してください」と無効化
- **Fix 適用後**: 位置マップを再構築し、残った Diagnostic の範囲を再計算（Rust 側に再度 Lint 要求）

---

## ルール詳細

### Severity と既定 ON/OFF の方針

| 既定 ON | 既定 OFF |
|---|---|
| 記号・約物（A群）すべて | 文体混在（B群） |
| 一文長（D群の1つ） | 冗長表現（C群） |
|  | 同語近接反復（D群） |
|  | 文末単調（D群） |
|  | 小説的（E群） |
|  | Codex 連動（F群） |

→ **Phase 1 完了時点では「うるさくない、確実に効く」セットのみ ON**。OFF のルールは設定パネルで個別に有効化。

### Phase 1 ルール一覧（regex のみ、形態素解析不要）

#### 日本語

| Rule ID | 内容 | Severity | 自動修正 |
|---|---|---|---|
| `ja/ellipsis-single` | `…` 単体 → `……` | error | ✅ |
| `ja/ellipsis-odd` | `………` のような奇数個 → `……` または `…………` | warn | ✅ |
| `ja/dash-single` | `—` 単体 → `——` | error | ✅ |
| `ja/consecutive-punct` | `、、` `。。` の連続 | error | ✅（1つに圧縮） |
| `ja/halfwidth-kana` | `ｱｲｳ` 等の半角カナ | error | ✅（全角化） |
| `ja/quote-period` | `「〜だ。」` の末尾句点（プロジェクト設定で方針切替） | info | ✅ |
| `ja/sentence-length` | 一文 80 文字超で warn、120 で error | warn / error | × |
| `ja/sentence-ending-repeat` | 「〜た。」「〜だ。」等が 3 文連続（括弧内は除外） | info | × |
| `ja/halfwidth-fullwidth-mix` | 全半角英数字の混在（プロジェクトで規則を設定） | warn | ✅ |

**Phase 1 から除外したルール**:

- `ja/particle-no-chain`（助詞「の」連続）: 「の」は格助詞／連体修飾／準体助詞／終助詞など意味が多岐で、形態素解析なしでは誤検出が多い（例: 「真琴の母の作ったお弁当を食べた」のような自然な文も拾ってしまう）。**Phase 2 で形態素解析を導入後に実装**。

### ルール固有のデフォルト値

#### `ja/quote-period`（カギ括弧内末尾句点）

- 設定値: `"strip" | "keep"`
- **デフォルト: `strip`**（`「〜だ。」` → `「〜だ」`。日本の小説出版で多数派）

#### `ja/halfwidth-fullwidth-mix`（全半角英数字の混在）

プロジェクト設定で以下から選択:

| 値 | 規則 |
|---|---|
| `"all-halfwidth"` | 英数字はすべて半角 |
| **`"ja-halfwidth-with-exceptions"`（デフォルト）** | 日本語文中の英数字は半角。ただし 1 桁の数字・単位記号（%、℃ 等）は全角 |
| `"all-fullwidth"` | 英数字はすべて全角（縦書き作品向け） |
| `"off"` | ルール適用しない |

#### `ja/sentence-ending-repeat`（同文末連続）

- 閾値: 3 文連続で警告
- **括弧内の文は除外**（会話文中の「〜た。」が連続しても自然なため）

#### 英語

| Rule ID | 内容 | Severity | 自動修正 |
|---|---|---|---|
| `en/straight-quotes` | `"hello"` → `"hello"` | warn | ✅ |
| `en/em-dash` | `word - word` のハイフン誤用 → em dash | info | 候補提示 |
| `en/ellipsis` | `...` → `…` | info | ✅ |
| `en/double-space` | `. ` ピリオド後の二重スペース | warn | ✅ |

### Phase 2 以降のルール（参考、設計時詳細化）

- **B群** 文体・時制混在（形態素解析必要）
- **C群** 冗長表現（textlint 辞書流用、形態素解析必要）
- **D群** 同語近接反復、漢字・平仮名連続（形態素解析必要）
- **E群** 小説 craft（フィルターワード、会話タグ単調さ等）
- **F群** Codex 連動（人名・固有名詞表記ゆれ、一人称、口調）

**F群（Codex 連動）の判定方針**: 完全一致のみ。表記ゆれの吸収は Codex 側の Alias（別名）で行う。編集距離は使わない。

---

## 設定の保存

### 階層構造

**2 層構成**:

1. **組み込みデフォルト**（Rust コード内部、またはアプリ同梱 JSON）
2. **プロジェクト上書き**（プロジェクト DB の `settings` テーブル）

ユーザーグローバル層は**現状なし**。他 Settings カテゴリが将来グローバル層を追加する時に横断的に昇格する方針。シーン層も作らない（Phase 3 のインライン無効化記法でカバー）。

### 保存先

#### ルール設定本体

プロジェクト DB の既存 `settings` テーブル（key-value, JSON value）に **1 キー `lint.config`** で JSON blob として格納。既存 Settings カテゴリ（Editor, Display 等）の規約に揃える。

```typescript
// settings テーブルの lint.config キーに入る JSON
{
  "enabled": true,
  "languages": {
    "ja": { "enabled": true },
    "en": { "enabled": true }
  },
  "rules": {
    "ja/ellipsis-single": { "enabled": true },
    "ja/sentence-length": {
      "enabled": true,
      "severity": "warn",
      "options": { "warnAt": 80, "errorAt": 120 }
    },
    "ja/halfwidth-fullwidth-mix": {
      "enabled": true,
      "options": { "policy": "ja-halfwidth-with-exceptions" }
    },
    "ja/quote-period": {
      "enabled": true,
      "options": { "policy": "strip" }
    }
    // ...
  }
}
```

保存はデバウンス 300ms（既存 Settings 規約）。起動時に 1 回ロードしてメモリに展開。

#### 用語統一辞書

専用テーブルを用意:

```sql
CREATE TABLE lint_term_dictionary (
  id         TEXT PRIMARY KEY,
  preferred  TEXT NOT NULL,           -- 推奨表記（例: "ウェブ"）
  variants   TEXT NOT NULL,           -- JSON array: ["web", "Web", "ウエブ"]
  severity   TEXT NOT NULL DEFAULT 'warn',
  note       TEXT,                    -- メモ（"企画書で決まった表記" 等）
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**JSON blob ではなくテーブルを採用する理由**:

- 数百規模のエントリになり得るため、行単位で扱えた方が検索・編集・並び替えが楽
- 将来的な CSV インポート／エクスポートが自然
- Codex entries と並列的なライフサイクルで管理できる

### Codex Alias との棲み分け

| 対象 | 格納先 | 例 |
|---|---|---|
| 登場人物名・固有名詞の表記ゆれ | **Codex `entries.aliases`** | 「真琴」「Makoto」の揺れ |
| 一般用語の表記ゆれ | **`lint_term_dictionary`** | 「ウェブ／Web」「1 人／一人」 |

Lint 実行時は両方を参照する。Codex Alias は「エントリの正表記 + 別名」として人物・固有名詞専用、`lint_term_dictionary` は作品世界の知識と無関係な校正ルール専用。

### 実効設定の計算

```
[組み込みデフォルト (Rust 内部)]
          ↓ deep merge
[プロジェクト設定 (lint.config)]
          ↓
[実効設定] → Linter エンジンに渡す
```

- プロジェクト設定に存在しないルールは組み込みデフォルトが適用される
- 新ルールの追加でマイグレーション不要

### 新ルール追加時のデフォルトポリシー

**新規追加ルールは組み込みデフォルトで `enabled: false`** とする。安定版で動作が確認されたものを順次デフォルト ON へ昇格させる。

**理由**: 既存プロジェクトを開いた時に突然大量の警告が出るのを防ぐ。執筆中の体験を阻害しないことが最優先。

Phase 1 ルール群は「初回リリース」のため例外的に既定 ON（設計書冒頭の「既定 ON／OFF」表に従う）。

### 設定のリセット機能

Phase 1 から設定 UI に用意:

- **全ルールをデフォルトに戻す**
- **言語ごとにデフォルトに戻す**（「日本語ルールだけリセット」）
- **個別ルールをデフォルトに戻す**（ルール行の右クリック or メニュー）

---

## ルール設定 UI（概要）

設定パネル（`Settings → Linter`）で以下を制御:

- **Linter 全体の有効/無効**
- **言語ごとの有効/無効**
- **ルールごとの ON/OFF**
- **ルールごとの Severity 上書き**
- **ルール固有のオプション**（一文長の閾値、カギ括弧内句点の方針等）
- **用語統一辞書の編集**（`lint_term_dictionary` の CRUD）
- **リセットボタン**（全体／言語／個別）

---

## Diagnostic の保持戦略

### Phase 1: キャッシュなし（現在シーンのみ保持）

Phase 1 のルールは regex のみで、実測コストは 5,000 文字 × 14 ルールでも **〜5ms**。予算 50ms に対して 10% 以下のため、**キャッシュを持たず、毎回再計算**する方針。

```typescript
// Zustand store
type LintStore = {
  currentSceneId: string | null;
  diagnostics: Diagnostic[];         // 現在シーンの Diagnostic のみ
  pendingRequestId: number;          // stale 応答破棄用の世代番号
  isLinting: boolean;
};
```

### ライフサイクル

| イベント | 挙動 |
|---|---|
| シーン開封 | 即座に Lint 実行 → 結果表示 |
| シーン編集 | `docChanged` なトランザクションのみを debounce 500ms で再 Lint |
| Fix 適用 | **debounce をバイパス**して即座に再 Lint |
| シーン切替 | 前シーンの Diagnostic を破棄、新シーンを即座に Lint |
| 設定変更 | 現在シーンを即座に再 Lint |
| アプリ終了 | 何もしない（state はメモリのみ） |

### Stale 応答の破棄

キャッシュはないが、**同一シーン内で複数の Lint 要求が並行する可能性**は残る（debounce 直後に Fix 適用で即時再 Lint が発火する等）。世代番号で新旧を区別:

```typescript
// Lint 要求発火時
const requestId = ++pendingRequestId;
const result = await invoke('lint_text', { ... });
// 応答到着時、自分の requestId が最新でなければ破棄
if (requestId !== pendingRequestId) return;
setDiagnostics(result.diagnostics);
```

### TipTap トランザクションのフィルタ

debounce 入力は **`transaction.docChanged === true` のみ**を使う。カーソル移動・選択変更では Lint を再実行しない。

### プロジェクト全体の Diagnostic

**ステータスバーや常時表示では扱わない**。以下のみで確認可能:

- **Linter パネル**の「プロジェクト全体表示」モード（明示操作）
- **明示コマンド「全章 Lint」**実行時

→ 「警告ゼロに見えるが実は他シーンに 50 件」のような誤解を構造的に防ぐ。

### Phase 2 への拡張方針

- メモリキャッシュ（Scene ID → Diagnostic[]）の導入
- textHash / configHash による整合性チェック（textHash は**フロント側で計算**）
- Incremental lint（段落単位の差分更新）
- LRU による上限管理（例: 30 シーン）
- ステータスバーでのプロジェクト集計表示（集計ロジックが確定してから）

---

## 実行モデル

### 実行タイミング

| トリガー | 範囲 | デバウンス |
|---|---|---|
| キーストローク（`docChanged` のみ） | 現在シーンのみ | 500ms |
| シーン切替 | 移動先シーン全体 | なし（即時） |
| 明示コマンド「全章 Lint」 | プロジェクト全体 | なし |
| Fix 適用 | 現在シーン | **バイパス**（即時） |
| 設定変更 | 現在シーン | なし（即時） |
| 保存時 | 現在シーン | なし |

### リニア編集モードでの Lint スコープ

Editor 設計書で定義される「リニア編集モード」（プロジェクト内の全シーンを `sortOrder` 順に縦連結表示）での挙動:

- **ビューポート基準**: 画面に表示中のシーン + 上下バッファ 1 シーン分のみを Lint
- **カーソル位置のシーン**: ビューポート外でも常に含める
- **明示コマンド「全章 Lint」**: 通常モードと同じく全シーン対象
- **シーン間の context はまたがない**: 各シーンを独立に Lint する（文末連続などの判定はシーン境界で切れる）

### パフォーマンス予算

- 現在シーン Lint: **< 50ms** （シーン平均 5,000 文字想定、実測見込み 〜5ms）
- 全章 Lint: **< 2s** （プロジェクト平均 30 シーン想定）
- 形態素解析を使うルールは Phase 2 以降のため、Phase 1 はこの予算で余裕

### キャンセル

- 新しい Lint 要求が来たら、古い応答は**世代番号で破棄**（フロント側）
- Rust 側は到達時点まで実行して破棄（同期実行、Phase 1 では中断機構なし）
- Phase 2 で形態素解析を入れたら、Rust 側でのキャンセル機構（`AbortHandle` 相当）を検討

---

## エラーハンドリング

### LintError（致命的エラー）

Lint 全体の実行失敗。`Result::Err` として返す。

```rust
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum LintError {
    #[error("text too large: {actual} bytes (max: {max})")]
    TextTooLarge { actual: usize, max: usize },

    #[error("invalid language: {0}")]
    InvalidLanguage(String),

    #[error("config parse error: {path}: {reason}")]
    InvalidConfig { path: String, reason: String },

    #[error("internal error: {0}")]
    Internal(String),
}
```

### RuleWarning（非致命的な警告）

個別ルールの劣化・スキップを `LintResponse.warnings` で返す。

- `Skipped`: 設定やランタイム条件でルールを実行しなかった
- `InvalidOption`: オプション値が不正、デフォルト値で継続
- `InitFailed`: ルール構築失敗（ユーザー辞書の regex エラー等）、該当ルールのみ除外

### ルール構築時のエラー処理

`check()` は `Result` を返さない。失敗し得るのは**構築時**のみ:

```rust
pub fn build_ruleset(
    config: &LintConfig,
) -> (Vec<Box<dyn LintRule>>, Vec<RuleWarning>) {
    // 各ルールのコンストラクタを走査
    // 成功 → rules に追加
    // 失敗 → warnings に積んでスキップ
}
```

### Panic ポリシー（Phase 1）

- **`catch_unwind` は使わない**。開発中の panic を隠さず、バグとして顕在化させる
- `unwrap()` / `expect()` 禁止（プロジェクト規約準拠）
- clippy で以下を denial:
  - `clippy::unwrap_used`
  - `clippy::expect_used`（例外的に許容する場合は `#[allow]` を明示）
  - `clippy::panic`
  - `clippy::indexing_slicing`（スライス記法を強制）
- ゴールデンファイルテストで境界値（空文字、1 文字、巨大テキスト、CJK 境界、絵文字等）を網羅

**Phase 2 以降の再評価**: lindera など外部クレートを導入した時点で panic リスクが増えるため、`catch_unwind` 導入を再検討する。

### 入力バリデーション

| シナリオ | 挙動 |
|---|---|
| テキスト合計 > **500KB**（UTF-8）| `LintError::TextTooLarge` |
| 不正な `language` 文字列 | `LintError::InvalidLanguage` |
| 空のブロック配列 | 通常動作（空の Diagnostic 配列を返す） |
| 未知のルール ID を設定に含む | 黙って無視（前方互換性） |
| ルールオプションの型不一致 | デフォルト値を使用、`InvalidOption` 警告を返す |

**500KB の意味**: `LintBlock.text` の合計バイト数。TipTap JSON 全体や画像バイナリは含まれない。コードブロックや画像は Lint 対象外のため、この制限にも含まれない。実運用では到達困難な安全弁として機能。

**ソフト警告 100KB**: 超えても Lint は実行するが、Linter パネルに「このシーンは大きくなっています」と表示。

### Codex DB エラー（Phase 2 以降）

Codex 連動ルールで DB 読み取りに失敗した場合:

- **全体失敗にはしない**。他ルールは正常に実行
- 該当ルールのみ `Skipped` 警告を返す
- DB ロックなど一時的なエラーは次回 Lint サイクルで解消を期待

### フロント側の UI 挙動

| 応答 | UI |
|---|---|
| `Ok(LintResponse)` | Diagnostic を表示。`warnings` があれば Linter パネルの右上に小さなインジケータ |
| `Err(TextTooLarge)` | トースト: 「このシーンは Lint できない大きさです」。Diagnostic は空に |
| `Err(InvalidLanguage / InvalidConfig)` | devtools にログ、UI バナー: 「Linter 設定にエラー」 |
| `Err(Internal)` | devtools にログ、UI バナー: 「Linter が一時的に利用できません」 |
| いずれのエラー時も | **既存の Diagnostic を破棄**（stale 表示を避ける）。次の debounce サイクルで自動再試行 |

---

## UI 表現

### エディタ内表示

- **Squiggly underline**: TipTap Decoration で対象範囲に下線
  - Error: 赤
  - Warning: 黄
  - Info: 青
- **ホバー時**: ツールチップでメッセージ表示、修正候補があれば「[修正] [無視]」ボタン
- **クリック時**: 修正候補ポップオーバー

### Linter パネル

#### 配置とライフサイクル

- **デフォルト配置**: Bottom Dock（VS Code Problems 相当）
- 他パネル同様、Left/Right/Float へ移動可能。レイアウトプリセットで配置切替
- パネルトグルドロップダウンに「Linter」として登録
- 初期状態: **非表示**（ステータスバーのインジケータクリック、またはトグルから開く）

#### レイアウト構成

```
┌─────────────────────────────────────────────────────────────┐
│ [Current │ Project]  [⚠ 3 ⓘ 7]   [🔍 _________]   [⋮]      │  ← ヘッダー
├─────────────────────────────────────────────────────────────┤
│ Filter: [✓ Error] [✓ Warning] [✓ Info]  Group: [Severity▼]  │  ← ツールバー
├─────────────────────────────────────────────────────────────┤
│ ▼ ⚠ Warning (3)                                             │
│    📄 第1章 / シーン1                                        │
│    ⚠ 一文が 120 文字を超えています  [Fix] [無視]             │
│      「エララは塔の麓に…冷たい石肌を指でなぞりながら」        │
│    ...                                                      │
└─────────────────────────────────────────────────────────────┘
```

#### 表示モード

ヘッダー左のセグメントコントロールで切替:

| モード | 内容 |
|---|---|
| **Current** | 現在シーンの Diagnostic のみ。リアルタイム更新 |
| **Project** | 「全章 Lint」実行後のプロジェクト全体結果 |

#### ツールバー

- **Severity フィルタ**: Error / Warning / Info の ON/OFF チェックボックス
- **Group by**: `Severity` / `Rule` / `Scene`（Project モード時のみ）/ `None`。デフォルト: `Severity`
- **検索ボックス**: **`rule_id` と `message` の両方に対する部分一致検索**
- **右上メニュー (⋮)**: 全フィルタリセット / Linter 設定を開く

#### エントリ表示

- Severity アイコン（🔴 Error / ⚠ Warning / ⓘ Info）
- メッセージ
- 位置表示（Current モードではブロック番号のみ、Project モードではシーン名込み）
- **該当箇所の抜粋**（範囲＋前後コンテキスト、該当箇所をハイライト）
- **Fix ボタン**（自動修正が可能な場合のみ）
- **無視ボタン**（右クリックメニューに集約してもよい）

##### 長大な Diagnostic.range の抜粋

`Diagnostic.range` の長さに応じて表示を切替:

- **60 文字以下**: 範囲全体 + 前後コンテキスト（例: 前後 10 文字）
- **60 文字超**: 前半 30 文字 `…` 後半 30 文字（`ja/sentence-length` など長文マッチ向け）

#### クリック動作

- **行クリック**: エディタで該当位置にジャンプ + 選択状態にする
- **Fix ボタン**: その場で適用（エディタへ反映、debounce バイパスで再 Lint）
- **右クリック**: コンテキストメニュー

#### 右クリックメニュー

- Fix を適用（可能な場合）
- この箇所を永続的に無視
- このルール (`ja/ellipsis-single`) を OFF にする
- ルール詳細を設定で開く
- メッセージをコピー

#### 一括アクション（右上メニュー）

- 表示中の Fixable を全適用（フィルタ・検索条件に一致するものだけ）
- このルールの Fix を全適用（Group by Rule 時、グループヘッダにボタン）
- 全章 Lint を実行 / キャンセル

#### Fix 適用後のパネル状態

- **選択解除**（次のエントリを自動選択はしない）
- スクロールは**上部基準で維持**
- Fix 済みの Diagnostic は自然に消える（再 Lint 結果で上書き）
- エントリ ID 追跡はしない（複雑化の割にメリットが小さいため）

#### 「全章 Lint」の進捗表示

Project モードで実行時:

```
[Project モード]  Linting 15/30 scenes...  [Cancel]
```

- プログレスバーをヘッダーに表示
- 完了済みシーンの Diagnostic から逐次追加表示（全完了を待たない）
- キャンセル可能
- 実行中も通常のエディタ操作は阻害しない（非同期進行）

##### キャンセル時の部分結果

- **部分結果を保持**。ヘッダーに `15/30 scenes (cancelled)` と表示
- 再実行は**残りのみ再開**（未 Lint シーンだけを処理）
- ユーザーが明示的に「最初からやり直す」を選べば全シーン再実行

#### Empty state

| 状態 | 表示 |
|---|---|
| Linter 無効 | アイコン + 「Linter が無効です」+ **[有効にする]** ボタン |
| 現在シーンで問題なし | チェックマーク + 「問題は見つかりませんでした」 |
| シーン未開封（Project モード） | 「全章 Lint を実行してください」+ **[実行]** ボタン |
| Lint 実行中（初回） | スピナー + 「Lint 実行中...」 |
| Lint エラー時 | 「Linter が一時的に利用できません」+ 詳細（折りたたみ） |

#### 警告インジケータ

ヘッダーに `LintResponse.warnings` の件数を⚠アイコンで表示。クリックでモーダル:

```
Linter warnings:
  · [InitFailed] ja/user-terms: ユーザー辞書の正規表現が不正です
  · [Skipped]    codex/name-consistency: Codex DB を一時的に読めませんでした
```

開発者向け情報として、ユーザーが「Linter が壊れている？」と感じた時の原因究明に使う。

**Phase 1 の寿命管理**: 「直近の応答」の warnings のみ表示（一時的な警告が消えた時にアイコンが消える = 点滅のように見える可能性は許容）。Phase 2 で warnings log と重複除去を検討。

#### 状態の永続化

- パネルの表示/非表示、位置、サイズ → レイアウトシステム経由で自動永続化
- フィルタ設定、Group by 選択 → `settings` テーブル（`lint.panel.ui`）
- スクロール位置、展開状態 → メモリのみ（セッション限定）

#### 永続無視リスト

「この箇所を永続的に無視」を実現するための専用テーブル:

```sql
CREATE TABLE lint_ignored_diagnostics (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT NOT NULL,
  scene_id        TEXT NOT NULL,
  text_snippet    TEXT NOT NULL,     -- Diagnostic.range のテキスト
  context_before  TEXT NOT NULL,     -- 前 20 文字（生テキスト）
  context_after   TEXT NOT NULL,     -- 後 20 文字（生テキスト）
  created_at      INTEGER NOT NULL,
  note            TEXT
);

CREATE INDEX idx_lint_ignored_scene ON lint_ignored_diagnostics(scene_id);
```

**同定ロジック**:

```
match = rule_id 一致
      AND text_snippet 一致
      AND (context_before 一致 OR context_after 一致)
```

**context をハッシュではなく生テキストで持つ理由**: 編集耐性を持たせつつ誤ヒットを防ぐため。単純な `text_snippet` 一致では「意図的な吃音表現『え、、』を無視」「同シーン内の誤字『です、、』も無視」の誤爆が発生する。前後文脈のどちらか一方が一致することを条件とすることで、同じ内容でも文脈が違えば別物として扱う。

**古い無視エントリの扱い**: テキスト変更で context の両方が一致しなくなると、その無視エントリは効かなくなる。設定画面に「古い無視エントリ」として一覧表示し、手動で削除可能にする。

### ステータスバー

- **現在シーンのみ**の Diagnostic 数を表示（例: `⚠ 3  ⓘ 7`）
- プロジェクト全体の集計は表示しない（誤解防止）
- クリックで Linter パネルを開く

---

## ライセンス管理

### 取り込む辞書（Phase 2 以降）

| 辞書 | 元ライブラリ | ライセンス | 用途 |
|---|---|---|---|
| 冗長表現対応表 | `textlint-rule-preset-japanese` | MIT | C群 |
| 表記ゆれ辞書 | `textlint-rule-prh` 系 | 要個別確認（CC-BY 混在の可能性） | C群 |
| ipadic / unidic | lindera | (各辞書のライセンス) | 形態素解析 |

### 運用

- `src-tauri/data/lint/LICENSES.md` に出典・ライセンス・取得日を記録
- 抽出スクリプト実行時に自動で更新（`scripts/extract-lint-dicts.ts` の責務）
- リリース前のチェックリストに「Lint 辞書ライセンス棚卸し」を含める
- THIRD_PARTY_LICENSES.md にも反映

---

## テスト戦略

### ゴールデンファイルテスト（必須）

```
src-tauri/src/lint/tests/fixtures/
├── ja/ellipsis-single/
│   ├── input.txt         # 検査対象テキスト
│   └── expected.json     # 期待される Diagnostic 配列
├── ja/sentence-length/
│   ├── input.txt
│   └── expected.json
└── ...
```

- ルール追加時は必ず fixture を追加
- 期待値を変更する場合は明示的に再生成
- `cargo test` で全 fixture を回帰チェック

### ユニットテスト

- **オフセット変換層**: CJK、絵文字、改行、ノード境界の境界値テスト（最初の PR で必須）
- 各ルールの個別エッジケース

### 統合テスト

- 複数ルールが同じ箇所に当たる場合の挙動
- 大きなテキスト（10万文字）でのパフォーマンス計測

---

## 段階的実装計画

### Phase 1（土台 + regex ルール）

最初の PR に含める **4 点セット（エンジン側）**:

1. `LintRule` trait + `Diagnostic` 型 + `LintContext` の設計
2. ProseMirror ↔ 文字列オフセット変換層（ユニットテスト付き）
3. ゴールデンファイル形式のテストハーネス
4. Phase 1 ルール群（日英、regex のみ）

加えて:

- Tauri Command `lint_text` の登録
- TipTap Decoration による squiggly 表示
- 設定パネルに最低限の ON/OFF UI

UI 側（Linter パネル）はサブフェーズに分けて実装:

#### Phase 1a（最小動作）

- Bottom Dock にパネル枠組みを配置、パネルトグルに登録
- Current モードのエントリリスト（フラット表示）
- クリックでエディタの該当位置にジャンプ
- Fix ボタンで Fix 適用
- 基本的な Empty state（Diagnostic なし／Lint 実行中）

#### Phase 1b（体験向上）

- Severity フィルタ（Error / Warning / Info）
- Group by Severity / None
- 検索ボックス（`rule_id` + `message` 部分一致）
- 抜粋表示（60 文字超は前後 30 文字 + `…` 省略）
- 警告インジケータ（⚠ アイコン + モーダル）
- ステータスバーからパネルを開く
- 全 Empty state の実装

**完了基準**: Phase 1 ルールがエディタ上でリアルタイムに動作し、Linter パネルから一覧表示・ジャンプ・Fix 適用ができる。

### Phase 2（形態素解析 + Codex 連動）

- lindera 導入（辞書サイズで ipadic / unidic を再判断）
- **`ja/particle-no-chain`**（Phase 1 から持ち越し）
- C群（冗長表現）、D群（同語近接反復、漢字・平仮名連続）
- F群（Codex 連動）— 人名・固有名詞表記ゆれ、一人称、口調
- 設定パネルの拡充（ルール詳細オプション、プロジェクト辞書）

**Linter パネル側の拡張**:

- **Project モード**と全章 Lint 進捗表示（キャンセル・部分結果保持・残り再開）
- **Group by Rule / Scene**
- **右クリックメニュー**（永続無視、ルール OFF、ルール詳細を開く）
- **永続無視リスト**（`lint_ignored_diagnostics` テーブル + 同定ロジック実装）
- **一括 Fix 適用**（フィルタ絞り込み対象、ルール単位）
- **キーボード操作**（↑↓ / Enter でジャンプ / Cmd+. で Fix メニュー）
- **エディタカーソル → パネル逆方向ハイライト**
- **Codex 連動ルールの Diagnostic から Codex エントリへのリンク**

**Phase 2 で検討すべきパフォーマンス課題**:

- **Incremental lint**: 変更されたパラグラフだけ再 Lint し、それ以外の Diagnostic は維持する仕組み。形態素解析を入れると全文再 Lint は無視できないコストになる
- **1 パス統合最適化**: Phase 1 時点で 14 個のルールが各々テキストを走査するため、同じテキストを複数回舐めている。形態素解析導入のタイミングで、**形態素列を共有キャッシュにし、全ルールが 1 パスで評価**するアーキテクチャへの再設計を検討
- **警告インジケータの寿命管理**: warnings log と重複除去

### Phase 3（小説 craft）

- B群（文体・時制混在）
- E群（フィルターワード、会話タグ単調さ）
- 英語の Phase 2/3 ルール（passive voice, weasel words, dialogue tag）
- **インライン Lint 無効化記法**（`<!-- lint-disable-next-line <rule-id> -->` 相当）— 固有名詞や意図的な表現を個別に除外できる
- Linter パネルのフィルタプリセット保存

### 将来的検討（本設計のスコープ外）

- AI を使った提案（show vs tell、設定矛盾検出）
  - **Linter 機能には組み込まない**。別機能として「AI 校正」等で実装
  - Linter は確定論的に保つという原則を維持

---

## 確定事項サマリ

| 項目 | 決定 |
|---|---|
| 実装言語 | Rust（src-tauri 内） |
| 辞書取り込み | textlint 系から抽出してリポジトリにコミット、`include_str!` |
| ビルド | 純 Rust。CI に Node 不要 |
| 位置インデックス | UTF-16 コードユニット単位で Rust → JS に返却 |
| ProseMirror 連携 | フロント側で位置マップを保持して変換 |
| Phase 1 ルール | 日本語 9、英語 4（すべて regex、`ja/particle-no-chain` は Phase 2 へ） |
| 既定 ON | 記号・約物すべて + 一文長 |
| 実行範囲 | 現在シーンのみ（debounce 500ms）+ 明示で全章 |
| Codex 連動の判定 | 完全一致のみ。表記ゆれは Codex Alias で吸収 |
| AI 連携 | Linter には組み込まない（確定論性を保つ） |
| 設定階層 | 2層（組み込みデフォルト → プロジェクト上書き）。グローバル層は将来検討 |
| ルール設定の保存 | `settings` テーブルに `lint.config` の 1 キー JSON blob |
| 用語統一辞書の保存 | 専用テーブル `lint_term_dictionary` |
| 新ルール追加時の既定 | `enabled: false`（既存プロジェクトの体験を阻害しない） |
| Phase 1 の Diagnostic 保持 | キャッシュなし。現在シーンのみメモリ保持、毎回再計算 |
| Stale 応答対策 | 世代番号（pendingRequestId）で古い応答を破棄 |
| debounce 入力 | `transaction.docChanged === true` のみ |
| Fix 適用の再 Lint | debounce バイパスで即時実行 |
| ステータスバー | 現在シーンのみ表示。プロジェクト全体集計は Linter パネルと「全章 Lint」のみ |
| Rust への入力 | `Vec<LintBlock>`（プレーンテキスト化後のブロック配列） |
| Lint 対象外ノード | `codeBlock` / `image` / `horizontalRule` |
| Diagnostic 範囲 | 常に同一ブロック内（ブロック跨ぎなし） |
| Panic ポリシー | `catch_unwind` なし。`unwrap`/`expect`/`panic!` は clippy で denial |
| サイズ上限 | ハード 500KB（UTF-8、`LintBlock.text` 合計）、ソフト警告 100KB |
| ルール警告 | `LintResponse.warnings` で非致命的問題を返す |
| Linter パネル配置 | Bottom Dock デフォルト、初期非表示 |
| Linter パネルモード | Current（Phase 1）/ Project（Phase 2） |
| 検索ボックス対象 | `rule_id` + `message` の部分一致 |
| 長文 Diagnostic の抜粋 | 60 文字超は「前半 30 + … + 後半 30」形式 |
| Fix 適用後の選択状態 | 解除。スクロールは上部基準で維持 |
| 全章 Lint キャンセル | 部分結果保持、残りのみ再開可能 |
| 永続無視の同定 | `rule_id` + `text_snippet` + (`context_before` OR `context_after`) |
| テスト | ゴールデンファイル形式を day 1 から |

---

## 未決事項（Phase 2 着手時に再判断）

- lindera 辞書: ipadic（軽量）/ unidic（高精度）
- Codex 連動の口調・一人称検出の精度（小説的に許容できる粒度の見極め）
- 全章 Lint のキャンセル機構（Phase 1 では同期で十分）
