# Grimodex ゴミ箱パネル設計書

## 概要

ゴミ箱パネル（内部名: Trash Bin、メタファ名: 文屑箱）は、エディタで削除されたテキストを物理的に「落下して溜まる」視覚で保持し、偶然の再発見と再利用を促すパネル。良い表現は光り輝き、クリックで拾い上げてエディタへ再挿入できる。執筆ツールならではの「削除＝捨てる」体験を視覚化する。

デフォルト位置: Bottom Dock（非表示）
キーボードショートカット: `Ctrl+Alt+T`

---

## パネル構造

縦長の「瓶」状コンテナ。削除テキストは上部から落下し、床と他 body に衝突しながら積もっていく。ユーザーは「かき混ぜる」ボタンで攪拌し、埋もれた屑を掘り起こせる。

```
┌──────────────────────────────────┐
│ A. Header                         │
│ ゴミ箱  18 屑    [🌀かき混ぜる][🗑]│
├──────────────────────────────────┤
│                                   │
│ B. 物理フィールド                  │
│                                   │
│     "彼女は静かに微笑んだ"         │
│            ✨                      │
│                                   │
│   "——"        "ああ、もういい"    │
│                                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  [human片] [ai片✨] [human片]    │
│     [human片][ai片✨][unknown片] │
└──────────────────────────────────┘
         ▲ 床、bodyが積もる
```

aria-label: 「ゴミ箱。削除されたテキスト{n}件」
reduced-motion 時は物理を止めてリスト表示に切り替える（詳細は後述）。

---

## A. ヘッダー

- **タイトル**: 「ゴミ箱」
- **件数**: 現在保持している屑の数。右寄せ
- **● 記録インジケータ**: 記録中は小さな発光ドット、クリックで一時停止/再開をトグル
  - 一時停止中はドットをグレーアウト + フィールド上部に薄く「記録停止中」ステータスバー
  - `trashBinStore.isCapturing: boolean` を参照。プラグインはこのフラグが `false` の間キャプチャをスキップ
  - 機密入力前に即座に止められるよう設定ではなくパネル直上に置く
- **🌀 かき混ぜるボタン**: 単発タップ/長押しで物理攪拌（後述の「攪拌インタラクション」）
- **🗑 Clear All ボタン**: 確認モーダルを挟んで全削除
  - 「ゴミ箱の中身をすべて完全に削除します。取り消せません。」
  - モーダル確認後、DB + storeからprojectIdの全`trashItems`を削除

---

## B. 物理フィールド

屑アイテムはフィールド内で物理シミュレーションされる。配置順は `deletedAt DESC` の新しい順に上から落下。

### アイテム要素

- `position: absolute` の div
- サイズはテキスト長に応じて可変（min 80×24, max 240×48, 文字数に応じて幅自動）
- テキストは truncate + title属性に全文
- source別カラーリング:
  - `human` → デフォルト前景色
  - `ai` → 紫系（`--color-accent-ai`）
  - `unknown` → グレー
- `isInteresting === true` の場合、source別グロー（amber / purple）を `@keyframes trash-glow` で常時発光
- origin バッジ表示: 「本文」/「設定資料」のテキストラベル + 色（Scene=青系, Codex=緑系）。絵文字は装飾としてオプション、テキスト+色で必ず区別可能にする
- クリックで詳細 Popover 表示

### フィールドサイズ

- パネルリサイズに追従。物理の `floorY` / `containerWidth` は `ResizeObserver` で更新
- 床（見えない）より下に出そうになった body はバウンス

---

## データモデル

### `trashItems` テーブル

| カラム          | 型                | 説明                                                                 |
|----------------|------------------|--------------------------------------------------------------------|
| `id`           | TEXT PRIMARY KEY | `nanoid`                                                             |
| `projectId`    | TEXT NOT NULL    | 外部キー                                                             |
| `origin`       | TEXT NOT NULL    | 出自種別。`"scene"` / `"codex"`（Phase 6 で `"chat-input"` 拡張予定）  |
| `sceneId`      | TEXT             | origin = "scene" のときセット                                         |
| `codexEntryId` | TEXT             | origin = "codex" のときセット                                         |
| `text`         | TEXT NOT NULL    | spans 全結合の表示用テキスト（500文字で truncate）                     |
| `spans`        | TEXT (JSON)      | `TrashSpan[]` をシリアライズ。authorship 情報を位置順に保持           |
| `charCount`    | INTEGER NOT NULL | 文字数（Unicode コードポイント数、`[...text].length`）。既存の `charCount`/`chars` 表記に揃える |
| `isInteresting`| INTEGER (0/1)    | 光る判定                                                             |
| `deletedAt`    | TEXT NOT NULL    | ISO8601                                                              |

インデックス: `(projectId, deletedAt DESC)`

制約: origin と id列の整合はアプリ層で担保（SQLite の CHECK制約は省略、Drizzle のバリデーションで補う）。

### `TrashSpan` 構造

```typescript
interface TrashSpan {
  text: string;
  source: "human" | "ai" | "unknown";
  model: string | null;
  chatMessageId: string | null;
  timestamp: string | null;
}
```

- 削除範囲内の各テキストノードから authorship mark を位置順に抽出
- mark 未付与テキストは `source: "human"` として記録
- 再挿入時、この配列を走査して各 span に authorship mark を再付与する（属性を完全復元）

### 保持ポリシー

- **保持期間: 60日**（`deletedAt < now() - 60d` で prune、デフォルト）
- **件数上限は設けない**。60日ぶん自然に溜まる量を許容（平均 ~2KB/行、重い執筆でも 1プロジェクト 10MB 程度）
- **セーフティバルブ**: 1プロジェクトあたり 10,000件を超えたら警告ログを吐き古い順に刈る。通常運用では到達しない保険
- **表示/物理対象**: 最新 50件（それ以前は DB のみに残り、物理フィールドには出さない）
- **Prune タイミング**:
  - アプリ起動時
  - 1時間おきのバックグラウンド（`setInterval`、アプリフォアグラウンド時のみ）
  - `addItem` 時にセーフティバルブのみチェック

### プライバシー / オプトアウト

- **デフォルト ON**（全プロジェクトで記録開始）
- プロジェクト設定に **「ゴミ箱を有効化」トグル**（デフォルト ON）
- v2 で保持期間の選択肢を設定 UI に追加予定（7 / 30 / 60 / 90 / 無期限）。今は 60日固定
- **一時停止**: パネルの ● 記録インジケータ（上述）から即座にトグル可
- **プロジェクトエクスポート時**: `trashItems` は **デフォルト除外**。エクスポートダイアログに「ゴミ箱の内容を含める」チェックボックス（デフォルト OFF）を追加。詳細は `docs/Grimodex_エクスポートダイアログ設計書.md` 側に反映

### Drizzle / Rust マイグレーション

- `src/db/schema.ts` に `trashItems` を追加。`spans` 列は `text("spans", { mode: "json" }).$type<TrashSpan[]>()` で型付け
- `src-tauri/src/database.rs` の `migrate()` に `CREATE TABLE IF NOT EXISTS trash_items ...` と上記インデックスを追加
- `CASCADE ON DELETE`:
  - `projectId` → 親プロジェクト削除時に連動削除（自明）
  - `sceneId` / `codexEntryId` → **親シーン/エントリ削除時に連動削除する**（意図的）
  - 理由: 元となる scene/entry が無い屑は origin バッジも表示しようがなく、孤児データが残るより連動削除のほうがユーザー期待に合う
  - 副作用として「誤って scene 削除 → trash も消える → 戻せない」がある。scene 削除側に確認モーダルがあれば十分、trash 側は明記のみ

### Phase 1 着手前の確認事項

- **`AuthorshipMark` の属性が null を許容するか検証**（`src/features/attribution/AuthorshipMark.ts`）
  - `TrashSpan` は `model` / `chatMessageId` / `timestamp` が null を取り得る
  - mark 定義が `default: null` を持たない場合は、再挿入時に null を渡すとエラーになる
  - 対応策: (a) mark 定義側で default: null を許容する / (b) spans 側で `source === "human"` かつ全 null のときは mark 自体を付与しない
  - Phase 1 のキャプチャ実装に入る前に確認

---

## 削除キャプチャ

### `TrashBinCapturePlugin`

`src/features/editor/TrashBinCapturePlugin.ts` に配置。`AiEditedPlugin` と同様に `appendTransaction` を用いるが、**トランザクションは変更しない**（`return null` 固定）。

#### 基本フロー

1. `transactions` を走査し、各 step が `ReplaceStep` か判定
2. `from !== to` の削除範囲について:
   - `tr.getMeta("programmaticDelete")` または `tr.getMeta("skipTrashCapture")` があればスキップ
   - `tr.getMeta("programmaticInsert")` による挿入は対象外（挿入 step は `from === to`）
3. `oldState.doc.nodesBetween(from, to)` で走査し、各テキストノードから `authorship` mark を抽出して `TrashSpan[]` を構築
4. **即時書き込みはせず、後述のバッファに蓄積**

#### Backspace 連打バッファ

- バッファ: `{ fragments: TrashFragment[], timerId: number | null, sceneId: string }`
- 新しい削除が来るたび:
  1. 前回から 500ms 以内かつ位置が隣接（前回 from ± 1）なら既存バッファに合体
     - Backspace: 先頭に prepend（`pos` 減少方向）
     - Delete: 末尾に append（`pos` 増加方向）
     - spans も位置に応じてマージ
  2. 非隣接 or 500ms超 → 既存バッファを **フラッシュ** して新バッファ開始
  3. タイマーリセット: 500ms 後にフラッシュ
- **フラッシュ**: 合体テキストが 2文字以上なら `trashBinStore.getState().addItem()` に渡す
- 2文字未満（1文字タイポ即訂正など）はノイズとして破棄

#### 出自 (origin) の受け渡し

各エディタは自分の出自情報をプラグインに通知する:

- **Scene エディタ** (`EditorPane.tsx`): シーンロード時に
  `tr.setMeta("trashBinOrigin", { kind: "scene", id: sceneId })` を dispatch
- **Codex エディタ** (`CodexContentEditor.tsx`): `entryId` 変化時の `useEffect` で
  `tr.setMeta("trashBinOrigin", { kind: "codex", id: entryId })` を dispatch

プラグイン側:
- plugin state として最新 `origin: { kind: "scene" | "codex"; id: string } | null` を保持
- `origin === null` のエディタ（Snippet 編集・メタデータ入力・Phase 6 以前の ChatInput 等）では **キャプチャ自体を skip**
- `addItem` 呼び出し時に origin を渡し、DB の `origin` / `sceneId` / `codexEntryId` 列にマッピング

#### プラグイン登録先

- `src/features/editor/extensions.ts` の `getEditorExtensions()`（Scene エディタ経由）
- `src/features/codex/components/CodexContentEditor.tsx` の `useEditor({ extensions })` 配列にも追加

同一プラグインを両方に登録することで、Scene / Codex どちらの削除も同一経路で拾う。

#### Codex プレビューモードの除外

`CodexContentEditor` は `externalContent` prop によるフェーズプレビュー（読み取り専用）機能を持ち、親コンポーネントが外部からコンテンツを差し替えるタイミングで大量の `ReplaceStep` が発火する。ユーザー操作ではないのでキャプチャすべきでない。

- プラグインに `capturePaused: boolean` を meta 経由で受け取るインターフェイスを用意
- `CodexContentEditor` 側で `isApplyingExternalUpdate.current === true` の間、あるいは `externalContent != null` の間は
  `tr.setMeta("trashBinCapturePaused", true)` を dispatch
- プラグイン state が pause 中はキャプチャを完全スキップ
- Scene エディタ側でも同等の外部更新タイミング（`sceneContentStore` からの同期適用など）があれば同様に pause を設定

### 置換（Replace）の扱い

`ReplaceStep` で `from !== to` かつ `slice.size > 0` は置換（タイピング置き換え、ペースト上書き、IME確定による変換確定）。

**方針: 置換はキャプチャ対象外**（純粋な削除、`slice.size === 0` のみ）。

- 選択範囲へのタイピング/ペースト上書き時に大量のゴミが流入するのを防ぐ
- IME 確定との干渉を避ける
- 「置換された古いテキスト」はほぼ常に意図的な書き換えであり、「捨てた」感覚は薄い

### IME 合成中の扱い

- `view.composing === true` の間は **キャプチャ保留**（プラグインの `appendTransaction` 内で早期 return）
- 合成中の Backspace（変換候補を戻す操作）もゴミ箱に入れない
- 合成完了後の `ReplaceStep` から通常どおりキャプチャ再開

**IME 確定時の ReplaceStep:** 合成の確定は「未確定文字列 → 確定文字列」の置換として `from !== to, slice.size > 0` 形で飛んでくる。これは上の「Replace は対象外（`slice.size === 0` のみ）」ルールに該当して自動的にキャプチャ対象外となる。IME 開始時の「選択範囲を IME で上書き開始」も同型なので同ルールでカバーされる。

### Undo との協調

#### 基本: undo/redo 起源の削除はキャプチャしない

- `tr.getMeta("history$") !== undefined` or `tr.getMeta("addToHistory") === false` を検査し、undo/redo から生じた削除はキャプチャしない

#### 「消した直後に Ctrl+Z」の吸収

ProseMirror の undo は逆トランザクションを生成するため、「直前の削除範囲と新しい undo の from/to が一致するか」で判定するのは position も doc も変わっていて信頼できない。代わりに **時間窓ベース**で実装する:

- Backspace バッファのフラッシュ時、**即座に DB 書き込みはせず** `trashBinStore` 内の「保留キュー」に置く:
  ```typescript
  interface PendingTrashItem {
    tempId: string;
    data: TrashItemData;
    expireAt: number;  // Date.now() + 1500
  }
  ```
- 保留キュー上のアイテムは **UI には出さない**（落下しない、リストにも出ない）
- 1500ms の間に、同一エディタで undo トランザクション（`tr.getMeta("history$")`）が来たら、該当する保留アイテムを破棄（捨てる）
- 1500ms 経過 or 別の削除が飛んできたら保留アイテムを DB 書き込み + UI 表示へ昇格
- 保留キューは plugin state ではなく **store に持つ**（他のロジックから参照可能にするため）

この設計だと「消して1秒以内に Ctrl+Z」はきれいに吸収され、「消して2秒後に Ctrl+Z」は trash 残留（両方に入ることになる）。ユーザーの時間感覚とおおむね一致する。

定数 `UNDO_ABSORB_WINDOW_MS = 1500` は T-2 と同じく β で調整可。

---

## `trashBinStore`（Zustand）

```typescript
interface TrashItemData {
  id: string;
  projectId: string;
  origin: "scene" | "codex";
  sceneId: string | null;
  codexEntryId: string | null;
  text: string;
  spans: TrashSpan[];
  charCount: number;
  isInteresting: boolean;
  deletedAt: string;
  // body は含めない。物理状態はパネル内 useRef が別管理
}

interface TrashBinStore {
  items: Map<string, TrashItemData>;
  selectedItemId: string | null;
  isCapturing: boolean;
  lastFocusedEditor: { kind: "scene" | "codex"; id: string } | null;
  loadItems(projectId: string): Promise<void>;
  addItem(raw: Omit<TrashItemData, "id" | "isInteresting" | "charCount">): Promise<void>;
  removeItem(id: string): Promise<void>;
  clearAll(projectId: string): Promise<void>;
  insertItem(id: string): Promise<InsertResult>;
  setSelectedItem(id: string | null): void;
  setCapturing(value: boolean): void;
  setLastFocusedEditor(target: { kind: "scene" | "codex"; id: string } | null): void;
}
```

### 設計判断

- **store は永続データのみ**。`TrashItemData` に物理状態 (x, y, vx, vy, settled, rotation) は含めない
- **物理状態は `TrashBinPanel` 内の `useRef<Map<string, PhysicsBody>>` で別管理**
  - パネルがマウントされるたびに store の items から Map を再構築
  - マウント中は Map を直接 mutate（React state 更新を回さない、rAF ループから高頻度更新するため）
  - パネルがアンマウントされれば Map は破棄、再マウント時に再初期化（物理状態の永続化はしない）
- `Map<id, ...>` で O(1) アクセス
- `addItem` 内で interestingness判定・charCount算出（`[...text].length`）を完結。PhysicsBody 生成はパネル側が store の更新を検知して行う
- `insertItem` は spans を走査して各 span に authorship mark を再付与しつつ `editorStore` のinsert API を経由

### Interestingness 判定

`src/features/trash-bin/interestingness.ts`:

1. `spans` 配列内に `source === "ai"` が 1つでもあれば → `true`
2. 全体テキストが 3語以上（英語）or 5文字以上（日本語）→ `true`
3. 文学的記号（`——` `…` `!` `?` `「」` `『』`）を含む → `true`
4. それ以外 → `false`

テスト: `interestingness.test.ts`

---

## 物理シミュレーション

### `physics.ts`

```typescript
interface PhysicsBody {
  id: string;
  x: number; y: number;
  vx: number; vy: number;
  width: number; height: number;
  rotation: number;
  rotationV: number;
  settled: boolean;
}
```

### 関数

- `createBody(id, containerWidth, size)` — ランダム x 初期位置、y = -height で上から落下
- `stepPhysics(bodies, dt, floorY, containerWidth)`:
  1. settled === true の body は **重力・衝突検査ともスキップ**（sleep 状態）
  2. 重力適用: `vy += GRAVITY * dt`
  3. 位置更新: `x += vx * dt; y += vy * dt`
  4. 壁反射: `x < 0 || x + w > containerWidth` でバウンス
  5. 床衝突: `y + h > floorY` でバウンス + 摩擦
  6. AABB 衝突検査: 他 body と重なっていれば最小貫通量で押し戻し + 速度反転（係数 0.4）
  7. settle判定（後述）
- `applyShake(bodies, ax, ay)` — 全 body（sleep 中含む）に外力を付与し settled 解除
- `wakeNeighbors(newBody, bodies)` — 新規 body 着地時に接触する既存 body の settled を解除
- `hasUnsettled(bodies)` — rAF ループ継続判定

### 定数

| 名前                | 値          |
|--------------------|-------------|
| `GRAVITY`          | 680 px/s²   |
| `BOUNCE_DAMPING`   | 0.35        |
| `WALL_DAMPING`     | 0.5         |
| `FRICTION`         | 0.92        |
| `SETTLE_THRESHOLD` | 4 px/s      |
| `COLLISION_REST`   | 0.4         |
| `STIR_IMPULSE`     | 400 px/s    |
| `STIR_IMPULSE_MAX` | 1200 px/s   |
| `SLEEP_FRAMES`     | 10 frames   |

テスト: `physics.test.ts` — pure function 単位でバウンス・AABB 衝突・settle 判定を検証

### Sleep 状態と静止接触の扱い

単純な AABB + 弾性反発 + 重力の組み合わせは、積み重なった body が永続微振動を起こす（静止接触が未実装なため）。対策:

- **Sleep 状態**: `|vx|, |vy| < SETTLE_THRESHOLD` が `SLEEP_FRAMES` 連続で続いたら `settled = true` にして速度をゼロ固定
- Sleep 中の body は `stepPhysics` で **重力・衝突計算の対象外**（CPU/ジッター両方を抑える）
- 新 body が落下して既存 body と接触したら `wakeNeighbors` で下の body を wake させる
- `applyShake` 発火時は全 body を強制 wake

**既知の制限:**
- 完璧な積み重ねは得られない。body同士はそれなりに重なりつつ無秩序に積もる
- 「スタッキング物理」ではなく「雑然とした屑だまり」の表現として受け入れる
- 気持ちよく積みたい要件が出たら matter.js（~50KB gzip）の導入を Phase 6 で検討

### rAF ループ

`TrashBinPanel.tsx` 内:

- `requestAnimationFrame` で `stepPhysics` を呼び回す（`AsciiSplash.tsx` 参考）
- `IntersectionObserver` でパネル非表示 → ループ停止
- `hasUnsettled(bodies) === false && !stirring` で停止
- DOM 要素に `transform: translate3d(x, y, 0) rotate(deg)` で反映（React state更新は使わず直接DOM操作）

### 初期ロード時の配置

`loadItems` 完了直後に 50件が全部上から落下するのはドラマチックすぎて邪魔。

- 初期ロード時は各 body を **床に settled 状態で積まれた状態**から開始する
  - x はランダム、y は床面に近い位置に順次配置
  - settled = true、速度ゼロ
  - 見た目は「すでに屑が溜まっている状態」
- 以降、新規 `addItem` で追加される body のみ、上（y = -height）から落下開始
- パネル再マウント時も同様に settled 積載状態から開始

雑に積まれた状態の初期位置は決定論でもランダムでも可、テスト都合で seed 可能にしておく。

---

## 攪拌インタラクション

### 方針

元案の「パネル rect 加速度検知」は **廃止**。DockView のドラッグ/リサイズの副作用として意図せず発火する挙動を避け、明示的なユーザー操作でのみ攪拌する。

### 🌀 かき混ぜるボタン（プライマリ）

ヘッダ右に配置。

- アイコン: Lucide `Tornado` または `Waves`
- ラベル: `trashBin.stir`（i18n）
- `aria-label`, キーボードフォーカス可

**挙動:**

- **単発タップ** (`click`)
  - `applyShake(bodies, ax, ay)` を 1回呼び出す
  - 方向: ランダム（`ax = (Math.random() - 0.5) * 2 * STIR_IMPULSE`, 同様に `ay`、ただし `ay < 0` バイアスを掛けて上向きに飛ばす）
  - 各 body に小さな乱数回転速度 `rotationV += (Math.random() - 0.5) * 240`
- **長押し** (`pointerdown` → `pointerup`)
  - 300ms 間隔で連続インパルス
  - 呼ぶたび強度を段階的に増やす: `intensity = min(STIR_IMPULSE * (1 + 0.2 * tickCount), STIR_IMPULSE_MAX)`
  - `pointerup` / `pointerleave` でタイマークリア、通常重力に戻り沈殿していく

### アイテム衝突の副産物演出

AABB 衝突 + Sleep/Wake を実装することで、以下の演出が同じ物理コードから得られる:

- **着地波紋**: 新しい屑が落下して既存 body に当たると下の body が wake、軽く跳ねて再 settle
- **攪拌後のカオス**: 全 body を強制 wake して外力付与。互いにぶつかり合い自然な撹拌感
- **（v2）アイテムドラッグ衝突**: アイテムを掴んで動かせるようにした場合、周囲を押しのける

ただし「タダで付いてくる」わけではない。Sleep 状態管理・wake 伝播・接触判定の精度調整など、`physics.test.ts` で pure function の挙動を固めてから UI に載せる前提。

### （v2 検討）床スワイプ攪拌

以下は本プランでは実装しない、将来検討:

- パネル空白領域を pointermove でドラッグ → マウス速度を外力に変換
- クリック（アイテム選択）との排他に 5px ドラッグ閾値 + アイテム以外の領域限定が必要
- 既存の `applyShake` API はそのまま流用可能

---

## 再挿入

### 挿入先ルール

**再挿入先 = 現在フォーカス中のコンテンツエディタ（Scene または Codex）のカーソル位置**

- `trashBinStore` が `lastFocusedEditor: { kind: "scene" | "codex"; id: string } | null` を保持
- Scene / Codex エディタは `useEditor` の `onFocus` で `setLastFocusedEditor` を呼ぶ
- 選択範囲がある場合は選択範囲を置換
- spans を順に挿入、各 span の `source` / `model` / `chatMessageId` / `timestamp` で `authorship` mark を再付与
- **クロス越境を許可**: Codex 屑を Scene に挿入、Scene 屑を Codex に挿入、どちらも警告なしで可。執筆フローを止めない
- **どこにもフォーカスがないとき**: 挿入ボタンを無効化 + tooltip「本文または設定資料にカーソルを置いてください」

### 既知の制限

- `TrashSpan` はテキストと authorship mark のみ保持。Ruby / Emphasis dots / Lint 系 mark などは **削除時点で失われる**（再挿入時も復元されない）
- 全 mark 保持は設計複雑度の割に利得が薄く不採用
- 代わりに Popover のプレビュー表示ではテキストと source 色帯のみを示し、「元の装飾は失われる」ことを暗に伝える

### 挿入 API

```typescript
interface TrashBinStore {
  insertItem(id: string): Promise<InsertResult>;
}

type InsertResult =
  | { ok: true; targetKind: "scene" | "codex"; targetId: string }
  | { ok: false; reason: "no-focused-editor" };
```

ok 時: Popover 閉じる + 挿入位置を 1秒 glow（Phase 4 仕上げ）+ store と DB から item 削除。
失敗時: Popover は開いたまま、挿入ボタンを無効化のまま（トースト等の通知は出さない）。ボタン無効化が主で、API 失敗パスは保険扱い。

### TrashBinPopover

`src/features/trash-bin/TrashBinPopover.tsx`:

- 全文表示（scroll可）
- ソースバッジ（spans の内訳を色帯で可視化）
- origin バッジ（📖 Scene / 📚 Codex）+ 元のシーン/エントリ名 + 削除日時
- `[カーソル位置に挿入]` → `insertItem(id)`
- `[完全に削除]` → `removeItem(id)`

#### アンカリング

クリック時に該当 body を即 `settled = true` 強制 + 中央へ軽くアニメで寄せてから Popover を開く。動き続ける body に Popover を貼ると酔うため。

---

## アクセシビリティ / Reduced Motion

Grimodex のモーション規約（`src/lib/animation.ts`、`useReducedMotion`）に従う。

### `prefers-reduced-motion: reduce` 時の挙動

- 物理シミュレーションは **停止**。rAF ループを起動しない
- 表示は **単純なリスト表示**（Phase 2 のリスト版をそのまま fallback として使う）
- 「かき混ぜる」ボタンは残す。押下で:
  - `items` 配列を Fisher-Yates シャッフル
  - リストに `DURATIONS.fast` のフェードトランジションを適用
- 「偶然の再発見」の意図は保たれる

### キーボード操作

- パネルフォーカス時、`Tab` で各 item をフォーカス可能
- `Enter` で Popover を開く
- ただし物理配置時は DOM 順が視覚順と一致しない → スクリーンリーダ向けに `aria-describedby` で「ゴミ箱内の{N}番目の屑」を付与
- 物理無効時（reduced-motion）は素直にリスト順で navigable

---

## i18n

`src/locales/ja.json` / `en.json` に追加:

| キー                     | ja                     | en                           |
|-------------------------|------------------------|------------------------------|
| `layout.panel.trash-bin`| ゴミ箱                  | Trash Bin                    |
| `trashBin.title`        | ゴミ箱                  | Trash Bin                    |
| `trashBin.empty`        | ゴミ箱は空です           | Nothing discarded yet        |
| `trashBin.count`        | {{count}} 屑            | {{count}} scraps             |
| `trashBin.stir`         | かき混ぜる               | Stir                         |
| `trashBin.clearAll`     | 全削除                   | Clear all                    |
| `trashBin.clearConfirm` | ゴミ箱の中身をすべて完全に削除します。取り消せません。 | Permanently delete all scraps? This cannot be undone. |
| `trashBin.insert`       | カーソル位置に挿入        | Insert at cursor             |
| `trashBin.discard`      | 完全に削除               | Delete permanently           |
| `trashBin.sourceHuman`  | 自分が書いた             | Written by you               |
| `trashBin.sourceAi`     | AIが書いた               | Written by AI                |
| `trashBin.recording`    | 記録中                   | Recording                    |
| `trashBin.paused`       | 記録停止中                | Paused                       |
| `trashBin.pauseToggle`  | 記録を一時停止/再開       | Pause / resume recording     |
| `trashBin.enableLabel`  | ゴミ箱を有効化            | Enable trash bin             |
| `trashBin.includeInExport` | ゴミ箱の内容を含める   | Include trash bin contents   |
| `trashBin.originScene`  | 本文                    | Scene                        |
| `trashBin.originCodex`  | 設定資料                 | Codex                        |

---

## パネル登録

### `layoutStore.ts`
- `PanelId` union に `"trash-bin"` 追加
- `addPanelWithDefaults` に case 追加（center-bottom）

### `panelRegions.ts`
- `PANEL_REGION_MAP`: `"trash-bin": "center-bottom"`
- `KEYBOARD_SHORTCUT_MAP`: `"trash-bin": "Ctrl+Alt+T"`
- `TOGGLEABLE_PANELS` に追加

### `App.tsx`
- `TrashBinContent` を components map に登録

---

## ファイル構成

### 新規

| ファイル                                                      | 内容                          |
|--------------------------------------------------------------|------------------------------|
| `src/features/trash-bin/api.ts`                              | DB CRUD                      |
| `src/features/trash-bin/trashBinStore.ts`                    | Zustandストア                 |
| `src/features/trash-bin/TrashBinPanel.tsx`                   | パネル本体（rAF ループ）      |
| `src/features/trash-bin/TrashBinItem.tsx`                    | 個別アイテム                  |
| `src/features/trash-bin/TrashBinPopover.tsx`                 | 詳細 Popover                 |
| `src/features/trash-bin/TrashBinStirButton.tsx`              | かき混ぜるボタン              |
| `src/features/trash-bin/physics.ts`                          | 物理エンジン                  |
| `src/features/trash-bin/physics.test.ts`                     | 物理のテスト                  |
| `src/features/trash-bin/interestingness.ts`                  | 光る判定                      |
| `src/features/trash-bin/interestingness.test.ts`             | 判定テスト                    |
| `src/features/editor/TrashBinCapturePlugin.ts`               | 削除キャプチャ PM プラグイン  |
| `src/features/editor/TrashBinCapturePlugin.test.ts`          | キャプチャのテスト            |

### 変更

| ファイル                                               | 内容                                         |
|-------------------------------------------------------|----------------------------------------------|
| `src/db/schema.ts`                                    | `trashItems` 追加                             |
| `src-tauri/src/database.rs`                           | `CREATE TABLE IF NOT EXISTS trash_items`      |
| `docs/Grimodex_統合DBスキーマ.md`                      | `trashItems` を追記                           |
| `src/features/editor/extensions.ts`                   | `TrashBinCapturePlugin` を登録                |
| `src/features/editor/EditorPane.tsx`                  | `trashBinOrigin`（scene）meta dispatch        |
| `src/features/codex/components/CodexContentEditor.tsx`| `TrashBinCapturePlugin` 登録 + `trashBinOrigin`（codex）meta dispatch |
| `src/features/layout/layoutStore.ts`                  | `PanelId` 追加                                |
| `src/features/layout/panelRegions.ts`                 | region/shortcut/toggle                        |
| `src/App.tsx`                                         | `TrashBinContent` 登録                        |
| `src/locales/ja.json`                                 | 翻訳キー                                      |
| `src/locales/en.json`                                 | 翻訳キー                                      |
| `src/index.css`                                       | `@keyframes trash-glow` など                  |

---

## フェーズ計画

### Phase 0: 方針確定（本設計書）
IME、undo協調、reduced-motion、保持ポリシー、Replace扱いの方針を確定済み。Phase 1 着手前に以下を確認:

- `AuthorshipMark` の属性 null 許容（「Drizzle / Rust マイグレーション」セクション参照）
- `CodexContentEditor` の `externalContent` 適用時の meta 伝達経路
- Scene エディタで外部コンテンツ適用がある場合の pause 経路

### Phase 1: DB + キャプチャ
- `trashItems` スキーマ（Drizzle + Rust、`origin` / `sceneId` / `codexEntryId` 列含む）
- API 層（CRUD + prune）
- `interestingness.ts`
- `TrashBinCapturePlugin`（デバウンス合体 + IME ガード + undo協調 + origin 受け渡し）
- Scene エディタ (`EditorPane.tsx`) と Codex エディタ (`CodexContentEditor.tsx`) 両方に登録
- `trashBinStore`

### Phase 2: パネル登録 + リスト表示
- DockView 登録 / i18n
- `TrashBinPanel` のリスト版（reduced-motion fallback としても使う）
- 全パイプラインを検証

### Phase 3: 物理シミュレーション
- `physics.ts`（AABB 衝突含む）
- rAF ループ統合
- `TrashBinItem`
- `ResizeObserver` / `IntersectionObserver`

### Phase 4: 光る演出 + 攪拌 + 再挿入
- `@keyframes trash-glow`（source別色）
- `TrashBinStirButton`（単発 + 長押し）
- `TrashBinPopover` + 再挿入
- reduced-motion 時のシャッフル fallback

### Phase 5: エッジケース + 仕上げ
- 50件上限（物理表示）/ 60日 prune（起動時 + 1時間おき）/ 10,000件セーフティバルブ
- 500文字 truncate
- Clear All 確認モーダル
- プロジェクト設定に「ゴミ箱を有効化」トグル（デフォルト ON）
- パネル ● 記録インジケータの一時停止トグル
- エクスポートダイアログに「ゴミ箱の内容を含める」オプション追加（デフォルト OFF）
- origin = null エディタ（Snippet・メタデータ入力等）の skip
- 検証: Scene/Codex 両経路で同一プラグインが正常動作すること

---

## 検証方法

1. `pnpm tauri dev` で起動
2. シーンでテキスト選択 → 削除 → ゴミ箱にアイテムが落下
3. Backspace 連打 → 1つの item に合体されてから落下
4. IME で日本語入力中の変換操作 → キャプチャされない
5. 削除直後に Ctrl+Z → 対応する ゴミ箱 item が消える
6. 長いフレーズや AI生成テキスト削除 → 光る
7. 「かき混ぜる」ボタン単発 → bodies が跳ねる。長押し → 連続攪拌
8. `prefers-reduced-motion: reduce` で起動 → リスト表示、「かき混ぜる」でシャッフル
9. 光るアイテムをクリック → Popover → 「挿入」で authorship 完全復元
10. アプリ再起動 → 保持確認
11. `pnpm test` / `npx tsc --noEmit` / `cargo test`

---

## 運用中に調整予定の項目

設計として確定しているが、β利用中の体感で定数を微調整する可能性がある項目。

### T-1: `isInteresting` 閾値

現状の判定ロジック（`interestingness.ts`）:
- spans 内に `source === "ai"` が1つでもあれば true
- 全体テキストが 5文字以上 （`charCount >= 5`）で true
- 文学的記号（`——` `…` `!` `?` `「」` `『』`）を含む true

β で「光りすぎ/光らなすぎ」が出たら閾値を調整する。定数を `interestingness.ts` の先頭にまとめておく。

### T-2: Backspace 合体デバウンス時間

現状 500ms / 隣接位置 ± 1。タイピングのテンポによっては別物が合体されたり逆に分離されすぎたりするので、β で調整。

### T-3: 保持期間 60日

実運用で「もう少し短く/長く」となれば調整。併せて設定 UI の期間選択肢追加（Phase 6 以降）を再検討。
