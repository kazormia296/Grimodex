# マルチウインドウ：別窓 Codex 編集（書き込み）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 別フローティングウィンドウから Codex の本文(content/notes)＋構造化フィールドを編集・新規作成できるようにする。同一 entry は 1 窓ずつ編集する運用とし、(1) per-entry advisory lock と (2) 人間保存経路への base_version OCC 配線で本文消失を防ぐ。

**Architecture:** 真の source of truth は共有 SQLite。別窓は自前ストアを共有 DB から hydrate し、Rust の全窓 broadcast emit で再 hydrate＋ロックイベントを受ける。本文編集の衝突 UX（マージ）は作らず、advisory lock で「1 entry = 1 窓」を担保、既存の OCC（`version` 列・agent 経路と同型）を人間保存経路にも通して stale write を reject する最終防波堤を置く。

**Tech Stack:** Tauri v2（capability/ACL・WebviewWindow・app.emit）、React 19 + TypeScript、Zustand（グローバル）、Drizzle ORM（sqlite-proxy、生 SQL 禁止）、Vitest。

## Global Constraints

- ES modules のみ（CommonJS 禁止）。2 スペース、TypeScript strict。
- 状態管理: グローバル=Zustand、局所=Jotai。DB は Drizzle 経由（生 SQL 禁止。既存の `db_execute` raw SELECT は version 読取の前例として許容）。
- React は関数コンポーネント + hooks のみ。1 ファイル 1 コンポーネント、200 行超で分割。
- 検証コマンド: `pnpm test` / `npx tsc --noEmit` / `pnpm lint:fix` / Rust 変更時 `cd src-tauri && cargo check`（sandbox では `cargo test` は ort-sys リンクで失敗するため CI に委ねる。`cargo check --tests` まで）。
- `git add` は `-A` 禁止、変更ファイルを個別 add。master 直 commit/push 禁止（branch + PR）。
- `gen/schemas/`・`acl-manifests.json` は生成物、手編集しない。
- 設計正本: `docs/Grimodex_マルチウインドウ検討.md` の §A〜§G2。
- **`version` 列は既に DB に存在**（`src-tauri/src/database/migrate.rs:1659-1666` が codex_entries/snippets/tree_nodes に追加済み）。Drizzle 側 `schema.ts` には未定義なので追加する（マイグレーションは Rust 側 migrate.rs が正本、drizzle-kit 不使用なので schema.ts 追加は migration を誘発しない）。

---

# Phase 1 — 安全基盤（TDD・Tauri ランタイム不要・このセッションで検証可能）

> Phase 1 は窓 UI に依存しない。OCC 配線と advisory lock の純ロジックを TDD で固める。これだけで「同一 entry を複数経路（別窓・MCP・agent）から書いても本文消失しない」基盤が完成する。

### Task 1: Drizzle スキーマに `version` 列を追加

**Files:**
- Modify: `src/db/schema.ts`（`codexEntries` テーブル定義、:148-194 付近）
- Test: `src/db/schema.version.test.ts`（新規）

**Interfaces:**
- Produces: `codexEntries.version`（drizzle column）、`CodexEntry["version"]: number`（`$inferSelect` 経由で自動付与）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/db/schema.version.test.ts
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { codexEntries } from "./schema";

describe("codexEntries.version column", () => {
  it("exists as a column (mirrors migrate.rs add_column_if_missing)", () => {
    const cols = getTableColumns(codexEntries);
    expect(cols.version).toBeDefined();
  });
  it("maps to snake_case db column 'version'", () => {
    const cols = getTableColumns(codexEntries);
    expect(cols.version.name).toBe("version");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認** — `pnpm test --run src/db/schema.version.test.ts`（`cols.version` が undefined で FAIL）

- [ ] **Step 3: 最小実装** — `codexEntries` 定義の `updatedAt` の直後に追加：

```ts
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // OCC version (column created by src-tauri/src/database/migrate.rs:1659-1666).
    // Drizzle was unaware of it; needed so the human save path can do a
    // conditional version check instead of a blind overwrite.
    version: integer("version").notNull().default(0),
```

（`integer` が import 済みか確認。未 import なら drizzle-orm/sqlite-core の import に追加。）

- [ ] **Step 4: テストが通ることを確認** — `pnpm test --run src/db/schema.version.test.ts`（PASS）

- [ ] **Step 5: commit**

```bash
git add src/db/schema.ts src/db/schema.version.test.ts
git commit -m "feat(codex): drizzle schema に OCC version 列を認識させる"
```

---

### Task 2: `updateCodexEntry` を version-aware に（OCC backstop）

**Files:**
- Modify: `src/features/codex/api.ts`（`updateCodexEntry` :92-117）
- Create: `src/features/codex/occ.ts`（`CodexVersionConflictError` 型）
- Test: `src/features/codex/occUpdate.test.ts`（新規）

**Interfaces:**
- Consumes: `codexEntries.version`（Task 1）
- Produces:
  - `class CodexVersionConflictError extends Error { entryId: string }`
  - `updateCodexEntry(projectId, id, data, opts?: { baseVersion?: number }): Promise<CodexEntry | undefined>`
    - `baseVersion` 省略時は**従来通りの blind UPDATE**（後方互換。version は触らない）。
    - `baseVersion` 指定時は `WHERE id AND project_id AND version = baseVersion` で条件付き UPDATE し `version = baseVersion + 1`。0 件更新かつ行が存在するなら `throw new CodexVersionConflictError`。行が無いなら従来通り `undefined`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/features/codex/occUpdate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// db をモック: update().set().where().returning() チェーンと、conflict 判定用の
// 再 SELECT を制御する。
const returningMock = vi.fn();
const selectExistsMock = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ returning: returningMock }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: selectExistsMock }) }) }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({ scheduleCodexIndex: vi.fn() }));

import { updateCodexEntry } from "./api";
import { CodexVersionConflictError } from "./occ";

beforeEach(() => { returningMock.mockReset(); selectExistsMock.mockReset(); });

describe("updateCodexEntry OCC", () => {
  it("baseVersion 一致 → 更新成功し version をインクリメント", async () => {
    returningMock.mockResolvedValueOnce([{ id: "e1", projectId: "p", version: 3, content: "x" }]);
    const r = await updateCodexEntry("p", "e1", { content: "x" }, { baseVersion: 2 });
    expect(r?.version).toBe(3);
  });
  it("baseVersion 不一致かつ行は存在 → CodexVersionConflictError", async () => {
    returningMock.mockResolvedValueOnce([]); // 条件付き UPDATE が 0 件
    selectExistsMock.mockResolvedValueOnce([{ id: "e1" }]); // 行は存在
    await expect(
      updateCodexEntry("p", "e1", { content: "x" }, { baseVersion: 2 }),
    ).rejects.toBeInstanceOf(CodexVersionConflictError);
  });
  it("行が存在しない（別プロジェクト等）→ undefined（従来通り）", async () => {
    returningMock.mockResolvedValueOnce([]);
    selectExistsMock.mockResolvedValueOnce([]); // 行なし
    const r = await updateCodexEntry("p", "e1", { content: "x" }, { baseVersion: 2 });
    expect(r).toBeUndefined();
  });
  it("baseVersion 省略 → blind UPDATE（version 非加算・後方互換）", async () => {
    returningMock.mockResolvedValueOnce([{ id: "e1", projectId: "p", version: 0, content: "x" }]);
    const r = await updateCodexEntry("p", "e1", { content: "x" });
    expect(r?.id).toBe("e1");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — `pnpm test --run src/features/codex/occUpdate.test.ts`（`./occ` 未定義で FAIL）

- [ ] **Step 3: 実装**

`src/features/codex/occ.ts`:

```ts
export class CodexVersionConflictError extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`Codex entry '${entryId}' version conflict`);
    this.name = "CodexVersionConflictError";
    this.entryId = entryId;
  }
}
```

`src/features/codex/api.ts` の `updateCodexEntry` を改修（既存副作用カスケードは温存）：

```ts
import { CodexVersionConflictError } from "./occ";

export async function updateCodexEntry(
  projectId: string,
  id: string,
  data: Partial<Pick<NewCodexEntry, /* …既存の列… */>>,
  opts?: { baseVersion?: number },
): Promise<CodexEntry | undefined> {
  const useOcc = opts?.baseVersion !== undefined;
  const rows = await db
    .update(codexEntries)
    .set(
      useOcc
        ? { ...data, version: opts!.baseVersion! + 1, updatedAt: new Date().toISOString() }
        : { ...data, updatedAt: new Date().toISOString() },
    )
    .where(
      useOcc
        ? and(
            eq(codexEntries.id, id),
            eq(codexEntries.projectId, projectId),
            eq(codexEntries.version, opts!.baseVersion!),
          )
        : and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)),
    )
    .returning();

  if (!rows[0]) {
    if (useOcc) {
      // 0 件: 行が存在するなら version 不一致＝衝突、無ければ project スコープ miss。
      const exists = await db
        .select({ id: codexEntries.id })
        .from(codexEntries)
        .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)))
        .limit(1);
      if (exists[0]) throw new CodexVersionConflictError(id);
    }
    return undefined;
  }
  // …以降の既存副作用（mention cache / rescan / 伏線 dirty / index）はそのまま…
}
```

- [ ] **Step 4: 通ることを確認** — `pnpm test --run src/features/codex/occUpdate.test.ts`（PASS）。既存 `src/features/codex/api.test.ts` も緑のまま：`pnpm test --run src/features/codex/api.test.ts`

- [ ] **Step 5: commit**

```bash
git add src/features/codex/api.ts src/features/codex/occ.ts src/features/codex/occUpdate.test.ts
git commit -m "feat(codex): updateCodexEntry に base_version OCC を任意追加(後方互換)"
```

---

### Task 3: `codexStore.updateText` で OCC を使い、衝突は非破壊で扱う

**Files:**
- Modify: `src/features/codex/codexStore.ts`（`updateText` :378-420）
- Test: `src/features/codex/updateTextOcc.test.ts`（新規）

**Interfaces:**
- Consumes: `updateCodexEntry(..., { baseVersion })`、`CodexVersionConflictError`（Task 2）
- Produces: `updateText` は `before.version` を baseVersion として送る。衝突時は **store を上書きしない**＋`onCodexEditConflict(id)` コールバックを発火（既定はトースト「別の窓で更新されました」）。`setCodexEditConflictHandler(fn)` を export（UI 層が差し替え）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/features/codex/updateTextOcc.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const updateCodexEntryMock = vi.fn();
vi.mock("./api", () => ({ updateCodexEntry: updateCodexEntryMock }));
vi.mock("@/features/timelapse/recorder", () => ({ recordChangeEvent: vi.fn() }));

import { useCodexStore, setCodexEditConflictHandler } from "./codexStore";
import { CodexVersionConflictError } from "./occ";

beforeEach(() => {
  updateCodexEntryMock.mockReset();
  useCodexStore.setState({ entries: [{ id: "e1", version: 5, content: "old" } as any] });
});

describe("updateText OCC", () => {
  it("before.version を baseVersion として渡す", async () => {
    updateCodexEntryMock.mockResolvedValueOnce({ id: "e1", version: 6, content: "new" });
    await useCodexStore.getState().updateText("e1", { content: "new" });
    expect(updateCodexEntryMock).toHaveBeenCalledWith(
      expect.any(String), "e1", { content: "new" }, { baseVersion: 5 },
    );
  });
  it("衝突時は store を上書きせず conflict handler を呼ぶ", async () => {
    updateCodexEntryMock.mockRejectedValueOnce(new CodexVersionConflictError("e1"));
    const handler = vi.fn();
    setCodexEditConflictHandler(handler);
    await useCodexStore.getState().updateText("e1", { content: "new" });
    expect(handler).toHaveBeenCalledWith("e1");
    expect(useCodexStore.getState().entries[0].content).toBe("old"); // 上書きされない
  });
});
```

- [ ] **Step 2: 落ちることを確認** — `pnpm test --run src/features/codex/updateTextOcc.test.ts`

- [ ] **Step 3: 実装** — `updateText` を改修：

```ts
let codexEditConflictHandler: (entryId: string) => void = (entryId) => {
  toast.error(i18next.t("codex.store.editConflict"));
};
export function setCodexEditConflictHandler(fn: (entryId: string) => void) {
  codexEditConflictHandler = fn;
}

// updateText 内:
const before = get().entries.find((e) => e.id === id);
try {
  const updated = await updateCodexEntry(getCurrentProjectId(), id, data, {
    baseVersion: before?.version ?? 0,
  });
  if (updated) {
    set((state) => ({ entries: state.entries.map((e) => (e.id === id ? updated : e)) }));
  }
} catch (e) {
  if (e instanceof CodexVersionConflictError) {
    codexEditConflictHandler(id);
    return; // store も timelapse も触らない（非破壊）
  }
  toast.error(i18next.t("codex.store.updateFailed"));
  debugLog.error("CodexStore", `updateText: ${rootCause(e)}`, errorDetail(e));
  return;
}
// …既存の timelapse diff 記録…
```

ロケール追加: `src/locales/{ja,en}/*` の codex.store に `editConflict`（ja「この項目は別のウィンドウで更新されたため保存できませんでした。最新を読み込んでから編集し直してください。」/ en 相当）。

- [ ] **Step 4: 通ることを確認** — `pnpm test --run src/features/codex/updateTextOcc.test.ts` + 既存 `codexStore.test.ts` 緑

- [ ] **Step 5: commit**

```bash
git add src/features/codex/codexStore.ts src/features/codex/updateTextOcc.test.ts src/locales
git commit -m "feat(codex): updateText を OCC 経由にし衝突を非破壊処理(差替可ハンドラ)"
```

---

### Task 4: advisory lock 純レデューサ（`codexEditLock`）

**Files:**
- Create: `src/features/codex/multiwindow/codexEditLock.ts`
- Test: `src/features/codex/multiwindow/codexEditLock.test.ts`

**Interfaces:**
- Produces（純関数・トランスポート非依存）:
  - `type LockEvent = { type: "acquire" | "release" | "heartbeat"; entryId: string; windowId: string; ts: number }`
  - `type LockState = Record<string /*entryId*/, { windowId: string; ts: number }>`
  - `reduceLock(state: LockState, ev: LockEvent, ttlMs: number): LockState`
    - acquire: holder 不在 or 同 holder or 既存 holder が TTL 切れ → この窓を holder に。既存 holder 有効なら**先勝ち維持**（タイブレークは `ts` 昇順、同 ts は `windowId` 辞書順）。
    - heartbeat: 同 holder の ts 更新。
    - release: 同 holder のみ削除。
  - `canEdit(state: LockState, entryId: string, selfWindowId: string, now: number, ttlMs: number): boolean` — holder 不在 / 自分 / TTL 切れ なら true。
  - `holderOf(state, entryId, now, ttlMs): string | null`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// codexEditLock.test.ts
import { describe, it, expect } from "vitest";
import { reduceLock, canEdit, holderOf } from "./codexEditLock";
const TTL = 5000;

describe("codexEditLock reducer", () => {
  it("最初の acquire が holder になる", () => {
    const s = reduceLock({}, { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 }, TTL);
    expect(holderOf(s, "e1", 1000, TTL)).toBe("A");
    expect(canEdit(s, "e1", "B", 1000, TTL)).toBe(false);
    expect(canEdit(s, "e1", "A", 1000, TTL)).toBe(true);
  });
  it("先勝ち：2番目の acquire は holder を奪えない", () => {
    let s = reduceLock({}, { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 }, TTL);
    s = reduceLock(s, { type: "acquire", entryId: "e1", windowId: "B", ts: 1001 }, TTL);
    expect(holderOf(s, "e1", 1001, TTL)).toBe("A");
  });
  it("同時 acquire（同 ts）は windowId 辞書順で決定的", () => {
    let s = reduceLock({}, { type: "acquire", entryId: "e1", windowId: "B", ts: 1000 }, TTL);
    s = reduceLock(s, { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 }, TTL);
    expect(holderOf(s, "e1", 1000, TTL)).toBe("A"); // 辞書順 A < B
  });
  it("TTL 切れの holder は別窓が奪える（クラッシュ復帰）", () => {
    let s = reduceLock({}, { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 }, TTL);
    s = reduceLock(s, { type: "acquire", entryId: "e1", windowId: "B", ts: 1000 + TTL + 1 }, TTL);
    expect(holderOf(s, "e1", 1000 + TTL + 1, TTL)).toBe("B");
  });
  it("release は同 holder のみ削除", () => {
    let s = reduceLock({}, { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 }, TTL);
    s = reduceLock(s, { type: "release", entryId: "e1", windowId: "B", ts: 1001 }, TTL); // 他窓の release は無視
    expect(holderOf(s, "e1", 1001, TTL)).toBe("A");
    s = reduceLock(s, { type: "release", entryId: "e1", windowId: "A", ts: 1002 }, TTL);
    expect(holderOf(s, "e1", 1002, TTL)).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — `pnpm test --run src/features/codex/multiwindow/codexEditLock.test.ts`

- [ ] **Step 3: 実装**（純関数のみ。Date.now/乱数なし、now は引数で受ける）

- [ ] **Step 4: 通ることを確認**

- [ ] **Step 5: commit**

```bash
git add src/features/codex/multiwindow/codexEditLock.ts src/features/codex/multiwindow/codexEditLock.test.ts
git commit -m "feat(codex): 別窓編集の advisory lock 純レデューサ(先勝ち+TTL復帰)"
```

---

# Phase 2 — 窓プラミング（実コードだが多窓 E2E は実機 GUI QA gate）

> Phase 2 は Tauri マルチウインドウランタイムが要るため、このサンドボックスでは end-to-end 検証できない（happy-dom/browser test 不可）。コードは決定的に書き、ユニットで切れる部分は切り、**多窓動作・capability ACL・vibrancy は実機 QA をゲートとして明示**する。

### Task 5: capability に窓生成＋codex-window label 権限を追加

**Files:**
- Modify: `src-tauri/capabilities/default.json`（`core:webview:allow-create-webview-window` 追加）
- Create: `src-tauri/capabilities/codex-window.json`（label `codex-window` の最小権限）

- [ ] **Step 1:** `default.json` の `permissions` に `"core:webview:allow-create-webview-window"` を追加（生成側=main に窓生成権限）。
- [ ] **Step 2:** `codex-window.json` を新規作成：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "codex-window",
  "description": "Capability for the floating Codex editor window",
  "windows": ["codex-window"],
  "permissions": [
    "core:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:webview:allow-set-webview-zoom"
  ]
}
```

- [ ] **Step 3 検証:** `cd src-tauri && cargo check`（ACL codegen が通ること。`gen/schemas`/`acl-manifests.json` は触らない）。
- [ ] **Step 4 commit:** `git add src-tauri/capabilities/default.json src-tauri/capabilities/codex-window.json` → `git commit -m "feat(multiwindow): codex-window 用 capability と窓生成権限を追加"`
- [ ] **GUI QA gate:** 実機で codex-window 生成時に ACL 拒否が出ないこと。

### Task 6: 窓生成 API ＋ 起動アフォーダンス

**Files:**
- Create: `src/features/codex/multiwindow/openCodexWindow.ts`（`WebviewWindow` 生成。`transparent:true, decorations:false` 等は main に倣う。label `codex-window`、URL `index.html?window=codex`）
- Modify: Codex パネルのヘッダ（`CodexManagementPanel.tsx` 付近）に「別窓で開く」ボタン（`isTauri()` 時のみ表示）。

- [ ] 既存窓があれば focus、無ければ生成（`WebviewWindow.getByLabel("codex-window")`）。
- [ ] ユニット: `openCodexWindow` の URL/label/options 組み立てを純関数 `buildCodexWindowOptions()` に切り出してテスト。
- [ ] commit / GUI QA gate（実際に窓が出る・glass shell が崩れない）。

### Task 7: codex-window の panel-only マウント分岐

**Files:**
- Create: `src/features/codex/multiwindow/codexWindowMode.ts`（`getWindowMode(): "main" | "codex"`。`new URLSearchParams(location.search).get("window")==="codex"` or `getCurrentWindow().label==="codex-window"`）
- Modify: `src/App.tsx`（screenshot 分岐 :338 付近に倣い、codex モードなら専用 bootstrap→`<LayoutShell hidden screenshotPanelId="codex" />` 相当の panel-only 描画。本タスクでは `codex` パネルを単独全画面表示）
- Modify: `src/features/layout/LayoutShell.tsx`（:177-190 の panel-only 分岐を codex モードでも使えるよう一般化。`screenshotPanelId` を `soloPanelId` に名称拡張 or codex 用 prop 追加）

- [ ] screenshot 前例（`LayoutShell.tsx:177` の `if (hidden && screenshotPanelId)`）を踏襲。
- [ ] ユニット: `getWindowMode`/`codexWindowMode` の判定を純関数化してテスト（happy-dom で location/label をモック）。
- [ ] commit / GUI QA gate（codex-window が Codex パネルだけ全画面で描画される）。
- [ ] **レイアウト変更を含むため `pnpm test:browser` を CI で確認**（LayoutShell 周辺、CLAUDE.md 規約）。

### Task 8: codex-window の軽量 bootstrap

**Files:**
- Create: `src/features/codex/multiwindow/bootstrapCodexWindow.ts`（`screenshotBootstrap.bootstrapScreenshotWorkspace` に倣う：`initCurrentProject()`→`useCodexStore.loadEntries()`→settings/theme effect 流用）
- Modify: `src/App.tsx`（codex モード時に呼ぶ）

- [ ] DB 再 open は不要（Rust `WorkspaceState` に既に開いている）。`initCurrentProject()`（`projectStore.ts:52-64`）→ `loadEntries()`。
- [ ] theme/font は `App.tsx:140-176` の effect を codex モードでも通す。
- [ ] commit / GUI QA gate（別窓でテーマ・フォント・Codex 一覧が main と一致）。

### Task 9: Rust 全窓 broadcast emit ＋ JS listen（再 hydrate＋ロックイベント輸送）

**Files:**
- Create: `src-tauri/src/multiwindow/mod.rs`（`data://changed` emit ヘルパ。`watch.rs:165-190` の `app.emit(channel, payload)` テンプレ流用＝全窓配信）
- Modify: codex mutating command（`agent_writes.rs` の create/update、及び `db_execute` 経由の人間 write をどう拾うか）— v1 は**フロント発の emit** で簡潔化（後述）。
- Create: `src/features/codex/multiwindow/codexWindowSync.ts`（`lib/tauri.ts` の `listen("data://codex-changed")` → `useCodexStore.loadEntries()`、`listen("codex-lock://event")` → lock reducer へ供給）
- Modify: `src/features/codex/codexStore.ts`（create/update/remove 後にフロントから `emit("data://codex-changed", {projectId})` を撃つ。`emit` は `lib/tauri.ts` に薄いラッパ追加）

**設計判断:** v1 は **フロント発 broadcast**（`@tauri-apps/api/event` の `emit` は全窓配信）で実装し、Rust 側 emit（命令横断・timelapse 非依存の本命）は v2。理由: 人間 write は JS の codexStore を必ず通るので、フロント emit で漏れなく拾える。`externalWriteFeed`(750ms) は MCP/agent の別プロセス用に併存（重複再ロードは loadEntries の冪等性で無害）。

- [ ] `lib/tauri.ts` に `emit(event, payload)` ラッパ（Tauri 時 `@tauri-apps/api/event` の emit、browser 時 `window.dispatchEvent(CustomEvent)`）。`listen` は既存（:58）。
- [ ] ユニット: `codexWindowSync` の listen→reducer 供給を、`listen` をモックして検証。emit payload 形を純関数で組み立ててテスト。
- [ ] commit / GUI QA gate（窓 A で Codex 更新→窓 B が即再ロード）。

### Task 10: advisory lock を Codex エディタ mount に配線（read-only バナー）

**Files:**
- Create: `src/features/codex/multiwindow/useCodexEditLock.ts`（このフックが: mount 時 `acquire` emit＋heartbeat interval、unmount 時 `release` emit、`codexEditLock` reducer 購読、`canEdit` を返す）
- Modify: `CodexDetailContent.tsx`（本文/notes エディタ。`canEdit===false` なら read-only ＋「他のウィンドウで編集中」バナー。`setCodexEditConflictHandler` でリロード誘導も配線）

- [ ] windowId は `getCurrentWindow().label`（main / codex-window）。
- [ ] `canEdit` が false の間は TipTap を `editable: false`＋バナー。holder release で復帰。
- [ ] ユニット: `useCodexEditLock` の状態遷移を renderHook で（emit/listen モック）。
- [ ] commit / GUI QA gate（同 entry を 2 窓で開く→後発が read-only バナー）。

### Task 11: per-window 選択状態（別 entry 独立編集）

**Files:**
- Modify: codex-window 側の選択は main の `activeCodexId` に追従しない独立状態にする（codex-window 専用の選択 store、または codexWindowMode 時のみ local state）。

**設計判断:** main に追従だと「同じ entry を 2 窓」になり lock で常に read-only＝無意味。codex-window は**独立に entry を選べる**必要がある。最小実装は codex-window 内のローカル選択（per-window state）。main 窓の選択とは分離。

- [ ] codex-window の Codex 一覧クリックでローカル選択のみ更新（グローバル `activeSceneId` は駆動しない）。
- [ ] commit / GUI QA gate（窓 B で別 entry を編集、窓 A は別 entry のまま）。

---

# Phase 3 — 検証 ＋ 敵対レビュー

- [ ] `npx tsc --noEmit`（型）
- [ ] `pnpm test`（全ユニット緑）
- [ ] `pnpm lint:fix`
- [ ] `cd src-tauri && cargo check`（capability/Rust）
- [ ] レイアウト変更を含むため CI で `pnpm test:browser`
- [ ] `/review-code`（敵対レビュー）→ Critical/Important を潰す。特に: 衝突時の非破壊性／lock の race とクラッシュ復帰／emit 多重再ロードの無害性／authorship の劣化（別窓 human write の帰属）。
- [ ] **GUI QA チェックリスト**（実機・Phase 2 の各 gate を集約）。

## 残課題（実装時に明示判断）
- **authorship**: 別窓本文編集の human/ai 追跡。v1 は「別窓 human write は human 既定（既存 ADR-001 の既定）」で割り切り、ai span 配線は後続。
- **scene 本文・snippet**: 本計画は Codex 限定。scene 本文 detach(T3) は別計画（OCC 列は tree_nodes にもあるので将来再利用可）。

## Self-Review メモ
- Phase 1（Task1-4）は Tauri 不要・全 TDD・このセッションで `pnpm test`/`tsc` 緑にできる。
- Phase 2（Task5-11）は決定的コードだが多窓 E2E は実機 QA gate。ユニットで切れる純関数（window mode 判定／options 組み立て／lock reducer／sync payload）は必ずテスト。
- 型整合: `updateCodexEntry` の `opts.baseVersion`、`CodexVersionConflictError`、`reduceLock/canEdit/holderOf`、`setCodexEditConflictHandler` の名前は全タスクで一致させた。
