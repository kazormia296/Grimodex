# Grimodex Linter 設計書

## 概要

Grimodex のテキスト Linter は、執筆中の文章に対して**確定論的（AI非依存）** に問題を検出し、エディタ上でリアルタイムにフィードバックする機能。

日本語・英語両方をサポートし、小説執筆に特化したルール群を備える。Codex と連動して、登場人物名や固有名詞の表記ゆれを検出できる点が独自価値。

### 設計の柱

1. **Rust ネイティブ実装**: Tauri アプリの軽量性を保ち、Codex DB との連携を直接的に
2. **決定論的に保つ**: AI 連携は本機能から除外。判定が常に再現可能で説明可能
3. **段階的なルール追加**: regex で済むものから始め、形態素解析・Codex 連動へ拡張
4. **既存資産の活用**: textlint エコシステムから**辞書データのみ**を抽出して取り込む（ランタイムは取り込まない）

---

## PostEffects との境界とクロスリファレンス

本 Linter は決定論ベース。LLM を用いた事後分析は [`Grimodex_PostEffects設計書.md`](Grimodex_PostEffects設計書.md) に分離する。同一の本文上で両者が並走するため、以下の境界を固定する。**本セクションが両者の境界の正本**。PostEffects 設計書側には要点のみ書き、詳細はここを参照する。

### 責務の線引き

| 観点 | Linter（本書） | PostEffects |
|---|---|---|
| 判定の性質 | 決定論・再現可能 | LLM・非決定論 |
| Codex 連動 | **表記の一致**（F群、完全一致） | **事実の整合**（整合性チェック、意味的） |
| 粒度 | span / block | span / scene / folder / project |
| 本文への反映 | Fix による置換（ユーザー操作） | しない（オーバーレイのみ） |

Codex 基点で「真琴/Makoto の表記ゆれ」は Linter、「Codex: 目=青 vs 本文: 緑」は PostEffects。同じ Codex エントリが両機能で別角度から検出されるのは許容（責務が異なる情報源として並記する）。

### 装飾の重なり規則

同一 span に Linter の squiggly と PostEffect の `pe-annotation-*` decoration が重なる場合:

- **描画レイヤ**: Linter squiggly を**下**、PostEffect decoration を**上**に重ねる（Linter は形式的で常時更新、PostEffect は run 単位で粗いため、ユーザーが気づくべき優先度で上に置く）
- **ホバー**: 両方のツールチップを**縦に連結**して表示（Linter 所見 → PostEffect 所見の順）
- **クリック**: 最も手前の要素を優先（PostEffect のスレッド UI 優先）
- **Fix ボタン**: Linter Fix のみに表示（PostEffect は本文を書き換えない）

### Fix 適用と PostEffect annotation の相互作用

`Fix.range` が PostEffect の `AnnotationMark` と重なる場合:

- TipTap 標準挙動で Mark は自動追従・縮小・消滅する（`lintDisable` Mark の扱いと同じ）
- Fix 適用後のシーン保存時に `savePostEffectAnnotations` が `range_start/end` と `text_snapshot` を再同期する（既存パイプラインに乗る）
- Fix によって **AnnotationMark が完全消滅した場合**、Linter パネルに通知: 「Fix 適用により {N} 件の注釈が削除されました」（`lintDisable` 消失通知と同じ UI で統一）
- 事前警告はしない（執筆体験を阻害しない原則）

### エクスポート時のマーク除去

本文エクスポート時は **Linter の `lintDisable` Mark / ブロック属性 + PostEffect の `AnnotationMark`** を**両方とも除去**する。エクスポーター実装時の必須テストケース:

- disable 入りシーン → 出力に directive 情報が含まれない
- PostEffect annotation 入りシーン → 出力に annotation span が含まれない

両除去はエクスポーターの同一パスで行う（Mark を無視する filter を共有）。

### 位置オフセット層の共有

「位置オフセットの取り扱い」セクションで定義する UTF-16 位置マップ（区間テーブル + 二分探索）は **Linter / PostEffect の両機能で共通のユーティリティ**として実装する。

- 配置: `src/features/editor/offsetMap.ts`（仮、両機能を実装する時点で正式名を決定）
- 両機能がこのモジュールを import し、位置マップの再構築トリガ（`transaction.docChanged`）も共有
- PostEffects の「位置追跡の権威性 — ライブマークが真実、DB はフォールバック」（PostEffects 設計書 §方針決定事項 3）とも整合

### 状態管理の独立性（現状）

「無視/解決」系の状態は現状独立:

- Linter: `lint_ignored_diagnostics`（永続無視）+ `lintDisable` Mark + `lint_action_log`
- PostEffects: `post_effect_annotations.status`（open / resolved / dismissed）

将来「本文上の全アノテーションを横断管理したい」要求が顕在化した場合に統合を検討する（Phase 4 以降）。現時点では独立のまま運用し、UI レベルでの相互ジャンプ（Linter パネル ↔ PostEffect パネル）のみを追うべき課題とする。

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
- **用語統一辞書の編集**（`lint_term_dictionary` の CRUD、詳細は後述「用語辞書 UI」）
- **リセットボタン**（全体／言語／個別）

---

## 用語辞書 UI

`lint_term_dictionary` の編集 UI。配置と動作を定義する。

### 配置

- Settings パネルの **`Linter → 用語辞書` サブタブ**に配置
- 独立パネル化や Linter パネル内タブ化はしない（用語辞書は「設定の一種」で編集頻度が低く、ルール設定との近接性を優先）
- 辞書が 1,000 行を超えるようなプロジェクトが出てきたら独立パネルへの昇格を Phase 2 以降で検討

### レイアウト

```
┌─ 用語辞書 ──────────────────────────────────┐
│ [＋ 追加]  [⭳ CSV インポート]  [⭱ エクスポート]│
│ 検索: [________]   並び: 推奨表記 ▼          │
├────────────────────────────────────────────┤
│ # │ 推奨表記 │ 許容しない表記       │ Sev │ ✓  │
│ 1 │ ウェブ   │ web, Web, ウエブ     │ warn│ ON │
│ 2 │ 一人     │ 1人, ひとり         │ info│ ON │
│ 3 │ サーバー │ サーバ              │ warn│ OFF│
│ ...                                         │
├────────────────────────────────────────────┤
│ 選択中: 「ウェブ」                           │
│ メモ: 企画書 §3.2 で決定                     │
│ [削除] [複製]                               │
└────────────────────────────────────────────┘
```

- 1 行 1 エントリのテーブル編集（Excel 的操作感）
- `variants` は UI 上カンマ区切り表示・編集。内部格納は JSON 配列
- Severity は **warn / info のみ**（`error` は用語レベルでは強すぎる）
- 各行に **ON/OFF チェックボックス**（特定エントリだけ一時的に黙らせる）
- 並び替え: 推奨表記、更新日、Severity、`sort_order`（手動並び）

### CSV インポート / エクスポート（Phase 2 以降）

- フォーマット: `preferred,variants,severity,note,enabled`（`variants` は `|` 区切り）
- 用途: textlint-rule-prh YAML からの移行、複数プロジェクト間の辞書共有、編集者への校正ルール共有
- Phase 1 では UI のボタンは用意するが `[未実装]` 状態とする

### Lint 実行との接続

- **Rule ID**: **`project/term-consistency`**（言語横断のため `ja/` `en/` `codex/` と並ぶ `project/` prefix を新設）
- 単一ルールとして、`lint_term_dictionary` の `enabled = true` な全エントリを内部で OR 結合して評価
- **Quick Fix**: variants → preferred への置換を常に提供
- **メッセージ形式**: `「web」→「ウェブ」に統一（企画書 §3.2）`（`note` があれば括弧で補足）

#### マッチングのセマンティクス

- **variants はリテラル扱い**。保存時に regex エスケープした上で内部で正規表現化
- **大文字小文字は完全一致**。`web` と `Web` は別 variant として登録する運用（表記ゆれを明示する方が日本語文書で自然）
- **英字 variant は自動で `\b` 境界を付与**（`web` → `\bweb\b`）。`webhook` 等の誤検知を防ぐ
- **日本語 variant は境界なし**（Phase 1 は形態素解析なしで単語境界を決められないため）。誤検知リスクはユーザーが `note` に注意書きで残す運用

#### Severity の扱い

- 実効 Severity は**エントリ単位の値をそのまま使う**（ルール単位の Severity 上書きは無効）
- ルール設定 UI では `project/term-consistency` の Severity 欄を **disabled** 化し、「エントリごとに設定」のツールチップを表示
- ルール全体の ON/OFF だけはルール設定 UI で制御可能（全エントリを一括無効化する経路として残す）

### Codex Alias との衝突

- **検知**: 辞書編集時および Lint 実行時に、variants と Codex entries の `aliases` を突き合わせる
- **優先順位**: **Codex Alias が先勝ち**（人名判定の一貫性優先）、衝突した辞書エントリは Lint 実行時にスキップ
- **通知経路（2 系統）**:
  1. 辞書タブ内の行に**警告アイコン**。ホバーで `Codex「真琴」の alias と衝突、Codex 側が優先されます`
  2. `RuleWarning` チャネルに `[Skipped] project/term-consistency: "ウェブ" は Codex "..." の alias と衝突` を流し、Linter パネルヘッダの ⚠ アイコンでも気づけるようにする

### バリデーション（保存時）

| 条件 | 挙動 |
|---|---|
| 同じ variant が複数エントリに登録 | エラー表示、保存ブロック |
| `preferred == variant` のエントリ | variant 側から自動除去（警告トースト） |
| `variants` が空 | 保存不可 |
| `variants` が regex メタ文字を含む | 自動エスケープ（ユーザー通知なし、内部処理） |

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

---

## インライン無効化（Phase 3）

TipTap ドキュメント内に埋め込む無効化指示。ユーザーは UI（ホバーボタン・右クリック・エディタメニュー）から挿入・解除する。

### 永続無視リストとの違い

| 仕組み | 同定方法 | 用途例 |
|---|---|---|
| **永続無視リスト**（Phase 2） | `(rule_id, text_snippet, context 前後)` 一致 | 「"ウェブ" は正式表記として使っている」→ シーン内全て無視 |
| **インライン無効化**（Phase 3） | テキストに埋め込んだ directive の位置 | 「この会話文だけは意図的に『、、』を使っている」→ 該当 1 箇所のみ無視 |

両者は残して併用。永続無視は「内容ベース」、インラインは「位置ベース」。

### 格納方式: TipTap Mark + ブロック属性

**Plain text コメント方式（`<!-- lint-disable -->`）は採用しない**。理由: 小説テキストにマークアップが混ざる／エクスポート時の除去漏れ事故リスク／執筆体験の違和感。

#### インライン粒度（Mark）

```typescript
const LintDisableMark = Mark.create({
  name: 'lintDisable',
  inclusive: false,                  // 端での入力で Mark が拡張しないように
  attrs: {
    rules: { default: [] as string[] },  // 無効化するルール ID 配列（空 = 全ルール）
  },
  // copy/paste: TipTap デフォルトに従い Mark も一緒にコピー
});
```

**`inclusive: false` の理由**: 執筆中に disable 範囲の端に文字を入力した時に、意図せず無効化範囲が広がるのを防ぐため。

#### ブロック粒度（属性）

Paragraph / Heading / Blockquote / ListItem / TableCell に属性を追加:

```typescript
{
  lintDisable: string[] | null,  // このブロックで無効化するルール ID（空配列 = 全ルール）
}
```

### 階層的な粒度と優先順位

| 粒度 | 適用範囲 | 格納 |
|---|---|---|
| **Span（インライン）** | 選択範囲のみ | `lintDisable` Mark |
| **Block** | 段落・見出し等のブロック全体 | ブロックの `lintDisable` 属性 |
| **Scene** | シーン全体で特定ルール OFF | （Phase 4+） |
| **Project** | プロジェクト全体 | 既存の `lint.config` |

**合成ルール**: 同一位置に複数粒度の disable が重なる場合、**無効化されるルール ID の集合和（ユニオン）** が適用される。

- 例: Span が `ja/ellipsis-single` を無効化、Block が `ja/dash-single` を無効化
- Span の範囲内では **両方のルールが無効化**される

**Block 無効化の範囲**: ブロックの textContent 全体に適用。内部に Span disable があればその範囲で Block ∪ Span のユニオンで無効化。

### UI フロー

1. **Diagnostic ホバー時のツールチップ**: 「この箇所でこのルールを無効化（インライン）」ボタン
2. **Linter パネルの右クリック**: 「この箇所で無効化（インライン）」/「このブロックで無効化（ブロック）」
3. **エディタ右クリックメニュー**: 選択範囲があれば「選択範囲でルールを無効化 → [サブメニューでルール選択]」
4. **解除**: 無効化 span 上で右クリック →「無効化を解除」

**ルール選択 UI**: デフォルトで「どのルールを無効化するか」のマルチセレクトを表示。「すべてのルール」は**明示的なチェックボックス**で選ぶ必要がある（誤操作で広範囲を無効化する事故を防ぐ）。

### 視覚的表示

- 無効化 Span: 薄いグレーの下線（既定）
- **「全ルール無効化」の Span**: 通常より目立つ色（ただし警告色ではない）で区別表示
- ガター（行頭）に小さなアイコン「この行に disable あり」
- 設定で **表示 ON/OFF** 可能（執筆時に邪魔なら隠せる）

### Rust 側への受け渡し

位置マップ構築時に `lintDisable` Mark とブロック属性を walk して `DisableDirective` を収集:

```rust
pub struct LintInput<'a> {
    pub blocks: &'a [LintBlock],
    pub disables: &'a [DisableDirective],   // 追加
    pub language: Language,
    pub scope: LintScope,
}

pub struct DisableDirective {
    pub range: Utf16Range,          // 無効化範囲（UTF-16、シーン全体座標）
    pub rule_ids: Vec<String>,      // 対象ルール ID。空配列は「全ルール」
    pub kind: DisableKind,
}

pub enum DisableKind {
    Span,       // インライン
    Block,      // ブロック全体
}
```

### 位置マップ構築時の directive 抽出

doc を walk する際、以下を同時に行う:

1. TextNode → 位置マップ区間を追加
2. `lintDisable` Mark 発見時 → `DisableDirective { kind: Span, range, rule_ids }` を収集
3. ブロックノードの `lintDisable` 属性発見時 → `DisableDirective { kind: Block, range: ブロック全域, rule_ids }` を収集

位置マップと `disables: DisableDirective[]` をセットで Rust 側に渡す。

### Diagnostic フィルタ

Lint エンジンは Diagnostic を**発行前にフィルタ**:

```rust
fn is_disabled(diag: &Diagnostic, disables: &[DisableDirective]) -> bool {
    disables.iter().any(|d| {
        d.range.contains(&diag.range)
            && (d.rule_ids.is_empty() || d.rule_ids.contains(&diag.rule_id))
    })
}
```

発行前フィルタを採用することで、無効化された Diagnostic は Linter パネル・Decoration・警告インジケータのいずれにも現れない。

### Fix 適用と Disable の相互作用

Fix 適用時に `Fix.range` が disable Span と重なる場合:

- **TipTap 標準挙動に従う（黙って実行）**
- 文字置換により disable Mark の範囲は自動的に縮小／消滅する（TipTap の既定）
- Fix 結果として **disable が完全消滅した場合、Linter パネルに通知**: 「Fix 適用により disable が削除されました」
- 事前警告はしない（執筆体験を阻害しない）

### エクスポート時の扱い

- **テキストエクスポート**（.txt / .docx / .ePub / .md）: `lintDisable` Mark / ブロック属性は**完全に無視**してテキストのみ出力
- **プロジェクト JSON スナップショット**: 保持
- エクスポーター実装時の**必須テストケース**: 「disable 入りシーン → 出力に directive 情報が含まれない」

実装順として **TipTap 拡張と同時にエクスポーター側の無視処理を実装**する（事故予防）。

### 発見しやすさ（忘却対策）

対策:
- **Linter パネルに「Disables」タブ**（Phase 3）
  - 現在シーン／プロジェクト全体の無効化一覧
  - クリックで該当箇所へジャンプ
  - そこから解除可能
- ガターアイコンで常時視認可能（設定で OFF 可）
- ステータスバーに無効化件数表示（任意）

**Project モードの集約ロジック**: 開いたことのないシーンの disable も集計するため、プロジェクト DB に保存されたシーンコンテンツ（`tree_nodes.content` 等）を走査して `lintDisable` を抽出する処理が必要。Phase 3 のタスクに含める。

### エッジケース

| ケース | 挙動 |
|---|---|
| 無効化 Span が複数ブロックをまたぐ | **禁止**（TipTap Mark の仕様上、1 ブロック内に閉じる）。ブロック跨ぎが必要ならブロック disable を併用 |
| 同一範囲に複数 directive | ルール ID のユニオンを適用 |
| 空の Mark（テキストなし） | 無効化は発動しない |
| 無効化箇所で Fix 適用 | Fix は出ない（Diagnostic 自体が出ないため） |
| Undo/Redo | TipTap の標準 undo に乗る（Mark 操作は自然に undo される） |
| Copy/Paste | Mark は一緒にコピーされる（TipTap デフォルト） |

### Future（Phase 3 内の後半 or それ以降）

- Disable の検索フィルタ（「全ての `ja/ellipsis-single` disable」）
- Disable のバッチ削除（シーン単位）
- AI 校正（将来機能）との責務分離 — Linter の disable は AI 校正を無効化しない（責務分離）

### ステータスバー

#### 表示形式

- **現在シーンのみ**の Diagnostic 数を表示。Error / Warning / Info の 3 区分を並列表示し、**ゼロの区分は非表示**（例: Error 0 件なら `⚠ 3  ⓘ 7`）
- 全件ゼロ（問題なし）の場合は `✓` アイコン 1 つ。Linter パネル Empty state「問題は見つかりませんでした」と整合
- Linter 無効時は**何も表示しない**（無効と「問題なし」を区別）
- プロジェクト全体の集計は表示しない（誤解防止）
- クリックで Linter パネルを開く

#### 「現在シーン」の定義

| モード | 現在シーン |
|---|---|
| 通常モード（タブ） | アクティブなタブのシーン |
| リニア編集モード | **カーソル位置のシーン**（「リニア編集モードでの Lint スコープ」節と整合） |
| スプリットビュー | **フォーカス中のエディタグループのカーソル位置シーン** |
| フォーカスが Editor 外（サイドパネル等）にある間 | **直前の値を維持** |

#### 更新タイミング

- Lint 完了イベントに同期して即更新
- 実行中（pending）は前回値を**グレーアウト表示**で維持（ちらつき防止）
- シーン切替／リニアモードでカーソルがシーン境界をまたいだ場合 → 一旦 `…` 表示、新シーンの Lint 完了で確定

#### 失敗時の表示

`LintError` と `RuleWarning` で表示場所を分離:

| 状態 | 表示場所 | 表示 |
|---|---|---|
| `LintError`（致命的: Lint が完走しなかった） | **ステータスバー** | `⚠︎ Lint失敗`（クリックでパネルを開き詳細表示）。古い数値は出さない |
| `RuleWarning`（部分失敗: 一部ルールが無効化された） | **Linter パネルのヘッダー** | `⚠ N件` アイコン（既存仕様） |
| Lint 実行中の初回（前回値なし） | ステータスバー | `…` |

エラーから復帰したら通常の数値表示に自動で戻る。

#### トグル（Phase 1 では置かない）

Linter の全体 ON/OFF はステータスバーには置かず、設定パネル経由のみ。ステータスバーのクリック動作は「パネルを開く」の 1 アクションに限定する。

---

## MCP サーバー連携

Grimodex の MCP サーバー（`docs/Grimodex_MCPサーバー設計書.md` 参照、スタンドアロン Rust バイナリ `grimodex-mcp`）から Linter 結果を参照可能にする。主用途は外部 AI（Claude Desktop 等）にプロジェクトの原稿と Diagnostic を同時に提示し、修正提案を得ること。

### Crate 構成（Phase 1 で決定）

MCP サーバーは Tauri とは別プロセスのスタンドアロンバイナリのため、Linter コアを**共有ライブラリ crate**として切り出す必要がある:

```
src-tauri/
├── Cargo.toml          ← workspace root
├── src/                ← Tauri アプリ本体（grimodex-lint に依存）
├── crates/
│   ├── grimodex-lint/  ← 新設、Linter コアロジック + 辞書（include_str!）
│   └── grimodex-mcp/   ← MCP 設計書の既存計画、grimodex-lint に依存
```

- 取り込み辞書（textlint 系、ipadic/unidic）は `grimodex-lint` に配置
- Tauri 本体・MCP・CLI（将来）すべてが同一の Lint 実装を共有

**Phase 1 で crate 分離を済ませる理由**: 後から分離するより Phase 1 の最初の PR で構造を固める方が安い。

### 公開コマンド

MCP 命名規約 `verb_noun` + ドメイン名詞 `lint` を付ける形で統一（既存 `list_codex_entries` の慣例に準拠）:

| コマンド | 読/書 | MCP Phase | 概要 |
|---|---|---|---|
| `list_lint_diagnostics` | R | **v2** | シーン単位 or プロジェクト全体の Diagnostic 一覧 |
| `run_lint` | R | **v2** | Lint を実行して結果を返す（副作用なし） |
| `list_lint_rules` | R | **v2** | 有効なルールとその設定の一覧 |
| `apply_lint_fix` | W | **v4 以降** | Quick Fix 適用（シーン書き込みを伴うため MCP の `write_scene` と同時期） |

### 入力コンテンツの扱い

MCP は Content Dir の **Markdown ファイル**を読む前提（MCP 設計書 line 773-777）:

- Lint 実行時は **Markdown → `LintBlock[]` 変換**（見出し/段落/コードブロック等で分解）
- `codeBlock` / `image` は既存方針通り Lint 対象外
- Ruby `{漢字|かんじ}` / emphasisDots `《《text》》` の扱いは Tauri 側（ProseMirror ベース）と MCP 側（Markdown ベース）で処理経路が異なるため、同一結果になる保証は **Phase 2 の Markdown パーサ決定時にゴールデンファイルで検証**する

### Diagnostic の返却形式

Tauri 向けの UTF-16 ProseMirror オフセットは MCP では無意味。**別形式で返す**:

```typescript
// MCP 返却形
{
  rule_id: "ja/sentence-length",
  severity: "warn",
  scene_id: "uuid",
  scene_title: "The tower",
  line: 23,          // Markdown ファイル内の行番号（1-origin）
  column: 5,         // UTF-16 コードユニット（LSP 慣例、内部表現と一致）
  length: 120,       // UTF-16 コードユニット単位
  message: "一文が 120 文字を超えています",
  text_snippet: "扉の前に立った...",
  fixes: [...]
}
```

- `column` / `length` は **UTF-16 コードユニット**で統一（LSP 仕様準拠、Tauri 側内部表現と一致、変換コスト最小）
- Diagnostic 型は内部形式と公開形式で分ける（同じソースから出力時に分岐）
- `apply_lint_fix`（将来）では `line / column / length` を受け取り Fix を適用

### MCP Resources（未決、MCP v2 着手時に再判断）

`grimodex://lint/diagnostics` のような Resource を出すかは **MCP v2 着手時に再検討**。検討時の論点:

- Lazy 方式（読み込み時に Lint 実行）: 連続アクセスで計算コストが重い
- Eager 方式（事前計算して保存）: キャッシュ保存先とトリガーが未決
- 候補: Content hash ベースの簡易メモ化（`--workspace` 直下の一時ファイル or メモリのみ）

Phase 2 着手時点で MCP サーバー設計書側と同時に最終決定する。

### 書き込み制限との整合

MCP 設計書の `--readonly` フラグに従う:

- `--readonly`: `list_lint_diagnostics` / `run_lint` / `list_lint_rules` のみ（Lint 実行は副作用なしのため許可）
- フルモード: `apply_lint_fix` を追加

### Phase 配分

| MCP Phase | Linter 要素 |
|---|---|
| MCP v1 | Linter 連携なし |
| **MCP v2** | Linter 読み取り系（`list_lint_diagnostics` / `run_lint` / `list_lint_rules`） + Resources（未決） |
| MCP v3 | Linter 連携なし（Codex 書き込みと独立） |
| **MCP v4 以降** | `apply_lint_fix`（シーン書き込みが可能になる前提） |

Linter 本体の Phase と MCP の Phase は独立に進むため、タイミングは両設計書を見比べて都度決める。

---

## Lint レポートのエクスポート（Phase 2）

校正作業、編集者との共有、ベータ読者へのフィードバック依頼、ルール精度測定のための出力機能。

### 対象

- **プロジェクト全体**: 「全章 Lint」実行結果の全 Diagnostic（主用途）
- **フィルタ結果のみ**: Linter パネルで絞り込んだ現在の一覧（調査・ルール別集計用途）
- 現在シーンのみは対象外（その場で見れば済むため）

### フォーマット

| フォーマット | 用途 | 内容 |
|---|---|---|
| **CSV** | Excel / Google Sheets で編集者と共有 | `scene_id, scene_title, rule_id, severity, line, col, text_snippet, message, fix_suggestion` |
| **Markdown** | GitHub Issue / Notion 貼り付け、レポート化 | シーン別にグルーピング、Severity アイコン、該当箇所の引用ブロック |
| **JSON** | 他ツール連携、スクリプト処理、ルール精度測定の生データ | `LintResponse` をそのまま（または軽量化した形で） |

#### Markdown フォーマット例

````markdown
# Lint レポート: プロジェクト「XXX」
生成日時: 2026-04-23 10:15
対象: 全章 Lint / プロジェクト全体
総 Diagnostic 数: 42（Error 1 / Warning 15 / Info 26）

---

## Part 1 / Chapter 1 / The tower

### ⚠ `ja/sentence-length` (L23)
> 扉の前に立ったエララは、手を伸ばしかけて止まった、指先が震えていたからだ…

一文が 120 文字を超えています（設定: 80 文字）

### ⓘ `ja/quote-period` (L45)
> 「本当に行くのか。」

カギ括弧内末尾の句点。
````

### 起動口

- **Linter パネル右上メニュー → `エクスポート...`**
- ダイアログで「対象（全体 / フィルタ結果）」「フォーマット」を選択 → ファイル保存ダイアログ
- Phase 1 時点では UI にメニュー項目を置き、`[Phase 2]` でグレーアウト表示してもよい

### Phase 配分

- **Phase 1**: 実装しない（全章 Lint の結果が永続化されていないため）
- **Phase 2**: 全章 Lint の結果が構造化保持されるタイミングで正式実装
- **Phase 3**: 編集者からのフィードバックを Diagnostic に紐付ける等の双方向連携は対象外（別機能として検討）

### セキュリティ / プライバシー

- エクスポートには**本文の抜粋**が含まれる（未発表原稿の取り扱いに注意）
- デフォルトの `text_snippet` は前後 30 文字（Linter パネル抜粋と同ルール）
- **「本文抜粋を含めない」オプション**を用意（`rule_id` + 位置情報のみの軽量出力）

---

## テレメトリー / デバッグログ

個人執筆ツールという性格上、**外部送信機能は一切持たない**。目的ごとに3分類した上で、開発者向け収集（A）は実装せず、ユーザー価値がある B / C のみ実装する。

### 分類と方針

| 目的 | 対象 | 実装 |
|---|---|---|
| **A. ルール精度の改善**（開発者向け） | 検出数 / Fix 採用率 / 無視率の集計 | **実装しない** |
| **B. ユーザー自身の執筆傾向把握** | 「自分はどのルールを無視しがちか」 | Phase 2〜3 |
| **C. クラッシュ / エラー診断** | Panic / LintError / RuleWarning | Phase 1 から |

**A を実装しない根拠**: Grimodex は未発表原稿を扱うツールで、**外部送信はユーザーの信頼を損なう**。代替手段は:
- 開発者が自分のプロジェクトで C のログを `debug` レベルで回す
- ゴールデンファイル fixture の拡充で精度改善
- ベータテスターからの手動フィードバック

**Phase 1 時点では「A 目的のために追加実装するものはない」**（ゴールデンファイル + 手動テストで代替）。将来 A への要求が再燃した際の根拠としてここに明記する。

### B: 執筆傾向の記録（Phase 2〜3）

#### テーブル設計

```sql
CREATE TABLE lint_action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  action      TEXT NOT NULL,        -- 'detected' / 'fixed' / 'ignored_once' / 'ignored_persistent_set' / 'ignored_persistent_unset' / 'disabled_inline'
  scene_id    TEXT,
  occurred_at INTEGER NOT NULL
);
```

#### `lint_ignored_diagnostics` との役割分離（重要）

| テーブル | 役割 | 用途 |
|---|---|---|
| `lint_ignored_diagnostics` | **現在の状態**（どの Diagnostic が今無視中か） | Lint 実行時のフィルタ、永続無視リスト表示 |
| `lint_action_log` | **イベント履歴**（いつ何をしたか） | 執筆傾向の統計可視化のみ |

「今無視されているか」のクエリ源は常に `lint_ignored_diagnostics`。`lint_action_log` は集計用の append-only ログで、状態管理の源泉にはしない。無視追加は `ignored_persistent_set`、解除は `ignored_persistent_unset` の2イベントを別々に記録する。

#### 可視化

- Linter パネル内「統計」タブ（Phase 3）
- 例: 「あなたは `ja/quote-period` を 80% 無視しています → OFF にしますか？」のセルフチューニング提案

#### サイズ管理

- 90 日で自動削除、または最大 10,000 行 FIFO
- プロジェクトサイズに直結しないよう DB 肥大化を防ぐ

### C: デバッグログ（Phase 1 から）

#### バックエンド

- クレート: **`tracing` + `tracing-subscriber`**（既存のアプリログ基盤は未整備のため、Linter と共に導入）
- ローテーション: `tracing-appender` で日次ローテーション
- 格納先: `~/.grimodex/logs/`

#### プロセス別ファイル分離

Tauri 本体と MCP サーバーは別プロセスでファイルロックが衝突するため、**ログファイルを分離**する:

| プロセス | ファイル名 |
|---|---|
| Tauri 本体 | `lint-tauri-YYYY-MM-DD.log` |
| `grimodex-mcp` | `lint-mcp-YYYY-MM-DD.log` |

両者は `grimodex-lint` crate を共有するが、ログ subscriber の初期化はそれぞれのバイナリ側で行う（crate 自体は `tracing` マクロを呼ぶだけ）。

#### レベルと記録内容

| レベル | 記録する事象 | デフォルト |
|---|---|---|
| `error` | `LintError`、辞書ロード失敗、Panic | 常時 ON |
| `warn` | `RuleWarning`、500KB 超過、衝突検知 | 常時 ON |
| `info` | Lint 実行の開始・終了、処理時間、件数サマリ | Phase 2 以降 ON |
| `debug` | ルール個別の実行時間、Fix 適用イベント | 開発者モードのみ |
| `trace` | 位置マップ構築詳細、Diagnostic raw データ | 開発者モードのみ |

- 開発者モード: `--verbose-lint` 起動フラグ または設定での切替

#### プライバシー

- **本文は原則ログに残さない**。Diagnostic の `text_snippet` は `[redacted]` 化
- 例外: `--verbose-lint` + `debug` レベル時のみ、開発診断のため snippet をログに含める
- ログエクスポート UI を用意する場合は「本文が含まれる可能性があります」の警告を必須表示

### D: 外部送信（スコープ外）

- Grimodex からテレメトリー / クラッシュレポートを外部サーバーに送信する機能は**本設計書のスコープ外**
- 必要になったら Sentry 等の導入を独立の設計書で議論
- 個別ログ共有はユーザーが手動でファイルをエクスポートする形のみ

### Phase 配分まとめ

| Phase | C（ログ） | B（執筆傾向） |
|---|---|---|
| Phase 1 | `error` / `warn` レベル、`tracing` 導入、Tauri/MCP 別ファイル | 実装なし |
| Phase 2 | `info` 追加、`lint_action_log` 書き込み開始 | ログ記録のみ（UI なし） |
| Phase 3 | `debug` / `trace` + 開発者モード | 統計 UI（Linter パネル統計タブ） |

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

最初の PR に含める **5 点セット（エンジン側）**:

1. **Cargo ワークスペース化 + `src-tauri/crates/grimodex-lint/` crate 分離**（MCP 連携を見据えた構造、後から分離すると手戻りが大きい）
2. `LintRule` trait + `Diagnostic` 型 + `LintContext` の設計
3. ProseMirror ↔ 文字列オフセット変換層（ユニットテスト付き）
4. ゴールデンファイル形式のテストハーネス
5. Phase 1 ルール群（日英、regex のみ）

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
- Linter パネルのフィルタプリセット保存

**インライン無効化（推奨作業順）**:

1. **TipTap Mark/Node 拡張**（`inclusive: false`、ブロック属性追加）
2. **エクスポーター側の無視処理を同時実装**（事故予防のため先に潰す）
3. 位置マップ構築時の directive 抽出
4. Tauri Command `lint_text` に `disables` を追加、Rust 側フィルタ
5. UI（Diagnostic ホバー、右クリック、エディタメニュー、「全ルール無効化」は明示チェックボックス）
6. Linter パネル「Disables」タブ（Project モード集約含む）
7. ゴールデンファイルテスト網羅（粒度ごと、Fix 相互作用、Undo/Redo、Copy/Paste）

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
| 用語辞書 Rule ID | `project/term-consistency`（`project/` prefix を新設、言語横断） |
| 用語辞書 UI | Settings `Linter → 用語辞書` サブタブ、テーブル編集、エントリ単位 Severity（warn/info）と ON/OFF |
| 用語辞書マッチング | variants はリテラル扱い + 英字自動 `\b` 境界 + 大文字小文字完全一致 |
| 用語辞書 Severity | エントリ単位の値を優先、ルール設定 UI 側は disabled |
| Codex Alias 衝突 | Codex 先勝ち、辞書側は `RuleWarning` + 辞書タブの警告アイコンで2系統通知 |
| 新ルール追加時の既定 | `enabled: false`（既存プロジェクトの体験を阻害しない） |
| Phase 1 の Diagnostic 保持 | キャッシュなし。現在シーンのみメモリ保持、毎回再計算 |
| Stale 応答対策 | 世代番号（pendingRequestId）で古い応答を破棄 |
| debounce 入力 | `transaction.docChanged === true` のみ |
| Fix 適用の再 Lint | debounce バイパスで即時実行 |
| ステータスバー | 現在シーンの Error/Warning/Info 3 区分表示（ゼロ非表示、全件ゼロは `✓`）。リニアモードはカーソル位置シーン、スプリットはフォーカス側。`LintError` は `⚠︎ Lint失敗` 表示で古い値は残さない。Phase 1 ではトグル非搭載 |
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
| インライン無効化の格納 | TipTap `lintDisable` Mark（`inclusive: false`）+ ブロック属性。Plain text コメント方式は不採用 |
| インライン無効化の粒度 | Span / Block（+ 将来 Scene）。重複時はルール ID のユニオン |
| 「全ルール無効化」 | `rule_ids: []`。UI では明示的なチェックボックスで選択必須 |
| Fix × Disable | TipTap 標準挙動（黙って実行）。disable 消失時は Linter パネルに通知 |
| エクスポート（原稿） | `lintDisable` Mark/ブロック属性は除去。テスト必須 |
| Lint レポートのエクスポート | Phase 2 実装。CSV / Markdown / JSON の 3 形式。対象はプロジェクト全体 or フィルタ結果。本文抜粋非含有オプションあり |
| Linter の crate 構成 | Phase 1 で `src-tauri/crates/grimodex-lint/` に分離。Tauri 本体・MCP サーバーから共有依存 |
| MCP Linter コマンド | `list_lint_diagnostics` / `run_lint` / `list_lint_rules` を MCP v2 で公開。`apply_lint_fix` は MCP v4 以降 |
| MCP Diagnostic 返却形 | line（1-origin）+ column / length（UTF-16 コードユニット、LSP 準拠）。ProseMirror オフセットは返さない |
| MCP Lint Resources | 未決（MCP v2 着手時に lazy / eager / content hash メモ化を再検討） |
| 外部テレメトリー送信 | **実装しない**（本設計書のスコープ外、未発表原稿のプライバシー優先） |
| 執筆傾向ログ `lint_action_log` | Phase 2 で書き込み開始、Phase 3 で統計 UI。**イベント履歴**として `lint_ignored_diagnostics`（状態）と役割分離 |
| デバッグログ基盤 | `tracing` + `tracing-appender` を Phase 1 で導入。Tauri/MCP は別プロセスのため `lint-tauri-*.log` / `lint-mcp-*.log` にファイル分離 |
| ログ内の本文 | 原則 `[redacted]`。`--verbose-lint` + `debug` レベル時のみ `text_snippet` を含める |
| テスト | ゴールデンファイル形式を day 1 から |

---

## 未決事項（Phase 2 着手時に再判断）

- lindera 辞書: ipadic（軽量）/ unidic（高精度）
- Codex 連動の口調・一人称検出の精度（小説的に許容できる粒度の見極め）
- 全章 Lint のキャンセル機構（Phase 1 では同期で十分）
