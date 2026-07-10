# Grimodex 段落内並べ替え（推敲リオーダー）設計書

## 概要

推敲時に、**段落の中の文（sentence）／文節（bunsetsu）の順序を入れ替える**機能。
既存の「段落（行）移動」（`Alt+矢印`、PR#207）を1段細かい粒度へ拡張する位置づけ。

コア体験は Grimodex の「TALK → EXTRACT → RECALL」のうち **RECALL/推敲**側の強化：
一度書いた文章を、文・文節という自然な単位でカードのように並べ替えて練り直す。

2つの粒度と2つの操作を持つ：

- 粒度: **文**（句読点区切り・形態素不要）／**文節**（形態素解析ベース）
- 操作: **推敲モード＋文カードのドラッグ&ドロップ**／**キーボードで隣接単位を swap**

> **重要な前提**：これは *自動書き換え* ではなく *手動の推敲ツール* である。
> 並べ替え結果が非文（文法的に破綻した文）になっても、それはユーザーの推敲操作の
> 途中結果であり **完全に undo 可能**。したがって「文節を動かすと助詞の辻褄が崩れる」
> リスクは、確定前プレビュー（カードモード）と undo という安全弁で受け切る。
> 係り受け解析による助詞の自動調整は **やらない**（スコープ外）。

> **master 追従状況**：本設計は master `d612782c` を基点に起こし、その後マージされた
> **#296（エディタ入力補助3種＋TW縦書き＋縦中横 `TcyMark`）** および #295（バックアップ肥大対策）と
> 突合済み。中核依存（`ParagraphMoveExtension` / `CodexHighlightPlugin` / `codexDocFlatten` /
> `AuthorshipMark` / Rust 側 `chunker.rs`・`morph.rs`・`en.rs`・`lib.rs`）は **#296 で無改修＝設計は
> そのまま成立**。#296 由来の差分（新 inline mark `tcy`、自己修復 decoration `ShowInvisibles`、
> `extensions.ts` 登録追加）は §6.3 / §6.4 / §6.5 に反映済み。

---

## 動機・背景

### なぜ形態素エンジンを使うのか（前提の整理）

- **文単位の並べ替えには形態素解析は不要**。日本語の文境界は句読点（`。！？`）で決まり、
  括弧深度に対応した文分割器 `split_sentences_ja` が既に Rust 側に存在する
  （`src-tauri/src/semantic/chunker.rs:166`、semantic chunking 用）。
- 形態素エンジン（**lindera 4.0.0 + UniDic**、`grimodex-lint/src/morph.rs`）が本当に活きるのは
  1段細かい **文節** 単位。品詞（`pos_major`/`pos_sub1`）と語彙素（`lemma`）、そして
  **バイト境界**（`byte_start`/`byte_end`）を保持しているため、自立語＋付属語の
  文節チャンク化に使える。
- ただし lindera は *形態素解析* であって *係り受け解析* ではない。文節境界は求まるが、
  「どの文節がどの文節に係るか」は分からない。よって文節の並べ替えは非文を生みうる
  （前掲の安全弁で対処）。

### 既存基盤（そのまま流用する）

| 基盤 | 場所 | 流用点 |
| --- | --- | --- |
| 段落（行）移動 | `src/features/editor/ParagraphMoveExtension.ts` | 隣接単位 swap の transaction 構築・キャレット追従・FLIP・縦書き対応の型 |
| Codex 装飾の reorder 再構築 | `src/features/editor/CodexHighlightPlugin.ts:132-160`（`remapCodexDecosForReorder`） | `replaceWith` で落ちる装飾を meta 経由で per-block 再構築する仕組み |
| 文分割（日本語） | `src-tauri/src/semantic/chunker.rs:166`（`split_sentences_ja`） | 括弧深度対応・末尾終端記号飲み込みのロジックを TS へ移植 |
| 形態素解析 | `src-tauri/crates/grimodex-lint/src/morph.rs`（`tokenize_block`） | 文節チャンク化の入力。現状 Rust 内部限定なので expose が必要 |
| 帰属マーク | `src/features/attribution/AuthorshipMark.ts` | 移動時に marks 込みで運べば保持される（`inclusive:false`） |
| フラット化契約 | `src/features/editor/codexDocFlatten.ts` | 文/文節の char 範囲 → ProseMirror position 変換の基準 |
| アニメ定数 / Reduced Motion | `src/lib/animation.ts:52-61` / `src/lib/gsap.ts:4` | `CSS_DURATIONS.normal`（200ms）・`isReducedMotion()` |

---

## スコープ

### やること

- 段落内の **文** の並べ替え（句読点ベース）。
- 段落内の **文節** の並べ替え（形態素ベース）。
- 操作: **文カードのドラッグ&ドロップ（推敲モード）** と **キーボードでの隣接 swap** の両方。
- 帰属（`authorship`）・Codex ハイライト装飾の保持。
- 縦書き対応・Reduced Motion 対応。

### やらないこと（YAGNI）

- **係り受け解析による助詞・格の自動調整**（例: 「が」→「を」の書き換え）。手動推敲に徹する。
- **段落をまたぐ文の移動**（今回は段落内限定。段落間は既存の段落移動が担う）。
- 英語の文節相当（clause）並べ替え。英語は文単位のみ対応（`sentence_ranges_en`,
  `grimodex-lint/src/textscan/en.rs:169` を TS 移植）。文節は日本語のみ。
- リスト項目・テーブルセル内の並べ替え（対象は本文段落＝`paragraph` ノードのみ）。

---

## 用語・単位定義

- **文（sentence）**: `。！？!?` を終端とする範囲。直後の閉じ括弧・連続終端記号を同じ文に含める。
  括弧（`「『（(`）深度が 0 のときだけ終端とみなす（`split_sentences_ja` と同一規則）。
- **文節（bunsetsu）**: 1つの自立語と、それに後続して付着する付属語（助詞・助動詞・接尾辞・
  補助記号）のまとまり。形態素列から下記ヒューリスティックで構成する（§6.2）。

---

## 機能仕様

### 操作モードA: 推敲モード＋文カードD&D（中核）

```
┌─ 通常のエディタ ──────────────────────────────┐
│  彼女は塔の前に立った。指先で冷たい石をなぞる。│
│  そして懐のアミュレットに手を伸ばした。         │  ← カーソルのある段落
└───────────────────────────────────────────────┘
        │  「推敲」トグル（ツールバー or ショートカット）
        ▼
┌─ 推敲モード（この段落だけカード分解）─────────┐
│  ┌──────────────────────────┐  [粒度: 文 ▾]   │
│  │ ⠿ 彼女は塔の前に立った。   │                 │
│  └──────────────────────────┘                 │
│  ┌──────────────────────────┐                 │
│  │ ⠿ 指先で冷たい石をなぞる。 │  ← ドラッグ中    │
│  └──────────────────────────┘                 │
│  ┌──────────────────────────┐                 │
│  │ ⠿ そして懐のアミュレットに…│                 │
│  └──────────────────────────┘                 │
│                        [確定] [キャンセル]      │
└───────────────────────────────────────────────┘
```

- カーソルのある段落に「推敲」トグルを掛けると、その段落だけを**単位カードに分解表示**する。
- 粒度スイッチ（**文 ⇄ 文節**）でカードの粒度を切り替える。文節に切り替えると各文が
  さらに文節カードへ割れる（ネスト表示ではなく、選択粒度でフラットに割り直す）。
- カードは **Scenes ツリーと同種の D&D** で並べ替える（ドラッグハンドル `⠿`）。
- **カードはブロック的**なので FLIP アニメが素直に効く（＝後述のインライン FLIP 問題を回避）。
- **[確定]** で並べ替え結果を marks 込みでエディタ doc に書き戻す。**[キャンセル]** で破棄。
  この「確定前プレビュー」が非文リスクの安全弁。
- 対象は1段落。複数段落を跨いだカード移動は不可（段落境界はカード領域の外）。

### 操作モードB: キーボード隣接 swap

- `Alt+Shift+矢印` で、**現在の単位（文 or 文節）を前後の単位と入れ替える**。
  既存の段落移動 `Alt+矢印`（`ParagraphMoveExtension.ts:208-215`）と一貫した体系。
- 現在の作業粒度は小さなトグル（例 `Alt+Shift+G` で 文⇄文節 切替、ステータスバーに現在粒度を表示）。
- **インライン単位（文/文節）は複数の行ボックスを跨ぐため FLIP（transform）が破綻する。**
  よってキーボード swap のアニメは FLIP ではなく **控えめなハイライトフラッシュ**
  （移動後の単位を一瞬ハイライト）に置換する。`isReducedMotion()` 時は無し。
- 縦書き（`vertical-rl`）では段落移動と同じくキー方向をジオメトリに合わせる
  （`Alt+Shift+Right` = 前へ / `Alt+Shift+Left` = 後ろへ、向きが合わないキーは素通し）。

### キーバインド一覧

| キー | 動作 | 備考 |
| --- | --- | --- |
| `Alt+矢印`（既存） | 段落（ブロック）移動 | `ParagraphMoveExtension` |
| `Alt+Shift+↑/↓`（横書き） | 現在単位を前/後の単位と swap | 新規 |
| `Alt+Shift+→/←`（縦書き） | 現在単位を前/後の単位と swap | 新規・方向反転 |
| `Alt+Shift+G` | 作業粒度 文⇄文節 切替 | 新規（暫定・要確認） |

---

## 技術設計

### 6.1 文分割（TS 移植）

`split_sentences_ja`（`chunker.rs:166`）と `sentence_ranges_en`（`textscan/en.rs:165`）の
ロジックを TS に移植し、**フラットな段落テキスト上の char 範囲**として文境界を返す純関数を作る。

- 同期・低コスト（キーボード swap の即応性のため IPC 往復を避ける）。
- Rust 実装と **parity テスト**で境界一致を担保（fixture 共有）。
- 括弧深度・末尾終端記号飲み込み・閉じ括弧の同文包含を厳密に移植する。

配置案: `src/features/editor/reorder/sentenceSplit.ts`。

### 6.2 文節分割（Rust コマンドを新設）

lindera は **Rust 内部限定**で、`MorphToken` は `Serialize` 非対応・トークン列を返す
Tauri コマンドは1つも無い（`morph.rs:27`「tokens never leave the Rust side」）。
文節粒度のために **新規コマンドを1つだけ追加**する：

```rust
// 新規 #[tauri::command]
// 入力: 段落のプレーンテキスト（フラット化済み）
// 出力: 文節境界（フラットテキスト上のオフセット）＋ surface
pub struct Bunsetsu { start: usize, end: usize, surface: String } // DTO(Serialize) を新設

fn segment_bunsetsu(text: String) -> Result<Vec<Bunsetsu>, String>
```

- `MorphToken` 自体は内部維持のまま、**返却用 DTO だけ Serialize** 化する
  （境界情報は `MorphToken.byte_start/byte_end` から得る）。
- **文節チャンク化ヒューリスティック**（UniDic `pos_major` ベース）:
  - 自立語（`名詞`/`代名詞`/`動詞`/`形容詞`/`形状詞`/`副詞`/`連体詞`/`接続詞`/`感動詞`）
    または `接頭辞` で**新しい文節を開始**する。ただし直前が `接頭辞` の場合は継続（接頭辞は後続に付く）。
  - `助詞`/`助動詞`/`接尾辞`/`補助記号`/`記号`/`空白`（句読点含む）は**直前の文節に付着**。
  - ※これはヒューリスティックで、稀に区切りが甘い。その場合ユーザーは **文粒度に落とす**か
    **確定前に手で直す**ことで吸収する（非文ガードと同じ思想）。
  - ※上記の `pos_major` 文字列のうち、既存 lint ルールでコード確認できているのは
    `名詞`/`代名詞`/`形状詞`/`接頭辞`/`動詞`/`形容詞`/`助詞` のみ
    （`particle_no_chain.rs:22,28`, `kanji_hiragana_chain.rs:86`, `word_repetition.rs:88-90`）。
    残り（`連体詞`/`接続詞`/`感動詞`/`助動詞`/`接尾辞`/`補助記号`/`記号`/`空白`/`副詞`）は
    UniDic の実出力に依存しコードからは裏取り不可。**実装時に実 UniDic 出力へプローブテストを
    当て、分類名の全集合を確定する**こと（想定と食い違う名称は現状ゼロ）。
- **オフセット規約**（要確定・§10）: Rust が返す `start/end` は、フロントが持つフラット
  段落テキストと**同一の単位系**（Unicode スカラ＝コードポイント基準を推奨）でなければ
  ならない。JS 文字列は UTF-16 なので、Rust のバイトオフセット → コードポイント →
  フロントの UTF-16 index 変換を1箇所に閉じ込める。
- **キャッシュ**: 文節分割は async。段落単位で結果をキャッシュし、当該段落が編集されたら破棄。
  カードモードは開いた時に1回呼ぶ。キーボード swap は当該段落で初回のみ呼ぶ。

配置案: `src-tauri/src/commands/reorder.rs`（`lib.rs` の `invoke_handler!` に登録）。

### 6.3 段落内スライス移動（並べ替えの本体）

段落内は素の `paragraph`（`content: "inline*"`）で **文/文節に相当する構造ノードは無い**。
単位は「text run（+ marks）＋ ruby/mention atom の連続する範囲」でしかない。よって並べ替えは
**2つのテキスト範囲を swap** する ProseMirror transaction として実装する。

- **必ず marks 込みの Slice を運ぶ。** `doc.slice(from, to)` は各 text node の marks を保持する。
  **プレーンテキストを抽出して再挿入するのは禁止**（`authorship` mark が全消失し human 既定に
  化けるほか、`emphasisDots`（傍点）・`tcy`（縦中横、#296 で追加の inline mark）等の特殊表現
  マークも失う）。`AuthorshipMark` は `inclusive:false`（`AuthorshipMark.ts:28`）なので、境界で
  隣接文の帰属が誤って伸びることはない（有利）。※ #296 追加の `TcyMark` は atom ではなく
  **inline mark** なので flat 化（§6.4）には影響せず、Slice でそのまま運ばれる。
- **単一 transaction で範囲反転**：swap する2単位を `[start1, end1]`, `[start2, end2]`
  （`end1 <= start2`、同一段落内・非重複）とすると、`start1..end2` を
  `slice2 + gap + slice1` で `replaceWith` して置換する（段落移動の
  `Fragment.fromArray([second, first])` と同じ発想を、ノード境界ではなく範囲に適用）。
- **区切り（gap）の扱い**：単位間の空白・全角空白は「後続単位に含める／前単位に含める」を
  一方に固定する。文分割は末尾句読点を前の文に含めるため、文と文の間の余白は原則無い想定。
  文節の場合、句読点は前の文節に付着（§6.2）。この規約を分割関数と移動関数で共有する。
- **キャレット追従**：段落移動と同様、単位内オフセットを保持して `TextSelection.near` を再設定
  （`ParagraphMoveExtension.ts:110-111` を参照）。
- `scrollIntoView` は呼ばない（隣接1つ移動では視界に残る）。

配置案: `src/features/editor/reorder/reorderTransaction.ts`（純粋な transaction 構築関数）。

### 6.4 位置マッピング（flat char ↔ PM position）

文/文節の char 範囲を ProseMirror position に変換するとき、`codexDocFlatten.ts` の契約を
**必ず踏襲**する：

- text node → 1 char/slot。
- ruby atom → base 文字が同一 pos を指す。
- mention 等 atom → フラットテキストに寄与しない。
- ブロック境界 → `"\n"` 1 slot（段落内では出てこないが、段落抽出時に効く）。

ここを外すと pos がずれ、隣の単位の mark を巻き込む。分割関数・移動関数の双方でこの契約に
沿った同一のフラット表現を使う。

### 6.5 Codex 装飾の再構築

`replaceWith` は置換範囲内の decoration を `DecorationSet.map` で落とす。段落移動では
`tr.setMeta("codexHighlightReorder", {...})` を積み、`CodexHighlightPlugin.ts` 側で
per-block オフセット再構築している（`CodexHighlightPlugin.ts:132-160`）。

段落内 swap では**同一段落内でオフセットが可変**になるため、既存 meta 機構を
**段落内 swap 向けに拡張**する：

- meta に「swap した2範囲と各々の移動量」を積む。
- 受け側は範囲ごとに `codexKind`（`"inline"|"node"`、`CodexHighlightPlugin.ts:87,110`）を
  復元しつつ、旧 pos → 新 pos のマップで装飾を張り直す。
- 既存の `CodexHighlightPlugin.reorder.test.ts` を段落内 swap ケースへ拡張する。

> **他の decoration プラグインは自己修復するので特別扱い不要。** エディタには
> `ShowInvisiblesPlugin`（#296 追加）や `TateChuYokoPlugin`（縦中横 auto）等の decoration
> プラグインもあるが、これらは `docChanged` のたびに doc から**丸ごと再構築**（map しない。
> `ShowInvisiblesPlugin.ts` の `apply` = `buildInvisibleDecorations(newState.doc)` を参照）＝
> 自己修復するため reorder-meta は要らない。**map で DecorationSet を持ち越す Codex ハイライト
> だけが特別扱いを要する**（PR#207 が Codex のみ再構築し、TateChuYoko は段落移動と無改修で
> 共存しているのと同じ理由）。実装時は「自作の新プラグインが map 方式なら reorder-meta 対象」と
> いう基準で判定する。

### 6.6 attribution（帰属）の保持

`AuthorshipMark` は inline mark（node attr ではない）。§6.3 の「marks 込み Slice を運ぶ」
原則を守る限り、swap 後も `source`（human/ai/unknown）等の属性はテキストに付随して保たれる。
段落移動が Codex 装飾のみ再構築し attribution に触れていない（＝ swap で保たれる前提）のと同じ。

### 6.7 アニメ・縦書き・Reduced Motion

- カードD&D: カードはブロック的なので WAAPI FLIP（`ParagraphMoveExtension.ts:138-156`
  相当）をそのまま流用できる。
- キーボード swap: インライン FLIP は破綻するため **ハイライトフラッシュ**に置換。
- 定数は `CSS_DURATIONS.normal`（文字列 `"200ms"`、`parseFloat`→200）／`CSS_EASINGS`。
  べた書き禁止（`/polish-motion`）。
- `isReducedMotion()`（`src/lib/gsap.ts:4`）が真、または `view.dom.animate` 非対応なら
  アニメ無しで即最終状態。

---

## データ・永続化

- 並べ替えは **エディタ doc 内のテキスト移動のみ**。専用の DB スキーマ変更・新テーブルは不要。
- 保存は既存のシーン本文保存フロー（帰属 span 保存を含む）に乗る。並べ替え後の doc が
  通常の編集と同様に保存されるだけ。
- 推敲モードの「確定前カード状態」は **一時的なビュー状態**であり永続化しない
  （キャンセルで破棄、確定でのみ doc へ反映）。

---

## エラー処理・エッジケース

- **段落に単位が1つ以下** → 並べ替え不可（キーボード swap は素通し `false`、カードモードは
  分解しても意味が無い旨を表示 or トグル不可）。
- **端の単位で外側へ swap** → `false`（段落移動と同じく端では no-op）。
- **選択が単位境界を跨ぐ / 複数段落に跨る** → 対象外（段落移動の `planSwap` が
  複数ブロック跨ぎを弾く `ParagraphMoveExtension.ts:57` と同じ思想）。
- **ruby / mention atom を含む単位** → §6.4 の契約で atom を正しく数える。ruby は base 文字と
  同一 pos、mention はフラット非寄与。
- **文節分割が空を返す / Rust 側 Err** → 文粒度にフォールバックし、ユーザーに通知。
- **段落編集とキャッシュ不整合** → 段落が編集されたら文節キャッシュを破棄（§6.2）。
- **英語段落で文節粒度を要求** → 文節は日本語のみ。英語は文粒度のみ提供。

---

## 非文リスクと安全弁（設計の芯）

文節の並べ替えは、係り受けを保証しないため容易に非文を生む。これを**自動修正しない**代わりに：

1. **手動操作＋完全 undo** … ユーザーが文法の最終判断者。1手で元に戻せる。
2. **確定前プレビュー（カードモード）** … 書き戻し前に結果を目で見て確認・再調整できる。
3. **粒度フォールバック** … 文節が扱いにくければ文粒度へ即切替。

この3点で「壊れた日本語を生成する道具」化を防ぐ。自動助詞調整は将来の別機能（要係り受け解析）
として本設計のスコープ外に置く。

---

## テスト方針

- **文分割 parity**: TS 版 `sentenceSplit` ↔ Rust `split_sentences_ja` の境界一致（fixture 共有）。
  英語は `sentence_ranges_en` と一致。
- **文節分割 parity**: Rust `segment_bunsetsu` の fixture テスト（代表文でチャンク境界を固定）。
  形態素依存なので `cargo test --no-default-features`（CLAUDE.md の制約）で走らせる。
- **marks 保持**: swap 後に `authorship` の `source` が保持されることを assert
  （`api.saveAuthorshipSpans.test.ts` 周辺のパターン流用）。
- **Codex 装飾 reorder**: `CodexHighlightPlugin.reorder.test.ts` を段落内 swap へ拡張。
- **transaction 単体**: `reorderTransaction` の純関数テスト（範囲反転・キャレット位置・区切り規約）。
- **カードD&D の幾何**: happy-dom でロジックを gate。ドラッグ位置の実寸が絡む部分は
  `*.browser.test.tsx`（CLAUDE.md のレイアウト/幾何 invariant 方針に従う）。

---

## 実装の内部作業順（出荷は「文・文節／カード・キーボード」を一括）

出荷スコープは全部入りだが、各段が検証可能になるよう内部的には次の順で積む：

1. **F1 — 文粒度コア**: `sentenceSplit`（TS）＋ `reorderTransaction`（marks 込みスライス swap）
   ＋ キーボード swap（文粒度）＋ 帰属/Codex 装飾保持 ＋ 単体テスト。
2. **F2 — カードD&Dモード**: 推敲トグル UI ＋ 文カード分解 ＋ D&D ＋ FLIP ＋ 確定/キャンセル。
3. **F3 — 文節粒度**: `segment_bunsetsu`（Rust コマンド＋DTO Serialize）＋ 粒度スイッチを
   両操作に接続 ＋ parity テスト。

各段で `pnpm test` / `cargo test --no-default-features` / `npx tsc --noEmit` /
`cargo clippy --all-targets` を通す。レイアウトに触れたら `pnpm test:browser`。

---

## 未決事項・オープンな論点（§10）

1. **粒度切替キー** `Alt+Shift+G` は暫定。既存ショートカットと衝突しないか要確認
   （`grimodex-shortcut-mac-platform` の Mod/Control/Alt/Shift 完全一致規約）。
2. **フラットテキストのオフセット単位**（コードポイント vs UTF-16）を Rust↔TS で1つに固定する。
3. **推敲モードの UI 実装形態**: 段落をその場でカードに差し替える（インライン）か、
   ポップオーバー/オーバーレイで見せるか。インライン差し替えは schema 非対称の罠
   （`extensions.schemaParity.test.ts`）に注意。
4. **カードモードの粒度ネスト表示**: 文→文節を割り直す UX（フラット割り直し想定）で足りるか。
5. 文節の**接頭辞/接尾辞の付着方向**の細部（複合語・数詞＋助数詞など）は fixture で詰める。

---

## 参考ファイル

- `src/features/editor/ParagraphMoveExtension.ts` — 段落移動（swap transaction・キャレット・FLIP・縦書き）
- `src/features/editor/CodexHighlightPlugin.ts:132-160` — reorder 時の装飾再構築（拡張対象）
- `src/features/editor/CodexHighlightPlugin.reorder.test.ts` — 装飾 reorder テスト（拡張対象）
- `src/features/editor/codexDocFlatten.ts` — flat text ↔ PM position 契約
- `src/features/editor/extensions.ts` — schema/拡張登録（段落は既定 `inline*` を継承、sentence ノード無し。#296 で `TcyMark`/`AozoraInputRules`/`AutoPairBracketsExtension` を追加登録＝登録ブロックは 211 行付近へ移動）
- `src/features/attribution/AuthorshipMark.ts` — 帰属 inline mark（`inclusive:false`）
- `src-tauri/src/semantic/chunker.rs:166` — `split_sentences_ja`（TS 移植元）
- `src-tauri/crates/grimodex-lint/src/textscan/en.rs:169` — `sentence_ranges_en`（英語 TS 移植元）
- `src-tauri/crates/grimodex-lint/src/morph.rs` — `tokenize_block` / `MorphToken`（文節分割の入力）
- `src/lib/animation.ts:52-61` / `src/lib/gsap.ts:4` — アニメ定数・Reduced Motion ガード
