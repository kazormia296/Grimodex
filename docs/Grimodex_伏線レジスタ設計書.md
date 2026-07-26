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

  // AI コンテキスト注入から除外するかのフラグ（新規作成時の既定は true / 秘匿）
  // 詳細は「AI コンテキスト注入と secret フラグ」セクション参照
  secret: integer("secret", { mode: "boolean" }).notNull().default(true),

  // 構造的重要度（Phase 6）。null は未設定で既存伏線の挙動を維持
  loadBearing: text("load_bearing"),                     // 'critical' | 'supporting' | 'optional' | null

  // impact-review（2026-06-18 追記）。リンク先 Codex の変更時刻。setup の
  // lastEvaluatedAt より新しければ「Codex 変更により再評価が必要」と stale 判定する
  // （null=未変更）。詳細は「Codex 変更追従（codexLinkDirtyAt）」セクション参照
  codexLinkDirtyAt: integer("codex_link_dirty_at", { mode: "timestamp_ms" }),

  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  lastEvaluatedAt: integer("last_evaluated_at", { mode: "timestamp_ms" }),

  isOrphan: integer("is_orphan", { mode: "boolean" }).notNull().default(false),  // mark消失検出時に立てる

  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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

## AI コンテキスト注入と secret フラグ

伏線レジスタは「未回収伏線一覧を AI コンテキストに確定的に注入する」ことを目標に掲げる（→ 「目標」セクション）。一方、ネタバレ回避のために**この伏線は AI に見せたくない**ケース（未明かしの真相を AI に執筆させる場面など）が存在する。

そのため `foreshadows.secret: boolean` を導入する。

| 観点 | 値 |
|---|---|
| 新規 INSERT 時の既定 | `true`（DB schema default = 1） |
| 既存伏線への migration 既定 | `false`（後方互換のため、`add_column_if_missing` は default 0 で adds） |
| 編集経路 | `EditForeshadowDialog` のチェックボックスで作者が切替（Phase 5 で実装） |
| Create dialog での編集 | **なし**（DB default に委ねる。作成時の dialog 肥大化を避ける） |

### `listOpenForeshadowsForContext`：AI コンテキスト用フィルタ

`src/features/foreshadow/api.ts` の純 TS 関数。シーン補完／チャットの context-injection 時にこれを呼ぶ。

```ts
// 概念: projectId 内の「生きている未回収」かつ「秘匿でない」伏線を返す
where (
  projectId = ? AND
  payoffConfirmed = false AND
  abandoned = false AND
  secret = false
)
```

呼び出し元: `src/features/chat/chatStore.ts`、`src/features/chat/agent/toolExecutors.ts`。AI に渡るのは `secret = false` のもののみ。

### 設計判断

- **既定が秘匿（true）であるべき理由**: 「うっかり書いた伏線が AI に漏れる」より「明示的に開示した伏線のみ AI が知る」方が事故が少ない。執筆ワークフローでは、開示判断は意識的に行うべき作業。
- **migration 既定が `false` であるべき理由**: 既存伏線は既に「AI に渡るもの」として作者が判断済み（Phase 1〜4 はそもそも secret フラグが無かった）。後付けで全件秘匿化すると挙動が変わるため、後方互換で `false` を採用。
- **Create dialog から外す理由**: 新規作成時の UI を肥大化させない。`secret = true`（新規 INSERT 既定）→ 開示したくなったら EditForeshadowDialog で切替、という流れにする。実利用で「作成直後に開示したい」頻度が高ければ Phase 7+ で再検討。

---

## Agent write 連携（2026-06-18 追記）

Chat Agent から伏線本体を**作成 / 更新**できる。読み取り（`list_open_foreshadows`）に加えて、伏線が read/write とも chat・MCP 対称になった（どちらも tracked write 経由）。コミット 5e4c1a9e（前提は foreshadow tracked 化 7df9374d）。

### ツール定義

`src/features/chat/agent/toolDefinitions.ts` に 2 ツール：

| ツール | 必須 | 主なフィールド |
|---|---|---|
| `create_foreshadow` | `title` | `intent` / `notes` / `loadBearing`（critical/supporting/optional）/ `secret`（既定 true） |
| `update_foreshadow` | `id` | `title` / `intent` / `notes` / `loadBearing` / `payoffConfirmed` / `abandoned` / `secret`（与えた項目のみ変更） |

`create_foreshadow` の `secret` 既定は `true`（MCP parity）。description に「同会話内で読み返すなら `secret=false`」を明記し、`secret=true` の plant は `list_open_foreshadows` / AI コンテキストから隠れる（→「AI コンテキスト注入と secret フラグ」）。

### 実行経路

`toolExecutors.ts` → `src/features/agent-writes/foreshadow.ts` の `agentCreateForeshadow` / `agentUpdateForeshadow`：

1. `blockIfPolicyOff("knowledgeWrite")` ゲート（OFF なら throw、`MUTATING_EXECUTORS` 経由で error result 化）。`loadBearing` 値検証・空 patch 拒否。
2. Tauri `agent_foreshadow_create` / `agent_foreshadow_update`（`src-tauri/src/commands/agent_writes.rs`）→ `grimodex_core::writes::foreshadow::tracked_foreshadow_create/update`。entity 書き込み + `undo_journal` + `change_event` を **1 tx**・`surface="in-app-agent"`（recorder session 連動）。
3. `useForeshadowStore.load(projectId)` でパネルをリロードし、書き込んだ行を返す。
4. `useGlobalHistoryStore.push({ kind: "foreshadow", undo/redo })` で undo/redo を登録。undo/redo は `applyUndoJournal(undoJournalId, "undo"|"redo")`（実装済みの foreshadow revert/apply アーム）→ 再度 store reload。`isReplaying` 中は push をスキップ。

### injection 遮断

`create_foreshadow` / `update_foreshadow` は MUTATING ツールなので、Hermes 本文 channel 経由の駆動を JS `MUTATING_TOOL_NAMES` と Rust `HERMES_BLOCKED_TOOL_NAMES` の両セットで遮断する（prompt injection 駆動の書き込みベクタ封じ）。

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

> **`relatedCodex` の自動投入（`detectRelatedCodex`、2026-06-18 追記）**: `relatedCodex` は手動指定だけでなく、本文テキストから自動検出できる。`src/features/foreshadow/api.ts` の `detectRelatedCodex(text)` が chat の auto-detect と同じ `findMentionedEntriesAsync`（editor 非依存・text ベースの Rust マッチャ）でシーン本文中の Codex 言及を拾い、`{ id, name, summary }` に整形する。`contextMode` が `hidden` / `suppress` のエントリと summary 空のエントリは除外し、エントリ数（最大 20）と合計文字数（3000 字）で上限を掛ける。

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

**実装形態（2026-06-18 追記）**

`proposePastSetups` は **Tauri command ではなく `src/features/foreshadow/api.ts` の純 TS 関数**で、`sendChatMessageWithThinking` を直接呼ぶ（Rust 側の `foreshadow_propose_past_setups` は存在しない）。冒頭で `blockIfPolicyOff("analysis")` を評価し、AiPolicy の analysis トグルが OFF なら **LLM を呼ばず `[]` を即返す**（kouetsu の分析系 view と同じ correctness 層。詳細は ai-policy/policyGuard.ts）。生成 usage は `recordAiUsage({ surface: "foreshadow" })` で台帳に記録する。

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

**実装形態 / AiPolicy gate（2026-06-18 追記）**

`evaluateSetupStrength` も純 TS（`sendChatMessageWithThinking` 直呼び・Rust IPC なし）。冒頭で `blockIfPolicyOff("analysis")` を評価し、analysis トグルが OFF なら **LLM を呼ばず `null` を返す**。usage は `recordAiUsage({ surface: "foreshadow" })`。

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

**実装形態（2026-06-18 訂正）**

`auditChapter` は **Tauri command ではなく `api.ts` の純 TS**で、Tauri / ブラウザを問わず `sendChatMessageWithThinking` を直接呼ぶ（旧記述の「Tauri は `foreshadow_audit_chapter` Rust IPC でプロンプト生成 + OpenRouter」は誤り。Rust 側 audit command は存在しない）。冒頭で `blockIfPolicyOff("analysis")` を評価し、analysis トグル OFF なら LLM を呼ばず `[]` を返す。空シーン除外後にシーン本文を結合してプロンプト化する。usage は `recordAiUsage({ surface: "foreshadow" })`。

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

### Staleness 判定（Phase 2 実装済み / 2026-06-18 第 3 要因追加）

```ts
// src/features/foreshadow/staleness.ts
export function isSetupEvaluationStale(
  setup: ForeshadowSetupRow,
  sceneUpdatedAt: string,             // treeNodes.updatedAt（ISO 文字列）
  codexLinkDirtyAt?: Date | null,     // 2026-06-18 追記: impact-review
): boolean {
  if (!setup.lastEvaluatedAt) return true;
  if (new Date(sceneUpdatedAt) > setup.lastEvaluatedAt) return true;
  if (codexLinkDirtyAt && codexLinkDirtyAt > setup.lastEvaluatedAt) return true;
  return false;
}
```

`sceneUpdatedAt` は `listSetups()` 時に `treeNodes` を LEFT JOIN して取得し、`ForeshadowSetupRow.sceneUpdatedAt?: string` として付与する（非永続フィールド、DB には保存しない）。UI では黄色 dot でインジケートする。

### Codex 変更追従（`codexLinkDirtyAt`）（2026-06-18 追記）

impact-review 連携。**リンク先 Codex の埋め込み対象フィールド（name / aliases / summary / content）が更新されると、関連伏線の AI 強度評価を stale 扱い**にする経路を追加した。スキーマ詳細は **Grimodex_統合DBスキーマ.md**（`foreshadows.codex_link_dirty_at`）を参照。

- **マーク（書き込み）**: `src/features/codex/api.ts` の Codex 更新で、埋め込みに効く差分があれば（`scheduleCodexIndex` と同条件）`markLinkedForeshadowsDirty(entryId)` を呼ぶ。`foreshadow_codex_links` を辿り、リンク先 `foreshadows.codexLinkDirtyAt` を現在時刻に一括 update する。リンク無しは no-op、失敗は非致命（保存自体は妨げない）。
- **判定（読み取り）**: 上記 `isSetupEvaluationStale` の第 3 引数。`codexLinkDirtyAt > setup.lastEvaluatedAt` なら stale。`ForeshadowPanel` が `item.codexLinkDirtyAt` を SetupRow に渡し、既存の「シーン更新で stale」黄色 dot と同じインジケータに合流させる。
- 既存伏線・新規作成時は `null`（未変更）。`api.ts` の行正規化が `codex_link_dirty_at` の snake_case フォールバックを持つ。

---

## IPC surface（Tauri Commands）

実体は `src-tauri/src/commands/foreshadow.rs`（lib.rs の `invoke_handler` に登録）。
**AI passthrough（`propose_past_setups` / `evaluate_setup_strength` / `audit_chapter`）は Tauri command ではなく、
`src/features/foreshadow/api.ts` の純 TS が `sendChatMessageWithThinking` を直接呼ぶ**（→ 「AI 連携（Phase 1〜3）」参照）。Rust 側 AI command は存在しない。

```rust
// src-tauri/src/commands/foreshadow.rs（lib.rs で登録）

#[tauri::command]
foreshadow_create(project_id: String, title: String, intent: Option<String>) -> Result<Foreshadow>

#[tauri::command]
foreshadow_update(id: String, patch: ForeshadowPatch) -> Result<Foreshadow>

#[tauri::command]
foreshadow_delete(id: String) -> Result<()>

#[tauri::command]
foreshadow_get(id: String) -> Result<ForeshadowDetail>
// setup一覧、orphan setup含む

#[tauri::command]
foreshadow_link_codex(foreshadow_id: String, codex_id: String) -> Result<()>

#[tauri::command]
foreshadow_unlink_codex(foreshadow_id: String, codex_id: String) -> Result<()>

#[tauri::command]
foreshadow_list_linked_codex(foreshadow_id: String) -> Result<Vec<CodexEntry>>
// Phase 5 で追加。EditForeshadowDialog 起動時に関連 Codex を表示するための片方向クエリ。
// Codex 詳細側からの逆参照（listForeshadowsByCodexEntry）と双方向で対になる。

#[tauri::command]
foreshadow_save_anchors_for_scene(scene_id: String, payload: SaveAnchorsPayload) -> Result<SaveAnchorsResult>
// SaveAnchorsResult に invalid_setup_ids（mark側で strip すべきID）を含める

#[tauri::command]
foreshadow_load_anchors_for_scene(scene_id: String) -> Result<LoadAnchorsResult>

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
```

### 追加コマンド群（2026-06-18 追記）

ForeshadowPanel / 章別監査 / Codex タブ / AI コンテキスト注入の DB 集計・読み取りを担う AI 不使用の Rust コマンド群が追加されている（いずれも `ws_state` を取り `Result<_, AppError>` を返す）：

```rust
#[tauri::command]
foreshadow_list_with_labels(project_id: String) -> Result<ForeshadowListWithLabelsResponse>
// 派生ラベル + setup 集計を付与した一覧（パネルの主クエリ）。

#[tauri::command]
foreshadow_list_open_for_context(project_id: String) -> Result<ForeshadowListWithLabelsResponse>
// AI コンテキスト注入用フィルタ（payoffConfirmed=false かつ abandoned=false かつ secret=false）。
// TS wrapper は listOpenForeshadowsForContext。→ 「AI コンテキスト注入と secret フラグ」参照。

#[tauri::command]
foreshadow_get_scene_info(scene_id: String) -> Result<ForeshadowSceneInfoResponse>

#[tauri::command]
foreshadow_get_scene_context(scene_id: String) -> Result<ForeshadowSceneContextResponse>
// propose / audit のシーン文脈（excerpt / past scenes 等）を組み立てる読み取り。

#[tauri::command]
foreshadow_list_by_codex_entry(codex_entry_id: String) -> Result<ForeshadowListWithLabelsResponse>
// Codex 詳細「伏線」タブの逆参照（listForeshadowsByCodexEntry）。

#[tauri::command]
foreshadow_get_chapter_stats(chapter_id: String) -> Result<ForeshadowChapterStatsBundle>
// 章別監査ダッシュボードの統計（getChapterForeshadowStats）。AI 不使用。

#[tauri::command]
foreshadow_get_setup(setup_id: String) -> Result<Option<Value>>

#[tauri::command]
foreshadow_update_setup(id: String, patch: ForeshadowSetupPatch) -> Result<()>
// setup の固有メタ（strength / aiStrength / aiReasoning / lastEvaluatedAt 等）を差分パッチ更新。
```

### Agent write commands（2026-06-18 追記）

Chat Agent から伏線本体を作成 / 更新するための tracked write 系（`src-tauri/src/commands/agent_writes.rs`、内部で `grimodex_core::writes::foreshadow::tracked_foreshadow_create/update` を呼ぶ）。詳細は「Agent write 連携」セクション参照：

```rust
#[tauri::command]
agent_foreshadow_create(payload: AgentForeshadowCreatePayload) -> Result<AgentWriteResult>

#[tauri::command]
agent_foreshadow_update(payload: AgentForeshadowUpdatePayload) -> Result<AgentWriteResult>
// AgentWriteResult: { entityId, version, changeEventUid, undoJournalId }
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

### 副入口：伏線レーダータブ（2026-06-20 追記 / #123 shipped）

伏線パネルの第 3 タブ「**レーダー**」（`ForeshadowRadarTab`）。回収状況を読書順タイムライン上で俯瞰する読み取り専用ビューで、AI 不使用・純フロントエンド集計（`buildForeshadowRadarModel`）。

- **ヘッダーのサマリー**: `abandoned` を除いた回収率（`paid / total`）を % と積み上げバーで表示。内訳チップは **確定回収（paid）/ 未回収（planned + seeded）/ 要注意（critical_weak + needs_strengthening + orphan_payoff）**、`abandoned` が 1 件以上ある場合のみ **破棄** チップも出す。
- **アークタイムライン**: 読書順（`computeGlobalSceneOrder`）の x 軸上に、各伏線を「最早 Setup → Payoff」を結ぶ円弧（SVG）として描く。アーク高さはスパン（読書順インデックス差）に比例。x 軸上部に章バンド（読書順で連続する同一トップレベルフォルダ）の区切り線とラベルを重ねる。
- **状態の描き分け**:
  - 確定回収（payoff 確定）= 実線アーク + 両端塗りマーカー
  - 未回収（payoff 未確定）= 末尾フロンティア（最終シーン）まで破線でダングリングし、終端は中空マーカー
  - 回収先シーン欠落（broken: payoff 確定だが読書順に該当シーンなし）= 未回収と同じくフロンティアまでダングリング
  - orphan_payoff（Setup 不在で payoff マーカーのみ）= 弧を描かず payoff マーカーのみ
  - 派生ラベルの色はパネル共通の `foreshadowLabelStyles` を流用
- **未配置（floating）**: Setup も Payoff も本文に存在しない伏線はタイムライン外の別枠にラベルピルで列挙し、クリックで一覧タブ側へハイライト要請（`requestPanelHighlight`）。
- **インタラクション**: アーククリックで Setup / Payoff シーンへジャンプ（`requestForeshadowJump`、payoff は本文内位置で選択範囲付き）。「**回収済みを隠す**」トグルで paid アークを一時的に伏せられる（paid が 1 件以上あるときのみ表示）。
- **データの鮮度**: load 時スナップショット（`setupScenesByForeshadowId`）を基本に、setup 編集で再ロード済みの伏線は live な `setupsByForeshadowId` で上書きし、編集後も俯瞰を正確に保つ。

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
  - 実装は純 TS（`sendChatMessageWithThinking` 直呼び）で Tauri / ブラウザ共通。Rust IPC は持たない（2026-06-18 訂正）

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
  - （2026-06-18 訂正）`auditChapter` は当初 Rust IPC を想定していたが、実装は純 TS で `foreshadow_audit_chapter` コマンドは存在しない

**Phase 3 の残課題・見送り**

- `load_bearing` 軸（除去テスト前提、empirical データ未充足のため E スコープとして見送り）
- quota / rate-limit（Phase 3 計画には含まれていたが未実装。AI 呼び出しは手動トリガのみで暫定許容）
- `fromPosHint` が null の `designated_existing` 採用時は position=0 にフォールバック。toast エラーへの変更は post-Phase 3 ポリッシュ候補

### Phase 4（2026-05-16 完了 — 伏線本体メタデータ編集 / ライフサイクル UI）

**実装済み**

- `EditForeshadowDialog.tsx` 新設（伏線パネルから Pencil ボタンで起動）
- title / intent / notes / payoffConfirmed / abandoned の全フィールド差分パッチ送信
- payoff anchor 解除フロー（確認モーダル → DB null 更新 + open editor の payoff mark sweep）
- `payoffConfirmed` の disable 制御（anchor 未設定 / 解除予約時）
- 「破棄」「成立確定」は確認モーダル無し、anchor 解除のみ確認モーダル
- IPC は既存 `foreshadow_update` を流用（追加なし）

**設計通りだが補足**: Phase 5 で同 dialog に Codex リンク編集と `secret` チェックボックスを、Phase 6 で `loadBearing` セレクタを追加実装したため、`EditForeshadowDialog` の実体は Phase 4 で骨格を確定し、Phase 5/6 で肉付けされた形になっている。

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

**Phase 4 の見送り（Phase 5 で対応）**

- 関連 Codex リンクの編集 UI（line 835 / 865 の入口①②モックには記載があるが現在 Create dialog にも未実装）
- Setup の作者 strength 編集（現状 `null` 固定で、AI strength のみ表示）

### Phase 5（2026-05-16 完了 — 関連 Codex リンク編集 + Setup 作者 strength 編集 + secret フラグ）

**実装済み**

- **A. 関連 Codex リンク編集**: `EditForeshadowDialog` に Codex セクション追加
  - `linksToAdd` / `linksToRemove` の 2 Set モデル（Cancel セマンティクス保持）
  - 「+ Codex を追加」展開 → incremental search → クリックで追加 / `×` で削除
  - Save 時に `addCodexLink` / `removeCodexLink` を順次適用
  - `handleSave` の Save 実行条件を「patch 空でも Codex 差分があれば成立」に拡張
  - 読み取り IPC `foreshadow_list_linked_codex` を 1 件追加（既定方針通り）
- **B. Setup 作者 strength 編集**: `ForeshadowPanel.tsx` の `SetupRow` に inline `<select>` 追加
  - subtle / moderate / overt / —（未設定）から選択
  - `setSetupStrength(setupId, value)` で即時反映 → `loadSetups(foreshadowId)` でリフレッシュ
- **C. `secret` フラグ（追加実装）**: 設計書では Phase 5 に元々含まれていなかったが、AI コンテキスト注入のネタバレ防止のため同時導入
  - `foreshadows.secret` カラム追加（DB 既定 true / migration 既定 false）
  - `EditForeshadowDialog` にチェックボックス追加（"AI にこの伏線を見せない"）
  - `listOpenForeshadowsForContext` が `secret = false` でフィルタ
  - 詳細は「AI コンテキスト注入と secret フラグ」セクション参照
- **TS wrapper**: `api.ts` に `setSetupStrength` / `listCodexEntriesByForeshadow` / `listForeshadowsByCodexEntry` / `listOpenForeshadowsForContext` を追加
- 新規コンポーネントファイルは作らず、既存ファイルへの追記で完結（設計通り）

**動機**

Phase 4 で見送った 2 件をまとめて埋める。両者とも Tauri IPC とテーブルは Phase 1 から存在し、UI のみが欠落している。Setup 作者 strength の編集は Phase 1 設計（line 882）で「伏線パネルからの後付け編集で代替し、Phase 2 でダイアログにも追加する」と予告されたが、Phase 1〜4 では伏線パネル側の編集 UI も実装されていなかった。Phase 5 はこの積み残しの遅延実装も兼ねる。

| 項目 | DB | 既存 IPC | TS wrapper | UI |
|---|---|---|---|---|
| `foreshadow_codex_links` (M:N) | ✓ | `foreshadow_link_codex` / `foreshadow_unlink_codex` | `addCodexLink` / `removeCodexLink` 既存（未使用） | **欠落** |
| `foreshadow_setups.strength` | ✓ | `foreshadow_set_setup_strength` | **未実装** | **欠落** |

**スコープ**

- 関連 Codex 編集 → `EditForeshadowDialog` に新セクションを追記（**`CreateForeshadowDialog` には追加しない**）
- Setup 作者 strength 編集 → `ForeshadowPanel` の `SetupRow` に inline UI を追記
- TS wrapper を `api.ts` に 2 つ追加: `setSetupStrength(setupId, strength)` / `listCodexEntriesByForeshadow(foreshadowId)`
- 新規コンポーネントファイルは作らない（既存ファイルへの追記のみ）

**Phase 4 との違い: 読み取り IPC を 1 件追加**

Phase 4 は「IPC 追加なし」を原則としたが、Phase 5 では `foreshadow_list_linked_codex(foreshadow_id) -> Vec<CodexEntry>` を 1 件追加する。理由：

- Codex リンクの一覧は Edit dialog を開いた時のみ必要で、`ForeshadowWithLabel` に M:N JOIN を組み込むと panel ロードのたびに不要な JOIN が走る
- 既存 `listForeshadowsByCodexEntry`（Codex タブ用）は逆方向の問い合わせで、双方向で持つのが自然
- Phase 4 の「IPC 追加なし」は Phase 4 限定の指針であり、Phase 全体の不変条件ではない

**A: 関連 Codex リンク編集**

`EditForeshadowDialog` 末尾に Payoff anchor セクションと並ぶ形で追加：

```
┌─ 関連 Codex ─────────────────────────────────┐
│  [人物A ×] [場所B ×] [+ Codex を追加]         │
│  ─── 追加検索 ───                             │
│  [_________________________]                  │
│  (incremental search で候補絞り込み)          │
└────────────────────────────────────────────────┘
```

**保存モデル**: Phase 4 の「全フィールド差分パッチ」に揃える（**即時反映しない**）。

ダイアログ内 state：

```ts
// open 時に listCodexEntriesByForeshadow(foreshadowId) でロード
const [initialLinkedIds, setInitialLinkedIds] = useState<Set<string>>(new Set());
const [linksToAdd, setLinksToAdd] = useState<Set<string>>(new Set());
const [linksToRemove, setLinksToRemove] = useState<Set<string>>(new Set());
```

UI 操作の整合：

- × 押下: `initialLinkedIds` にあれば `linksToRemove` に追加、`linksToAdd` にあれば `linksToAdd` から除去
- 追加: `initialLinkedIds` から外れていれば `linksToAdd` に追加、`linksToRemove` にあれば `linksToRemove` から除去
- 表示順: `(initialLinkedIds ∪ linksToAdd) − linksToRemove`

Save 時：

```ts
// Phase 4 の updateForeshadow() に続けて:
for (const id of linksToAdd) await addCodexLink(foreshadowId, id);
for (const id of linksToRemove) await removeCodexLink(foreshadowId, id);
```

**設計判断（即時反映しない理由）**：Edit dialog 全体が「Cancel で何もなかったことに」セマンティクスを保つため。即時反映にすると、Cancel 押下後も Codex リンクだけ DB に残って Save の意味が壊れる。`linksToAdd` / `linksToRemove` の 2 Set は M:N でも実装コストが極めて低く、保存モデル統一の利点が勝る。

**Save 実行条件の修正**（Phase 4 からの差分）：

Phase 4 の `handleSave` は `Object.keys(patch).length > 0` のときのみ `updateForeshadow` を呼ぶ実装だが、Phase 5 では「patch 空 + Codex リンクだけ変更」というケースが発生する。Save 実行条件を拡張する：

```ts
const hasPatch = Object.keys(patch).length > 0;
if (hasPatch) await update(item.id, patch, item.projectId);
for (const id of linksToAdd) await addCodexLink(item.id, id);
for (const id of linksToRemove) await removeCodexLink(item.id, id);
onClose();
```

これを忘れると Codex 単独編集 → Save が無反応になるため、実装時の必須条件として明記する。Codex リンク変更単独では panel 表示は変わらない（リンクは dialog 内でのみ表示）ため、`useForeshadowStore.load()` 呼び出しは Phase 4 の `update()` 内に既に組み込まれた経路で十分。

**Codex 検索 UX**

「+ Codex を追加」押下で incremental search 用テキスト入力欄を露出。既存の `listCodexEntries()` をそのまま呼んで全件取得 → クライアント側で `name` / `aliases` の部分一致でフィルタ。

**現状確認（projectId スコープ）**：`listCodexEntries(type?: CodexEntryType)` は projectId フィルタを取らず、`codex_entries` テーブル全件を返す。Phase 1 は単一プロジェクト前提で `PROJECT_ID = "default-project"` 固定運用のため許容するが、複数プロジェクト対応時に projectId スコープ追加が必要になる（**Phase 6+ 対応**、本 Phase ではスコープ外）。Phase 1 のデータ規模では全件取得＋クライアントフィルタで十分（Codex 数千件超で問題が出たら後段で type フィルタ等を追加）。

**B: Setup 作者 strength 編集**

`SetupRow` の strength バッジをクリック可能にし、クリックで小さなメニューを表示：

```
[moderate ▼]
  ├─ subtle
  ├─ moderate ✓
  ├─ overt
  └─ — (未設定)
```

選択で即時 `setSetupStrength(setupId, value)`。

**未設定（`strength === null`）時の表示**：プレースホルダー的な薄いアウトラインバッジ（「strength 未設定」）。クリックで同メニュー。

**設計判断（即時反映する理由）**：

- 単一値（4 値の enum + null）で誤操作リスクが低い
- 同行に並ぶ「AI 評価」ボタン（既に即時実行）と操作モデルが揃う
- 伏線パネル inline は Phase 4 dialog とは別の文脈で、保存モデルの一貫性は dialog 内で完結すれば足りる

**保存後の処理**

- A: ダイアログ Save 後 `useForeshadowStore.load(projectId)` で panel リフレッシュ（Phase 4 既存動作にリンク書き込みが追加で乗るだけ）
- B: 即時反映後 `loadSetups(foreshadowId)` で当該 foreshadow の setup 一覧をリフレッシュ → `needs_strengthening` ラベルへの即時昇格を反映

**Phase 5 完了の定義**

- 編集ダイアログから関連 Codex を追加/削除できる（Save で確定、Cancel で破棄）
- 伏線パネルから Setup の作者 strength を編集できる（即時反映）
- 操作後 panel が即座に更新される
- Phase 4 の Cancel セマンティクスを破壊しない

**Phase 5 の見送り（Phase 6+ 候補）**

- `CreateForeshadowDialog` への Codex リンク統合（line 835 / 865 のモック踏襲）
- Setup の `kind` 編集（kind は本質的に作成時メタで、変更したい場面が薄い）
- Codex 検索の type 別フィルタ（Phase 1 規模では文字列マッチで足りる）
- 開いている Codex 詳細タブ（`ForeshadowTab.tsx`）の逆方向同期：伏線側から Codex リンクを add/remove した瞬間、開いている Codex タブは stale になる。次回タブ open 時に再フェッチされるため許容（グローバルイベント発火や store 購読は導入しない）

### Phase 6（2026-05-16 完了 — `load_bearing` 軸の導入）

**実装済み**

- **A. `foreshadows.load_bearing` カラム追加**
  - `text("load_bearing")` として nullable で追加（DB schema 更新のみ、migration スクリプトは作らず）
  - `types.ts` に `ForeshadowLoadBearing` 型追加
  - `api.ts` の `normalizeForeshadowRow` / `update` patch 受付に対応（`snake_case` フォールバック付き）
- **B. 派生ラベル `critical_weak` 新設 + `deriveLabel` ロジック変更**
  - 案①（保守的）採用: `critical × weak` → `critical_weak` / `optional × weak` → `seeded` / `null|supporting × weak` → 既存 `needs_strengthening`
  - `DerivedLabel` 型に `critical_weak` 追加、`LABEL_ORDER` / `LABEL_STYLE`（赤系 `bg-red-500/15`）に追加
  - `ForeshadowMarkPopover` の `payoff-unanchored` ホワイトリスト（`planned` / `seeded`）は変更せず（`critical_weak` は除外）
- **C. `EditForeshadowDialog` に `loadBearing` セレクタ追加**（critical / supporting / optional / 未設定）
- **D. `CreateForeshadowDialog` に `loadBearing` セレクタ追加**（Create 欠落 → Edit で後付けのパターンを再生産せず）
- **E. i18n キー追加**（`foreshadow.loadBearing.*`、`foreshadow.label.critical_weak` を ja/en に追加）
- **テスト**: `deriveLabel.test.ts` に `critical_weak` ケース追加

**Phase 6 の見送り（Phase 7+ に温存）**: AI プロンプト連携、AI による critical 自動推論、DB migration スクリプト化、UX 強化（ソート・検索・一括破棄）、quota / rate-limit。

**動機**

Phase 1 設計（line 210-212）で deferred とした「load_bearing（critical / supporting / optional）」軸を実証導入する。建築用語の "load-bearing wall（耐力壁）" の比喩で、**「その伏線を作品から外したら物語が崩れるか」を測る軸**。既存の `strength` とは独立した役割を持つ：

| 軸 | 主体 | 測るもの | 値 |
|---|---|---|---|
| `strength` | 読者主観 | 気づかれやすさ | subtle / moderate / overt |
| `load_bearing` | 作者主観 | 構造的重要度 | critical / supporting / optional |

Phase 1〜5 を経て、現行の `needs_strengthening` ラベルが「気づかれにくい伏線すべて」に発火する設計のため、本質的に optional な伏線にもノイズ警告を出す傾向が観察された。`load_bearing` を分離することで、「critical かつ subtle」のみを赤警告（`critical_weak`）として強調し、`optional` を選んだ伏線は警告対象から外せるようになる。

**スコープ**

A. **`foreshadows.load_bearing` カラム追加**
- 値: `"critical" | "supporting" | "optional" | null`（nullable text）
- **DB migration スクリプトは作成しない**（開発段階のため Drizzle schema 更新のみで運用、既存データは null で初期化される再構築前提）
  - `drizzle-kit generate` で migration ファイルが自動生成された場合は**適用せず削除**する（本格運用フェーズで初めて migration として確定させる）
- `types.ts` に `ForeshadowLoadBearing` 型を追加（`ForeshadowStrength` と並列）
- `api.ts` の `mapRow` / `update` patch 受付に `loadBearing` を追加（snake_case `load_bearing` の正規化フォールバックを忘れずに）

B. **派生ラベル `critical_weak` を新設、`needs_strengthening` の発火条件を変更**

`deriveLabel` を以下のロジックに変更（**案①：保守的、既存伏線の挙動を維持**）：

```ts
function deriveLabel(f: Foreshadow, setupCount: number, anyWeak: boolean): DerivedLabel {
  if (f.abandoned) return "abandoned";
  if (setupCount === 0 && f.payoffConfirmed) return "orphan_payoff";
  if (setupCount === 0) return "planned";
  if (f.payoffConfirmed) return "paid";
  if (anyWeak) {
    if (f.loadBearing === "critical") return "critical_weak";    // 赤警告
    if (f.loadBearing === "optional") return "seeded";           // 警告なし
    return "needs_strengthening";                                  // null / supporting → 既存挙動
  }
  return "seeded";
}
```

**判定マトリクス**：

|  | `optional × weak` | `null × weak`（既存伏線） | `critical × weak` | `supporting × weak` |
|---|---|---|---|---|
| 結果ラベル | `seeded`（警告なし） | `needs_strengthening`（黄） | `critical_weak`（赤） | `needs_strengthening`（黄） |

**設計判断（案①を採る理由）**：
- 既存伏線（`load_bearing === null`）の警告挙動が Phase 5 までと完全一致するため**移行が無痛**
- `optional` を**明示的に選んだ**ものだけ警告から外れる、という意図の明示性が保たれる
- 案②（null も警告なし）は導入時に既存伏線の警告が一斉に消えて作者を混乱させる
- 案③（optional でも警告）は本 Phase の動機（ノイズ削減）を打ち消す

**ラベル色 / フィルタ pill**：
- `critical_weak`: 赤系（既存 `needs_strengthening` の黄/橙より強い警告色、tailwind の `red-500/15` 系統）
- `DerivedLabel` 型に `"critical_weak"` を追加
- フィルタ pill リストにも `critical_weak` を追加（順序：`needs_strengthening` の直前）
- `DerivedLabel` 型・i18n キー・派生ラベルの色定義マップ・派生ラベル算定の全箇所を一括更新（実装時は `grep` で `DerivedLabel` の参照を全網羅し、`switch` 文の網羅性チェック抜けを防ぐ）

**ForeshadowMarkPopover への影響**：
Phase 3 で `payoff-unanchored` フィルタを「planned / seeded のホワイトリスト」に修正した（line 1030）。`critical_weak` は `seeded` と同じ「Setup 存在 + payoff 未確定」状態だが、強化必要な伏線は popover からは隠す方が筋なので**ホワイトリストに含めない**（現状の `needs_strengthening` 除外と同じ扱い）。

C. **`EditForeshadowDialog` に `load_bearing` セレクタを追加**
- title / intent / notes と並ぶ位置にネイティブ `<select>`（Phase 5 の strength セレクタと同じ実装パターン）
- 値: critical / supporting / optional / —（未設定 = null）
- 全フィールド差分パッチに乗せる（既存 `patch` Object に `loadBearing` キー追加）
- 警告 hover で短い説明（「外したら作品が崩れるか。critical/supporting/optional」）を `<select title="...">` で表示

D. **`CreateForeshadowDialog` にも `load_bearing` セレクタを追加**
- 単一 `<select>` なので Phase 5 の Codex M:N と違い実装コストが低い
- Create 欠落 → Edit で後付け、というパターン（Phase 4 で再生産していた）を**再生産しない**
- 入口①〜③のすべての作成系ダイアログ（`CreateForeshadowDialog` を共通利用）に追加
- デフォルト値: null（未設定）

E. **i18n 追加**
- `foreshadow.loadBearing.{critical,supporting,optional,unset}` を ja/en に追加
- `foreshadow.label.critical_weak` を ja/en に追加

**設計判断（AI 連携を Phase 6 スコープ外とする理由）**

`evaluateSetupStrength` のプロンプトに `load_bearing` を入力として渡す案は実装コストは低い（プロンプト 1〜2 行追加）が、生成結果の質が本当に改善するかは**実証データが必要**で、Phase 6 着手時点では検証手段がない。フィールド追加 + 編集 UI + 派生ラベル算定までを Phase 6 で完結させ、AI プロンプト統合は Phase 7+ に温存する（Phase 6 運用後に「critical 伏線の評価が雑」のような観察データが揃った時点で追加）。

**Phase 6 完了の定義**

- `foreshadows.loadBearing` を Edit/Create dialog の双方から編集できる
- 既存伏線（loadBearing === null）の警告挙動が Phase 5 と完全一致する
- 作者が `optional` を明示的に選ぶと weak 警告から外れる
- 作者が `critical` を選ぶと weak 時に `critical_weak` 赤警告が出る
- フィルタ pill から `critical_weak` のみを抽出表示できる
- ForeshadowMarkPopover の表示が Phase 5 と同じ（`critical_weak` は除外）

**Phase 6 の見送り（Phase 7+ 候補）**

- AI 連携（`evaluateSetupStrength` / `auditChapter` のプロンプトに load_bearing を渡す。質改善の実証データが必要）
- AI による load_bearing の自動推論（critical 提案）
- DB migration スクリプトの作成（本格運用時に必要、開発段階では再構築前提）
- パネル UX 強化（ソート・検索・一括破棄。Phase 6 候補 D 案、別 Phase に切り出し）
- AI コスト・品質ハードニング（quota / rate-limit。Phase 6 候補 B 案、別 Phase に切り出し）

---

## Deferred decisions

| 項目 | 判断 | 再検討タイミング |
|---|---|---|
| `load_bearing` の独立軸採用 | **Phase 6（2026-05-16）で実装済み**。critical / supporting / optional / null の 4 値、`critical × weak` のみ赤警告 `critical_weak` ラベル、null は既存挙動（`needs_strengthening`）維持の保守的ルール（案①） | AI 連携への入力化は Phase 7+ |
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
├── ForeshadowPanel.tsx                    # メインパネル（一覧 / 章別監査 / レーダー の 3 タブ切替）
├── ForeshadowPanel.test.tsx               # Phase 1/2 テスト
├── ForeshadowPanel.phase3.test.tsx        # Phase 3 テスト（タブ切替 / Setup 提案ボタン）
├── ForeshadowPanel.stories.tsx            # Storybook
├── ForeshadowChapterTab.tsx               # 章別監査ダッシュボード（Phase 3）
├── radar/                                  # 伏線レーダータブ（#123）
│   ├── ForeshadowRadarTab.tsx             # レーダータブ UI（SVG アークタイムライン / サマリー / floating 一覧）
│   ├── ForeshadowRadarTab.test.tsx
│   ├── foreshadowRadarModel.ts            # 読書順アーク + 章バンド + サマリー集計の純データモデル（buildForeshadowRadarModel）
│   └── foreshadowRadarModel.test.ts
├── ForeshadowMarkPopover.tsx              # setup mark 右クリックポップオーバー
├── ForeshadowMarkPopover.test.tsx
├── ForeshadowMarkHoverPopover.tsx         # hover 表示
├── CreateForeshadowDialog.tsx             # 伏線作成ダイアログ（initialTitle / initialIntent プリフィル対応）
├── EditForeshadowDialog.tsx               # 伏線編集ダイアログ（Phase 4: title/intent/notes/payoffConfirmed/abandoned + anchor 解除 / Phase 5: Codex リンク編集）
├── EditForeshadowDialog.test.tsx          # Phase 4: 編集パッチ送信 / anchor 解除 / lifecycle トグル / Phase 5: Codex リンク差分適用のテスト
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

src-tauri/src/commands/foreshadow.rs       # foreshadow 関連 Tauri コマンド（lib.rs の invoke_handler に登録）
                                           # （foreshadow_create / foreshadow_update / foreshadow_delete /
                                           #   foreshadow_list_with_labels /
                                           #   foreshadow_list_open_for_context / foreshadow_get /
                                           #   foreshadow_get_scene_info / foreshadow_get_scene_context /
                                           #   foreshadow_list_by_codex_entry / foreshadow_get_chapter_stats /
                                           #   foreshadow_get_setup / foreshadow_update_setup /
                                           #   foreshadow_link_codex / foreshadow_unlink_codex /
                                           #   foreshadow_list_linked_codex（Phase 5）/
                                           #   foreshadow_set_setup_strength / foreshadow_resolve_orphan /
                                           #   foreshadow_save_anchors_for_scene / foreshadow_load_anchors_for_scene /
                                           #   foreshadow_setup_create_ai（Phase 3））
                                           # ※ propose_past_setups / evaluateSetupStrength / auditChapter /
                                           #    getChapterForeshadowStats は Rust AI IPC を持たず
                                           #    src/features/foreshadow/api.ts に純 TS で実装
                                           #    （前 3 者は sendChatMessageWithThinking 直呼び + analysis policy gate、
                                           #     getChapterForeshadowStats は foreshadow_get_chapter_stats で DB 集計）
src-tauri/src/commands/agent_writes.rs     # agent_foreshadow_create / agent_foreshadow_update
                                           # （tracked write: entity + undo_journal + change_event を 1 tx で）

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
- 2026-04-28: Phase 5 セクション追加（関連 Codex リンク編集 + Setup 作者 strength 編集）。Phase 4 で見送った 2 件をまとめて埋める設計。Codex リンクは `EditForeshadowDialog` に「全フィールド差分パッチ」モデルで統合（`linksToAdd` / `linksToRemove` 2 Set を Save 時に一括適用、Cancel セマンティクスを保持）。Setup 作者 strength は `SetupRow` の inline ドロップダウンで即時反映。読み取り IPC `foreshadow_list_linked_codex` を 1 件追加（`ForeshadowWithLabel` への M:N JOIN 注入を避けるため）。TS wrapper `setSetupStrength` / `listCodexEntriesByForeshadow` を `api.ts` に追加。新規コンポーネントファイルは作らず既存ファイルへの追記で完結。
- 2026-04-28: Phase 6 セクション追加（`load_bearing` 軸の導入）。Phase 1 から繰り越されてきた最大の deferred decision を解消。`foreshadows.load_bearing` カラム追加（critical / supporting / optional / null）+ 派生ラベル `critical_weak` 新設で「critical かつ subtle」のみを赤警告化、`optional` 明示時は警告対象外、null（既存伏線）は既存挙動維持の保守的ルール（案①）を採用。`EditForeshadowDialog` と `CreateForeshadowDialog` の双方に `<select>` を追加し、Phase 4/5 で再生産していた「Create 欠落 → Edit で後付け」パターンを排除。**DB migration スクリプトは作らず**（開発段階のため Drizzle schema 更新のみ、再構築前提）、AI プロンプト連携は実証データ待ちで Phase 7+ に温存。Deferred decisions の `load_bearing` 行を「Phase 6 で実装予定」に更新。
- 2026-04-27: 実装と設計書の差分修正。`evaluateSetupStrength` / `getChapterForeshadowStats` は実装上 Rust IPC を持たず `src/features/foreshadow/api.ts` の純 TS 実装である旨を実装ファイル配置セクションに追記（旧表記の `foreshadow_evaluate_setup_strength` を削除）。実装ファイル配置の TS ツリーを実態に合わせて補完: `marks/` サブディレクトリ（ForeshadowSetupMark / ForeshadowPayoffMark / foreshadowPasteRule + テスト）、`foreshadowStore.adoptProposedSetup.test.ts`、`ForeshadowPanel.stories.tsx`、`types.test.ts`、`api.getChapterForeshadowStats.test.ts` を追記。
- 2026-05-16: Phase 4 / 5 / 6 の実装完了マーク + 実装差分を反映。
  - Phase 4（伏線本体メタデータ編集）/ Phase 5（Codex M:N 編集 + Setup strength inline 編集）/ Phase 6（`load_bearing` 軸 + `critical_weak` ラベル）の各セクション冒頭に **実装済み** ブロックを追加。Deferred decisions の `load_bearing` 行を「Phase 6 で実装済み」に更新。
  - **新規追加**: `foreshadows.secret` フラグを設計書に反映（設計書未記載のまま Phase 5 と同時実装されていた）。スキーマ定義に `secret` カラムを追記し、「AI コンテキスト注入と secret フラグ」セクションを新設して目的・既定値・migration 既定の非対称（schema default true / migration default false）・`listOpenForeshadowsForContext` のフィルタ挙動・Create dialog から外す設計判断を文書化。
  - **IPC surface 補完**: Phase 5 narrative に登場するが IPC 一覧から漏れていた `foreshadow_list_linked_codex` を追加。
  - スキーマ定義に `loadBearing` カラムも明示（Phase 6 narrative にしか書かれていなかった）。
- 2026-06-18: コードとの差分修正・shipped 機能の追記。
  - **impact-review 連携**: スキーマ定義に `codexLinkDirtyAt`（`codex_link_dirty_at`）を追記し、「Codex 変更追従」サブセクションを新設。リンク先 Codex の埋め込み対象更新で `markLinkedForeshadowsDirty` がリンク伏線をマーク → `isSetupEvaluationStale` の第 3 要因（codexLinkDirtyAt）で stale 判定する経路を文書化。DDL は Grimodex_統合DBスキーマ.md にリンク。
  - **IPC surface 訂正・補完**: 実体パスを `src-tauri/src/commands/foreshadow.rs` に修正（lib.rs 直書きではない）。追加コマンド群（`foreshadow_list_with_labels` / `foreshadow_list_open_for_context` / `foreshadow_get_scene_info` / `foreshadow_get_scene_context` / `foreshadow_list_by_codex_entry` / `foreshadow_get_chapter_stats` / `foreshadow_get_setup` / `foreshadow_update_setup`）を追記。agent write コマンド（`agent_foreshadow_create` / `agent_foreshadow_update`）を追記。
  - **誤った Tauri command 記載の修正**: `foreshadow_propose_past_setups` を IPC 一覧から削除し、`proposePastSetups` / `evaluateSetupStrength` / `auditChapter` は Tauri command を持たず `api.ts` の純 TS（`sendChatMessageWithThinking` 直呼び）である旨を各 AI 連携セクションで明記。`foreshadow_audit_chapter` Rust IPC は存在しないため Phase 3 のランタイム分岐記述を訂正。
  - **AiPolicy gate（28293b2b）**: 上記 3 AI 関数の冒頭 `blockIfPolicyOff("analysis")`（off 時は空 / null を返す）を追記。
  - **`detectRelatedCodex`**: 本文から Codex 言及を自動検出して `relatedCodex` に整形する経路を Phase 1 propose セクションに追記。
  - **Agent write 連携（5e4c1a9e）**: chat agent の `create_foreshadow` / `update_foreshadow` ツール（knowledgeWrite gate → tracked write → store reload → globalHistory undo）の新セクションを追加。実装ファイル配置に `agent_writes.rs` を追記。
- 2026-06-20: 伏線レーダータブ（#123 shipped）の追記。
  - **副入口：伏線レーダータブ** セクションを新設。回収状況を読書順タイムライン上の SVG アークで俯瞰する読み取り専用の第 3 タブ（AI 不使用・純フロント集計 `buildForeshadowRadarModel`）。回収率サマリー（paid / open / atRisk / abandoned）、確定回収 = 実線・未回収/broken = フロンティアへ破線ダングリング・orphan_payoff = マーカーのみ、の描き分け、未配置（floating）別枠、アーククリックでのシーンジャンプ、「回収済みを隠す」トグルを文書化。
  - パネルのタブ構成を **一覧 / 章別監査 / レーダー の 3 タブ**（`PanelTab = "list" | "chapter" | "radar"`）に整合。
  - 実装ファイル配置に `radar/`（`ForeshadowRadarTab.tsx` + `foreshadowRadarModel.ts` + 各 `.test`）を追記。
