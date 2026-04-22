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
    pub text: &'a str,           // UTF-8 文字列
    pub language: Language,
    pub scope: LintScope,        // Scene / Chapter / Project
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
    text: String,           // UTF-8、エディタからシリアライズ済み
    language: String,       // "ja" | "en"
    scope: LintScope,
    config: LintConfig,
) -> Result<Vec<Diagnostic>, LintError>;
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

## ルール設定 UI（概要）

設定パネル（`Settings → Linter`）で以下を制御:

- **言語ごとの有効/無効**
- **ルールごとの ON/OFF**
- **ルールごとの Severity 上書き**
- **ルール固有のオプション**（一文長の閾値、カギ括弧内句点の方針等）
- **プロジェクト辞書**（カスタム表記統一辞書）

設定はプロジェクト単位で保存（`project_settings.lint` テーブル想定）。

---

## 実行モデル

### 実行タイミング

| トリガー | 範囲 | デバウンス |
|---|---|---|
| キーストローク | 現在シーンのみ | 500ms |
| シーン切替 | 移動先シーン全体 | なし（即時） |
| 明示コマンド「全章 Lint」 | プロジェクト全体 | なし |
| 保存時 | 現在シーン | なし |

### リニア編集モードでの Lint スコープ

Editor 設計書で定義される「リニア編集モード」（プロジェクト内の全シーンを `sortOrder` 順に縦連結表示）での挙動:

- **ビューポート基準**: 画面に表示中のシーン + 上下バッファ 1 シーン分のみを Lint
- **カーソル位置のシーン**: ビューポート外でも常に含める
- **明示コマンド「全章 Lint」**: 通常モードと同じく全シーン対象
- **シーン間の context はまたがない**: 各シーンを独立に Lint する（文末連続などの判定はシーン境界で切れる）

### パフォーマンス予算

- 現在シーン Lint: **< 50ms** （シーン平均 5,000 文字想定）
- 全章 Lint: **< 2s** （プロジェクト平均 30 シーン想定）
- 形態素解析を使うルールは Phase 2 以降のため、Phase 1 はこの予算で余裕

### キャンセル

- 新しい Lint 要求が来たら古い実行はキャンセル（フロント側で結果を破棄、Rust 側は到達時点まで実行して破棄）
- Phase 1 では同期実行で十分（< 50ms）。Phase 2 で形態素解析を入れたら非同期化を検討

---

## UI 表現

### エディタ内表示

- **Squiggly underline**: TipTap Decoration で対象範囲に下線
  - Error: 赤
  - Warning: 黄
  - Info: 青
- **ホバー時**: ツールチップでメッセージ表示、修正候補があれば「[修正] [無視]」ボタン
- **クリック時**: 修正候補ポップオーバー

### Linter パネル（別途設計）

- 検出された Diagnostic の一覧
- ルール ID / Severity でフィルタ
- クリックでエディタの該当箇所にジャンプ
- 「全て修正」「ルールごとに無視」アクション

### ステータスバー

- 現在シーンの Diagnostic 数を表示（例: `⚠ 3  ⓘ 7`）
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

最初の PR に含める **4 点セット**:

1. `LintRule` trait + `Diagnostic` 型 + `LintContext` の設計
2. ProseMirror ↔ 文字列オフセット変換層（ユニットテスト付き）
3. ゴールデンファイル形式のテストハーネス
4. Phase 1 ルール群（日英、regex のみ）

加えて:

- Tauri Command `lint_text` の登録
- TipTap Decoration による squiggly 表示
- 設定パネルに最低限の ON/OFF UI

**完了基準**: 上記ルールがエディタ上でリアルタイムに動作し、修正候補ボタンで適用できる。

### Phase 2（形態素解析 + Codex 連動）

- lindera 導入（辞書サイズで ipadic / unidic を再判断）
- **`ja/particle-no-chain`**（Phase 1 から持ち越し）
- C群（冗長表現）、D群（同語近接反復、漢字・平仮名連続）
- F群（Codex 連動）— 人名・固有名詞表記ゆれ、一人称、口調
- 設定パネルの拡充（ルール詳細オプション、プロジェクト辞書）

**Phase 2 で検討すべきパフォーマンス課題**:

- **Incremental lint**: 変更されたパラグラフだけ再 Lint し、それ以外の Diagnostic は維持する仕組み。形態素解析を入れると全文再 Lint は無視できないコストになる
- **1 パス統合最適化**: Phase 1 時点で 14 個のルールが各々テキストを走査するため、同じテキストを複数回舐めている。形態素解析導入のタイミングで、**形態素列を共有キャッシュにし、全ルールが 1 パスで評価**するアーキテクチャへの再設計を検討

### Phase 3（小説 craft）

- B群（文体・時制混在）
- E群（フィルターワード、会話タグ単調さ）
- 英語の Phase 2/3 ルール（passive voice, weasel words, dialogue tag）
- **インライン Lint 無効化記法**（`<!-- lint-disable-next-line <rule-id> -->` 相当）— 固有名詞や意図的な表現を個別に除外できる

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
| テスト | ゴールデンファイル形式を day 1 から |

---

## 未決事項（Phase 2 着手時に再判断）

- lindera 辞書: ipadic（軽量）/ unidic（高精度）
- Codex 連動の口調・一人称検出の精度（小説的に許容できる粒度の見極め）
- 全章 Lint のキャンセル機構（Phase 1 では同期で十分）
