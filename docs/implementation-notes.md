# 実装補足資料

> 作成日: 2026-04-03
> 対象: implementation-workflow.md のタスクのうち、設計書だけでは実装方針が不明確な項目

本文書は、横断的タスク・TipTap拡張・クリップボードMIMEについて
**現状のコード** と **設計書の仕様** のギャップを明示し、
実装時の判断材料を提供する。

---

## 1. TipTap 拡張: 現状 vs 設計書

### 1.1 現状のエディタ構成

**`src/features/editor/extensions.ts`**（エントリポイント）:
```typescript
// 現在: 4 extension のみ
[StarterKit, Markdown.configure({ html: true }), AuthorshipMark, RubyNode]
```

**動的プラグイン**（React hooks 経由で `editor.registerPlugin()`）:
- `CodexHighlightPlugin` — Codex エントリ名のデコレーション
- `AttributionPlugin` — 帰属ソースの色分けデコレーション
- `AiEditedPlugin` — AI テキスト内のユーザー編集でマーク分割
- `InsertHighlight` — 挿入直後の一時ハイライト

**Toolbar**（`src/features/editor/Toolbar.tsx`）:
- 現在 4 ボタンのみ: Bold, Italic, Heading(H2), BulletList
- `extraSlots` プロップで外部ボタン追加可能（cursor, attribution トグル等）

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

**Markdown 変換**:
- エクスポート: `《圏点:テキスト》` 形式に変換
- インポート: `《圏点:(.+?)》` パターンを検出して EmphasisDotsMark に変換
- `tiptap-markdown` のカスタム serializer/parser で対応

**テスト**: `EmphasisDotsMark.test.ts`
- マーク適用・解除の往復テスト
- HTML parse/render の一致確認
- Markdown エクスポート・インポートの一致確認

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

**テスト**: `CommentMark.test.ts`
- 属性（text, createdAt）の保持確認
- inclusive: false の動作確認（コメント末尾での入力が非コメントになること）

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

現在 `StarterKit` のみだが、設計書は以下の公式拡張を要求:

| パッケージ | 用途 | 設定 |
|-----------|------|------|
| `@tiptap/extension-underline` | 下線マーク | `Ctrl+U` |
| `@tiptap/extension-link` | ハイパーリンク | `Ctrl+K` でダイアログ |
| `@tiptap/extension-placeholder` | 空エディタのプレースホルダー | `placeholder: 'ここに書き始める...'` |
| `@tiptap/extension-character-count` | 文字数カウント | `storage.characters()` でステータスバーに表示 |
| `@tiptap/extension-typography` | スマートクォート自動変換 | デフォルト設定 |
| `@tiptap/extension-focus` | フォーカスクラス付与 | FocusDim デコレーションの前提 |

**実装手順**:
1. `npm install` で各パッケージ追加
2. `extensions.ts` の配列に追加
3. Toolbar にボタン追加（Underline, Link）
4. 既存テストのリグレッション確認

#### E. 新規 ProseMirror Plugin: FocusDim — タスク C-2

```typescript
// src/features/editor/FocusDimPlugin.ts
// Focus 拡張が付与する `.has-focus` クラスを利用
// 現在の段落以外に opacity: 0.3 を適用するデコレーション

function createFocusDimPlugin(): Plugin {
  return new Plugin({
    key: focusDimKey,
    props: {
      decorations(state) {
        if (!enabled) return DecorationSet.empty;
        const focusPos = state.selection.$head.start(1); // ブロックレベル
        // focusPos のブロック以外に Decoration.node() で opacity 適用
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
    StarterKit,
    Markdown.configure({ html: true }),
    // 公式拡張
    Underline,
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: 'ここに書き始める...' }),
    CharacterCount,
    Typography,
    Focus.configure({ className: 'has-focus', mode: 'deepest' }),
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
// InsertHighlight, FocusDimPlugin
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

```typescript
// 1. copyWithAttribution() を拡張
export async function copyWithAttribution(
  segments: AttributedSegment[],  // 単一→配列に変更
): Promise<void> {
  const plainText = segments.map(s => s.text).join('');
  const html = segments.map(s =>
    `<span data-grimodex-source="${s.source}">${escapeHtml(s.text)}</span>`
  ).join('');
  const authorship: ClipboardAuthorship = {
    version: 1,
    segments: segments.map(s => ({
      text: s.text,
      length: s.text.length,
      source: s.source,
      ...(s.model && { model: s.model }),
      ...(s.chatMessageId && { chatMessageId: s.chatMessageId }),
    })),
  };

  const item = new ClipboardItem({
    'text/plain': new Blob([plainText], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
    'application/x-grimodex-authorship': new Blob(
      [JSON.stringify(authorship)],
      { type: 'application/x-grimodex-authorship' }
    ),
  });
  await navigator.clipboard.write([item]);
}

// 2. parseClipboard() で MIME を優先チェック
export async function parseClipboard(): Promise<AttributedSegment[] | null> {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    // 優先: カスタム MIME
    if (item.types.includes('application/x-grimodex-authorship')) {
      const blob = await item.getType('application/x-grimodex-authorship');
      const json: ClipboardAuthorship = JSON.parse(await blob.text());
      return json.segments;
    }
  }
  // フォールバック: 既存の HTML パース
  // ...existing parseClipboardHtml() logic...
  return null;
}
```

**互換性**:
- カスタム MIME は Grimodex 内部のコピペでのみ使用
- `text/html` の `data-grimodex-source` は **フォールバックとして残す**（MIME 非対応環境への保険）
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

### 4.1 現状のレイアウト構造

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
- `npm install diff-match-patch @types/diff-match-patch`
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

### 5.3 実装の要点

```typescript
// src/features/revision/diffUtils.ts
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
// src/features/revision/diffUtils.test.ts
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
| EmphasisDotsMark.test.ts | `src/features/editor/` | C-2 |
| CommentMark.ts | `src/features/editor/` | C-2 |
| CommentMark.test.ts | `src/features/editor/` | C-2 |
| CommentPopover.tsx | `src/features/editor/` | C-2 |
| SceneBreakNode.ts | `src/features/editor/` | C-2 |
| SceneBreakNode.test.ts | `src/features/editor/` | C-2 |
| FocusDimPlugin.ts | `src/features/editor/` | C-2 |
| ChatInput.tsx | `src/features/chat/` | D-16 |
| PanelToggleDropdown.tsx | `src/features/layout/` | A-2 |
| PanelHighlightOverlay.tsx | `src/features/layout/` | A-2 |
| panelRegions.ts | `src/features/layout/` | A-2 |
| DockZone.tsx | `src/features/layout/` | A-3 |
| layoutStore.ts | `src/features/layout/` | A-1 |
| diffUtils.ts | `src/features/revision/` | F-6 |
| diffUtils.test.ts | `src/features/revision/` | F-6 |
| RevisionHistoryModal.tsx | `src/features/revision/` | F-5 |
| revisionHistoryStore.ts | `src/features/revision/` | F-2 |
