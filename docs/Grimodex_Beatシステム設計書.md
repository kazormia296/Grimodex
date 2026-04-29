# Grimodex Beatシステム設計書

## 概要

Beatシステムは、シーン内の構造単位「ビート」を扱う Editor 拡張機能。各 Beat は AI 生成の局所プロンプトであり、同時に著者の構成意図の保存先でもある。Codex / Snippet / 伏線レジスタと並ぶ「外部化された執筆メモリ」のひとつだが、専用パネルを持たず Editor パネル内に内包される点が異なる。

Beat は **Unplaced（未配置） / Placed（配置済み）** の二状態モデルを取る。Unplaced beat は Editor 上部の Beats セクションに一覧表示され、本文中の位置を持たない。本文に D&D で配置されると Placed beat になり、TipTap ノードとして本文中に存在する。Placed beat は `Generate` で約500ワードの prose を直後に生成し、生成後も Beat ノード自体は本文中に残る（折りたたみ可、Export 時除去）。

設計の起点は Novelcrafter の Inline Beat に近いが、純粋な Inline Only ではプロッタ派（先に全体を計画してから書く派）を排除してしまうため、Unplaced セクションを並列に置いた**ハイブリッド構成**にしている。Grimodex は Timeline / Map / Codex / 伏線レジスタなど計画的な執筆を支援する設計を持っており、Unplaced beat はその計画フェーズの自然な拡張点になる。

---

## 目標 / 非目標

### 目標

- 著者の構成意図（「ここで何を書こうとしていたか」）を執筆中・推敲中いずれの段階でも保存できる
- AI 生成を「位置を持つ局所プロンプト」として表現する一級市民にする
- Beat の生成結果を可逆に管理する（生成 prose を消しても Beat は残る・再生成可）
- プロッタ派（Unplaced 起点）とパンツァー派（Inline 起点）の両方を吸収する
- Matrix ビューからのプロッティング起点（セル右クリック → Beat 追加）を提供する
- 既存のチャットコンテキスト構築機構（L1〜L5）と Attribution / Codex メンションを再利用する

### 非目標

- Beat ブロックを Markdown export に保持すること（剥がす）
- Beat の AI 自動抽出を一次フローとして提供すること（v2 で「Extract beats from this scene」として補助実装）
- Book/Act 全体の summary 機能（AI による結末 foreshadow を防ぐため意図的に持たない、Codex `lore` + `context_mode = hidden` で代替）
- Subplot 専用テーブルや Codex 専用タイプの追加（既存の `lore` タイプ + タグ運用で実装）

---

## 背景・設計判断

### Unplaced / Placed の二状態モデル

Beat は2つの状態を持つ。

- **Unplaced beat**: シーンに属するが、本文中の位置を持たない。プロッティング段階で書く。Editor 上部の Beats セクションに一覧表示される。
- **Placed beat**: 本文中の TipTap ノードとして存在する。執筆段階で配置・生成される。

状態遷移は D&D で行う。Unplaced beat を本文中にドラッグすると Placed に遷移し、Placed beat の `[⋮]` メニュー → 「Unplace」または Beats セクションへのドラッグで Unplaced に戻る。

理由：

- 純粋な Inline Only では「本文を一文も書かないと Beat も書けない」状態になり、プロッタ派が使えない
- 専用パネル（Fabula 風の Beat Plan）にすると Editor から離れすぎる
- 二状態にすることで、プロッタ派とパンツァー派の両方を同じ仕組みで吸収できる
- データモデルは TipTap ドキュメント内のコンテナノードで表現できるため、専用テーブル不要

### Beat は生成後も残す

生成された prose の直後に Beat ノードが消えるのではなく、Beat が残り続ける（折りたたみ可、Export 時自動除去）。

メリット：

- **可逆性**: 生成結果が気に入らなければ prose を消して再生成できる
- **意図の保存**: 「ここで何を書こうとしていたか」が後から見て分かる
- **推敲時の補助**: beat = 著者の意図、prose = 実際の文章、のズレを検出できる

これは Novelcrafter とは別の挙動（Novelcrafter の挙動は不明だが、Grimodex は明示的にこの方針を採る）。

### Placed beat は TipTap ノード、Unplaced beat は別カラム

Beat の保存先は状態によって分ける：

- **Placed beat**: 本文 TipTap ドキュメント (`tree_nodes.content`) 内の `sceneBeat` カスタムノード。位置を持つことが本質なので PM ドキュメント内に存在する必然がある
- **Unplaced beat**: 別カラム `tree_nodes.unplaced_beats_doc` に **ProseMirror JSON 配列**として保存。位置を持たない一覧データを PM ノードで表現する旨味は薄く、本文 EditorView の DOM ツリー外（Synopsis 隣の Beats セクション）にレンダリングする UI 要件に素直に合うため

理由：

- 本文と Unplaced は **同じシーンに属する別データ**。同じ `tree_nodes` 行内のカラムとして保存単位は一致するため、シーン保存・ロードはこれまで通り単一トランザクションで完結する
- 「ドキュメント内に存在するが Editor キャンバスからは描画除外」を ProseMirror で実現すると NodeView と React の reactivity が二重化し、selection / D&D / Undo の挙動が複雑化する。カラム分離により Unplaced セクションは **独立した小さい TipTap editor**（または React の textarea ベース）として素直に書ける
- Codex メンション拡張は「TipTap Extension オブジェクト」レベルで共有可能（editor instance の数は無関係）。Chat input、SceneEditor、Unplaced beat editor の3か所で同じ拡張を再利用する
- 既存の Attribution / Codex メンションは **Placed beat および本文** の側で従来通り動作する。Unplaced 側は性質上 Attribution の対象にしない（人間の構成意図のみが入るため）

D&D による状態遷移は、フロント側で

1. Unplaced 配列から該当要素を pop
2. 本文 EditorView に対応する `sceneBeat` を insert する PM transaction を発行
3. 両者を1つの保存リクエストにまとめてバックエンドに送る

の3ステップ。Undo は v1 では「本文側の PM history」と「Unplaced 側のアプリレベル history」が別管理になり、状態遷移直後の `Ctrl+Z` で同時には戻せない。これは v1 の制限として明示する。

生成統計（プロンプトトークン数、モデル名等）を取りたい場合のみ、将来的に `scene_beats` テーブルを別途追加する余地を残す（v1 では実装しない）。

### Subplot は Codex `lore` タイプを流用

Subplot 専用タイプは追加せず、既存の `lore` タイプ + `#subplot` タグで運用する。

理由：

- Codex タイプを増やすとマイグレーション・UI（タイプアイコン、フィルタ）・AI への型情報伝達など影響範囲が広い
- subplot は本質的に「物語上の概念」であり、`lore`（世界観・概念・設定）の一種と見なせる
- Codex リレーション・フェーズシステムをそのまま活用できる（subplotの進行段階をフェーズで表現）
- タグでフィルタすれば Matrix の Subplot モードで列に表示できる

タグ名は Settings で `subplotTagName` として変更可能（デフォルト: `subplot`）。

---

## データモデル

### TipTap ノード定義

本文 EditorView に登録するカスタムノードは2種類。Codex メンション機構（`@`）は現在 Chat 入力でのみ稼働している（`src/features/chat/extensions/ChatMentionExtension.ts`）。SceneEditor 本体および `sceneBeat` ノード内で動作させるには Phase A で別途登録が必要（後述「実装フェーズ」参照）。

```typescript
// scene-beat ノード（Placed beat。Unplaced は本文ノードに含まれない）
{
  name: 'sceneBeat',
  group: 'block',
  content: 'inline*',  // Codex メンション・bracket 記法を含むテキスト
  attrs: {
    id: string,                    // 一意な Beat ID（UUID v4）
    collapsed: boolean,            // 折りたたみ状態（default: false）
    beatType: 'free' | 'summary' | 'guided' | 'dialogue' | 'setting' | 'micro',
                                   // Novelcrafter の beat type に倣う（任意・default: 'free'）
    pov: string | null,            // POV オーバーライド: codex_entries.id (character)
                                   // null = シーン POV (tree_nodes.povCharacterId) を継承
  }
}

// generated-prose-block ノード（Beat の生成 prose を包むブロック）
{
  name: 'generatedProseBlock',
  group: 'block',
  content: 'block+',               // 段落・引用などを内包できる
  defining: true,                  // ブロック境界が保護される
  attrs: {
    beatId: string,                // 対応する sceneBeat.attrs.id
    modified: boolean,             // 生成後にユーザーが手で編集したか（default: false）
  }
}
```

`sceneBeat` から `placed`、`order`、`generated`、`generatedRange` の各属性は **削除**：

- `placed`: Placed/Unplaced はストレージで分離（本文ノード or `unplaced_beats_doc` カラム）するため属性で持つ必要がない
- `order`: Unplaced 側にのみ意味を持つので `unplaced_beats_doc` 配列の並び順で表現
- `generated` / `generatedRange`: 生成 prose は `generatedProseBlock` ノードでラップされるので、ノードの存在自体が「生成済みかどうか」と「どの範囲か」を表す

### ドキュメント構造例

```typescript
// 本文 (tree_nodes.content)
{
  type: 'doc',
  content: [
    { type: 'paragraph', content: [...] },
    { type: 'sceneBeat', attrs: { id: 'b1', ... }, content: [...] },
    {
      type: 'generatedProseBlock',
      attrs: { beatId: 'b1', modified: false },
      content: [
        { type: 'paragraph', content: [...] },  // 生成された prose
        { type: 'paragraph', content: [...] },
      ]
    },
    { type: 'paragraph', content: [...] },     // 通常の段落
  ]
}

// Unplaced beats (tree_nodes.unplaced_beats_doc)
[
  { id: 'u1', beatType: 'free', pov: null, collapsed: false,
    content: [/* ProseMirror inline content (text + mentions) */] },
  { id: 'u2', beatType: 'setting', pov: null, collapsed: false, content: [...] },
]
```

`unplaced_beats_doc` の各要素は ProseMirror inline content の片（fragment）として保存する。レンダリング側は1要素ごとに小さい独立 TipTap editor（または共通の単一 editor で paragraph = 1 beat の構造）として扱う。

### ID 一意性保証

`sceneBeat.attrs.id` および `unplaced_beats_doc[].id` は **シーンを跨いでも一意**（UUID v4）。`generatedProseBlock.attrs.beatId` は対応する `sceneBeat.attrs.id` を指す。

**コピー＆ペースト時の挙動:**

- 同一シーン内で重複 ID が出現した場合、paste ハンドラが新しい UUID v4 を採番する
- Placed beat を別シーンに paste した場合：
  - `id` は再採番される
  - 直後にあった `generatedProseBlock` も一緒に paste されるが、paste 先で対応 beat の id が再採番されたら **`generatedProseBlock` を unwrap**（中身の段落だけ残す）。AuthorshipMark は維持される
- ペーストされた Beat 内の `@mention`（Codex 参照）はそのまま保持される（Codex はプロジェクトグローバル）

### 生成 prose の所有とライフサイクル（generatedProseBlock）

生成 prose は ProseMirror ノード `generatedProseBlock` に包まれているため、範囲管理は ProseMirror のノード構造で自動的に成立する。設計者が独自に position mapping を追従させるロジックは不要。

| 操作 | 挙動 |
|------|------|
| ノード内テキスト編集（追加・削除） | ノード内に閉じる。`appendTransaction` で `modified=true` に倒す |
| ノード内へのノード挿入（段落追加など） | ノードのサイズが拡大、`modified=true` |
| ノード自体の削除 | `appendTransaction` で消失を検出。リンク Beat 側の操作は不要（ノードが無いこと自体が「生成 prose 不在」を意味する） |
| 境界跨ぎ削除（外側からの段落結合等） | `defining: true` により結合が抑止される。ユーザーが意図して block を解体した場合は unwrap として扱い、AuthorshipMark は維持 |
| Beat ノードと `generatedProseBlock` の間に他ノード挿入 | 両者は離れるが、`beatId` のリンクは保たれる。`Regenerate` 時は doc を走査して beatId 一致の block を見つける |

**`Regenerate` の挙動:**

- 対応 `generatedProseBlock` が存在する: `tr.replaceWith(blockPos, blockPos+blockSize, newContent)` でブロックごと差し替え。ユーザー手編集（`modified=true`）が入っていた場合は確認ダイアログを出す
- 対応 `generatedProseBlock` が無い: Beat 直後に新規 `generatedProseBlock` を挿入して生成
- ユーザーが「絶対に消したくない」場合は `Generate alternative` を使う設計とする

### AuthorshipMark との関係

`generatedProseBlock` と `AuthorshipMark`（`src/features/attribution/AuthorshipMark.ts`）は**別レイヤーで共存**する：

- **`generatedProseBlock`**: ブロック単位で「どの beat の生成範囲か」（`beatId`）を保持。Regenerate / Delete-with-prose の操作対象を identify する
- **`AuthorshipMark`**: inline mark として「この文字列を誰が書いたか」（human/ai/unknown + モデル・traceId 等）を文字単位で保持

両者は責務が直交しており、生成された段落内の text node には AuthorshipMark='ai' が付き、ブロック自体は `generatedProseBlock` で囲まれる：

```
generatedProseBlock { beatId: 'b1', modified: false }
└─ paragraph
   └─ text "ドロシーは..." marks: [authorship: { source: 'ai', model: '...', traceId: '...' }]
```

ユーザーがブロック内に手で書き加えると、新規 text には AuthorshipMark='human' が付き、ブロック側は `modified=true` に倒れる。「block 全体の起源は beat、各文字の起源は authorship」が同時成立する。

CSS は3層を視覚的に区別する：
- AuthorshipMark の Decoration: 既存の紫系（`AttributionPlugin`）
- Beat ヘッダ: 黄色系（既存方針）
- `generatedProseBlock` の左ボーダー: 控えめなグレー（任意で OFF にできる）

paste handler で `generatedProseBlock` を unwrap する場合も AuthorshipMark は維持されるので「誰が書いたか」の情報はロスしない。

### Beat type のセマンティクス

| beat type | 用途 | デフォルトプロンプト調整 |
|-----------|------|------------------|
| `free` | 一般用途・default | 補正なし（Beat instructions のみを AI に渡す） |
| `summary` | 要約的に進める | 「指示を簡潔な記述に展開、冗長表現を避ける」 |
| `guided` | 強い構造指定 | 「指示の順序・トーンを厳密に守る」 |
| `dialogue` | 会話シーン | 「会話と動作描写を中心に、地の文を抑える」 |
| `setting` | 風景・舞台描写 | 「五感描写と空間配置を重視、会話を抑える」 |
| `micro` | 1〜2文の短い差し込み | 「100語以内で簡潔に」 |

すべての beat type のデフォルトプロンプトは Phase B で Settings から編集可能になる（プロジェクトごと / グローバル）。Phase A では `free` のみがハードコーディングされ、他の type は UI 上で選択不可（Phase B で開放）。

---

## UI 表現

### Editor 上部の Beats セクション

Synopsis セクションと並列に配置。Beats セクションは折りたたみ可能で、Unplaced・Placed が両方0件のときはデフォルト折りたたみ。

```
┌──────────────────────────────────────────────────────┐
│ › Synopsis  雨の夜、朱音は十年ぶりに故郷の廃社へ...   │
├──────────────────────────────────────────────────────┤
│ ▾ Beats  3 unplaced · 2 placed              [+ Beat] │
│                                                       │
│  📌 Unplaced (drag to insert in document):           │
│  ┃ Setting: 雨の夜、廃社の前で立ち止まる朱音         │
│  ┃ Conflict: 祭壇に置かれた朱紐を見つける            │
│  ┃ Memory: 触れた瞬間に流れ込む見知らぬ記憶          │
│                                                       │
│  📍 Placed (in document order):                      │
│  ┃ Setting beat (line 3) — generated                 │
│  ┃ Dialog beat (line 18)                             │
└──────────────────────────────────────────────────────┘
```

**Unplaced セクションの挙動:**

- 左の縦線（`┃`）を掴んで本文にドラッグ → Placed に遷移
- `+ Beat` ボタンで新規 Unplaced beat を追加
- 並び順は `unplaced_beats_doc` 配列の順序で決定。D&D で並べ替え可
- 各項目の右に `[⋮]` メニュー: Edit / Place at end / Duplicate / Delete

**Placed セクションの挙動:**

- ドキュメント順で表示。各項目は本文位置への参照
- 項目クリックで本文の該当位置にスクロール
- 項目をドラッグして Unplaced セクションに戻すと Unplaced に遷移（prose は本文中に残る）

### 本文中の Placed beat 表示

```
┌─ Beat ──────────────────────────── [▼] [⚡Generate] [⋮] ┐
│ Dorothyがトトをベッドの下から取り出し、地下室に向かう。       │
│ 家が揺れて転倒し、サイクロンに巻き込まれる感触。              │
│ @トト [pace: slow]                                       │
└──────────────────────────────────────────────────────────┘

（↓生成された prose、通常の段落として並ぶ）
ドロシーはベッドの下に手を伸ばし、震えるトトを抱き寄せた...

┌─ Beat (collapsed) ──── トト視点の恐怖描写... ── [▶] [⋮] ┐
└──────────────────────────────────────────────────────────┘
```

- 折りたたみ時はヘッダーと冒頭文だけ表示
- 左ボーダーの色で Attribution と区別する（Beat: 黄色系、Attribution: 紫系）
- 生成中はストリーミング表示（prose が下に追記されていく）
- ヘッダー右の操作: 折りたたみトグル `[▼]/[▶]`、`[⚡Generate]`（未生成時のみ）、`[⋮]` メニュー

### Beat 内の特殊記法

| 記法 | 意味 | 実装 | 導入 Phase |
|------|------|------|--------|
| `@codex_name` | Codex メンション（default: `mentioned`） | 既存のオートコンプリート機構を流用 | Phase A |
| `@codex_name:actor` | 能動側として関与する Codex | メンションノードの `attrs.role` 拡張 | Phase B |
| `@codex_name:target` | 受動側として関与する Codex | 同上 | Phase B |
| `[instruction]` | AI への局所指示 | TipTap Decoration で視覚的にハイライト（保存時はテキストのまま） | Phase A |
| 改行・段落 | 自由 | `inline*` content で改行可 | Phase A |
| Markdown 記法 | **採用しない** | beat はプロンプトであって本文ではない | — |

角括弧記法の例: `[slow down]`, `[expand the dialogue]`, `[end here]`, `[describe in detail]`, `[pace: slow]`

### Beat の POV オーバーライド

`sceneBeat.attrs.pov` でシーン POV（`tree_nodes.povCharacterId`）を beat 単位で上書きできる。

- `pov: null`（default）: シーン POV を継承
- `pov: <character codex id>`: その beat に限り別 POV

ユースケース：

- 1シーン内で視点を切り替える（シーン分割せずに済む）
- Matrix の POV モードで「シーン全体は太郎視点だが、この beat だけ花子視点」と可視化される

オーバーライド時の挙動：

- 本文中の Placed beat ヘッダーに `POV: 花子` のチップを表示（シーン POV と異なる場合のみ）
- 生成時の AI コンテキストに「この beat の POV は花子」を追加で渡す
- `pov` を指定したキャラ Codex が削除されると `pov: null` に自動リセット（FK 整合）

### Codex メンションの role 修飾子（Phase B）

Phase A では `@codex_name` のみで「言及がある」ことだけを記録する。Phase B で role 修飾子を導入し、能動・受動の区別を可能にする。

| role | 意味 | Matrix での視覚 |
|------|------|--------|
| `actor`（能動側） | この beat で行動を起こすキャラ／使われる物 | 太枠 ● |
| `target`（受動側） | この beat で影響を受ける／対象になる | 細枠 ◯ |
| `mentioned`（default） | 言及はあるが actor/target ではない | 薄 ● |
| POV（pov 属性で指定） | この beat の視点 | ★（actor/target/mentioned とは独立に併記） |

入力 UX：

- `@キャラ名` 入力後、TipTap Mention のサジェストで role を選択可能（default: `mentioned`）
- Mention ノードの `attrs.role` に保存
- ユーザーが意識して入力しなくても運用できる（default = `mentioned`）

### AI 自動推定（Phase C）

Beat 生成完了後、生成された prose を AI が読み、beat 内の各 `@mention` の role を推定して提案する。フローは伏線レジスタの「AI 候補生成」と同型：

1. 生成完了 → AI が prose を分析
2. 「この beat では `@花子` が actor、`@桐野` が target」のような提案リストが beat ヘッダーにバッジ表示
3. ユーザーが accept すると Mention の `attrs.role` が更新される（reject すると default `mentioned` 維持）
4. 推定の信頼度が低い場合（曖昧な描写など）は提案を出さない

これにより、ユーザーが手動で role 修飾子を付けなくても、AI 生成 beat の Matrix 表示が自動的に Role-aware になる。

---

## 入力方法

### Unplaced beat の追加

1. Beats セクションの `+ Beat` ボタン
2. Beats セクションが空のときの「Add your first beat」プレースホルダ
3. **Matrix パネルのセル右クリック → 「Add beat to this scene」**（Matrix 設計書参照）
4. **Matrix パネルのシーン行ヘッダー右クリック → 「Add beat to this scene」**

### Placed beat の追加

1. **`/` コマンド**: 本文中で `/` → メニュー → 「Scene beat」「Continue writing」を選択
2. **ツールバー**: ツールバーから Beat 挿入ボタン
3. **キーボードショートカット**: `Ctrl+Shift+B`
4. **Unplaced beat を本文に D&D**（状態遷移として）

`/continue` は「instructions空のbeat + 即時生成」のショートカット。

---

## 生成フロー

### Unplaced beat の場合

Unplaced beat には `Generate` ボタンを表示しない（本文中の位置を持たないため）。生成するには本文に D&D で配置して Placed にする必要がある。

例外として、Unplaced beat の `[⋮]` メニューに「Place at end of document and generate」を用意し、ワンクリックで本文末尾に配置 + 生成するショートカットを提供する。

### Placed beat の場合

1. ユーザーが Beat の `Generate` ボタンを押す
2. 既存のチャットコンテキスト構築機構（L1〜L5）を**部分流用**してプロンプトを構築:
   - **L1**: Project info（常時）
   - **L2**: storySoFar（現在シーンより前のシーンの Synopsis 群）
   - **L3**: 現在シーンの本文（beat 位置までの内容）
   - **L4**: Codex（beat 内のメンション + 自動検出）
   - **L5**: なし（チャット履歴は不要）
   - **追加**: Beat instructions 本文（角括弧記法を含む）
   - **追加**: この beat の POV（`attrs.pov` がセットされていればそれ、null ならシーン POV を継承）。AI に「この beat は X の視点で書く」と明示
   - **追加（条件付き）**: 自分より後ろの Placed beat および全ての Unplaced beat を「予定されているビート」として注入（Settings で切替可能、default: ON）
3. Vercel AI SDK でストリーミング生成
4. Beat ノードの**直後**に空の `generatedProseBlock`（`beatId = sceneBeat.attrs.id`）を挿入
5. ストリーミングで届くテキストを `generatedProseBlock` 内に追記しつつ、各 text node に **AuthorshipMark='ai'** を自動付与（既存機構）
6. ブロックの存在自体が「生成済み」を表すため、Beat ノード側のフラグ更新は不要

### 生成失敗時の挙動

- Beat ブロックは残す（再生成できるように）
- 部分的に生成された prose があれば残す
- エラーメッセージは Beat の `[⋮]` メニューに表示

---

## Beat の操作メニュー

### Placed beat の `[⋮]` メニュー

| 項目 | 動作 |
|------|------|
| Regenerate | 既存の prose を削除して再生成 |
| Generate alternative | 既存を残したまま別バージョンを生成（Snippet として保存） |
| Edit beat | Beat 内容を編集 |
| Convert to text | Beat を通常の段落テキストに変換（prose だけ残したいとき） |
| Unplace | Beat を Unplaced セクションに戻す（prose は残る、Beat だけ移動） |
| Delete beat only | Beat だけ削除、prose は残す |
| Delete beat and prose | Beat と紐づく prose を両方削除 |

### Unplaced beat の `[⋮]` メニュー

| 項目 | 動作 |
|------|------|
| Edit beat | Beat 内容を編集 |
| Place at end of document and generate | 本文末尾に配置 + 即時生成 |
| Duplicate | Unplaced beat の複製 |
| Delete | Unplaced beat を削除 |

---

## 既存システムとの接続

### Editor との接続

- Placed beat は Editor の TipTap カスタムノード（`sceneBeat` / `generatedProseBlock`）として実装、Unplaced beat は `tree_nodes.unplaced_beats_doc` を読み取る独立 TipTap editor で実装
- 既存の Attribution（AuthorshipMark）、Codex ハイライトと共存。`generatedProseBlock` は inline mark の AuthorshipMark と別レイヤーで動作するため干渉しない
- ステータスバーに「Beats: 6 (3 generated)」などの統計を表示（"generated" は対応 `generatedProseBlock` を持つ Placed beat 数）
- Focus mode では Beat を非表示にするオプション
- リニア編集モードでの Beat 表示は Settings で切替（通常表示 / 折りたたみ / 非表示）

### Codex との接続

- Beat 内の `@mention` は既存の Codex メンション機構を再利用
- Subplot は Codex の `lore` タイプ + `#subplot` タグで運用
- Codex Quick の言及スキャン結果は Matrix パネルと共有

### Chat との接続

- Beat の生成プロンプトは Chat と**同じコンテキスト構築機構**を流用
- 違いは「L5 履歴を含めない」「Beat instructions を末尾に追加」のみ
- Beat の生成結果も Chat と同じ Attribution 機構を通る

### Matrix との接続

- Matrix のセル右クリック → 「Add beat to this scene」で Unplaced beat を追加（Matrix 設計書参照）
- 列の Codex エントリは `@mention` として自動挿入される
- シーン行ヘッダーの右クリックでも Beat 追加可能（Codex 自動挿入なし）

### 伏線レジスタとの接続

- Beat 内テキストへの `ForeshadowSetupMark` / `ForeshadowPayoffMark` 適用は**禁止**
  - Beat はプロンプトであって本文ではないため、伏線アンカーは生成された prose 側にのみ付与する
- 生成 prose に対しては通常通り伏線レジスタが機能する

---

## Export / Import の挙動

### Markdown Export

本文の `sceneBeat` ノードは **Export 時に完全除去**、`generatedProseBlock` は **unwrap**（中身の段落だけ残す）。Unplaced beat は本文外（`unplaced_beats_doc` カラム）に保存されるため Export 対象に含まれない。残るのは生成された prose と通常の段落のみ。

理由：

- Beat は執筆プロセスのメタデータであり、読者向けの本文ではない
- 角括弧記法 `[slow down]` などが本文に混入すると意味不明になる
- Novelcrafter 等他ツールへの export 互換性を保つ

### Markdown Import

外部経路で本文を書き換えた場合、`sceneBeat` ノードは復元されない（Markdown には Beat 表現がないため）。Import 時は警告を表示し、既存の Beat を破棄するか維持するかをユーザーに選択させる。

### 本文文字数カウントへの影響

- Editor の文字数カウントには Beat 内テキストを**含めない**（執筆統計は本文のみ）
- ただし Settings で「Beat 内テキストを含める」トグルを提供する余地を残す（v2 検討）

### 全文検索の対象

- デフォルトでは Beat 内テキストを全文検索の対象に**含める**（著者が「あの Beat はどこに書いた？」を探せるように）
- Settings で除外可能にする（v2 検討）

---

## AI コンテキスト注入における Beat の扱い

シーンに Unplaced beat / Placed beat が存在する場合、Chat や他の Placed beat の生成時に Beat を AI コンテキストに含めるかは Settings で切替可能（default: ON）。

| 含める場合 | 含めない場合 |
|------|------|
| 「このシーンで予定されているビート」を AI が把握でき、整合性が取れる | 不確定情報を AI に学習させない |
| プロッタ派が「このシーンの構成案」を AI に意識させながら執筆できる | トークン消費を抑えられる |

注入仕様：

- Layer 3（現在シーンの本文）の一部として「Pending beats for this scene」セクションを構築し、Synopsis の後ろに注入
- Placed beat の生成時は、**自分より後ろに位置する Placed beat および全ての Unplaced beat** を「予定されているビート」として注入
  - これにより AI が「このあと何が起きるか」を意識した文を書ける（Fabula の Plan → Script 生成に近い効果）

---

## 実装フェーズ

### Phase A: Inline Beat MVP（二状態モデル含む）

最小機能の Beat システム。**Unplaced/Placed の二状態を最初から実装**する（後付けはデータ移行が複雑になる）。

**スキーマ migration:**
- [ ] `tree_nodes.unplaced_beats_doc TEXT NOT NULL DEFAULT '[]'` カラム追加（Unplaced beat の保存先）
- [ ] `tree_nodes.char_count INTEGER NOT NULL DEFAULT 0` カラム追加（Grid のステータスバー集計に使用、シーン保存時にフロントが値を同梱）

**TipTap 拡張:**
- [ ] TipTap カスタムノード `sceneBeat` の実装（Placed beat 用、`attrs`: `id` / `collapsed` / `beatType` / `pov`）
- [ ] TipTap カスタムノード `generatedProseBlock` の実装（`group: 'block'`、`content: 'block+'`、`defining: true`、`attrs`: `beatId` / `modified`）
- [ ] `appendTransaction`: `generatedProseBlock` 内の編集を検出して `modified=true` に倒す
- [ ] **Codex メンション拡張を SceneEditor に登録**: `ChatMentionExtension` と同等のメンション拡張（または共通化したもの）を SceneEditor の Extensions リストに追加。`sceneBeat` ノードは `inline*` content のため、Mention（`group: 'inline'`）はそのまま動作する想定だが、Phase A の最初に挿入動作を検証すること
- [ ] Beat の角括弧記法ハイライト（Decoration、視覚的強調のみ）
- [ ] paste ハンドラ: シーン内 ID 重複検出と再採番、対応 beat 不在の `generatedProseBlock` を unwrap（中身の段落と AuthorshipMark は維持）

**Editor 内 UI（Placed beat）:**
- [ ] `/` コマンドで Placed beat 挿入
- [ ] Placed beat の本文中表示（折りたたみ含む）
- [ ] `Generate` ボタンによるストリーミング生成（Beat 直後に空 `generatedProseBlock` を挿入し、内部に AuthorshipMark='ai' 付き text を流す）
- [ ] `generatedProseBlock` の左ボーダー（控えめなグレー、AuthorshipMark の紫系・Beat ヘッダの黄色系と分離）
- [ ] Placed beat の `Regenerate`（対応 `generatedProseBlock` ごと差し替え。`modified=true` 時は確認ダイアログ）/ `Edit` / `Unplace` / `Convert to text` / `Delete beat only` / `Delete beat and prose`
- [ ] **POV オーバーライド UI**: Beat ヘッダーから POV を選択（character タイプの Codex から選択 or null）。シーン POV と異なる場合のみ `POV: 花子` チップを表示
- [ ] 生成プロンプトへの POV 注入（`attrs.pov` または継承された scene POV を AI に渡す）

**Editor 上部 Beats セクション（Unplaced beat の表示・編集）:**
- [ ] `SynopsisHeader.tsx`（`src/features/editor/`）と同じ親 div の兄弟要素として `BeatsHeader.tsx` を新規作成（既存 Synopsis セクションは独立 DOM のため衝突しない）
- [ ] `tree_nodes.unplaced_beats_doc` を読み込んで Unplaced beat を一覧表示・追加・編集・並べ替え（独立 TipTap editor または共通の単一 editor、いずれも Codex メンション拡張を共有）
- [ ] Placed beat の一覧表示（本文 EditorView を読み取って `sceneBeat` ノードへの参照を生成、クリックで本文内位置へスクロール）
- [ ] `+ Beat` で Unplaced beat 追加（`unplaced_beats_doc` 配列末尾に新規エントリを push）
- [ ] Unplaced beat の `[⋮]` メニュー（Edit / Place at end / Duplicate / Delete）
- [ ] Unplaced beat の「Place at end of document and generate」ショートカット

**D&D による状態遷移:**
- [ ] Unplaced → Placed: フロントで `unplaced_beats_doc` から要素を pop、本文 EditorView に `sceneBeat` を挿入する PM transaction を発行、両者を1リクエストでバックエンドに保存（@dnd-kit + ProseMirror Bridge）
- [ ] Placed → Unplaced: 逆方向。本文から `sceneBeat`（および隣接 `generatedProseBlock` があれば）を抽出し、Unplaced 側に push。`generatedProseBlock` の中身は本文中にそのまま残す or Unplaced 側に運ぶ — 暫定方針：**本文中に prose を残し、Beat だけ Unplaced へ戻す**（`generatedProseBlock` は `appendTransaction` で beatId 不在を検出して unwrap）

**保存ペイロード（フロント側で計算してバックエンドに送る）:**
- [ ] `tree_nodes.content`（本文 PM JSON）
- [ ] `tree_nodes.unplaced_beats_doc`（Unplaced 配列）
- [ ] `tree_nodes.char_count`（本文の文字数。CharacterCount 拡張の値）
- [ ] `tree_nodes.unplaced_beat_preview`（Unplaced 先頭3件 × 40文字、Grid 設計書参照）

**Export:**
- [ ] Export 時の Beat ブロック除去：本文の `sceneBeat` ノードを除去、`generatedProseBlock` は unwrap（中身の段落だけ残す）。Unplaced beat は元から本文外なので Export 対象外（自然に除外される）

依存: Editor、Chat のコンテキスト構築機構、Attribution、Codex メンション、@dnd-kit

### Phase B: Beat type と高度な操作

- [ ] Beat type（`free` / `summary` / `guided` / `dialogue` / `setting` / `micro`）の選択 UI
- [ ] Beat type に応じたデフォルトプロンプトの調整
- [ ] `Generate alternative` で Snippet 化
- [ ] `Convert to text`（Beat を通常段落に変換）
- [ ] ステータスバーに Beat 統計表示
- [ ] Focus mode での Beat 非表示オプション
- [ ] リニア編集モードでの Beat 表示切替
- [ ] **Codex メンション role 修飾子**: `@キャラ:actor` / `@キャラ:target` / `@キャラ`（default `mentioned`）の入力サジェスト＋保存
- [ ] Mention ノードの `attrs.role` 拡張
- [ ] Matrix の Role-aware Display モードに対応する出力（Matrix 設計書側で消費）

### Phase C: AI コンテキスト注入の精緻化＋ role 自動推定

- [ ] Settings で Beat 注入の ON/OFF トグル
- [ ] Layer 3 への「Pending beats for this scene」セクション注入
- [ ] 自分より後ろの Beat を予告として渡すロジック
- [ ] **Beat 生成完了後、prose から各 `@mention` の role を AI 推定**
- [ ] 推定結果を beat ヘッダーにバッジ提案表示（accept で `attrs.role` 更新、reject で default 維持）
- [ ] 推定信頼度が低い場合は提案を出さない（曖昧な描写の誤推定を抑制）

### Phase D: Bottom-up Beat 抽出（v2）

書き終わった本文に対して、AI が beat 候補を逆生成する機能。Synopsis の自動生成機能と類似のフロー。

- [ ] Editor の右クリック → 「Extract beats from this scene」コマンド
- [ ] AI が本文を分析して、6〜10個の beat 案を提示
- [ ] ユーザーが採用/編集/却下
- [ ] 採用された beat は対応する本文段落の**直前**に挿入される

### Phase E: 統計テーブル（v2+）

Beat の生成履歴・統計を取りたい要望が出たら別途追加：

```sql
CREATE TABLE scene_beats (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL,
  beat_id_in_doc TEXT NOT NULL,    -- TipTap ノードの attrs.id と一致
  generated_at TIMESTAMP,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  beat_type TEXT,
  FOREIGN KEY (scene_id) REFERENCES tree_nodes(id) ON DELETE CASCADE
);
```

v1 では実装しない。

---

## Phase A 着手前にユーザー確認が必要な決定事項

本設計書の本文では各事項について暫定方針を採用しているが、データ生成・移行コストに直結するため Phase A 着手前にユーザー判断を得る。本セクションはサインオフ用のチェックリストとして機能する。

### Beat type デフォルトプロンプトの編集可能性

beat type ごとのデフォルトプロンプトを Settings で編集可能にするか、ハードコーディングするか。

**暫定方針**: Settings で編集可能（プロジェクトごと / グローバル）。Codex プロンプトテンプレートと同じ仕組みを流用する。

### 本文文字数カウントへの Beat 内テキストの扱い

執筆統計に Beat 内テキストを含めるかどうか。

**暫定方針**: **含めない**（Beat はプロンプトであって本文ではない）。Settings でトグル切替する余地を残す。

### 全文検索における Beat の扱い

- **暫定方針**: デフォルトで含める。Settings で除外可能にする（v2）。

### リニア編集モードでの Beat 表示

- **暫定方針**: Settings で「通常表示 / 折りたたみ / 非表示」を切替可能。default は「折りたたみ」。

### Markdown export で Beat を完全除去するか保持するか

- **暫定方針**: 完全除去（読者向け本文に Beat が混入するのを防ぐ）。「コメント形式で保持」オプションは v2 検討。

### Unplaced beat の AI コンテキスト注入有無

- **暫定方針**: default ON、Settings で切替。Layer 3 に「Pending beats for this scene」を注入。

### Matrix からの Beat 追加時、既存 Beat があるセルの挙動

- **暫定方針（MVP）**: 単純に新規追加のみ
- **v2**: サブメニューで「Edit existing beat」「Add new beat」を分岐

### 連続 Beat 追加ワークフロー

Matrix で連続して複数シーンに Beat を追加するワークフロー（ダイアログを開きっぱなしにして、次のセルクリックで対象シーンが切り替わる連続入力モード）は v2 で検討。

---

## 既存設計書への影響

本設計書の確定に伴い、以下の既存設計書への追記が必要（別タスク）：

| 設計書 | 追記内容 |
|--------|----------|
| `Grimodex_Editorパネル設計書.md` | Beat ブロックノードの追加、ツールバー、`/` コマンド、Beat の操作メニュー、Beats セクションの UI |
| `Grimodex_Codexパネル設計書.md` | `lore` タイプの subplot 運用、Codex メンションの Beat 内利用、Codex Quick の言及スキャン結果を Matrix と共有する記述 |
| `Grimodex_Chatパネル設計書.md` | Beat 生成のコンテキスト構築（L1〜L4 + Beat instructions）を別フローとして記述 |
| `Grimodex_統合DBスキーマ.md` | `tree_nodes.unplaced_beats_doc` / `tree_nodes.char_count` カラム追加。（将来）`scene_beats` テーブル追加の可能性。subplot のためのスキーマ変更は不要 |
| `Grimodex_エクスポートダイアログ設計書.md` | Beat ブロックの Export 時挙動（除去） |
| `Grimodex_Settingsパネル設計書.md` | Beat type プロンプト編集、Beat 注入トグル、subplot タグ名カスタマイズ |

---

## 参考資料

- Novelcrafter Help: https://www.novelcrafter.com/help/faq/plan/where-do-i-put-my-scene-chapter-act-book-summary-what-about-my-beats
- Novelcrafter Beats Cookbook: https://www.novelcrafter.com/courses/beats-cookbook/scene-beat
- Google Research Fabula（Plan-pipeline-centered の比較対象）
