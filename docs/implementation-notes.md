# 実装補足資料

> 作成日: 2026-04-03
> **最終棚卸し: 2026-06-28**
> 対象: implementation-workflow.md のタスクのうち、設計書だけでは実装方針が不明確な項目

> ⚠️ **読む前に:** 本書の §1.1 / §4 は **2026-04 時点のスナップショット**から部分的に更新した。TipTap・レイアウト・Chronicle 等は大幅に進んでいる。**現行の正本**は各 `Grimodex_*` 設計書、`SPEC.md`（0.9.0）、[`CONTEXT_INJECTION.md`](CONTEXT_INJECTION.md)。本書は **未解消ギャップ（deferred 項目）** の参照用に残す。

本文書は、横断的タスク・TipTap拡張・クリップボードMIMEについて
**現状のコード** と **設計書の仕様** のギャップを明示し、
実装時の判断材料を提供する。

---

## 1. TipTap 拡張: 現状 vs 設計書

### 1.1 現状のエディタ構成（2026-06-28 更新）

**`src/features/editor/extensions.ts`**（エントリポイント）の主要構成:

- **StarterKit**（Underline / Link 含む）+ **ParagraphWithEmptyLineSupport** + **Markdown**
- **Placeholder**, **CharacterCount**, **Typography**（設定連動）
- **Table** 系、**ToolbarShortcutsExtension**
- **カスタム Mark/Node:** AuthorshipMark, EmphasisDotsMark, RubyNode, SceneBreakNode, SceneBeatNode, GeneratedProseBlockNode, CommentMark, LintDisableMark, ForeshadowSetup/PayoffMark, AnnotationMark
- **拡張機能:** FindReplace, ParagraphMove, InlineAtomNavigation, SlashCommand, Codex @mention（条件付き）
- **ProseMirror Plugin 経由:** Lint デコレーション、Comment デコレーション、Annotation

**動的プラグイン**（React hooks 経由で `editor.registerPlugin()`）:
- `CodexHighlightPlugin`, `AttributionPlugin`, `AiEditedPlugin`, `InsertHighlight`, `FocusModePlugin`

**Toolbar**（`src/features/editor/Toolbar.tsx`）:
- 書式・見出し・リスト・小説用（Ruby 等）・右寄せトグル群。`extraSlots` で外部ボタン追加可能

> 以下 §1.2 以降の「設計書が要求する追加拡張」は、**2026-04 時点のギャップ一覧**。EmphasisDots / CommentMark / SceneBreak 等は **実装済み**。未解消項目のみ **deferred** として残す。

### 1.2 設計書が要求する追加拡張

#### A. 新規 Mark: EmphasisDots（傍点・圏点）— タスク C-2

```typescript
// src/features/editor/EmphasisDotsMark.ts
Mark.create({
  name: 'emphasisDots',
  // 属性なし（ON/OFF トグル）

  parseHTML() {
    return [{ tag: 'span.emphasis-dots' }];
  },
  renderHTML() {
    return ['span', { class: 'emphasis-dots' }, 0];
  },
  addKeyboardShortcuts() {
    return { 'Mod-.' : () => this.editor.commands.toggleMark(this.name) };
  },
})
```

**CSS**: `span.emphasis-dots { text-emphasis: filled sesame; text-emphasis-position: over right; }`

**Markdown 変換**（当初設計）:
- エクスポート: `《圏点:テキスト》` 形式に変換
- インポート: `《圏点:(.+?)》` パターンを検出して EmphasisDotsMark に変換
- `tiptap-markdown` のカスタム serializer/parser で対応

> （2026-06-20 追記・未実装）現状の `EmphasisDotsMark.ts` は `parseHTML()` /
> `renderHTML()` による HTML ラウンドトリップとキーボードショートカット（`Mod-.`）の
> みを定義しており、`addStorage()` による markdown serializer/parser は持たない。
> `《圏点:…》` 形式の Markdown 変換は **未実装（deferred）** であり、出力整形は
> exportEngine 側に委譲されている。Markdown ラウンドトリップが必要になった時点で
> `addStorage()` を追加する。

**テスト**:
> （2026-06-20 追記・未実装）`EmphasisDotsMark.test.ts` は未作成（deferred）。
> 作成する場合は以下を最低限カバーする:
> - マーク適用・解除の往復テスト
> - HTML parse/render の一致確認
> - （Markdown 変換を実装した場合）Markdown エクスポート・インポートの一致確認

#### B. 新規 Mark: CommentMark（インラインコメント）— タスク C-2

```typescript
// src/features/editor/CommentMark.ts
Mark.create({
  name: 'comment',
  inclusive: false,  // コメント範囲は自動拡張しない
  addAttributes() {
    return {
      text: { default: '' },          // コメント本文
      createdAt: { default: null },   // ISO 8601
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(
      { 'data-comment': HTMLAttributes.text, class: 'inline-comment' },
      HTMLAttributes
    ), 0];
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-m': () => /* コメント入力ダイアログを表示 */ };
  },
})
```

**CSS**: `span.inline-comment { text-decoration: wavy underline; text-decoration-color: #BA7517; }`

**UI**:
- ホバーでポップオーバー表示（コメント本文、編集、削除ボタン）
- コンポーネント: `CommentPopover.tsx`（既存の `CodexPopover.tsx` と同構造）

**Markdown 変換**: コメントは **エクスポートに含めない**（本文テキストではないため）

**テスト**:
> （2026-06-20 追記・未実装）`CommentMark.test.ts` は未作成（deferred）。
> 作成する場合は以下をカバーする:
> - 属性（text, createdAt）の保持確認
> - inclusive: false の動作確認（コメント末尾での入力が非コメントになること）

#### C. 新規 Node: SceneBreakNode — タスク C-2

```typescript
// src/features/editor/SceneBreakNode.ts
Node.create({
  name: 'sceneBreak',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div.scene-break' }];
  },
  renderHTML() {
    return ['div', { class: 'scene-break' }, '* * *'];
  },
})
```

**CSS**: `.scene-break { text-align: center; margin: 2em 0; color: var(--muted-foreground); }`

**Markdown 変換**: `\n* * *\n`（水平線として出力）

#### D. 追加すべき公式拡張

以下の公式拡張の多くは `StarterKit` に含まれます。明示的追加が必要なもの:

| パッケージ | 用途 | 設定 |
|-----------|------|------|
| `@tiptap/extension-link` | ハイパーリンク | `Ctrl+K` でダイアログ |
| `@tiptap/extension-placeholder` | 空エディタのプレースホルダー | `placeholder: 'ここに書き始める...'` |
| `@tiptap/extension-character-count` | 文字数カウント | `storage.characters()` でステータスバーに表示 |
| `@tiptap/extension-typography` | スマートクォート自動変換 | デフォルト設定 |

> （2026-06-20 追記）
> - **Underline**: `StarterKit` v3.22+ に含まれるため、明示 import 不要（`Ctrl+U` も既定で有効）。
> - **`@tiptap/extension-focus`**: 採用していない。フォーカスのディミングは自前の
>   `FocusModePlugin`（ProseMirror Plugin）で実装しており、`.has-focus` クラスや本拡張には依存しない。

**実装手順**:
1. `pnpm install` で各パッケージ追加
2. `extensions.ts` の配列に追加
3. Toolbar にボタン追加（Underline, Link）
4. 既存テストのリグレッション確認

#### E. 新規 ProseMirror Plugin: FocusMode — タスク C-2

> （2026-06-20 追記）実装はファイル名・識別子ともに **FocusMode** で命名済み
> （`@tiptap/extension-focus` の `.has-focus` クラスには依存せず、自前で現在ブロックを判定する）。
> デコレーション構築の主エクスポートは `buildFocusDimDecorations()` ユーティリティ関数で、
> `createFocusModePlugin(getFocusMode)` がそれを `state.apply` で呼び出す。

```typescript
// src/features/editor/FocusModePlugin.ts
// 現在のブロック以外に focus-dimmed クラス（opacity dim）を適用するデコレーション

function createFocusModePlugin(getFocusMode: () => boolean): Plugin {
  return new Plugin({
    key: focusModeKey,
    props: {
      decorations(state) {
        if (!getFocusMode()) return DecorationSet.empty;
        // buildFocusDimDecorations() が現在ブロック以外に
        // Decoration.node() で focus-dimmed クラスを適用
      },
    },
  });
}
```

**トグル**: Toolbar の「Focus」ボタンで ON/OFF。`editorStore` に状態保持。

#### F. 段落インデント — タスク C-2

段落インデントは **TipTap 拡張ではなく CSS のみ** で実装:

```css
/* Settings > Editor > Paragraph indent: ON の場合にクラス付与 */
.editor-canvas.paragraph-indent p {
  text-indent: 1em;
}
```

- ProseMirror JSON やマークには影響しない（表示のみ）
- Markdown エクスポートではインデントなし（出力先に委譲）
- Settings の `editor.paragraphIndent: boolean` で制御

### 1.3 extensions.ts の最終形（全拡張追加後）

```typescript
export function getEditorExtensions(): Extensions {
  return [
    StarterKit, // Underline（Ctrl+U）含む — 明示 import 不要
    Markdown.configure({ html: true }),
    // 公式拡張
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: 'ここに書き始める...' }),
    CharacterCount,
    Typography,
    // ※ @tiptap/extension-focus は不採用。FocusModePlugin を動的登録する。
    // カスタム Mark
    AuthorshipMark,
    EmphasisDotsMark,
    CommentMark,
    // カスタム Node
    RubyNode,
    SceneBreakNode,
  ];
}
// 動的プラグイン（React hooks 経由、変更なし）:
// CodexHighlightPlugin, AttributionPlugin, AiEditedPlugin,
// InsertHighlight, FocusModePlugin
```

### 1.4 Toolbar の最終形（全ボタン追加後）

設計書の 5 グループ構成:

```
[B] [I] [U] [S] [﹅] | [H1] [H2] [H3] | [•] [1.] [❝] [—] | [Ruby] [🔗] [***] | ... [Attr] [Cmt] [Focus] [TW] [⋮]
──── 書式 ────  ── 見出し ──  ── リスト/引用 ──  ─ 小説用 ─       ──── 右寄せトグル ──── ─ More ─
```

- 現在の `Toolbar.tsx` は `extraSlots` パターンを使っているが、グループ区切り（`|`）とボタン数の増加に対応するため、グループ配列ベースに改修が必要
- `ToolbarGroup` コンポーネントを導入し、各グループを `<div className="flex gap-1">` で区切る
- 右寄せトグル群は `ml-auto` で右端に配置

### 1.5 TipTap Mini（Chat 入力エリア）— タスク D-16

Chat パネルの入力エリアは、メインエディタとは別の **軽量 TipTap インスタンス**:

```typescript
// src/features/chat/ChatInput.tsx
function getChatInputExtensions(): Extensions {
  return [
    StarterKit.configure({
      // 見出し・画像・水平線は不要
      heading: false,
      horizontalRule: false,
      codeBlock: false,
    }),
    Markdown.configure({ html: false }),
    Placeholder.configure({ placeholder: 'Ask about this scene...' }),
    // CodexHighlight は共有（同じデコレーションシステム）
  ];
}
```

**メインエディタとの違い**:
| 項目 | メインエディタ | Chat TipTap Mini |
|------|-------------|-----------------|
| 見出し | H1-H3 | なし |
| 画像/水平線 | あり | なし |
| AuthorshipMark | あり | なし |
| CodexHighlight | あり | あり（同一ストア共有） |
| `@` メンション補完 | なし | あり（Codex エントリ検索） |
| 送信動作 | なし | Enter で送信 |
| 高さ | 固定 | 自動伸長（最大 5 行） |
| 出力形式 | ProseMirror JSON | Markdown 文字列（LLM 送信用） |

**キーマップ**:
- `Enter` → 送信（`editor.getHTML()` → Markdown変換 → 送信）
- `Shift+Enter` → 改行
- `Escape` → ストリーミング停止 / 入力クリア
- `↑`（空入力時）→ 前回メッセージ復元

**`@` メンション補完**:
- `@` 入力で Codex エントリ検索ポップアップ表示
- `context_mode = 'hidden'` のエントリは候補から除外
- 選択するとエントリ名をテキストとして挿入し、自動ピンに追加
- TipTap の `@tiptap/suggestion` 拡張 + カスタムレンダラーで実装

---

## 2. クリップボード帰属 MIME

### 2.1 現状の実装

**`src/lib/clipboardAttribution.ts`** は HTML の `data-*` 属性を利用:
- コピー時: `<span data-grimodex-source="ai">テキスト</span>` を `text/html` に格納
- ペースト時: HTML をパースして `data-grimodex-source` / `data-authorship` 属性を検出

**問題点**:
- `text/html` のみに依存 → 外部アプリが HTML を加工するとメタデータ消失
- 単一ソースのコピーのみ対応 → 複数ソースが混在するエディタコピーでは `data-authorship` 属性にフォールバック
- 設計書が要求する専用 MIME タイプ `application/x-grimodex-authorship` が未実装

### 2.2 設計書の要求

**MIME タイプ**: `application/x-grimodex-authorship`

クリップボードに **3 つの MIME タイプ** を同時に設定:

| MIME | 内容 | 用途 |
|------|------|------|
| `text/plain` | プレーンテキスト | 外部アプリ貼り付け |
| `text/html` | 書式付き HTML | リッチテキスト貼り付け |
| `application/x-grimodex-authorship` | 帰属メタデータ JSON | Grimodex 内部の帰属保持 |

### 2.3 カスタム MIME の JSON フォーマット

```typescript
interface ClipboardAuthorship {
  version: 1;
  segments: Array<{
    text: string;
    length: number;
    source: 'human' | 'ai' | 'unknown';
    model?: string;          // AI の場合のみ
    chatMessageId?: string;  // チャット抽出の場合のみ
    timestamp?: string;      // ISO 8601
  }>;
}
```

**例: 混在テキストのコピー**
```json
{
  "version": 1,
  "segments": [
    { "text": "太郎は", "length": 3, "source": "human" },
    { "text": "静かに微笑んだ。", "length": 8, "source": "ai", "model": "anthropic/claude-sonnet-4-6" },
    { "text": "その目には", "length": 5, "source": "human" }
  ]
}
```

### 2.4 コピー元ごとの動作

| コピー元 | segments の source | 備考 |
|---------|-------------------|------|
| エディタ本文（選択範囲） | AuthorshipMark から継承 | 混在あり |
| Chat AI メッセージ | `ai` + model + chatMessageId | 単一 source |
| Chat ユーザーメッセージ | `human` | 単一 source |
| Codex/Snippet パネル | 元の source を継承 | 単一 source が多い |
| 外部アプリから貼り付け | — | MIME なし → `unknown` にフォールバック |

### 2.5 実装変更方針

**`clipboardAttribution.ts` の改修**:

> （2026-06-20 追記）現状の実装は **copy（書き込み）と paste（解析）で型が非対称**:
> - **copy**: `copyWithAttribution(text: string, source: AuthorshipSource)` は単一の
>   text/source ペアを受け取る。Chat AI メッセージのコピーは別関数
>   `copyChatMessageWithAttribution(text, messageId, model?)` が担い、こちらは
>   `web application/x-grimodex-authorship` MIME（"web " prefix 付き、Chrome 101+）も
>   試行し、未対応環境では HTML / plain text へフォールバックする。
> - **paste**: `parseClipboardHtml(html)` が `AttributedSegment[]` 配列を返す（解析側のみ
>   セグメント配列を扱う）。混在ソースの本文コピーは HTML の `data-authorship` / `data-pm-slice`
>   から復元する。
> 以下のコード例は「単一ソースの copy」と「配列を返す paste」を分離して示す。

```typescript
// 1. copyWithAttribution() — 単一の text/source ペアを受け取る（現在の実装と一致）
export async function copyWithAttribution(
  text: string,
  source: AuthorshipSource,
): Promise<void> {
  const html = `<span data-grimodex-source="${source}">${escapeHtml(text)}</span>`;
  const item = new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  });
  await navigator.clipboard.write([item]);
}

// 2. parseClipboardHtml() — ペースト時に AttributedSegment[] 配列を返す（解析用）
//    data-grimodex-source（Codex/Snippet/Chat コピー）または
//    data-authorship / data-pm-slice（エディタ本文コピー）から復元する。
export function parseClipboardHtml(
  html: string | undefined,
): AttributedSegment[] | null {
  // ...HTML をパースして混在セグメントを抽出...
  return null;
}
```

**互換性 / 今後の拡張**:
- `text/html` の `data-grimodex-source` を一次経路とし、`data-authorship` をフォールバックに残す
- 複数ソース混在のコピーが必要になった場合は、`copyWithAttribution()` のシグネチャ拡張
  （配列受け取り）か、呼び出し側での複数回呼び出しを検討する
- カスタム MIME `application/x-grimodex-authorship` は現状 Chat メッセージコピー
  （`copyChatMessageWithAttribution`）でのみ "web " prefix 付きで試行している
- 外部からのペーストは従来通り HTML フォールバック → `null` → `unknown`

**SceneEditor.tsx の handlePaste 改修**:
- `event.clipboardData` から `application/x-grimodex-authorship` を先にチェック
- 存在すれば JSON パースして `insertFromPaste()` に渡す
- なければ既存の `parseClipboardHtml()` にフォールバック

---

## 3. 横断タスク: storySoFar（D-7）

### 3.1 データフロー全体図

```
[Scenes パネル]                    [Chat パネル]
  Synopsis フィールド                 コンテキスト構築
  (tree_nodes.synopsis)              (Layer 2: storySoFar)
         │                                  ▲
         ▼                                  │
  DB: tree_nodes テーブル ─────────────► buildStorySoFar()
         │                                  │
         ▼                                  ▼
  storySoFar カバレッジ計算           システムプロンプトに注入
  (< 50% で警告ピル)                 (古い synopsis から切り詰め)
         │
         ▼
  [Chat コンテキストバー]
  [⚠ storySoFar: 3/12 scenes] ピル
```

### 3.2 実装ステップ

**Phase B（Scenes パネル側）**:

1. **B-7: Synopsis フィールド UI**
   - `tree_nodes.synopsis` カラムは DB スキーマに定義済み
   - Scenes パネル下部に `<textarea>` 追加（Codex Quick セクションの上）
   - プレーンテキストのみ（TipTap 不使用）
   - `treeStore` に `updateSynopsis(nodeId, text)` アクション追加
   - デバウンス 1 秒で DB 保存

2. **B-8: AI Synopsis 生成**
   - ✦ Generate ボタン → `send_chat_message` に Synopsis 生成用プロンプト送信
   - **前提**: AI 設定（プロバイダー・API キー・サマリー用モデル）が設定済みであること
   - モデル: Settings の `ai.summaryModel`（安価なモデル。未設定時は `ai.defaultChatModel` にフォールバック）
   - **effort**: `low`（1-3文の要約に深い推論は不要）
   - **thinking display**: `"omitted"`（UI に思考を表示する必要なし、TTFT 短縮）
   - プロンプト例: `"以下のシーンの内容を1-3文で要約してください:\n\n{sceneText}"`
   - 既存 synopsis がある場合: 上書き確認ダイアログ（Replace / Cancel）
   - 生成中: ボタンをスピナーに変更、キャンセル可能

3. **B-10: storySoFar カバレッジ**
   - `treeStore` にセレクタ追加:
     ```typescript
     selectStorySoFarCoverage(currentNodeId: string): {
       total: number;     // 現在シーンより前のシーン数
       filled: number;    // synopsis 記入済みシーン数
       ratio: number;     // filled / total
     }
     ```
   - ツリーの sort_order で「現在シーンより前」を判定
   - 計算結果を Chat パネルのコンテキストバーに表示

**Phase D（Chat パネル側）**:

4. **D-7: Layer 2 コンテキスト注入**
   - 既存のコンテキスト構築ロジック（`src/features/chat/` 内）に Layer 2 を追加
   - 実装関数:
     ```typescript
     async function buildStorySoFar(
       projectId: string,
       currentNodeId: string,
       budgetTokens: number,  // コンテキスト全体の ~10%
     ): Promise<string | null> {
       // 1. 現在シーンより前の全シーンを sort_order 順で取得
       // 2. synopsis が空のシーンをスキップ
       // 3. 全 synopsis が空なら null を返す（Layer 2 省略）
       // 4. 直近のシーンを優先し、古い synopsis から切り詰め
       // 5. フォーマット: "## これまでの物語\n\nCh1 Scene1: {synopsis}\nCh1 Scene2: {synopsis}\n..."
     }
     ```
   - トークン計算: `js-tiktoken` で各 synopsis のトークン数を加算
   - 切り詰め: 予算超過時は配列先頭（最も古いシーン）から削除

5. **コンテキストバー表示**
   - カバレッジ < 50% の場合: `[⚠ storySoFar: 3/12 scenes]` 警告ピル
   - ピルクリックでポップオーバー:
     - 「12 scenes before current position, but only 3 have synopses.」
     - 「AI will have limited story context. Generate missing synopses?」
     - [Generate all] ボタン → バッチ Synopsis 生成（プログレスバー）
   - カバレッジ = 100% の場合: 警告ピルなし

---

## 4. 横断タスク: Left Dock 移行（A-3）

> **注（2026-06-28）:** 本節は **2026-04 時点の移行前** の構造メモ。**IntelliJ 式レイアウト（`layoutStore` / RegionStripe / center-bottom Chronicle 等）は移行完了**。現行の正本は [`Grimodex_レイアウトシステム置換設計書.md`](Grimodex_レイアウトシステム置換設計書.md)。以下は履歴参照用。

### 4.1 現状のレイアウト構造（移行前・履歴）

```
App.tsx
└── ResizablePanelGroup (horizontal)
    ├── ResizablePanel (Sidebar: Scenes 固定)
    ├── ResizableHandle
    ├── ResizablePanel (Editor)
    ├── ResizableHandle
    └── ResizablePanel (RightPanel: Chat/Codex/Snippets/Attribution タブ)
```

### 4.2 設計書の目標構造

```
App.tsx
└── VStack
    ├── Header ([メニュー] [タイトル] ... [パネル▼] [⚙])
    └── HStack
    ├── LeftDock (リサイズ可能、初期 200px)
    │   └── TabGroup: [Scenes | Codex | ChatHistory]
    ├── CenterArea
    │   ├── EditorGroups (上部、メイン)
    │   └── BottomDock (リサイズ可能)
    │       └── TabGroup: [Snippets | Attribution]
    ├── RightDock (リサイズ可能)
    │   └── TabGroup: [Chat]
    └── StatusBar (最下部、フルwidth)
```

### 4.3 移行戦略

**既存コードの活用**:
- `ResizablePanelGroup` は引き続き使用（リサイズ機能はそのまま）
- 既存の各パネルコンポーネント（Sidebar, ChatPanel, CodexPanel 等）は **中身を変更せず**、配置場所のみ変更

**段階的移行**:

1. **layoutStore 作成**（A-1）
   ```typescript
   interface PanelState {
     status: 'closed' | 'docked' | 'collapsed';
     dockZone: 'left' | 'right' | 'bottom' | null;
     tabOrder: number;
   }

   interface LayoutState {
     panels: Record<PanelId, PanelState>;
     activeTab: Record<DockZone, PanelId | null>;
     // アクション
     togglePanel(id: PanelId): void;
     activateTab(zone: DockZone, id: PanelId): void;
     collapseZone(zone: DockZone): void;
   }
   ```

2. **PanelToggleDropdown 作成**（A-2）
   - 新規コンポーネント: `src/features/layout/PanelToggleDropdown.tsx`
   - ヘッダー右側のマルチセレクトドロップダウン
   - チェックボックス + パネル名 + ショートカット表示
   - クリックで `layoutStore.togglePanel()` 呼び出し
   - ホバー時に対象領域をハイライト（`PanelHighlightOverlay.tsx`）

3. **DockZone 汎用コンポーネント作成**（A-3 〜 A-5）
   ```typescript
   // src/features/layout/DockZone.tsx
   interface DockZoneProps {
     zone: 'left' | 'right' | 'bottom';
     panels: Array<{ id: PanelId; label: string; component: ReactNode }>;
   }
   ```
   - タブバー + アクティブパネル表示
   - 折りたたみボタン
   - `layoutStore` の状態に基づいてレンダリング

4. **App.tsx 改修**
   - 既存の `ResizablePanelGroup` を新レイアウトに置き換え
   - 各パネルコンポーネントを `DockZone` の children に移動
   - `Sidebar.tsx` → `LeftDock` 内の Scenes タブに（コンポーネント自体は変更なし）
   - `RightPanel` の既存タブ → Chat は RightDock に、Codex は LeftDock に、Snippets/Attribution は BottomDock に分散

**注意点**:
- Floating 状態は Post-MVP（実装しない）
- D&D によるパネル移動も Post-MVP
- 状態は 3 値（closed/docked/collapsed）で十分

---

## 5. 横断タスク: Diff 表示（F-6）

### 5.1 技術選定

**ライブラリ**: `diff-match-patch`（Google 製、MIT ライセンス）
- `pnpm add diff-match-patch @types/diff-match-patch`
- 軽量（~50KB）、純テキスト diff に特化

### 5.2 データフロー

```
リビジョン A (ProseMirror JSON)    リビジョン B (ProseMirror JSON)
         │                                  │
         ▼                                  ▼
  Node.fromJSON(schema, A)          Node.fromJSON(schema, B)
         │                                  │
         ▼                                  ▼
  node.textContent                   node.textContent
  (プレーンテキスト)                 (プレーンテキスト)
         │                                  │
         └──────────┬───────────────────────┘
                    ▼
          diff_match_patch.diff_main(textA, textB)
                    │
                    ▼
          diff_match_patch.diff_cleanupSemantic(diffs)
                    │
                    ▼
          diffs → TipTap Decorations に変換
          (追加=緑背景、削除=赤取消線)
                    │
                    ▼
          読み取り専用 TipTap インスタンスに適用
```

### 5.3 実装: 目的別に分散された diff 関数

> （2026-06-20 追記）Diff 機能は **統一モジュール（`src/features/revision/diffUtils.ts`）として
> 実装されていない**。実際には用途に応じて **2 つの機能モジュール** に分かれている:
>
> **1. `src/features/snippets/snippetDiff.ts`**（属性追跡用）
> - `computeAttributedSegments(originalContent, currentContent)` — AI 原文との diff から、
>   各テキストセグメントを `'ai'`（EQUAL）または `'human'`（INSERT）として分類（DELETE はスキップ）
> - Snippet テキスト編集の帰属管理に使用
> - テスト: `snippetDiff.test.ts`
>
> **2. `src/features/timelapse/bodyDiff.ts`**（タイムラプス表示用）
> - `computeBodyDiff(before, after)` / `computeDocDiff(beforeJson, afterJson)` —
>   ProseMirror JSON またはプレーンテキストの差分を compact フォーマットで返す
> - Codex/Snippet/Map 本文の変更履歴を payload サイズに最適化
>   （`EQ_CONTEXT=24` 字に切り詰め、`MAX_TOTAL_CHARS=8000` 字で truncate）して記録
> - テスト: `bodyDiff.test.ts`
>
> 両者とも `diff-match-patch` を使用し、`diff_main()` + `diff_cleanupSemantic()` で生成する。
> 以下の `computeDiff` / `diffsToDecorations` は、リビジョン比較ビュー（読み取り専用 TipTap への
> デコレーション適用）を実装する際の **当初設計の参考コード** として残す。

```typescript
// 当初設計（リビジョン diff デコレーションの参考）
import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

export function computeDiff(
  oldJson: string,  // ProseMirror JSON string
  newJson: string,
  schema: Schema,
): Diff[] {
  const oldNode = Node.fromJSON(schema, JSON.parse(oldJson));
  const newNode = Node.fromJSON(schema, JSON.parse(newJson));
  const oldText = oldNode.textContent;
  const newText = newNode.textContent;

  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

export function diffsToDecorations(
  diffs: Diff[],
  doc: ProseMirrorNode,
): DecorationSet {
  const decorations: Decoration[] = [];
  let pos = 0;  // テキスト内オフセット

  for (const [op, text] of diffs) {
    const length = text.length;
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      pos += length;
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      // 追加: 緑背景
      const from = textOffsetToDocPos(doc, pos);
      const to = textOffsetToDocPos(doc, pos + length);
      decorations.push(Decoration.inline(from, to, {
        class: 'diff-added',  // background: rgba(0, 180, 0, 0.2)
      }));
      pos += length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      // 削除: テキスト内に存在しないため Widget で挿入
      const docPos = textOffsetToDocPos(doc, pos);
      decorations.push(Decoration.widget(docPos, () => {
        const span = document.createElement('span');
        span.className = 'diff-deleted';  // red strikethrough
        span.textContent = text;
        return span;
      }));
      // pos は進めない（削除テキストは新ドキュメントに存在しない）
    }
  }
  return DecorationSet.create(doc, decorations);
}
```

**CSS**:
```css
.diff-added { background: rgba(0, 180, 0, 0.2); }
.diff-deleted {
  background: rgba(255, 0, 0, 0.2);
  text-decoration: line-through;
  color: var(--muted-foreground);
}
```

### 5.4 制約と注意点

- **テキストレベル diff のみ** — 書式変更（太字追加等）は検出しない
- `textContent` はブロック間の改行を含まない場合がある → `textBetween()` で改行を明示的に挿入
- 「Current version」選択時: 現在の `content` と最新リビジョンの diff を表示（未保存変更の可視化）
- 「Show changes」OFF: デコレーションなしの通常プレビュー
- **textOffsetToDocPos**: ProseMirror のドキュメント位置はテキストオフセットと一致しない（ノード境界分のオフセットがある）。`doc.descendants()` で各テキストノードの開始位置を記録し、テキストオフセットからドキュメント位置へのマッピングテーブルを構築する必要がある

### 5.5 テスト戦略

```typescript
// 当初設計（リビジョン diff ビュー）の参考テスト
// ※ 現状の実装テストは snippetDiff.test.ts / bodyDiff.test.ts を参照
describe('computeDiff', () => {
  it('同一テキスト → diff なし');
  it('末尾追加 → DIFF_INSERT のみ');
  it('部分削除 → DIFF_DELETE のみ');
  it('置換 → DELETE + INSERT');
  it('空ドキュメント同士 → diff なし');
});

describe('diffsToDecorations', () => {
  it('追加部分に diff-added クラス');
  it('削除部分に Widget デコレーション');
  it('複数ブロックにまたがる diff');
  it('テキストオフセット → ドキュメント位置の正確なマッピング');
});
```

---

## 6. ファイル配置ガイド

新規ファイルの配置先:

| ファイル | パス | タスク |
|---------|------|--------|
| EmphasisDotsMark.ts | `src/features/editor/` | C-2 |
| CommentMark.ts | `src/features/editor/` | C-2 |
| CommentPopover.tsx | `src/features/editor/` | C-2 |
| SceneBreakNode.ts | `src/features/editor/` | C-2 |
| FocusModePlugin.ts | `src/features/editor/` | C-2 |
| ChatInput.tsx | `src/features/chat/` | D-16 |
| PanelToggleDropdown.tsx | `src/features/layout/` | A-2 |
| PanelHighlightOverlay.tsx | `src/features/layout/` | A-2 |
| panelRegions.ts | `src/features/layout/` | A-2 |
| DockZone.tsx | `src/features/layout/` | A-3 |
| layoutStore.ts | `src/features/layout/` | A-1 |
| snippetDiff.ts | `src/features/snippets/` | F-6 |
| snippetDiff.test.ts | `src/features/snippets/` | F-6 |
| bodyDiff.ts | `src/features/timelapse/` | F-6 |
| bodyDiff.test.ts | `src/features/timelapse/` | F-6 |
| RevisionHistoryModal.tsx | `src/features/revision/` | F-5 |
| revisionHistoryStore.ts | `src/features/revision/` | F-2 |
