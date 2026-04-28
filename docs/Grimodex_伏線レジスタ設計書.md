# Grimodex 伏線レジスタ設計書

## 概要

伏線レジスタは、小説執筆中の「伏線（setup）↔ 回収（payoff）」の関係を構造化エンティティとして管理する機能。Codex / Snippet / Revision と同じ「外部化された執筆メモリ」思想に位置付けられる。

AIによる事後検出（post-hoc detection）も補助手段として有用だが、本機能は構造化エンティティを一次データソースとして採用する。理由は、伏線の本質が**作者の意図**にあり、「この一文を伏線として load-bearing にした」という再解釈の結果を確定的に保存する必要があるため。AI事後検出は判定が文脈依存で揺れやすく、作者の意図を確実に再構成しにくい性質がある。両者は排他ではなく、Phase 3 で AI 事後検出を**監査パスとして補助的に併用する**方針。

設計の起点は **payoff-anchored**（plant-anchored ではない）。理由：実務の小説執筆では「蒔き → 回収」の順より「回収を書いてから過去に蒔き直す／既存叙述を伏線として再解釈する」パターンが多いため。主操作は「後ろ向きリンク」で、**回収側からフラグ → AIが過去シーンから setup 候補を提案 → 既存文を指名 or 新規挿入**となる。ただし plant-anchored 方向（先に setup を登録して後で payoff を紐付ける）も補助フローとして同等にサポートする。

---

## 目標 / 非目標

### 目標

- 伏線の意図と setup ↔ payoff のリンクを永続化する
- 「未回収伏線一覧」を AI コンテキストに確定的に注入できる
- 既存テキストの遡及指名と新規挿入の両方をサポート
- AI による「過去から候補を探す」遡及提案
- 異常状態（orphan_payoff、setupテキスト消失）の検出
- 章末監査・俯瞰ビューの基盤提供
- **双方向フロー**: payoff-anchored（主）と plant-anchored（補助）の両方をサポート

### 非目標

- 自動的な伏線検出（Phase 3 で監査パスとして補助実装、一次データソースにはしない）
- 強度評価の AI 自動上書き（提案のみ。作者判定とは別フィールドで並列保持）
- 「回収済み」の AI 自動判定（作者手動のみ）
- Phase 1 での連作・シリーズ跨ぎ伏線（scene_id 抽象に依存しない設計だが UI 未対応）

---

## 背景・設計判断

### なぜ post-hoc AI 検出ではなく構造化を一次データソースとするか

| 観点 | post-hoc AI 検出 | 構造化 |
|------|---|---|
| 作者の意図保存 | 困難（明示的な記録機構がない） | 容易（明示的に書ける） |
| 判定の安定性 | 文脈依存で揺れやすい | 確定的 |
| 状態遷移 | 持たない | 蒔いた／回収済／放棄等を明示できる |
| AIプロンプトへの注入 | 都度再計算が必要 | 既登録分はリストで確定 |
| 監査の信頼性 | 偽陽性が出やすい | 作者宣言ベース |

両者は**排他ではなく相補**で、AI 事後検出は Phase 3 で「登録漏れの伏線候補」を提示する監査パスとして併用する。本節の論点は「どちらを**一次データソース**にするか」であり、構造化を選ぶ。

### なぜ payoff-anchored か

蒔きから書く writer 中心の plant-anchored 設計だと、Grimodex のような発見的執筆ワークフロー（シーン単位＋チャット駆動）で大半のユースケース（後付け伏線、再解釈）が漏れる。payoff 側を起点とすることで：

- 「ここを成立させたい」起点で AI 候補生成が走る
- 既存叙述の再解釈フローを一級市民として扱える
- 「未着手 TODO（蒔き先未定）」も自然に表現できる

### なぜ非対称 inline anchor か

setup と payoff は意味論的に異なる：

- **Setup**: 1 foreshadow に N 個。kind / strength / ai_strength / attribution / ai_rationale など固有メタが多い
- **Payoff**: 1 foreshadow に 1 個。confirmed bool のみ

対称テーブル（共通 `foreshadow_anchors` に role='setup'|'payoff' を行で表現）にすると保存パターンが統一できるが、固有メタの差異が表現できず、JOIN が増える。**非対称（payoff anchor は inline、setup anchor は別テーブル inline）** で意味論的差異を素直に反映する。

### 状態モデル：2軸 + lifecycle、実体は boolean 2 つ + Setup 存在

| 軸 | 値 | 実装 |
|---|---|---|
| Setup軸 | `none / present` | `Setup` テーブルの存在で計算（Foreshadow に持たない） |
| Payoff軸 | `pending / confirmed` | `payoff_confirmed: boolean` |
| Lifecycle | `active / abandoned` | `abandoned: boolean` |

派生ラベルはこれらと Setup 集計から計算する関数で求める：

```ts
function deriveLabel(f: Foreshadow, setupCount: number, anyWeak: boolean): DerivedLabel {
  if (f.abandoned) return "abandoned";
  if (setupCount === 0 && f.payoffConfirmed) return "orphan_payoff"; // 異常状態
  if (setupCount === 0) return "planned";
  if (f.payoffConfirmed) return "paid";
  if (anyWeak) return "needs_strengthening";
  return "seeded";
}
```

### 観察可能な事実は派生に追い出す

設計議論で最終的に到達した整理原則：

| 層 | 保持するもの |
|---|---|
| Foreshadow の軸 | 作者の粗い意図（蒔いた／回収確定／生きてる） |
| Setup の属性 | 個別 Setup のメタ（kind, strength, anchor, attribution, ai_rationale） |
| 派生表示 | UI で計算する観察事実（orphan, weak rollup, written-but-unconfirmed） |

「テキストが書かれているか」のような機械観察は状態 enum に混ぜず、派生クエリとして UI で計算する。

---

## データモデル

### スキーマ定義（Drizzle ORM）

```ts
// 本体: payoff anchor は inline、payoff は 1:1 のため独立テーブルにしない
foreshadows = sqliteTable("foreshadows", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  intent: text("intent"),                                // 何を回収したいか（作者メモ）
  notes: text("notes"),

  // Payoff anchor (inline, 1:1)
  payoffSceneId: text("payoff_scene_id").references(() => treeNodes.id, { onDelete: "set null" }),
  payoffFromPos: integer("payoff_from_pos"),
  payoffToPos: integer("payoff_to_pos"),

  // 軸（boolean 2つ + Setup 存在で派生ラベル計算）
  payoffConfirmed: integer("payoff_confirmed", { mode: "boolean" }).notNull().default(false),
  abandoned: integer("abandoned", { mode: "boolean" }).notNull().default(false),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
  index("idx_foreshadows_project").on(t.projectId),
  index("idx_foreshadows_payoff_scene").on(t.payoffSceneId),
]);

// Setup: 1 foreshadow : N、anchor + 固有メタを inline で持つ
foreshadowSetups = sqliteTable("foreshadow_setups", {
  id: text("id").primaryKey(),                           // クライアント側 UUID 事前採番
  foreshadowId: text("foreshadow_id").notNull().references(() => foreshadows.id, { onDelete: "cascade" }),

  // anchor (inline)
  sceneId: text("scene_id").notNull().references(() => treeNodes.id, { onDelete: "cascade" }),
  fromPos: integer("from_pos").notNull(),
  toPos: integer("to_pos").notNull(),

  // 固有メタ
  kind: text("kind").notNull(),                          // 'designated_existing' | 'inserted_new' | 'rewritten'
  strength: text("strength"),                            // 'subtle' | 'moderate' | 'overt' | null（作者判定）
  aiStrength: text("ai_strength"),                       // 同上だが AI 評価（careful ペルソナの代表値）。Phase 1 から確保
  aiReasoning: text("ai_reasoning"),                     // Phase 1: 平文。Phase 2 以降: AiEvaluation JSON（下記参照）
  attribution: text("attribution").notNull().default("human"),  // 'human' | 'ai'
  aiRationale: text("ai_rationale"),                     // AI が候補提案した時の理由
  lastEvaluatedAt: integer("last_evaluated_at", { mode: "timestamp" }),

  isOrphan: integer("is_orphan", { mode: "boolean" }).notNull().default(false),  // mark消失検出時に立てる

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
  index("idx_fs_setup_fid").on(t.foreshadowId),
  index("idx_fs_setup_scene").on(t.sceneId),
  index("idx_fs_setup_orphan").on(t.isOrphan),
]);

// Codex関連 (M:N)
foreshadowCodexLinks = sqliteTable("foreshadow_codex_links", {
  foreshadowId: text("foreshadow_id").notNull().references(() => foreshadows.id, { onDelete: "cascade" }),
  codexEntryId: text("codex_entry_id").notNull().references(() => codexEntries.id, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ columns: [t.foreshadowId, t.codexEntryId] }),
  index("idx_fs_codex_codex").on(t.codexEntryId),
]);
```

### `aiReasoning` の Phase 2 JSON フォーマット（後方互換）

Phase 2 以降、`aiReasoning` は読者ペルソナ別の評価を JSON で格納する：

```ts
// src/features/foreshadow/types.ts
export interface PersonaEvaluation {
  strength: "subtle" | "moderate" | "overt";
  reasoning: string;
}

export interface AiEvaluation {
  careful: PersonaEvaluation;   // 精読者（anyWeak 判定に使用する代表ペルソナ）
  casual: PersonaEvaluation;    // 普通の読者
  skim: PersonaEvaluation;      // 流し読み
}
```

`aiStrength` カラムは `careful.strength` を代表値として保存する。後方互換のため、Phase 1 の平文文字列や不正 JSON は `safeParseAiEvaluation()` が `null` を返してフォールバックする（migration 追加なし）。

`anyWeak` ロールアップ（`needs_strengthening` ラベルへの昇格条件）：

```ts
// Phase 1: s.strength === "subtle" || s.aiStrength === "subtle"
// Phase 2: careful.strength === "subtle" のみ（casual/skim は昇格条件に使わない）
const evaluation = safeParseAiEvaluation(s.aiReasoning);
const effectiveStrength = s.strength ?? evaluation?.careful?.strength ?? s.aiStrength;
if (effectiveStrength === "subtle") anyWeak = true;
```

---

### `strength` と `ai_strength` を分離する理由

両者を同じカラムで上書きさせると：

- AI 評価のたびに作者判定が消える
- 作者判定のたびに AI 評価が消える
- 「作者は moderate と判定、AI は subtle と評価」という有用な不一致情報が失われる

別フィールドにすることで両者の差分が見え、UI で並列表示できる。AI 評価は「現時点の参照点」として保存され、再評価で書き換わる。作者判定は作者が能動的に変えるまで動かない。

### `load_bearing` を Phase 1 では持たない理由

`load_bearing`（critical / supporting / optional）は除去テストでしか測れない Phase 3 機能。Phase 1〜2 の実利用データが揃ってから実証的に判断すべき問題で、今フィールドを宙に浮かせる価値がない（deferred decision）。

---

## TipTap layer

### Mark 定義

`AuthorshipMark`（src/features/attribution/AuthorshipMark.ts）を雛形にした 2 種類の Mark：

```ts
// src/features/foreshadow/marks/ForeshadowSetupMark.ts
ForeshadowSetupMark = Mark.create({
  name: "foreshadowSetup",
  inclusive: false,
  addAttributes() {
    return {
      setupId: { default: null },        // クライアント側で事前採番した UUID
      foreshadowId: { default: null },   // 親 foreshadow の ID
    };
  },
  parseHTML() { return [{ tag: "span[data-foreshadow-setup]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-foreshadow-setup": "" }), 0];
  },
});

// src/features/foreshadow/marks/ForeshadowPayoffMark.ts
ForeshadowPayoffMark = Mark.create({
  name: "foreshadowPayoff",
  inclusive: false,
  addAttributes() {
    return { foreshadowId: { default: null } };
  },
  // parseHTML / renderHTML は同様
});
```

### Mark 作成時の ID 事前採番

```ts
// 「伏線を要請」操作で setup を作る時
const setupId = crypto.randomUUID();
editor.commands.setMark("foreshadowSetup", {
  setupId,
  foreshadowId: dialogResult.foreshadowId,
});
// この時点で DB には何も無い。シーン保存時に行が作られる
```

### Paste rule（重要：実装前必須対策その1）

ProseMirror のコピペは Mark をそのまま複製する。同 `setupId` を別シーンに貼ると次回保存で PK 衝突を起こす。

**対策**: クリップボードパーサに `transformPasted` を追加し、foreshadow 系 Mark を貼り付け時に strip する。

```ts
// 概念: extensions.ts に追加
new Plugin({
  props: {
    transformPasted(slice) {
      return slice.mapInline(node => {
        const filteredMarks = node.marks.filter(m =>
          m.type.name !== "foreshadowSetup" && m.type.name !== "foreshadowPayoff"
        );
        return node.mark(filteredMarks);
      });
    },
  },
});
```

> 設計上の含意：authorship にこのリスクが無いのは、authorship に永続 ID が無いから。Setup の固有メタ保護のため identity を導入したことの**直接的なコスト**。

### 表示

- **デフォルト**: 控えめなアンダーラインまたはマーカー（執筆中のノイズを避けるため微妙に）
- **トグル**: 執筆モード（マーカー非表示）／監査モード（マーカー表示）を切替可能
- **Phase 1 デフォルト**: 監査モード OFF（執筆体験優先）

統合先: `src/features/editor/extensions.ts`（Mark 登録）、`EditorPane.tsx`、`LinearSceneBlock.tsx`

---

## 保存・ロードライフサイクル

### なぜ authorship の delete→insert を流用しないか

`authorship_spans` の保存は「シーン保存時に該当 sceneId の行を全削除して bulk insert」。これが成立するのは authorship の行に乗る情報が `source` のみで、**Mark の attrs から再生成可能**だから。

Setup 行には kind / strength / ai_strength / ai_reasoning / attribution / ai_rationale / lastEvaluatedAt が乗る。これらは時間をかけて蓄積される（特に AI 評価は OpenRouter トークン消費を伴う）。delete→insert すると保存のたびに全部消える。

### 保存戦略：UPSERT by ID + orphan retention

```ts
// 概念: src/features/foreshadow/api.ts:saveForeshadowSetupsForScene
// 重要: 全体を 1 SQLite transaction で実行する。FK sweep と INSERT が別 tx だと、
// 間に別経路から foreshadow が削除されるレースで FK violation が再発する。
async function saveForeshadowSetupsForScene(sceneId: string, doc: ProseMirrorNode) {
  // 0. 削除済み foreshadow を参照する mark の事前 sweep（FK違反対策その1）
  const allMarks = collectForeshadowSetupMarks(doc);
  const referencedFids = unique(allMarks.map(m => m.foreshadowId));
  const validFids = new Set(
    await db.select({ id: foreshadows.id })
      .from(foreshadows)
      .where(inArray(foreshadows.id, referencedFids))
  );
  const invalidMarks = allMarks.filter(m => !validFids.has(m.foreshadowId));
  if (invalidMarks.length) {
    editor.commands.unsetForeshadowMarksByIds(invalidMarks.map(m => m.setupId));
    // 以降の処理は valid mark のみで再走
  }
  const marks = allMarks.filter(m => validFids.has(m.foreshadowId));

  // 1. 既存行ロード
  const existingRows = await db.select().from(foreshadowSetups)
    .where(eq(foreshadowSetups.sceneId, sceneId));
  const existingById = new Map(existingRows.map(r => [r.id, r]));
  const docSetupIds = new Set(marks.map(m => m.setupId));

  // 2. UPSERT
  for (const mark of marks) {
    if (existingById.has(mark.setupId)) {
      // UPDATE: anchor だけ書き換え、固有メタは温存
      await db.update(foreshadowSetups)
        .set({
          fromPos: mark.fromPos,
          toPos: mark.toPos,
          isOrphan: false,
          updatedAt: new Date(),
        })
        .where(eq(foreshadowSetups.id, mark.setupId));
    } else {
      // INSERT: 新規（mark 作成時に UUID 採番済、DB に行が無い初回ケース）
      await db.insert(foreshadowSetups).values({
        id: mark.setupId,
        foreshadowId: mark.foreshadowId,
        sceneId,
        fromPos: mark.fromPos,
        toPos: mark.toPos,
        kind: "designated_existing",  // default
        strength: null,                // 未判定
        attribution: "human",
        isOrphan: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  // 3. orphan 処理：DB にあるが doc に mark が無い行
  for (const row of existingRows) {
    if (!docSetupIds.has(row.id)) {
      await db.update(foreshadowSetups)
        .set({ isOrphan: true, updatedAt: new Date() })
        .where(eq(foreshadowSetups.id, row.id));
    }
  }
}
```

### Foreshadow 削除時の mark sweep（FK違反対策その1の解説）

`foreshadows` 行が削除されると `foreshadow_setups` は CASCADE で消えるが、**editor doc 内の Mark は残る**。次回保存で `setupId` をキーに行を探しても無く → INSERT 経路に落ちる → `foreshadowId` が削除済みのため FK 違反でクラッシュ。

**戦略**: lazy cleanup（保存時 sweep）を採用。

- メリット：foreshadow 削除時に開いている全 editor を走査する必要がない
- 上記の保存ロジック step 0 で実装

代替案として eager cleanup（foreshadow 削除時に open editor を sweep）もあるが、複数 editor インスタンス管理が複雑になるので採用しない。

### Payoff 側の保存（Setup より単純）

```ts
async function savePayoffsForScene(sceneId: string, doc: ProseMirrorNode) {
  const marks = collectForeshadowPayoffMarks(doc);
  // FK pre-sweep（Setup と同様、削除済み foreshadow を指す mark を strip）
  const validFids = await getValidForeshadowIds(unique(marks.map(m => m.foreshadowId)));
  const invalidMarks = marks.filter(m => !validFids.has(m.foreshadowId));
  if (invalidMarks.length) {
    editor.commands.unsetForeshadowPayoffMarksByForeshadowIds(invalidMarks.map(m => m.foreshadowId));
  }
  const validMarks = marks.filter(m => validFids.has(m.foreshadowId));

  for (const mark of validMarks) {
    await db.update(foreshadows)
      .set({
        payoffSceneId: sceneId,
        payoffFromPos: mark.fromPos,
        payoffToPos: mark.toPos,
        updatedAt: new Date(),
      })
      .where(eq(foreshadows.id, mark.foreshadowId));
  }

  // Payoff orphan: payoffSceneId = sceneId だが doc に mark が無い foreshadow
  const docFids = new Set(validMarks.map(m => m.foreshadowId));
  const orphans = await db.select().from(foreshadows)
    .where(eq(foreshadows.payoffSceneId, sceneId));
  for (const f of orphans) {
    if (docFids.has(f.id)) continue;
    if (f.payoffConfirmed) {
      // 「回収済み」確定の payoff anchor が消えた → 異常通知（行は触らない）
      // UI 側で警告表示
    } else {
      // 未確定 → anchor を null にロールバック
      await db.update(foreshadows)
        .set({
          payoffSceneId: null,
          payoffFromPos: null,
          payoffToPos: null,
          updatedAt: new Date(),
        })
        .where(eq(foreshadows.id, f.id));
    }
  }
}
```

### ロード

`AuthorshipMark` のロード機構（`applyInitialAuthorshipMarks`）と同形だが、**docJson 由来の stale mark を必ずクリアしてから DB を権威源として再適用する**点が異なる。

理由：foreshadow が削除されたあとシーンを再オープンすると、docJson parse 時に古い Mark が自動的に乗る。DB 側は CASCADE で空なので追加適用なし。結果として削除済み foreshadow を指す Mark が残存する。authorship に同じ問題が無いのは、source（human/ai）が時間で変化しないため docJson 由来の Mark がそのまま正しいから。foreshadow 特有のため authorship 模倣だけでは漏れる。

```ts
async function loadForeshadowMarksForScene(sceneId: string) {
  // 1. docJson 由来の foreshadow Mark を一掃（DB を権威源にする）
  clearAllForeshadowMarks(editor);

  // 2. DB から再適用
  // Setup
  const setups = await db.select().from(foreshadowSetups)
    .where(and(
      eq(foreshadowSetups.sceneId, sceneId),
      eq(foreshadowSetups.isOrphan, false),
    ));
  for (const s of setups) {
    applyMark(editor, "foreshadowSetup", s.fromPos, s.toPos, {
      setupId: s.id,
      foreshadowId: s.foreshadowId,
    });
  }
  // Payoff
  const payoffs = await db.select().from(foreshadows)
    .where(eq(foreshadows.payoffSceneId, sceneId));
  for (const f of payoffs) {
    if (f.payoffFromPos != null && f.payoffToPos != null) {
      applyMark(editor, "foreshadowPayoff", f.payoffFromPos, f.payoffToPos, {
        foreshadowId: f.id,
      });
    }
  }
}
```

orphan 行は読み込まない。orphan UI で別途リスト化される。

> 実装時の確認事項: `applyInitialAuthorshipMarks` の実装に同様のクリア挙動が含まれるか先に確認すること。authorship の Mark はそのまま信頼してよく clear 不要、foreshadow は clear 必須、という非対称が前提。

### authorship との対比

| 観点 | authorship_spans | foreshadow_setups |
|---|---|---|
| 行のメタ密度 | 薄い（source のみ） | 濃い（kind, strength, ai_*, attribution...） |
| 保存パターン | DELETE → bulk INSERT | UPSERT by ID |
| Mark↔DB binding | 暗黙（位置で対応） | 明示（mark.attrs.setupId） |
| ID 発行 | DB 側 | クライアント側（mark 作成時に UUID） |
| 範囲消失時 | row も消える | row は残し isOrphan=true |
| Foreshadow 削除時 | N/A | 保存時 mark sweep が必要 |
| コピペ | 問題なし | paste rule で strip |

---

## AI 連携（Phase 1）

### `propose_past_setups`：遡及候補生成

Phase 1 の主機能。「ここを成立させるための setup を過去のどこに置けるか」を AI に提案させる。

**入力**

```ts
type ProposeRequest = {
  intent: string;                       // foreshadow.intent（作者が書いた回収意図）
  payoffSceneId: string;                // 回収シーンID
  payoffExcerpt: string;                // 回収部分の本文（context 用、500〜1000字）
  pastScenes: Array<{                   // 過去シーンの本文サマリ集
    sceneId: string;
    title: string;                      // チャプター/シーン名
    excerpt: string;                    // 各シーン要約 or トリミング本文
    orderIndex: number;
  }>;
  relatedCodex: Array<{                 // 関連 codex（人物・物・場所）
    id: string;
    name: string;
    summary: string;
  }>;
};
```

**出力**

OpenRouter の structured output（JSON Schema 強制）を使用：

```ts
type ProposeResponse = {
  candidates: Array<{
    sceneId: string;
    kind: "designated_existing" | "inserted_new";

    // designated_existing の場合
    existingExcerpt?: string;           // 該当箇所の本文抜粋
    fromPosHint?: number;               // approximate position（ロード後 verify する）
    toPosHint?: number;

    // inserted_new の場合
    suggestedInsertionPoint?: string;   // 「○○の段落の後」等の自然言語ヒント
    suggestedText?: string;             // 推奨挿入文

    rationale: string;                  // なぜこの候補か
    predictedStrength: "subtle" | "moderate" | "overt";
  }>;
};
```

**モデル選定**

- 推奨: Sonnet 4.6 / Opus 4.7（structured output 対応 + 文学的判断力）
- ユーザ設定の AI モデルを尊重するが、structured output 対応モデルに限定

**トークン予算**

- 過去シーン本文をフルで渡すと爆発的に増える → **シーン要約モード**を採用
- 各シーン 200〜400 字の要約（chat_summaries の機構を再利用検討）
- 候補絞り込み時に該当シーンのフル本文を再リクエストする 2 段階方式

**コスト管理**

- 手動トリガのみ（自動再評価しない）
- 結果は `aiRationale` に保存、再リクエストまで再利用

### Phase 2 以降の AI タスク（参考）

| タスク | 入力 | 出力 | タイミング |
|---|---|---|---|
| 強度評価 | setup + foreshadow.intent + 周辺文脈（payoff 本文は渡さない） | strength + reasoning + 読者ペルソナ別気付き | 手動トリガ |
| 監査パス | 全シーン要約 | 登録漏れ伏線候補リスト（控えめに） | 章末／手動 |

`ai_strength` の staleness 判定（Phase 2 で検討）：
- `lastEvaluatedAt` だけでは不十分
- 「依存シーン（setup の含まれるシーン）の最終更新時刻 > 評価時刻」を判定
- Phase 1 では `lastEvaluatedAt` のみ持つ。Phase 2 設計で依存追跡を追加

---

## AI 連携（Phase 2）

### `evaluateSetupStrength`：読者ペルソナ別強度評価

Phase 2 で実装した手動トリガの強度評価。setup テキストを 3 種の読者ペルソナ視点から評価し、伏線としての気づかれやすさを判定する。

**設計上の制約**: payoff 本文は**渡さない**。理由：読者は payoff を読んでいない段階で setup を読む。payoff 本文を AI に渡すと「伏線として回収される」という知識を持った評価になり、naive reader simulation として不正確になる。

**入力**

```ts
type EvaluateStrengthRequest = {
  setupId: string;
  setupExcerpt: string;        // setup テキスト前後 500 字
  foreshadowIntent: string;    // foreshadow.intent（評価の参照軸）
};
```

**プロンプト設計（3ペルソナ）**

```
ペルソナ定義:
- careful（精読者）: 一語一句に注意を払い、伏線を積極的に探しながら読む
- casual（普通の読者）: 普通のペースで読む、自然に目に入る要素に気づく
- skim（流し読み）: 大まかな流れだけを追い、細部は流す

評価軸（strength）:
- subtle: そのペルソナでは伏線として気づかれない可能性が高い
- moderate: 気づく読者と気づかない読者が半々程度
- overt: そのペルソナには明らかに伏線とわかる
```

**出力（`AiEvaluation` JSON）**

```ts
{
  careful:  { strength: "subtle"|"moderate"|"overt", reasoning: string },
  casual:   { strength: "subtle"|"moderate"|"overt", reasoning: string },
  skim:     { strength: "subtle"|"moderate"|"overt", reasoning: string },
}
```

**保存先**

```ts
updateSetup(setupId, {
  aiStrength: evaluation.careful.strength,  // careful を代表値として保存
  aiReasoning: JSON.stringify(evaluation),  // AiEvaluation 全体を JSON 化
  lastEvaluatedAt: new Date(),
});
```

**コスト管理（Phase 2）**

- 手動トリガのみ（自動再評価しない）
- 評価中は `evaluatingSetupIds: Set<string>` でボタンを disabled + spinner 表示（二重送信防止）
- quota / rate-limit は Phase 3 で実装

### `proposePastSetups`（Phase 2 改善点）

Phase 1 の `propose_past_setups` プロンプトに `inserted_new` 用の指示を追加：

```
既存テキストに適切な箇所がない場合は kind="inserted_new" とし、
suggestedInsertionPoint（「○○の段落の後」等の自然言語ヒント）と
suggestedText（挿入推奨文）を必ず含めること。
```

**⚠ UI エントリポイント未実装（Phase 3 候補）**

Phase 2 時点では `proposePastSetups` を呼び出す UI が存在しない。`inserted_new` 候補の `suggestedText` 表示 UI も未実装。ProposeRequest には `payoffSceneId` / `payoffExcerpt` / `pastScenes` が必要で、現在の `CreateForeshadowDialog`（新規作成フォーム）の文脈では揃えられないため。

Phase 3 での実装先候補: `ForeshadowPanel` の展開セクションに「Setup を提案」ボタンを追加し、結果をインライン表示する。`inserted_new` 候補には `suggestedText` を `<pre>` で表示し「この文を挿入」ボタンで Setup 作成する。

---

## AI 連携（Phase 3）

### `auditChapter`：章単位の登録漏れ監査

手動トリガで章配下のシーン本文を AI に渡し、未登録の伏線候補を提示する。

**設計上の重要な選択**: synopsis（粗い要約）ではなく**本文そのもの**を AI に渡す。理由：伏線の本質は「さりげない描写」「具体的なディテール」にあり、synopsis ではこれらが落ちるため。トークン爆発は「章単位」というスコープ制約で自然に抑える（手動トリガ前提なのでバースト的なコストを許容）。

**入力**

```ts
interface ChapterAuditRequest {
  chapterId: string;
  scenes: Array<{
    sceneId: string;
    title: string;
    bodyText: string;  // フル本文（prosemirrorToText で平文変換済み）
    orderIndex: number;
  }>;
  existingForeshadows: Array<{ id: string; title: string; intent: string | null }>;  // 除外リスト
  relatedCodex: Array<{ id: string; name: string; summary: string }>;
}
```

空シーン（bodyText 空文字）は送信前に除外。章全体が空の場合は即時 `[]` を返す。

**出力**

```ts
interface AuditCandidate {
  suggestedTitle: string;
  suggestedIntent: string;
  evidenceSceneId: string;
  evidenceExcerpt: string;        // 本文からの直接引用（20〜80字）
  rationale: string;
  confidence: "low" | "medium" | "high";
  similarToExistingForeshadowId?: string;  // 既存伏線に近い場合
}
```

**プロンプト方針**

- `existingForeshadows` を除外リストとして明示（被り防止）
- confidence バイアス低め（「確信できない候補は提案しない」）
- 各候補に `evidenceExcerpt`（本文直接引用）必須 → UI で引用表示

**採用フロー**

`AuditCandidate` → 「伏線として登録」ボタン → `CreateForeshadowDialog` を `initialTitle` / `initialIntent` プリフィル付きで起動（既存 Phase 2 の props を流用）。

**ランタイム分岐**

- Tauri: `foreshadow_audit_chapter` IPC（Rust 側でプロンプト生成 + OpenRouter 呼び出し）
- ブラウザ: JS 側で `sendChatMessageWithThinking` を直接呼び出し（同一プロンプト）

**二重送信防止**

`auditingChapterIds: Set<string>` を foreshadowStore で管理。コンポーネント unmount をまたいで有効（ローカル state ではなく store）。

### `getChapterForeshadowStats`：章別集計（AI なし）

章配下の setup / payoff を DB 集計し統計情報を返す。AI 不使用のため軽量。章展開時に呼ぶ。

```ts
interface ChapterForeshadowStats {
  chapterId: string;
  totalScenes: number;
  scenesWithBody: number;          // bodyText が空でないシーン数
  byLabel: Partial<Record<DerivedLabel, number>>;
  orphanCount: number;
  needsStrengtheningCount: number;
}
```

### `adoptInsertedNewSetup`：AI 提案テキスト挿入 + Revision 記録（Phase 3 / D）

`proposePastSetups` が返した `inserted_new` 候補を採用するフロー。setup DB レコードの先行作成 → テキスト挿入 → UPSERT 保存 → revision 記録、の 5 ステップ。

**UPSERT 保全の仕組み**

`saveForeshadowAnchors` の ON CONFLICT 節は `fromPos / toPos / isOrphan / updatedAt` のみを更新する。そのため手順 1 で `foreshadow_setup_create_ai` に書き込んだ `kind / attribution / aiRationale / strength / aiReasoning` は手順 3 の UPSERT で上書きされない。これにより「AI が提案した挿入文として記録が保たれる」ことが保証される。

**revision の重複防止**

`createRevision` は content 同一時のスキップが内部実装済み。加えて `adoptInsertedNewSetup` は 1 採用フローにつき 1 回だけ呼ぶ（`saveSceneContent` の完了を await してから呼ぶ）。

### Staleness 判定（Phase 2 実装済み）

```ts
// src/features/foreshadow/staleness.ts
export function isSetupEvaluationStale(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,  // treeNodes.updatedAt（ISO 文字列）
): boolean {
  if (!setup.lastEvaluatedAt) return true;
  return new Date(sceneUpdatedAt) > setup.lastEvaluatedAt;
}
```

`sceneUpdatedAt` は `listSetups()` 時に `treeNodes` を LEFT JOIN して取得し、`ForeshadowSetupRow.sceneUpdatedAt?: string` として付与する（非永続フィールド、DB には保存しない）。UI では黄色 dot でインジケートする。

---

## IPC surface（Tauri Commands）

```rust
// src-tauri/src/commands/foreshadow.rs（新規）

#[tauri::command]
foreshadow_create(project_id: String, title: String, intent: Option<String>) -> Result<Foreshadow>

#[tauri::command]
foreshadow_update(id: String, patch: ForeshadowPatch) -> Result<Foreshadow>

#[tauri::command]
foreshadow_delete(id: String) -> Result<()>

#[tauri::command]
foreshadow_list(project_id: String, filter: ForeshadowFilter) -> Result<Vec<ForeshadowWithDerived>>
// derived label, setup count を含む

#[tauri::command]
foreshadow_get(id: String) -> Result<ForeshadowDetail>
// setup一覧、orphan setup含む

#[tauri::command]
foreshadow_link_codex(foreshadow_id: String, codex_id: String) -> Result<()>

#[tauri::command]
foreshadow_unlink_codex(foreshadow_id: String, codex_id: String) -> Result<()>

#[tauri::command]
foreshadow_save_anchors_for_scene(scene_id: String, payload: SaveAnchorsPayload) -> Result<SaveAnchorsResult>
// SaveAnchorsResult に invalid_setup_ids（mark側で strip すべきID）を含める

#[tauri::command]
foreshadow_load_anchors_for_scene(scene_id: String) -> Result<LoadAnchorsResult>

#[tauri::command]
foreshadow_propose_past_setups(req: ProposeRequest) -> Result<ProposeResponse>
// AIへのpassthrough、OpenRouterまで

#[tauri::command]
foreshadow_set_setup_strength(setup_id: String, strength: Option<Strength>) -> Result<()>

#[tauri::command]
foreshadow_resolve_orphan(setup_id: String, action: OrphanAction) -> Result<()>
// action: 'reanchor' | 'delete' | 'reinsert'

// ── Phase 3 追加 ──────────────────────────────────────────────────

#[tauri::command]
foreshadow_setup_create_ai(
    id, foreshadow_id, scene_id, from_pos, to_pos, kind,
    strength, ai_strength, attribution, ai_rationale,
    ai_reasoning, last_evaluated_at
) -> Result<()>
// AI メタデータ付き INSERT。ON CONFLICT(id) は fromPos/toPos/isOrphan/updatedAt のみ更新。
// ai_rationale / strength / kind / attribution / ai_reasoning は保持される。

#[tauri::command]
async foreshadow_audit_chapter(req: ForeshadowAuditRequest) -> Result<ForeshadowAuditResponse>
// 章配下シーン本文を AI に渡し AuditCandidate[] を返す。
// 空シーン事前除外。章全体が空なら candidates: [] を即時返す。
```

---

## UI surfaces

執筆中の入口は**双方向**に提供する：

- **payoff-anchored 経路（主）**: 回収を書いている時に「ここを成立させる setup を過去に置きたい」
- **plant-anchored 経路（補助）**: 何かを書いている最中に「これは将来 何かの伏線として使えそう」と気付いた時に登録

両者は最終的に同じデータ（Foreshadow + Setup）を作るが、起動文脈と必須入力が異なる。

### 主入口①（payoff-anchored）：「伏線を要請」

執筆中、payoff シーンで選択範囲を作って右クリック → メニューに「**伏線を要請**」が出現。「**この場面を成立させる setup を過去に置きたい**」フロー。

**起動するダイアログ**

```
┌────────────────────────────────────────────┐
│ 伏線を要請（回収側からの遡及登録）         │
├────────────────────────────────────────────┤
│ Title:        [_____________________]      │
│ Intent:       [_____________________]      │
│               (何を回収したいか)           │
│ Related Codex:[人物A] [×] [+追加]          │
│                                            │
│ ┌──────────────────────────────────────┐   │
│ │ 候補:                                │   │
│ │ ◯ 過去から候補を探す（AIに任せる）   │   │
│ │ ◯ 新規挿入を提案（AIに位置生成）     │   │
│ │ ◯ 後で考える（plannedで保留）        │   │
│ └──────────────────────────────────────┘   │
│                                            │
│             [キャンセル]  [作成]           │
└────────────────────────────────────────────┘
```

「過去から候補を探す」を選ぶと `propose_past_setups` が走り、結果をリストで表示 → 候補から選択 / 採用。

選択範囲は ForeshadowPayoffMark として記録され、Foreshadow 行が `payoffSceneId` + anchor を持って作成される。

### 主入口②（plant-anchored）：「伏線として登録」

執筆中、setup として残したいテキスト範囲を選択して右クリック → メニューに「**伏線として登録**」が出現。「**これは将来何かの伏線として使えそう**」フロー。

**起動するダイアログ**

```
┌────────────────────────────────────────────┐
│ 伏線として登録（蒔き側からの先行登録）     │
├────────────────────────────────────────────┤
│ Title:        [_____________________]      │
│ Intent:       [_____________________]      │
│               (何を回収する予定か / 任意)  │
│ Related Codex:[人物A] [×] [+追加]          │
│                                            │
│ ┌──────────────────────────────────────┐   │
│ │ 回収:                                │   │
│ │ ◉ 後で決める（payoff_scene 未定）    │   │
│ │ ◯ 既に書いた箇所を回収先に指名       │   │
│ │   → クリックで scene 選択ダイアログ   │   │
│ └──────────────────────────────────────┘   │
│                                            │
│             [キャンセル]  [登録]           │
└────────────────────────────────────────────┘
```

選択範囲は ForeshadowSetupMark として記録され、Foreshadow 行（payoffSceneId は null）と Setup 行（kind=`designated_existing`、attribution=`human`、strength=`null`）が作成される。

派生ラベルは `seeded`（setup あり、payoff 未確定）になる。

> **Phase 1 では strength 入力をダイアログから持たない**。理由：保存ロジックは新規 INSERT 時に `strength: null` 固定で、ダイアログから値を渡すには追加 IPC か Mark への mutable メタ載せが必要になり、「IPC 新規追加なし」原則と矛盾する。Phase 1 は伏線パネルからの後付け編集で代替し、Phase 2 の強度評価機能と合わせてダイアログにも追加する。

### 主入口③（plant-anchored 補助）：「○○ の回収にする」

既存の伏線（payoff anchor 未設定）に対し、エディタ側から payoff anchor を後付けで設定する経路。

執筆中の選択範囲 → 右クリック → サブメニュー「**回収先として指名**」 → payoff anchor 未設定の Foreshadow 一覧から選択 → Mark 適用。

**Phase 1 のフィルタ条件**: `payoffSceneId IS NULL` のみ。

```sql
-- 入口③の選択肢に出す Foreshadow
WHERE payoff_scene_id IS NULL AND abandoned = false
```

設計判断：一度 payoff anchor を設定済みの Foreshadow は入口③の選択肢に出さない。理由：

- 誤操作で作者判定済み（または `payoffConfirmed = true`）の anchor を吹き飛ばすリスクを回避
- 「再配置したい」場合は伏線パネルから明示的に anchor を削除 → 入口③で再指名、という二段操作を強制
- Phase 2 以降で「再アンカー」専用 UI を追加する余地を残す

```
右クリック
  ├─ 伏線を要請                    （新規 payoff-anchored）
  ├─ 伏線として登録                 （新規 plant-anchored）
  └─ 回収先として指名 ▶
       ├─ 古井戸の秘密 (planned)
       ├─ Aの裏切り (seeded, 2 setups)
       └─ ...
```

選択した Foreshadow に対し ForeshadowPayoffMark を当該範囲に挿入し、保存時に `payoffSceneId` + anchor が更新される。

### 副入口：伏線パネル

専用パネルとして提供。レイアウト位置は Right Panel もしくは Bottom Dock のタブ。

```
┌──────────────────────────────────────────┐
│ 伏線パネル                                │
│ Filter: [全て][planned][seeded][paid]... │
├──────────────────────────────────────────┤
│ Title          Status     Setup  Payoff  │
│ ──────────────────────────────────────   │
│ Aの裏切り      seeded      3/3   ch.12   │
│ 古井戸の秘密   planned     0/0   未定    │
│ 王の指輪       paid        2/2   ch.18   │
│ ⚠ 失われた名前 needs_strg  1/2*  ch.7    │ ← weak rollup
│ ⚠ 鐘の音       orphan_p    0/0   ch.5    │ ← 異常状態
└──────────────────────────────────────────┘
```

行展開（chevron）で setup 一覧・強度・AI 評価をインライン表示する形に進化（Phase 2）。Foreshadow 本体メタデータ（title / intent / notes / payoffConfirmed / abandoned / payoff anchor 解除）の編集経路は **`EditForeshadowDialog`**（Phase 4）で提供する。詳細はフェージング → Phase 4 を参照。

### 副入口：Codex 詳細

Codex 詳細画面に「**伏線**」タブ追加（既に検討中のタブ化と合流）。`foreshadow_codex_links` 経由で関連伏線を表示。

### 副入口：章末監査ビュー

チャプター/パート単位で「未着手」「未強化」「orphan」をリスト化。Phase 1 はシンプルなフィルタビュー、Phase 3 で AI 監査パス統合。

### orphan setup 通知 UI（Phase 1 必須）

orphan が発生した時、何らかの形でユーザに通知が必要：

- 伏線パネルに「⚠ orphan ○件」バッジ
- 該当 setup を開くと操作選択肢：
  - **再アンカー**: 別範囲を選んで再紐付け
  - **削除**: 行を物理削除
  - **新規挿入**: 別シーンに setup として再挿入

### Mark 表示トグル

設定（または編集モードトグル）で：

- 執筆モード: setup / payoff Mark を非表示（執筆体験優先）
- 監査モード: マーカー表示（hover で詳細）

Phase 1 デフォルトは執筆モード。

---

## フェージング

### Phase 1（MVP）

**含む**

- データモデル全体（`foreshadows` / `foreshadow_setups` / `foreshadow_codex_links`）
- TipTap Mark 2 種 + paste rule
- Save / load / FK sweep / orphan retention（保存ロジック完全実装）
- IPC: CRUD + save/load + propose_past_setups + resolve_orphan
- **入口①** 「伏線を要請」（payoff-anchored、AI 候補生成あり）
- **入口②** 「伏線として登録」（plant-anchored、新規 Foreshadow + Setup を直接作成）
- **入口③** 「回収先として指名」（既存 Foreshadow に payoff anchor を後付け）
- 伏線パネル（一覧 + status filter + 行詳細）
- AI: `propose_past_setups`（既存指名のみ、新規挿入は Phase 2）
- 派生ラベル計算と表示
- orphan UI（最低限）

**Phase 1 完了の定義**

- 作者が payoff シーンで「伏線を要請」 → AI 提案 → 既存テキスト指名 → Setup 作成
- 作者が任意のシーンで「伏線として登録」 → Foreshadow + Setup が作られ、後で payoff を紐付けられる
- 既存 Foreshadow（payoff 未確定）に「回収先として指名」で payoff anchor を後付けできる
- シーン編集を経ても anchor が追従、保存後にロードして Mark 復元
- foreshadow 削除時にシーン保存しても FK 違反でクラッシュしない
- コピペで PK 衝突しない
- orphan setup が伏線パネルに表示され、再アンカー / 削除できる
- 派生ラベル（planned / seeded / paid / orphan_payoff / abandoned）が正しく計算される

### Phase 2（2026-04-26 完了）

**実装済み**

- 強度評価機能（手動トリガ、3 ペルソナ: careful / casual / skim）
  - `evaluateSetupStrength()` API + `evaluateSetup` store アクション
  - ForeshadowPanel にペルソナ別結果の折りたたみ表示・AI 評価ボタン
  - 評価中 spinner（二重送信防止）
- Staleness 判定（`isSetupEvaluationStale`）+ 黄色 dot インジケータ
  - `listSetups()` で treeNodes を LEFT JOIN して `sceneUpdatedAt` を取得
- `anyWeak` 判定の精緻化（careful.strength === "subtle" のみで昇格）
- `aiReasoning` の JSON 拡張（`AiEvaluation` 型、後方互換）
- Codex 詳細「伏線」タブ（`ForeshadowTab.tsx`、`foreshadow_codex_links` 経由）
- Snippet コンテキストメニューから「伏線として登録」エントリ追加
  - `CreateForeshadowDialog` を `initialTitle` / `initialIntent` 付きで起動
- `proposePastSetups` プロンプトに `inserted_new` 用の指示を強化
- コスト管理（手動トリガのみ・二重送信防止）

**Phase 2 の残課題（Phase 3 候補）**

- `proposePastSetups` の UI エントリポイント未実装（API のみ存在）
- `inserted_new` 候補の `suggestedText` 表示 UI 未実装
  - 詳細は「AI 連携（Phase 2）」の `proposePastSetups` 節を参照
- `ForeshadowMarkPopover.test.tsx` の既存失敗 1 件（Phase 2 非関連）
- quota / rate-limit（Phase 3 で実装）

### Phase 3（2026-04-26 完了）

**実装済み（スコープ A + B + C + D）**

- **A. Phase 2 残課題の解消**
  - `proposePastSetups` UI: ForeshadowPanel の伏線展開セクションに「Setup を提案」ボタンを追加
    - payoff anchor がある伏線にのみ表示（`payoffSceneId != null`）
    - 提案結果をインライン表示（kind バッジ / rationale / predictedStrength）
    - `designated_existing` 候補 → 「採用」ボタン（`adoptProposedSetup`）
    - `inserted_new` 候補 → `suggestedText` 表示 + 「挿入して採用」ボタン（`adoptInsertedNewSetup`）
  - `ForeshadowMarkPopover` の `payoff-unanchored` フィルタ修正: flag ベース→ラベルホワイトリスト（`planned` / `seeded`）
  - 二重送信防止: `proposingForForeshadowIds: Set<string>` を store に追加（`evaluatingSetupIds` パターン踏襲）

- **B. AI 監査パス（`auditChapter`）**
  - 章配下の全シーン本文を AI に渡し、登録漏れ伏線候補を JSON で取得
  - 入力: `ChapterAuditRequest`（chapterId / scenes / existingForeshadows / relatedCodex）
  - 出力: `AuditCandidate[]`（suggestedTitle / suggestedIntent / evidenceSceneId / evidenceExcerpt / rationale / confidence）
  - 空シーン（bodyText 空文字）は事前除外
  - `existingForeshadows` を除外リストとして明示し被り防止
  - confidence バイアス低め（`low` → 折りたたみ表示推奨）
  - Tauri ランタイム: `foreshadow_audit_chapter` Rust IPC 経由 / ブラウザ: JS 直接呼び出し

- **C. 章別監査ダッシュボード（`ForeshadowChapterTab`）**
  - ForeshadowPanel にタブ切替「一覧」「章別監査」を追加
  - 章ツリー（folder nodeType）を縦に列挙。クリックで章展開 + stats ロード
  - stats バッジ: `scenesWithBody/totalScenes` を表示（`getChapterForeshadowStats` で DB 集計）
  - 章ヘッダ右に「AI 監査」ボタン → `auditChapter` 呼び出し
  - 監査結果の候補カード（confidence 色バッジ / evidenceExcerpt 引用表示）
  - 「伏線として登録」ボタン → `CreateForeshadowDialog` を `initialTitle` / `initialIntent` プリフィル付きで起動
  - 二重送信防止: `auditingChapterIds: Set<string>` を store で管理（コンポーネント unmount 跨ぎで有効）

- **D. Revision 統合（`adoptInsertedNewSetup`）**
  - `inserted_new` 候補採用時のフルフロー（store アクション）:
    1. `createForeshadowSetup`（Tauri: `foreshadow_setup_create_ai`）で DB レコードを事前作成
       - `kind: "inserted_new"`, `attribution: "ai"`, `aiRationale`, `strength`, `aiReasoning`, `lastEvaluatedAt` をプリセット
    2. `editor.chain().insertContentAt(...).setTextSelection(...).setMark("foreshadowSetup", ...).run()` でテキスト挿入 + mark 付与
    3. `saveForeshadowAnchors(sceneId, editor.state.doc)` — ON CONFLICT は fromPos/toPos/isOrphan/updatedAt のみ更新。手順 1 で書き込んだ AI メタ（kind / attribution / aiRationale / strength）は保持される
    4. `saveSceneContent(sceneId, contentJson)`
    5. `createRevision({ entityType: "scene", entityId: sceneId, snapshotType: "auto" })` を **1 回だけ** 呼ぶ
    6. setups をリロード、`proposeResults` から採用済み候補を除去
  - 採用後の `proposeResults` からの除去は `designated_existing` 採用（`adoptProposedSetup`）と同一パターン

- **新規 Tauri コマンド**
  - `foreshadow_setup_create_ai`: AI メタデータ付き INSERT（ON CONFLICT はアンカーのみ更新）。`ai_reasoning` / `last_evaluated_at` も含む
  - `foreshadow_audit_chapter`: 章監査 AI パス（Rust 側プロンプト生成 + OpenRouter 呼び出し）

**Phase 3 の残課題・見送り**

- `load_bearing` 軸（除去テスト前提、empirical データ未充足のため E スコープとして見送り）
- quota / rate-limit（Phase 3 計画には含まれていたが未実装。AI 呼び出しは手動トリガのみで暫定許容）
- `fromPosHint` が null の `designated_existing` 採用時は position=0 にフォールバック。toast エラーへの変更は post-Phase 3 ポリッシュ候補

### Phase 4（伏線本体メタデータ編集 / ライフサイクル UI）

**動機**

Phase 1〜3 は伏線の **作成 / setup 操作 / AI 評価 / 章監査** に注力した結果、伏線本体（`foreshadows` 行）のメタデータを後から編集する経路が **完全に欠落**している。

| フィールド | DB / IPC | UI 経路 |
|---|---|---|
| `title` | `foreshadow_update` 対応済 | **欠落**（作成時のみ） |
| `intent` | 同上 | **欠落**（作成時のみ） |
| `notes` | 同上 | **欠落**（一度も UI 露出していない） |
| `payoffConfirmed` | 同上 | **欠落**（label 計算で読むのみ） |
| `abandoned` | 同上 | **欠落**（フィルタ表示のみ） |
| payoff anchor 解除 | 同上（payoffSceneId / payoffFromPos / payoffToPos を null で update） | **欠落**（line 900「明示的に anchor を削除 → 入口③で再指名」を支える UI が無い） |

**スコープ**

- 伏線パネルの各行に「編集」ボタン（Pencil アイコン、Trash2 と並べる）
- `EditForeshadowDialog` を新設（`CreateForeshadowDialog` とは統合せず分離）
- 既存 `foreshadow_update` Tauri command をそのまま使用（**IPC 追加なし**）
- 関連 Codex 編集 / Setup の作者 strength 編集は Phase 5+ に切り出す

**EditForeshadowDialog レイアウト**

```
┌────────────────────────────────────────────┐
│ 伏線を編集                                  │
├────────────────────────────────────────────┤
│ タイトル:     [_____________________]       │
│ 回収意図:     [_____________________]       │
│               (何を回収したいか)            │
│ メモ:         [_____________________]       │
│               [_____________________]       │
│                                            │
│ ─ ライフサイクル ──                        │
│ [ ] 払い出し成立として確定                  │
│       ※ payoff anchor 必須               │
│ [ ] 破棄                                   │
│                                            │
│ ─ Payoff anchor ──                        │
│ シーン: ch.12 / scene 3   [→ジャンプ]      │
│ [Payoff anchor を解除]                     │
│                                            │
│             [キャンセル]  [保存]            │
└────────────────────────────────────────────┘
```

`title` / `intent` / `notes` / `payoffConfirmed` / `abandoned` の差分のみを `updateForeshadow(id, patch)` に渡す。`payoffConfirmed` は payoff anchor 未設定時にディスエーブル + ヘルプ文表示。

**Payoff anchor 解除のセマンティクス**

「Payoff anchor を解除」は **2 段階処理**：

1. **DB 更新**: `updateForeshadow(id, { payoffSceneId: null, payoffFromPos: null, payoffToPos: null, payoffConfirmed: false })`
2. **Open editor の mark sweep**: 該当シーンが現在 open であれば、その editor の `ForeshadowPayoffMark`（`foreshadowId === id`）を `unsetForeshadowPayoffMarksByForeshadowIds([id])` で除去

設計判断：open でないシーンの mark は次回ロード時に「DB に anchor が無い → mark 適用しない」で自動的に消える（ロードロジックは DB → mark の方向のみで再構成するため）。明示 sweep は **現在 open しているシーンの不整合だけ**を解決すればよい。これは Foreshadow 削除時の sweep ロジック（line 373-382）と同じ思想。

**保存後の処理**

- `useForeshadowStore.load(projectId)` を呼んで panel をリフレッシュ
- ダイアログを閉じる
- toast 不要（変更は panel に即時反映されるため可視）

**lifecycle トグルの確認モーダル**

- `abandoned` / `payoffConfirmed` のトグルは **確認モーダルなし**。誤操作は再トグルで取消可能（state の対称性を信頼）
- payoff anchor 解除のみ確認モーダル（mark の物理削除を伴うため）

**Phase 4 完了の定義**

- 伏線パネルから既存伏線の title / intent / notes を後付け編集できる
- 「破棄」「払い出し成立」を作者が UI から明示できる
- payoff anchor を解除して入口③（「回収先として指名」）から再指名できる
- 編集後 panel が即座に更新される

**Phase 4 の見送り（Phase 5+ 候補）**

- 関連 Codex リンクの編集 UI（line 835 / 865 の入口①②モックには記載があるが現在 Create dialog にも未実装）
- Setup の作者 strength 編集（現状 `null` 固定で、AI strength のみ表示）

---

## Deferred decisions

| 項目 | 判断 | 再検討タイミング |
|---|---|---|
| `load_bearing` の独立軸採用 | Phase 1 では持たない | Phase 3 着手時に Phase 1〜2 の実利用データから実証判断 |
| 読者ペルソナの数と種類 | 3 人（careful / casual / skim）で開始 | **Phase 2 で実装済み**。コスト・有用性は Phase 3 着手時にレビュー |
| `ai_strength` の staleness 依存追跡 | `lastEvaluatedAt` のみで開始 | **Phase 2 で `sceneUpdatedAt` JOIN による判定を実装済み** |
| Mark 表示のデフォルト | 執筆モード（非表示） | ユーザ設定で切替、好み判明したら既定変更検討 |
| `proposePastSetups` UI エントリポイント | **Phase 3 で実装済み**。「Setup を提案」ボタン、候補インライン表示、`designated_existing` 採用 / `inserted_new` 「挿入して採用」フルフロー | — |
| `fromPosHint` null 時の `designated_existing` 採用 | `fromPosHint ?? 0` フォールバック（position=0 になる）。toast エラーへの変更は post-Phase 3 | Phase 4 or ポリッシュ時に対応 |
| quota / rate-limit | Phase 3 計画には含まれていたが未実装。手動トリガのみで暫定許容 | Phase 4 以降で対応 |

---

## Open questions

1. **AI モデル選定の固定 vs ユーザ設定優先**: structured output 必須なので一定の制約あり。デフォルトを Sonnet にするか、ユーザのデフォルトAIモデルを尊重するか
2. **過去シーン要約のキャッシュ層**: `propose_past_setups` の入力で要約を毎回生成するか、`chat_summaries` 機構と統合するか、新規キャッシュテーブルを作るか
3. **複数 payoff シーン跨ぎ**: 1 foreshadow に複数 payoff scene のケース（連作・伏線連鎖）。現設計は単数前提だが、Phase 3 で対応する場合の拡張形式
4. **Markdown export 後の reimport 経路**: 後述「Markdown export/import の挙動」参照。再リンク UI を提供するか、諦めるか
5. **伏線パネルのレイアウト位置**: Right Panel / Bottom Dock / 専用 Floating のどれを既定にするか

---

## Migration & rollback

### Migration

- Drizzle migration ファイル新規追加: `XXXX_add_foreshadow_tables.sql`
- 3 テーブル追加（`foreshadows` / `foreshadow_setups` / `foreshadow_codex_links`）
- 全テーブルに index 追加（上述スキーマ参照）
- 既存データへの影響なし（追加のみ）

### Rollback

- migration の DOWN: 3 テーブルを drop
- 既存データに影響なし
- ただし Mark が docJson に書き込まれた状態で rollback すると：
  - parse 時に未知 Mark として無視される（TipTap デフォルト挙動）
  - 次回保存時に Mark がそのまま残る or `unknown` として剥がされる
  - **注意**: 一度 Mark を書き込んだ docJson は ForeshadowMark 拡張無しでロードしても壊れないが、Mark が消える可能性あり

ロールバック時のデータ消失リスクは「foreshadow テーブルのデータが全消失」と「doc 内 Mark の attrs 剥がれ」のみ。本文テキスト自体は無事。

---

## Testing strategy

### Unit tests

- `deriveLabel()` 関数の全ケース（abandoned / orphan_payoff / planned / paid / needs_strengthening / seeded）
- 派生ラベル計算が boolean 2 つ + Setup 集計から正しく算出されるか
- `saveForeshadowSetupsForScene()` の各分岐：
  - 新規 mark → INSERT
  - 既存 mark → UPDATE（固有メタ温存）
  - mark 消失 → isOrphan=true
  - 削除済み foreshadow を指す mark → strip

### Integration tests

- ProseMirror transaction 経由で setup mark の範囲が正しく追従するか
  - テキスト挿入で範囲拡張
  - テキスト削除で範囲縮小
  - 範囲全削除で mark 消失（→ orphan 検出）
- ロード → 編集 → 保存 → 再ロードのラウンドトリップで anchor が一致
- foreshadow 削除 → シーン保存で FK 違反が発生しない
- copy-paste で setupId 重複が起きない（paste rule の strip 動作）

### E2E tests

- 伏線要請ダイアログから AI 提案 → 採用 → setup 作成のフルフロー
- 伏線パネルでの一覧表示・filter・詳細遷移
- orphan resolution UI（再アンカー / 削除）

### Vitest 配置

`src/features/foreshadow/` 配下のソースと同階層に `*.test.ts` を配置（既存規約に従う）。

---

## Markdown export/import の挙動

### Export

`ForeshadowSetupMark` / `ForeshadowPayoffMark` は Markdown export で**剥がれる**（CommentMark と同じ挙動、TipTap デフォルト）。これは執筆物としては正しい挙動。

含意：
- export された .md ファイルから伏線情報は読み取れない
- foreshadow テーブルのデータはエクスポート対象外（別途エクスポート機能を将来検討する場合は議題化）

### Import（外部書き換え経路の影響）

シーン本文を**外部経路**（Markdown reimport / 直接 SQL 編集 / 他クライアント）で書き換えた場合：

- editor 内の Mark は失われる（reimport は新しい docJson を生成）
- DB の `foreshadow_setups.fromPos` / `toPos` は古いまま残る
- 次回シーンを開くとロード時に Mark を復元しようとするが、テキストが変わっているので**意図しない範囲を Mark してしまう**可能性

### 対応方針

- 仕様として明記：reimport は伏線 anchor を破壊する
- 警告ダイアログを reimport 時に表示
- 影響を受けた foreshadow を全て orphan 化する選択肢を提供
- 完全自動修復は試みない（誤った位置を Mark するリスクの方が大きい）

> 既存の authorship_spans も同じリスクを抱えている。新しい問題ではなく、既存リスクの再生産という位置付けで許容。

---

## 実装ファイル配置

```
src/features/foreshadow/
├── api.ts                                 # Tauri command wrapper + AI 連携（proposePastSetups / evaluateSetupStrength / auditChapter / getChapterForeshadowStats）
├── types.ts                               # ForeshadowFilter, DerivedLabel, AiEvaluation, ChapterAuditRequest, AuditCandidate, ChapterForeshadowStats, etc.
├── deriveLabel.ts                         # 派生ラベル計算関数
├── deriveLabel.test.ts
├── staleness.ts                           # isSetupEvaluationStale（Phase 2）
├── staleness.test.ts
├── saveAnchors.ts                         # save logic（FK sweep + UPSERT + orphan）
├── saveAnchors.test.ts
├── foreshadowStore.ts                     # Zustand store（伏線パネル UI 状態 + AI アクション）
├── foreshadowStore.test.ts
├── foreshadowStore.adoptProposedSetup.test.ts  # Phase 3: adoptProposedSetup テスト
├── foreshadowStore.adoptInsertedNew.test.ts    # Phase 3: adoptInsertedNewSetup テスト
├── ForeshadowPanel.tsx                    # メインパネル（一覧タブ + 章別監査タブ切替）
├── ForeshadowPanel.test.tsx               # Phase 1/2 テスト
├── ForeshadowPanel.phase3.test.tsx        # Phase 3 テスト（タブ切替 / Setup 提案ボタン）
├── ForeshadowPanel.stories.tsx            # Storybook
├── ForeshadowChapterTab.tsx               # 章別監査ダッシュボード（Phase 3）
├── ForeshadowMarkPopover.tsx              # setup mark 右クリックポップオーバー
├── ForeshadowMarkPopover.test.tsx
├── ForeshadowMarkHoverPopover.tsx         # hover 表示
├── CreateForeshadowDialog.tsx             # 伏線作成ダイアログ（initialTitle / initialIntent プリフィル対応）
├── EditForeshadowDialog.tsx               # 伏線編集ダイアログ（Phase 4: title/intent/notes/payoffConfirmed/abandoned + anchor 解除）
├── EditForeshadowDialog.test.tsx          # Phase 4: 編集パッチ送信 / anchor 解除 / lifecycle トグルのテスト
├── types.test.ts                          # safeParseAiEvaluation 等の型ユーティリティテスト
├── api.tauri.test.ts                      # Tauri ブランチ unit テスト
├── api.proposePastSetups.test.ts          # proposePastSetups unit テスト
├── api.auditChapter.test.ts               # auditChapter unit テスト（Phase 3）
├── api.getChapterForeshadowStats.test.ts  # getChapterForeshadowStats unit テスト（Phase 3）
└── marks/
    ├── ForeshadowSetupMark.ts             # Setup Mark 定義（setupId / foreshadowId attrs）
    ├── ForeshadowPayoffMark.ts            # Payoff Mark 定義（foreshadowId attr）
    ├── foreshadowPasteRule.ts             # transformPasted で foreshadow 系 mark を strip
    └── ForeshadowMarks.test.ts            # mark + paste rule のテスト

src-tauri/src/lib.rs                       # foreshadow 関連 Tauri コマンドを lib.rs に直書き
                                           # （foreshadow_create / foreshadow_update / foreshadow_delete /
                                           #   foreshadow_list / foreshadow_get /
                                           #   foreshadow_link_codex / foreshadow_unlink_codex /
                                           #   foreshadow_set_setup_strength / foreshadow_resolve_orphan /
                                           #   foreshadow_save_anchors_for_scene / foreshadow_load_anchors_for_scene /
                                           #   foreshadow_propose_past_setups /
                                           #   foreshadow_setup_create_ai（Phase 3）/ foreshadow_audit_chapter（Phase 3））
                                           # ※ evaluateSetupStrength / getChapterForeshadowStats は
                                           #    Rust IPC を持たず src/features/foreshadow/api.ts に純 TS で実装
                                           #    （前者は sendChatMessageWithThinking 直呼び、後者は DB 集計のみ）

drizzle/migrations/
└── XXXX_add_foreshadow_tables.sql         # Phase 1 migration（追加 migration なし）
```

---

## 関連設計書

- **Grimodex_Editorパネル設計書.md**: AuthorshipMark 機構（雛形として流用）
- **Grimodex_Attributionパネル設計書.md**: authorship_spans の保存パターン（対比対象）
- **Grimodex_Codexパネル設計書.md**: Codex 詳細タブ統合先。同設計書の「スパン単位セマンティックリンク」とは排他関係で、setup→payoff の回収構造を持つ叙述トリック・信頼できない語り手系のユースケースは本レジスタで吸収する（純 disambiguation はセマンティックリンク側）
- **Grimodex_Snippetsパネル設計書.md**: Phase 2 の chat 抽出経路統合先
- **Grimodex_リビジョン履歴設計書.md**: Phase 3 の Revision 統合先
- **Grimodex_統合DBスキーマ.md**: スキーマ追加時に更新必要

---

## 改訂履歴

- 2026-04-25: 初版作成。Phase 1 設計確定、Phase 2/3 概要、deferred decisions 明示。
- 2026-04-26: Phase 2 実装完了に伴う更新。`aiReasoning` JSON フォーマット（AiEvaluation）、`evaluateSetupStrength`、staleness 判定、`anyWeak` 精緻化、Codex タブ、Snippet 入口を追記。`proposePastSetups` UI 未実装を deferred decisions に追加。
- 2026-04-26: Phase 3 実装完了に伴う更新（同日）。スコープ A+B+C+D を実装、E（load_bearing 軸）は見送り。
  - AI 連携（Phase 3）セクション追加: `auditChapter`（章監査）/ `getChapterForeshadowStats`（DB 集計）/ `adoptInsertedNewSetup`（挿入 + revision 統合）の設計詳細。
  - 当初計画では AI 入力に synopsis を使う想定だったが、「伏線特有のさりげない描写を synopsis では拾えない」理由により**本文そのもの**を送る方式に変更。トークン爆発はスコープ制約（章単位 / 手動トリガ）で抑える。
  - IPC surface に `foreshadow_setup_create_ai` / `foreshadow_audit_chapter` を追加。
  - `ForeshadowMarkPopover` の `payoff-unanchored` フィルタをラベルホワイトリスト（`planned` / `seeded`）に修正（Phase 2 残バグ）。
  - 実装ファイル配置を実際のファイル構成に合わせて更新。deferred decisions に Phase 3 完了分と残課題を反映。
- 2026-04-28: Phase 4 セクション追加（伏線本体メタデータ編集 / ライフサイクル UI）。`EditForeshadowDialog` の設計を策定: title / intent / notes / payoffConfirmed / abandoned の編集経路と payoff anchor 解除フロー（DB 更新 + open editor の mark sweep 2 段階）を確定。**IPC 追加なし**で既存 `foreshadow_update` を流用。副入口：伏線パネルの記述を Phase 2/3 の inline 展開に合わせて更新し、編集ダイアログへの参照を追加。実装ファイル配置に `EditForeshadowDialog.tsx` / `.test.tsx` を追加。関連 Codex 編集と Setup 作者 strength 編集は Phase 5+ として切り出し。
- 2026-04-27: 実装と設計書の差分修正。`evaluateSetupStrength` / `getChapterForeshadowStats` は実装上 Rust IPC を持たず `src/features/foreshadow/api.ts` の純 TS 実装である旨を実装ファイル配置セクションに追記（旧表記の `foreshadow_evaluate_setup_strength` を削除）。実装ファイル配置の TS ツリーを実態に合わせて補完: `marks/` サブディレクトリ（ForeshadowSetupMark / ForeshadowPayoffMark / foreshadowPasteRule + テスト）、`foreshadowStore.adoptProposedSetup.test.ts`、`ForeshadowPanel.stories.tsx`、`types.test.ts`、`api.getChapterForeshadowStats.test.ts` を追記。
