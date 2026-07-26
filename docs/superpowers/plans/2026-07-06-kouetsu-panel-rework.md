# 校閲パネル リワーク（受信箱モデル）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 校閲パネルを「指摘（受信箱）/ コメント / ブロッカー」の3タブに再編し、Chat 流用のツリースコープ（シーン/フォルダ/プロジェクト）とステータスフィルタを導入、Phase 2 で全体チェック（観点直列実行）と Rust の per-run 中止を実装する。

**Architecture:** 指摘/批評の 2 タブ 9 セクションを 1 タブ 8 グループの受信箱に統合。スコープは `kouetsuStore` の判別 union（scene/folder/project）1 本に集約し、「除外」はステータスフィルタへ分離。folder スコープは既存の `getSceneIdsForScope`/`buildMultiPayload` の folder 対応をそのまま通す（Rust 変更不要）。疑似コメントはコメントタブへ一本化。Phase 2 は Rust の中止フラグを run_id キー化した上で、FE オーケストレータが観点を1つずつ直列実行する。

**Tech Stack:** React 19 + TypeScript strict / Zustand persist / react-resizable-panels / Tauri v2 (Rust) / Vitest。

**設計書:** `docs/superpowers/specs/2026-07-06-kouetsu-panel-rework-design.md`

## Global Constraints

- 2スペースインデント、TypeScript strict、ES modules。
- 状態管理: グローバル=Zustand、局所=Jotai。DB は Drizzle 経由・生SQL禁止。
- 1ファイル1コンポーネント、200行超えたら分割。テストはソース同階層 `*.test.ts(x)`。
- Rust: `unwrap()` 禁止（Mutex poison は `unwrap_or_else(|e| e.into_inner())` で回復）、thiserror/anyhow。
- prompt_version は FE 定数と Rust 定数の両側一致が不変条件（本計画では変更しない — 触らないこと）。
- ドキュメント・コミットメッセージ本文は日本語。
- branch-first: master 直 commit 禁止。`git add` は明示パス（`-A` 禁止）。
- コミット末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Phase 1 = ブランチ `feat/kouetsu-panel-rework`（PR 1本目）。Phase 2 = Phase 1 マージ後に新ブランチ `feat/kouetsu-full-check`（PR 2本目）。スタックしない。
- レイアウト検証: 各 Phase 完了時に `pnpm test` に加え `pnpm test:browser` を実行。
- Chat パネルの表示文字列・既存テスト（`ChatPanelHeader.test.tsx`）は green を維持する（byte-identical なラベル）。

## 精読で確定した前提（実装者はこれを信じてよい）

- `PostEffectScopeType = "scene" | "folder" | "project"`（`src/db/schema.ts:2373`）— folder は型・Rust とも既に受理される（Rust は scope_type を String で保存するだけ）。
- `getSceneIdsForScope(nodes, "folder", anchorId)` と `buildMultiPayload(projectId, "folder", anchorId, ...)` は folder subtree 対応済み（`src/features/post-effect/consistencyPayloadBuilder.ts:293-348`）。
- **intent_drift はシーン毎の `intent` を system_prompt と input_hash に畳み込む**（`intentDriftPayloadBuilder.ts:33-48`、`CurrentSceneIntentDriftView.tsx:83-94` の `appendIntentGuidance`）。multi は全シーン共有 system_prompt のため **Rust multi allowlist に足すだけでは成立しない**。→ Phase 2 では FE 直列単発ループで実装する（設計書からの逸脱、根拠は上記）。
- Rust の中止は `PostEffectAbortFlag`（単一 AtomicBool、`src-tauri/src/commands/mod.rs:62-64`）。run 開始時に false リセット（post_effect.rs:5180-5183, 5409-5411）、`run_multi_task` のループ先頭でチェック（post_effect.rs:4794）、`abort_post_effect_run`（post_effect.rs:5508-5531）が true を立てる。単発 run task は abort を見ない。
- 校正の全章スキャンは `useLintProjectStore.start(projectId): Promise<void>`（完走まで resolve しない、`src/features/lint/lintProjectStore.ts:87`）。
- `PanelHeader` 正本 API（`src/features/layout/PanelHeader.tsx:45`）: `panelId` / `count` / `children`（タイトル行の左側差し込み）/ `actions`（右端）。`PANEL_ICON_MAP.kouetsu = SpellCheck` 定義済み。
- `runPostEffectMulti` の req は `scenes: Array<{scene_id, codex_payload_json, scene_text}>` を受け、runStore/進捗トースト/OS通知への配線は `runPostEffectInternal` が一元処理（`src/features/post-effect/api.ts:311-522`）。

---

# Phase 1: UI 再編（Rust 変更なし）

## Task 1: kouetsuStore 再設計 + persist migration

**Files:**
- Modify: `src/features/kouetsu/kouetsuStore.ts`（全面書き換え）
- Create: `src/features/kouetsu/kouetsuStore.test.ts`

**Interfaces (Produces):**
```ts
export type KouetsuTab = "issues" | "comments" | "blocker";
export type KouetsuScope =
  | { type: "scene" }
  | { type: "folder"; anchorId: string }
  | { type: "project" };
export type KouetsuStatusFilter = "open" | "dismissed";
export type ProjectGroupBy = "scene" | "codex";
// state: activeTab / scope / statusFilter / projectGroupBy / panelActive
// actions: setActiveTab / setScope / setStatusFilter / setProjectGroupBy / setPanelActive
```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/kouetsu/kouetsuStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { migrateKouetsuStore, useKouetsuStore } from "./kouetsuStore";

describe("kouetsuStore persist migration (v0 → v1)", () => {
  it("editorial タブは issues へ写像される", () => {
    const migrated = migrateKouetsuStore(
      { activeTab: "editorial", activeIssuesScope: "current", activeEditorialScope: "project", projectGroupBy: "codex" },
      0,
    );
    expect(migrated.activeTab).toBe("issues");
    expect(migrated.projectGroupBy).toBe("codex");
  });
  it("current → {type:'scene'} / open", () => {
    const m = migrateKouetsuStore(
      { activeTab: "issues", activeIssuesScope: "current", activeEditorialScope: "current", projectGroupBy: "scene" },
      0,
    );
    expect(m.scope).toEqual({ type: "scene" });
    expect(m.statusFilter).toBe("open");
  });
  it("project → {type:'project'}", () => {
    const m = migrateKouetsuStore(
      { activeTab: "comments", activeIssuesScope: "project", activeEditorialScope: "current", projectGroupBy: "scene" },
      0,
    );
    expect(m.scope).toEqual({ type: "project" });
  });
  it("ignored → {type:'scene'} + statusFilter='dismissed'", () => {
    const m = migrateKouetsuStore(
      { activeTab: "issues", activeIssuesScope: "ignored", activeEditorialScope: "current", projectGroupBy: "scene" },
      0,
    );
    expect(m.scope).toEqual({ type: "scene" });
    expect(m.statusFilter).toBe("dismissed");
  });
  it("v1 以降はそのまま返す", () => {
    const v1 = { activeTab: "blocker", scope: { type: "project" }, statusFilter: "open", projectGroupBy: "scene" };
    expect(migrateKouetsuStore(v1, 1)).toEqual(v1);
  });
});

describe("kouetsuStore actions", () => {
  it("setScope / setStatusFilter が反映される", () => {
    useKouetsuStore.getState().setScope({ type: "folder", anchorId: "f1" });
    expect(useKouetsuStore.getState().scope).toEqual({ type: "folder", anchorId: "f1" });
    useKouetsuStore.getState().setStatusFilter("dismissed");
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
  });
});
```

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/kouetsuStore.test.ts` → FAIL（migrateKouetsuStore 未定義）

- [ ] **Step 3: 実装**

`src/features/kouetsu/kouetsuStore.ts` 全体を置き換え:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KouetsuTab = "issues" | "comments" | "blocker";
export type KouetsuScope =
  | { type: "scene" }
  | { type: "folder"; anchorId: string }
  | { type: "project" };
export type KouetsuStatusFilter = "open" | "dismissed";
export type ProjectGroupBy = "scene" | "codex";

interface KouetsuState {
  activeTab: KouetsuTab;
  /** 指摘タブのスコープ（Chat と同セマンティクス）。scene = アクティブシーン追従。 */
  scope: KouetsuScope;
  /** 場所軸から分離したステータスフィルタ（旧 "ignored" スコープの後継）。 */
  statusFilter: KouetsuStatusFilter;
  projectGroupBy: ProjectGroupBy;
  /**
   * AnimatedSlotPanel keepalive 中の KouetsuPanel の active 状態。
   * 実行時 UI 状態なので永続化しない (partialize で除外)。
   */
  panelActive: boolean;
  setActiveTab: (tab: KouetsuTab) => void;
  setScope: (scope: KouetsuScope) => void;
  setStatusFilter: (filter: KouetsuStatusFilter) => void;
  setProjectGroupBy: (mode: ProjectGroupBy) => void;
  setPanelActive: (active: boolean) => void;
}

interface PersistedV0 {
  activeTab?: string;
  activeIssuesScope?: "current" | "project" | "ignored";
  activeEditorialScope?: "current" | "project" | "ignored";
  projectGroupBy?: ProjectGroupBy;
}

/**
 * v0（指摘/批評独立スコープ + ignored スコープ）→ v1（単一 scope + statusFilter）。
 * 旧 activeIssuesScope を正とし、editorial 側は捨てる（タブ自体が消えるため）。
 */
export function migrateKouetsuStore(persisted: unknown, version: number) {
  if (version >= 1) return persisted as Record<string, unknown>;
  const old = (persisted ?? {}) as PersistedV0;
  const oldScope = old.activeIssuesScope ?? "current";
  const scope: KouetsuScope =
    oldScope === "project" ? { type: "project" } : { type: "scene" };
  const statusFilter: KouetsuStatusFilter =
    oldScope === "ignored" ? "dismissed" : "open";
  const activeTab: KouetsuTab =
    old.activeTab === "comments" || old.activeTab === "blocker"
      ? old.activeTab
      : "issues";
  return {
    activeTab,
    scope,
    statusFilter,
    projectGroupBy: old.projectGroupBy ?? "scene",
  };
}

export const useKouetsuStore = create<KouetsuState>()(
  persist(
    (set) => ({
      activeTab: "issues",
      scope: { type: "scene" },
      statusFilter: "open",
      projectGroupBy: "scene",
      panelActive: true,
      setActiveTab: (tab) => set({ activeTab: tab }),
      setScope: (scope) => set({ scope }),
      setStatusFilter: (filter) => set({ statusFilter: filter }),
      setProjectGroupBy: (mode) => set({ projectGroupBy: mode }),
      setPanelActive: (active) => set({ panelActive: active }),
    }),
    {
      name: "kouetsu-store",
      version: 1,
      migrate: migrateKouetsuStore,
      partialize: (s) => ({
        activeTab: s.activeTab,
        scope: s.scope,
        statusFilter: s.statusFilter,
        projectGroupBy: s.projectGroupBy,
      }),
    },
  ),
);
```

注意: 旧型 `IssuesScope` の export は**この時点では消さない**（後続タスクで参照箇所を移行してから Task 5 で削除）。一時的に `export type IssuesScope = "current" | "project" | "ignored";` を残すとコンパイルが通る。

- [ ] **Step 4: テスト green を確認** — `pnpm test --run src/features/kouetsu/kouetsuStore.test.ts` → PASS。この時点で他ファイルの型エラーは残ってよい（`npx tsc --noEmit` は Task 5 完了後に回復する）。

- [ ] **Step 5: Commit** — `git add src/features/kouetsu/kouetsuStore.ts src/features/kouetsu/kouetsuStore.test.ts && git commit -m "refactor(kouetsu): store を単一スコープ+ステータスフィルタへ再設計 (persist v1 migration)"`

## Task 2: ScopeTreePicker 共通抽出 + ChatPanelHeader 載せ替え

**Files:**
- Create: `src/features/tree/ScopeTreePicker.tsx`
- Create: `src/features/tree/ScopeTreePicker.test.tsx`
- Modify: `src/features/chat/components/ChatPanelHeader.tsx`

**Interfaces (Produces):**
```tsx
export interface TreeRow { node: TreeNodeData; depth: number }
export function flattenTree(nodes: TreeNodeData[]): TreeRow[];
export type TreeScopeSelection =
  | { type: "scene"; sceneId: string }
  | { type: "folder"; anchorId: string }
  | { type: "project" }
  | null; // null = ツリー外 (chat の codex/snippet スコープ)
export function ScopeTreePickerList(props: {
  selection: TreeScopeSelection;
  /** エディタが実際に開いているシーン（●インジケータ）。省略時は非表示 */
  editorActiveSceneId?: string;
  onPickScene: (sceneId: string) => void;
  onPickFolder: (folderId: string) => void;
  onPickProject: () => void;
}): JSX.Element;
```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/tree/ScopeTreePicker.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScopeTreePickerList, flattenTree } from "./ScopeTreePicker";
import { useTreeStore, type TreeNodeData } from "./treeStore";

const nodes: TreeNodeData[] = [
  { id: "act1", parentId: null, nodeType: "folder", title: "第一幕", sortOrder: "a" },
  { id: "ch1", parentId: "act1", nodeType: "folder", title: "第一章", sortOrder: "a" },
  { id: "s1", parentId: "ch1", nodeType: "scene", title: "冒頭", sortOrder: "a" },
  { id: "s2", parentId: "ch1", nodeType: "scene", title: "追跡", sortOrder: "b" },
] as unknown as TreeNodeData[];

beforeEach(() => {
  useTreeStore.setState({ nodes });
});

describe("flattenTree", () => {
  it("DFS 順に depth 付きで平坦化する", () => {
    const rows = flattenTree(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(["act1", "ch1", "s1", "s2"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });
});

describe("ScopeTreePickerList", () => {
  it("project 行 + folder/scene 行を出し、クリックで各 onPick* が飛ぶ", () => {
    const onScene = vi.fn();
    const onFolder = vi.fn();
    const onProject = vi.fn();
    render(
      <ScopeTreePickerList
        selection={{ type: "project" }}
        onPickScene={onScene}
        onPickFolder={onFolder}
        onPickProject={onProject}
      />,
    );
    fireEvent.click(screen.getByText("第一章"));
    expect(onFolder).toHaveBeenCalledWith("ch1");
    fireEvent.click(screen.getByText("冒頭"));
    expect(onScene).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByText("プロジェクト"));
    expect(onProject).toHaveBeenCalled();
  });
  it("selection の行に選択スタイルが付く", () => {
    render(
      <ScopeTreePickerList
        selection={{ type: "folder", anchorId: "ch1" }}
        onPickScene={() => {}}
        onPickFolder={() => {}}
        onPickProject={() => {}}
      />,
    );
    expect(screen.getByText("第一章").closest("button")?.className).toContain("bg-accent");
  });
});
```

（treeStore の setState に必要な最小フィールドは実際の `TreeNodeData` 型定義を見て合わせる。`sortOrder` は `cmpKeys` が読む fractional index。）

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/tree/ScopeTreePicker.test.tsx` → FAIL

- [ ] **Step 3: 実装**

`src/features/tree/ScopeTreePicker.tsx` を新規作成。内容は `ChatPanelHeader.tsx:91-118` の `TreeRow`/`flattenTree` を**そのまま移動**し、同 379-452 行の scene タブ本体（project 行 + rows マップ）を `ScopeTreePickerList` として一般化する:

```tsx
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Circle, FileText, FolderTree, Globe } from "lucide-react";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import { cmpKeys } from "./fractionalIndex";

export interface TreeRow {
  node: TreeNodeData;
  depth: number;
}

/** Flatten nodes into a depth-tagged DFS order using parentId chains. */
export function flattenTree(nodes: TreeNodeData[]): TreeRow[] {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  const out: TreeRow[] = [];
  function walk(parentId: string | null, depth: number) {
    const kids = childrenByParent.get(parentId) ?? [];
    for (const n of kids) {
      out.push({ node: n, depth });
      if (n.nodeType === "folder") walk(n.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

export type TreeScopeSelection =
  | { type: "scene"; sceneId: string }
  | { type: "folder"; anchorId: string }
  | { type: "project" }
  | null;

interface ScopeTreePickerListProps {
  selection: TreeScopeSelection;
  editorActiveSceneId?: string;
  onPickScene: (sceneId: string) => void;
  onPickFolder: (folderId: string) => void;
  onPickProject: () => void;
}

/**
 * プロジェクト/フォルダ/シーンを選ぶツリーピッカーの中身（popover の body）。
 * Chat スコープピッカーから抽出した共通部品。ラベルは chat.scope.* を共有する
 * （表示文字列を Chat と byte-identical に保つため。名前空間の付け替えはしない）。
 */
export function ScopeTreePickerList({
  selection,
  editorActiveSceneId,
  onPickScene,
  onPickFolder,
  onPickProject,
}: ScopeTreePickerListProps) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const rows = useMemo(() => flattenTree(nodes), [nodes]);

  return (
    <>
      <button
        type="button"
        onClick={onPickProject}
        className={[
          "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs",
          selection?.type === "project"
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        ].join(" ")}
      >
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t("chat.scope.project")}</span>
        {selection?.type === "project" && <Check className="h-3 w-3 shrink-0" />}
      </button>

      <div className="max-h-72 overflow-y-auto py-1">
        {rows.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("chat.noScenes")}
          </p>
        )}
        {rows.map(({ node, depth }) => {
          const isFolder = node.nodeType === "folder";
          if (!isFolder && node.nodeType !== "scene") return null;
          const isSelected = isFolder
            ? selection?.type === "folder" && selection.anchorId === node.id
            : selection?.type === "scene" && selection.sceneId === node.id;
          const isEditorActive = !isFolder && editorActiveSceneId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() =>
                isFolder ? onPickFolder(node.id) : onPickScene(node.id)
              }
              style={{ paddingLeft: 12 + depth * 12 }}
              className={[
                "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs",
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              ].join(" ")}
            >
              {isFolder ? (
                <FolderTree className="h-3 w-3 shrink-0 opacity-70" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 opacity-70" />
              )}
              <span className="flex-1 truncate">{node.title}</span>
              {isEditorActive && (
                <Circle
                  className="h-2 w-2 shrink-0 fill-primary text-primary"
                  aria-label={t("chat.scope.editorHere")}
                />
              )}
              {isSelected && <Check className="h-3 w-3 shrink-0" />}
            </button>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 4: ChatPanelHeader を載せ替え**

`src/features/chat/components/ChatPanelHeader.tsx`:
1. ローカルの `TreeRow` interface と `flattenTree`（91-118 行）を削除し、`import { ScopeTreePickerList } from "@/features/tree/ScopeTreePicker";` を追加。`rows` の useMemo（150 行）も削除（ScopeTreePickerList 内へ移動済み。`nodes` は currentLabel 用に残す）。不要 import（`cmpKeys`, `Circle`, `FileText`, `FolderTree`, `Globe`, `Check` のうち他で未使用のもの）を整理。
2. `{pickerTab === "scene" && (<>...</>)}`（379-452 行）の中身全体を置き換え:

```tsx
{pickerTab === "scene" && (
  <ScopeTreePickerList
    selection={
      chatScope === "project"
        ? { type: "project" }
        : chatScope === "folder" && scopeAnchorId
          ? { type: "folder", anchorId: scopeAnchorId }
          : chatScope === "scene"
            ? { type: "scene", sceneId: chatSceneId }
            : null
    }
    editorActiveSceneId={editorActiveSceneId}
    onPickScene={handlePickScene}
    onPickFolder={handlePickFolder}
    onPickProject={handlePickProject}
  />
)}
```

- [ ] **Step 5: chat 既存テスト + 新テスト green を確認**

`pnpm test --run src/features/chat/components/ChatPanelHeader.test.tsx src/features/tree/ScopeTreePicker.test.tsx` → 両方 PASS（chat のドロップダウン tablist / portal / 選択のテストが従来どおり通ること）

- [ ] **Step 6: Commit** — `git add src/features/tree/ScopeTreePicker.tsx src/features/tree/ScopeTreePicker.test.tsx src/features/chat/components/ChatPanelHeader.tsx && git commit -m "refactor(tree): ツリースコープピッカーを共通部品へ抽出し Chat を載せ替え"`

## Task 3: 校閲スコープバー（ピッカー + ステータスフィルタ）

**Files:**
- Create: `src/features/kouetsu/KouetsuScopeBar.tsx`
- Create: `src/features/kouetsu/KouetsuScopeBar.test.tsx`
- Modify: `src/locales/ja.json` / `src/locales/en.json`（kouetsu.filter.* 追加）

**Interfaces:**
- Consumes: `useKouetsuStore`(Task 1) の `scope`/`statusFilter`、`ScopeTreePickerList`(Task 2)、`useAnchoredPopover`、`useTreeStore`
- Produces: `export function KouetsuScopeBar(): JSX.Element` — props なし（store 直結）

- [ ] **Step 1: 失敗するテストを書く**

`src/features/kouetsu/KouetsuScopeBar.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { useKouetsuStore } from "./kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";

beforeEach(() => {
  useKouetsuStore.setState({ scope: { type: "scene" }, statusFilter: "open" });
  useTreeStore.setState({ nodes: [], activeSceneId: null });
});

describe("KouetsuScopeBar", () => {
  it("トリガにスコープラベルが出る（scene 既定）", () => {
    render(<KouetsuScopeBar />);
    expect(screen.getByRole("button", { name: /現在シーン/ })).toBeInTheDocument();
  });
  it("トリガクリックで ScopeTreePickerList が開き、プロジェクト選択で store が変わる", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: /現在シーン/ }));
    fireEvent.click(screen.getByText("プロジェクト"));
    expect(useKouetsuStore.getState().scope).toEqual({ type: "project" });
  });
  it("ステータスフィルタ chips: 除外クリックで statusFilter='dismissed'", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: "除外" }));
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
    // aria-pressed で状態を表現する
    expect(screen.getByRole("button", { name: "除外" })).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/KouetsuScopeBar.test.tsx` → FAIL

- [ ] **Step 3: i18n キー追加**

`src/locales/ja.json` の `kouetsu` 直下に追加:
```json
"filter": {
  "open": "開いている",
  "dismissed": "除外"
},
"scopePicker": "チェック範囲を選択"
```
`src/locales/en.json` に対応:
```json
"filter": {
  "open": "Open",
  "dismissed": "Dismissed"
},
"scopePicker": "Select check scope"
```
（既存 `kouetsu.scope.current` = 現在シーン / `kouetsu.scope.project` = プロジェクト はトリガラベルに再利用。`kouetsu.scope.ignored` は Task 9 で削除。フォルダラベルは `chat.scope.act` / `chat.scope.chapter` を再利用。）

- [ ] **Step 4: 実装**

`src/features/kouetsu/KouetsuScopeBar.tsx`:

```tsx
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, FileText, FolderTree, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { ScopeTreePickerList } from "@/features/tree/ScopeTreePicker";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import {
  useKouetsuStore,
  type KouetsuStatusFilter,
} from "./kouetsuStore";

const FILTERS: Array<{ id: KouetsuStatusFilter; labelKey: string }> = [
  { id: "open", labelKey: "kouetsu.filter.open" },
  { id: "dismissed", labelKey: "kouetsu.filter.dismissed" },
];

/**
 * 指摘タブのヘッダ行: ツリースコープピッカー（シーン/フォルダ/プロジェクト、
 * Chat と同セマンティクス）+ ステータスフィルタ chips（開いている/除外）。
 * シーン選択はエディタ移動 + scene スコープ（Chat と同挙動）。
 */
export function KouetsuScopeBar() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const setScope = useKouetsuStore((s) => s.setScope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const setStatusFilter = useKouetsuStore((s) => s.setStatusFilter);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "bottom-start",
  );

  const label = (() => {
    if (scope.type === "project") return t("kouetsu.scope.project");
    if (scope.type === "folder") {
      const folder = nodes.find((n) => n.id === scope.anchorId);
      if (!folder) return t("kouetsu.scope.project");
      const kindLabel =
        folder.parentId === null ? t("chat.scope.act") : t("chat.scope.chapter");
      return `${kindLabel}: ${folder.title}`;
    }
    const scene = nodes.find((n) => n.id === activeSceneId);
    return scene
      ? `${t("kouetsu.scope.current")}: ${scene.title}`
      : t("kouetsu.scope.current");
  })();

  const ScopeIcon =
    scope.type === "project" ? Globe : scope.type === "folder" ? FolderTree : FileText;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-2 py-1 text-xs">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[220px] items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("kouetsu.scopePicker")}
      >
        <ScopeIcon className="h-3 w-3 shrink-0 text-primary" />
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      <div className="ml-auto flex items-center gap-1">
        {FILTERS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            aria-pressed={statusFilter === id}
            onClick={() => setStatusFilter(id)}
            className={cn(
              "rounded px-2 py-0.5",
              statusFilter === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            className="z-[100] w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          >
            <ScopeTreePickerList
              selection={
                scope.type === "scene"
                  ? activeSceneId
                    ? { type: "scene", sceneId: activeSceneId }
                    : null
                  : scope
              }
              editorActiveSceneId={activeSceneId ?? undefined}
              onPickScene={(sceneId) => {
                setActiveScene(sceneId);
                setScope({ type: "scene" });
                setOpen(false);
              }}
              onPickFolder={(folderId) => {
                setScope({ type: "folder", anchorId: folderId });
                setOpen(false);
              }}
              onPickProject={() => {
                setScope({ type: "project" });
                setOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
```

注意: `useTreeStore` の「エディタでシーンを開く」アクション名は実装時に treeStore を確認して合わせる（`setActiveScene` が無ければ Chat の `onSelectScene` が使っている経路 = `ChatPanel` 側の配線を grep して同じ関数を使う）。

- [ ] **Step 5: green 確認** — `pnpm test --run src/features/kouetsu/KouetsuScopeBar.test.tsx` → PASS

- [ ] **Step 6: Commit** — `git add src/features/kouetsu/KouetsuScopeBar.tsx src/features/kouetsu/KouetsuScopeBar.test.tsx src/locales/ja.json src/locales/en.json && git commit -m "feat(kouetsu): スコープピッカー+ステータスフィルタの新スコープバー"`

## Task 4: Project 系ビューの folder スコープ対応

**Files:**
- Modify: `src/features/kouetsu/views/ProjectAnnotationsView.tsx`
- Modify: `src/features/kouetsu/views/ProjectTypoView.tsx`
- Modify: `src/features/kouetsu/views/ProjectReviewView.tsx`
- Modify: `src/features/kouetsu/views/MetaStructureView.tsx`
- Modify: `src/features/kouetsu/views/ProjectImpactReviewView.tsx`
- Modify: `src/features/kouetsu/views/ProjectIntentDriftView.tsx`
- Modify: `src/features/kouetsu/views/ProjectTimelineConsistencyView.tsx`
- Test: `src/features/kouetsu/views/ProjectReviewView.test.tsx`（既存を拡張）

**Interfaces:**
- Consumes: `useKouetsuStore().scope`(Task 1)、`getSceneIdsForScope`（`@/features/post-effect/consistencyPayloadBuilder`、folder 対応済み）
- Produces: 各 Project ビューは props 変更なし（store 直読）。内部で以下の共通パターンを適用する。

**共通パターン（全ビュー同一）:**

```ts
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";

// コンポーネント内:
const kouetsuScope = useKouetsuStore((s) => s.scope);
// multi 実行の scope 引数（scene スコープでこのビューは出ないが、型は防御的に project へ倒す）
const scopeType = kouetsuScope.type === "folder" ? ("folder" as const) : ("project" as const);
const scopeTargetId = kouetsuScope.type === "folder" ? kouetsuScope.anchorId : null;
// 表示フィルタ（folder のとき subtree 外の annotation を隠す）
const visibleSceneIds = useMemo(() => {
  if (kouetsuScope.type !== "folder") return null;
  const { nodes } = useTreeStore.getState();
  return new Set(getSceneIdsForScope(nodes, "folder", kouetsuScope.anchorId));
}, [kouetsuScope]);
```

- [ ] **Step 1: 失敗するテストを書く（代表 = ProjectReviewView）**

既存 `src/features/kouetsu/views/ProjectReviewView.test.tsx` に追加（既存のモック構成に合わせて記述する）:

```tsx
it("folder スコープでは subtree 外シーンの annotation を表示しない", async () => {
  useKouetsuStore.setState({ scope: { type: "folder", anchorId: "ch1" } });
  // listAnnotationsForProject モックに ch1 配下の s1 と、外側の sX を混ぜる
  // (既存テストのモックデータ生成ヘルパを流用し、sceneId だけ差し替える)
  render(<ProjectReviewView />);
  await screen.findByText(/冒頭/);           // subtree 内は出る
  expect(screen.queryByText(/外部シーン/)).toBeNull(); // subtree 外は出ない
});
it("folder スコープの実行は scope_type='folder' + scope_target_id を multi へ渡す", async () => {
  useKouetsuStore.setState({ scope: { type: "folder", anchorId: "ch1" } });
  render(<ProjectReviewView />);
  fireEvent.click(screen.getByRole("button", { name: /AIレビュー|チェック/ }));
  await waitFor(() => expect(runPostEffectMultiMock).toHaveBeenCalled());
  const req = runPostEffectMultiMock.mock.calls[0][0];
  expect(req.scope_type).toBe("folder");
  expect(req.scope_target_id).toBe("ch1");
});
```

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/views/ProjectReviewView.test.tsx` → FAIL

- [ ] **Step 3: 各ビューを修正**

各ファイルの具体的変更（すべて同型。ProjectReviewView で書いた形を全ビューに適用する）:

1. **ProjectReviewView.tsx / ProjectTypoView.tsx / ProjectAnnotationsView.tsx**:
   - `buildMultiPayload(projectId, "project", null, ...)` → `buildMultiPayload(projectId, scopeType, scopeTargetId, ...)`
   - `runPostEffectMulti` の req: `scope_type: "project"` → `scope_type: scopeType`、`scope_target_id: null` → `scope_target_id: scopeTargetId`
   - 実行前の空チェック `getSceneIdsForScope(nodes, "project", null)` → `getSceneIdsForScope(nodes, scopeType, scopeTargetId)`
   - 表示: annotation の scene グルーピング直前に `visibleSceneIds` でフィルタ:
     `const filtered = visibleSceneIds ? annotations.filter((a) => a.sceneId && visibleSceneIds.has(a.sceneId)) : annotations;`
2. **MetaStructureView.tsx**: `scope === "project"` 分岐の `runProject()`（225 行付近の `runPostEffectMulti`）に同じ scopeType/scopeTargetId を適用。lens 表示リスト（267-276 行の scenes 由来リスト）も `visibleSceneIds` でフィルタ。props は `scope: "current" | "project"` のまま（folder は project 扱いで入ってくる — 呼び出し側 Section が folder/project 両方でこのビューを出す）。
3. **ProjectImpactReviewView.tsx / ProjectIntentDriftView.tsx**（表示専用）: 表示フィルタのみ適用。
4. **ProjectTimelineConsistencyView.tsx**: 時系列は本質的にプロジェクト全域なので multi は **常に project のまま**（変更しない）。folder スコープ時はヘッダに `kouetsu.scope.project` のチップ（`<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("kouetsu.scope.project")}</span>`）を出して「フォルダに絞られない」ことを明示する。表示フィルタも適用しない。

- [ ] **Step 4: green 確認** — `pnpm test --run src/features/kouetsu/views/` → PASS（MetaStructureView.test.tsx / ProjectReviewView.test.tsx 既存分を含む）

- [ ] **Step 5: Commit** — `git add src/features/kouetsu/views/ProjectAnnotationsView.tsx src/features/kouetsu/views/ProjectTypoView.tsx src/features/kouetsu/views/ProjectReviewView.tsx src/features/kouetsu/views/MetaStructureView.tsx src/features/kouetsu/views/ProjectImpactReviewView.tsx src/features/kouetsu/views/ProjectIntentDriftView.tsx src/features/kouetsu/views/ProjectTimelineConsistencyView.tsx src/features/kouetsu/views/ProjectReviewView.test.tsx && git commit -m "feat(kouetsu): Project 系ビューに folder スコープ（subtree 絞り込み+multi 連携）"`

## Task 5: 指摘タブ統合（8 観点グループの受信箱）

**Files:**
- Create: `src/features/kouetsu/SectionHeader.tsx`（両タブのローカル重複を統合、`IssuesTab.tsx:22-65` の action 付き版を採用）
- Create: `src/features/kouetsu/IssuesInbox.tsx`（IssuesTab 後継）
- Create: `src/features/kouetsu/IssuesInbox.test.tsx`
- Modify: `src/features/kouetsu/sections/`（8 ファイル全部 — scope/statusFilter 分岐の更新）
- Delete: `src/features/kouetsu/IssuesTab.tsx` / `EditorialTab.tsx` / `IssuesScopeBar.tsx` / `EditorialScopeBar.tsx` / `sections/PseudoCommentSection.tsx`
- Modify: `src/features/kouetsu/kouetsuStore.ts`（暫定 `IssuesScope` export を削除）

**Interfaces:**
- Consumes: `KouetsuScopeBar`(Task 3)、Task 4 の各ビュー、`deriveIssueCounts`(Task 6 で正直化するが本タスク時点では既存 API のまま使用可)
- Produces: `export function IssuesInbox(): JSX.Element`。グループ順序（機械系→批評系）: 校正 / 誤字脱字 / 整合性 / 影響レビュー / レビュー / 狙いズレ / メタ構造 / 時系列。

**セクションの新分岐規約（全 8 セクション共通）:**

```ts
const scope = useKouetsuStore((s) => s.scope);
const statusFilter = useKouetsuStore((s) => s.statusFilter);
// 1) statusFilter === "dismissed" → DismissedAnnotationsView(category)（従来の ignored 分岐と同じ中身）
//    校正のみ LinterPanel mode="disables"、メタ構造のみ固定メッセージ（従来どおり）
// 2) scope.type === "scene" → CurrentScene* ビュー（activeSceneId ガードは従来どおり）
// 3) scope.type === "folder" | "project" → Project* ビュー（Task 4 で folder 対応済み）
//    時系列は従来どおり常に Project ビュー
```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/kouetsu/IssuesInbox.test.tsx`（KouetsuPanel.test.tsx と同じ「子を全部 vi.mock」方式）:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssuesInbox } from "./IssuesInbox";
import { useKouetsuStore } from "./kouetsuStore";

vi.mock("./KouetsuScopeBar", () => ({ KouetsuScopeBar: () => <div data-testid="scope-bar" /> }));
vi.mock("./sections/LinterSection", () => ({ LinterSection: () => <div data-testid="sec-linter" /> }));
vi.mock("./sections/TypoSection", () => ({ TypoSection: () => <div data-testid="sec-typo" /> }));
vi.mock("./sections/ConsistencySection", () => ({ ConsistencySection: () => <div data-testid="sec-consistency" /> }));
vi.mock("./sections/ImpactReviewSection", () => ({ ImpactReviewSection: () => <div data-testid="sec-impact" /> }));
vi.mock("./sections/ReviewSection", () => ({ ReviewSection: () => <div data-testid="sec-review" /> }));
vi.mock("./sections/IntentDriftSection", () => ({ IntentDriftSection: () => <div data-testid="sec-intent" /> }));
vi.mock("./sections/MetaStructureSection", () => ({ MetaStructureSection: () => <div data-testid="sec-meta" /> }));
vi.mock("./sections/TimelineConsistencySection", () => ({ TimelineConsistencySection: () => <div data-testid="sec-timeline" /> }));

beforeEach(() => {
  useKouetsuStore.setState({ scope: { type: "scene" }, statusFilter: "open" });
});

describe("IssuesInbox", () => {
  it("8 グループが機械系→批評系の順で並ぶ", () => {
    render(<IssuesInbox />);
    const headers = screen.getAllByRole("button", { name: /校正|誤字脱字|整合性|影響レビュー|レビュー|狙いズレ|メタ構造|時系列/ });
    expect(headers.length).toBeGreaterThanOrEqual(8);
  });
  it("折りたたみ中のグループはビューを mount しない（既定: 校正/誤字/整合性のみ展開）", () => {
    render(<IssuesInbox />);
    expect(screen.getByTestId("sec-linter")).toBeInTheDocument();
    expect(screen.getByTestId("sec-typo")).toBeInTheDocument();
    expect(screen.getByTestId("sec-consistency")).toBeInTheDocument();
    expect(screen.queryByTestId("sec-review")).toBeNull();
    expect(screen.queryByTestId("sec-timeline")).toBeNull();
  });
  it("ヘッダクリックで展開するとビューが mount される", () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByRole("button", { name: /レビュー/ }));
    expect(screen.getByTestId("sec-review")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/IssuesInbox.test.tsx` → FAIL

- [ ] **Step 3: SectionHeader.tsx を作成**

`IssuesTab.tsx:22-65` の `SectionHeader`（action スロット付き）をそのまま `src/features/kouetsu/SectionHeader.tsx` へ移動し `export` を付ける。

- [ ] **Step 4: sections/ 8 ファイルを新分岐規約へ更新**

各ファイル、`useKouetsuStore((s) => s.activeIssuesScope)` / `activeEditorialScope` を `scope` + `statusFilter` の 2 読みに変え、上記分岐規約どおり並べ替える。例（ConsistencySection.tsx 全文）:

```tsx
import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneAnnotationsView } from "@/features/kouetsu/views/CurrentSceneAnnotationsView";
import { ProjectAnnotationsView } from "@/features/kouetsu/views/ProjectAnnotationsView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function ConsistencySection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (statusFilter === "dismissed") {
    return (
      <DismissedAnnotationsView
        category="consistency_anchor"
        emptyLabel={t("kouetsu.consistency.emptyIgnored")}
      />
    );
  }
  if (scope.type !== "scene") {
    return <ProjectAnnotationsView />;
  }
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return <CurrentSceneAnnotationsView sceneId={activeSceneId} />;
}
```

同型で: TypoSection / ImpactReviewSection / ReviewSection / IntentDriftSection / MetaStructureSection（folder/project → `<MetaStructureView scope="project" />`）/ TimelineConsistencySection（dismissed 以外は常に Project ビュー + Task 4 のチップ）/ LinterSection:

```tsx
export function LinterSection() {
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const mode =
    statusFilter === "dismissed"
      ? "disables"
      : scope.type === "scene"
        ? "current"
        : "project";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LinterPanel mode={mode} />
    </div>
  );
}
```

- [ ] **Step 5: IssuesInbox.tsx を作成**

セクション定義配列 + map で 8 パネルを描画（1 ファイル 200 行制約のため宣言的に）。折りたたみ中は**子を render しない**（3 セクション同時 mount による project fetch の束を避ける・従来は最大5だったので悪化させない）:

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useKouetsuStore } from "./kouetsuStore";
import { deriveIssueCounts } from "./issueCounts";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { SectionHeader } from "./SectionHeader";
import { LinterSection } from "./sections/LinterSection";
import { TypoSection } from "./sections/TypoSection";
import { ConsistencySection } from "./sections/ConsistencySection";
import { ImpactReviewSection } from "./sections/ImpactReviewSection";
import { ReviewSection } from "./sections/ReviewSection";
import { IntentDriftSection } from "./sections/IntentDriftSection";
import { MetaStructureSection } from "./sections/MetaStructureSection";
import { TimelineConsistencySection } from "./sections/TimelineConsistencySection";

interface SectionDef {
  key: string;
  titleKey: string;
  defaultExpanded: boolean;
  countKey:
    | "linterCount"
    | "typoCount"
    | "consistencyCount"
    | "impactCount"
    | "reviewCount"
    | "intentCount"
    | null;
  Body: () => JSX.Element;
  /** ヘッダ右端の補助表示（校正=自動検出ラベルのみ） */
  actionKey?: string;
}

// 機械系 → 批評系の固定順。「指摘/批評」はタブではなく並び順に降格する。
const SECTIONS: SectionDef[] = [
  { key: "linter", titleKey: "settings.linter.proofreading", defaultExpanded: true, countKey: "linterCount", Body: LinterSection, actionKey: "settings.ai.autoDetect" },
  { key: "typo", titleKey: "kouetsu.issues.typo", defaultExpanded: true, countKey: "typoCount", Body: TypoSection },
  { key: "consistency", titleKey: "codex.tab.consistency", defaultExpanded: true, countKey: "consistencyCount", Body: ConsistencySection },
  { key: "impact", titleKey: "kouetsu.impactReview.title", defaultExpanded: false, countKey: "impactCount", Body: ImpactReviewSection },
  { key: "review", titleKey: "kouetsu.editorial.review", defaultExpanded: false, countKey: "reviewCount", Body: ReviewSection },
  { key: "intent", titleKey: "kouetsu.editorial.intentDrift", defaultExpanded: false, countKey: "intentCount", Body: IntentDriftSection },
  { key: "meta", titleKey: "kouetsu.editorial.metaStructure", defaultExpanded: false, countKey: null, Body: MetaStructureSection },
  { key: "timeline", titleKey: "kouetsu.editorial.timeline", defaultExpanded: false, countKey: null, Body: TimelineConsistencySection },
];

export function IssuesInbox() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);

  const counts = useMemo(
    () =>
      deriveIssueCounts({
        diagnostics,
        annotationsByScene,
        scope,
        statusFilter,
        activeSceneId,
      }),
    [diagnostics, annotationsByScene, scope, statusFilter, activeSceneId],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <KouetsuScopeBar />
      <ResizablePanelGroup orientation="vertical" className="flex-1 overflow-hidden">
        {SECTIONS.map((def, i) => (
          <InboxSection
            key={def.key}
            def={def}
            count={def.countKey ? counts[def.countKey] : null}
            withHandle={i > 0}
          />
        ))}
      </ResizablePanelGroup>
    </div>
  );
}
```

`InboxSection` は同ファイル内の子（1 ファイル 1 公開コンポーネント原則の範囲内のローカル private。行数が 200 を超える場合は `InboxSection.tsx` へ分割する）:

```tsx
function InboxSection({ def, count, withHandle }: { def: SectionDef; count: number | null; withHandle: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(def.defaultExpanded);
  const ref = usePanelRef();
  const toggle = () => {
    if (expanded) ref.current?.collapse();
    else ref.current?.expand();
  };
  return (
    <>
      {withHandle && <ResizableHandle horizontal withHandle />}
      <ResizablePanel
        panelRef={ref}
        collapsible
        collapsedSize={32}
        minSize="10%"
        defaultSize={def.defaultExpanded ? "22%" : undefined}
        onResize={() => setExpanded(!(ref.current?.isCollapsed() ?? false))}
        className="flex flex-col overflow-hidden"
      >
        <SectionHeader
          title={t(def.titleKey)}
          count={count ?? 0}
          expanded={expanded}
          onToggle={toggle}
          action={
            def.actionKey ? (
              <span className="text-[10px] text-muted-foreground">{t(def.actionKey)}</span>
            ) : undefined
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {expanded && <def.Body />}
        </div>
      </ResizablePanel>
    </>
  );
}
```

（collapsible の初期 collapse: `defaultExpanded: false` のパネルはマウント後に `ref.current?.collapse()` を初回 effect で呼ぶ。react-resizable-panels に `defaultCollapsed` 相当があるか実装時に確認し、無ければ `useEffect(() => { if (!def.defaultExpanded) ref.current?.collapse(); }, [])`。）

- [ ] **Step 6: 旧ファイル削除 + 参照更新**

- `IssuesTab.tsx` / `EditorialTab.tsx` / `IssuesScopeBar.tsx` / `EditorialScopeBar.tsx` / `sections/PseudoCommentSection.tsx` を削除（PseudoCommentSection の中身は Task 7 で Comments 側に吸収されるため、この時点で消してよい。CurrentScenePseudoCommentView 本体は Task 7 まで残す）。
- `kouetsuStore.ts` の暫定 `IssuesScope` export と `deriveIssueCounts` の旧 import を確認して整理（issueCounts.ts は Task 6 で書き換えるため、この時点では `deriveIssueCounts` に `statusFilter` を受けさせる最小 shim を入れる: 引数に `statusFilter` を追加受理し、`scope` は `KouetsuScope` を受けて `scope.type === "scene"` を旧 `"current"` 扱いにする）。
- `KouetsuPanel.tsx` はまだ 4 タブのまま（Task 8 で 3 タブ化）。ビルドを通すため、暫定的に `IssuesTab`→`IssuesInbox`、`EditorialTab` の import を外し editorial 分岐で `IssuesInbox` を描画しておく（Task 8 で正式に削除）。

- [ ] **Step 7: green 確認** — `pnpm test --run src/features/kouetsu/` → PASS（KouetsuPanel.test.tsx の editorial スタブ mock が壊れるので、この時点で該当 mock 行を削除して 4→タブ数 assert を一時 `4` のまま維持。Task 8 で 3 に更新）

- [ ] **Step 8: Commit** — `git add -- src/features/kouetsu/ && git commit -m "feat(kouetsu): 指摘/批評タブを 8 観点グループの受信箱へ統合"`（削除を含むため kouetsu ディレクトリ指定で add。`-A` は使わない）

## Task 6: バッジ正直化 + LocalTypoList 削除（誤字/校正の重複解消）

**Files:**
- Modify: `src/features/kouetsu/issueCounts.ts`（全面書き換え）
- Modify: `src/features/kouetsu/issueCounts.test.ts`
- Modify: `src/features/kouetsu/views/CurrentSceneTypoView.tsx`（LocalTypoList 削除）
- Modify: `src/features/kouetsu/IssuesInbox.tsx`（新 counts 型へ追従）

**Interfaces (Produces):**
```ts
export interface IssueCounts {
  linterCount: number | null;   // scene+open のみ実数、他は null (バッジ非表示 = 嘘の0を出さない)
  typoCount: number | null;     // AI 検出 (typo_anchor) のみ。lint 二重計上を廃止
  consistencyCount: number | null;
  impactCount: number | null;
  reviewCount: number | null;
  intentCount: number | null;
}
export function deriveIssueCounts(args: {
  diagnostics: Diagnostic[];
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  scope: KouetsuScope;
  statusFilter: KouetsuStatusFilter;
  activeSceneId: string | null;
}): IssueCounts;
```

- [ ] **Step 1: 失敗するテストを書く**

`issueCounts.test.ts` を新仕様で書き換え（既存ケースのデータ生成は流用）:

```ts
it("typo lint 診断は typoCount に含めない（二重計上廃止）", () => {
  const counts = deriveIssueCounts({
    diagnostics: [typoLintDiag, otherLintDiag],
    annotationsByScene: new Map([["s1", [openTypoAnn]]]),
    scope: { type: "scene" },
    statusFilter: "open",
    activeSceneId: "s1",
  });
  expect(counts.linterCount).toBe(2); // 校正は全 lint 診断
  expect(counts.typoCount).toBe(1);   // AI typo_anchor のみ
});
it("scene 以外のスコープでは全カウントが null（0 固定の嘘バッジ禁止）", () => {
  const counts = deriveIssueCounts({
    diagnostics: [typoLintDiag],
    annotationsByScene: new Map([["s1", [openTypoAnn]]]),
    scope: { type: "project" },
    statusFilter: "open",
    activeSceneId: "s1",
  });
  expect(counts.linterCount).toBeNull();
  expect(counts.typoCount).toBeNull();
});
it("statusFilter=dismissed では全カウント null", () => {
  const counts = deriveIssueCounts({
    diagnostics: [],
    annotationsByScene: new Map(),
    scope: { type: "scene" },
    statusFilter: "dismissed",
    activeSceneId: "s1",
  });
  expect(counts.consistencyCount).toBeNull();
});
it("review / intent もカウントされる（旧 EditorialTab のインライン計数を吸収）", () => {
  const counts = deriveIssueCounts({
    diagnostics: [],
    annotationsByScene: new Map([["s1", [openReviewAnn, openIntentAnn]]]),
    scope: { type: "scene" },
    statusFilter: "open",
    activeSceneId: "s1",
  });
  expect(counts.reviewCount).toBe(1);
  expect(counts.intentCount).toBe(1);
});
```

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/issueCounts.test.ts` → FAIL

- [ ] **Step 3: issueCounts.ts を書き換え**

```ts
import type { Diagnostic } from "@/features/lint/types";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import type { KouetsuScope, KouetsuStatusFilter } from "./kouetsuStore";

export interface IssueCounts {
  linterCount: number | null;
  typoCount: number | null;
  consistencyCount: number | null;
  impactCount: number | null;
  reviewCount: number | null;
  intentCount: number | null;
}

/**
 * 受信箱グループのバッジ件数。不変条件: バッジは「いま表示されている件数」に
 * 一致する実数のみ。scene スコープ + open フィルタ以外では件数を知らないので
 * null（バッジ非表示）を返す — 0 固定の嘘バッジ（旧実装）を出さない。
 * typo lint は校正(linterCount)のみに計上（旧 MVP の意図的二重計上を廃止）。
 */
export function deriveIssueCounts({
  diagnostics,
  annotationsByScene,
  scope,
  statusFilter,
  activeSceneId,
}: {
  diagnostics: Diagnostic[];
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  scope: KouetsuScope;
  statusFilter: KouetsuStatusFilter;
  activeSceneId: string | null;
}): IssueCounts {
  const NONE: IssueCounts = {
    linterCount: null,
    typoCount: null,
    consistencyCount: null,
    impactCount: null,
    reviewCount: null,
    intentCount: null,
  };
  if (scope.type !== "scene" || statusFilter !== "open" || !activeSceneId) {
    return NONE;
  }
  const anns = annotationsByScene.get(activeSceneId) ?? [];
  const openOf = (category: string) =>
    anns.filter((a) => a.status === "open" && a.category === category).length;
  return {
    linterCount: diagnostics.length,
    typoCount: openOf("typo_anchor"),
    consistencyCount: openOf("consistency_anchor"),
    impactCount: openOf("impact_review_anchor"),
    reviewCount: openOf("review"),
    intentCount: anns.filter(
      (a) => a.status === "open" && a.category === "intent_anchor",
    ).length,
  };
}
```

`IssuesInbox.tsx` の `SectionHeader` 呼び出しは `count={count ?? 0}`（SectionHeader は count>0 のみバッジ表示なので null→0 で非表示になる）のままで整合する。Task 5 で入れた shim を本実装に差し替える。

- [ ] **Step 4: CurrentSceneTypoView.tsx から LocalTypoList を削除**

- `LocalTypoList` 関数（~214-306 行）と呼び出し（`<LocalTypoList />`）、`useLintStore` / `Diagnostic` / `buildOffsetMap` / `strOffsetToPmPos` / `guardInlineAiPending` など LocalTypoList 専用 import、`TYPO_RULE_ID` 定数を削除。「AI検出」sticky サブヘッダは残す（唯一のリストになるがラベルで出自が分かる価値があるため）。
- 確定タイポ（lint 検出）は校正グループ（LinterPanel）で引き続き見える — UX 後退ではなく重複解消であることをコミットメッセージに明記。

- [ ] **Step 5: green 確認** — `pnpm test --run src/features/kouetsu/` → PASS

- [ ] **Step 6: Commit** — `git add src/features/kouetsu/issueCounts.ts src/features/kouetsu/issueCounts.test.ts src/features/kouetsu/views/CurrentSceneTypoView.tsx src/features/kouetsu/IssuesInbox.tsx && git commit -m "fix(kouetsu): バッジ正直化（嘘の0を廃止）+ 誤字/校正の二重表示解消 (LocalTypoList 削除)"`

## Task 7: 疑似コメントをコメントタブへ一本化

**Files:**
- Create: `src/features/kouetsu/PseudoCommentRunControl.tsx`（CurrentScenePseudoCommentView からペルソナ選択+実行ロジックを抽出）
- Create: `src/features/kouetsu/PseudoCommentRunControl.test.tsx`
- Modify: `src/features/kouetsu/CommentsTab.tsx`（ヘッダに実行コントロール + 「除外」チップ追加）
- Delete: `src/features/kouetsu/views/CurrentScenePseudoCommentView.tsx`

**Interfaces:**
- Produces: `export function PseudoCommentRunControl(props: { onCompleted: () => Promise<void> | void }): JSX.Element` — アクティブシーン対象。シーン未選択時は disabled + title で理由表示。
- Consumes: `pseudoCommentPayloadBuilder` の全ヘルパ（`CurrentScenePseudoCommentView.tsx:16-24` の import 群をそのまま）、`runPostEffect`、`useIsPostEffectRunning("pseudo_comment", "scene", activeSceneId)`。

- [ ] **Step 1: 失敗するテストを書く**

`PseudoCommentRunControl.test.tsx`（`runPostEffect` を vi.mock）:

```tsx
it("アクティブシーンなしでは実行ボタンが disabled", () => {
  useTreeStore.setState({ activeSceneId: null });
  render(<PseudoCommentRunControl onCompleted={() => {}} />);
  expect(screen.getByRole("button", { name: /実行|生成/ })).toBeDisabled();
});
it("ペルソナを選んで実行すると effect_type=pseudo_comment / scope=scene で起動する", async () => {
  useTreeStore.setState({ activeSceneId: "s1", projectId: "p1" });
  render(<PseudoCommentRunControl onCompleted={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /実行|生成/ }));
  await waitFor(() => expect(runPostEffectMock).toHaveBeenCalled());
  const req = runPostEffectMock.mock.calls[0][0];
  expect(req.effect_type).toBe("pseudo_comment");
  expect(req.scope_type).toBe("scene");
  expect(req.scope_target_id).toBe("s1");
});
```

（AI gate / license gate / aiSettingsStore は CurrentSceneIntentDriftView.test 等の既存 kouetsu テストの mock 構成を流用する。）

- [ ] **Step 2: 失敗を確認** — FAIL

- [ ] **Step 3: 実装**

`CurrentScenePseudoCommentView.tsx` から以下を `PseudoCommentRunControl.tsx` へ移植（view の `run` useCallback 全体 = 129-224 行、persona/genre/targetReaders の state と effect = 64-128 行、ペルソナ `<select>` + 実行ボタンの JSX）。差分:
- `sceneId` prop → `useTreeStore((s) => s.activeSceneId)` 直読。null なら disabled。
- スレッド表示 (`groupPseudoThreads` / `PseudoCommentThread`) は持たない（CommentsTab が既に表示している）。
- 完了時 `await reload()` → `await props.onCompleted()`（CommentsTab の `reloadAnnotations` を渡す）。
- `panelActive` 依存の scene 追従 reload は持ち込まない（表示を持たないため不要）。

`CommentsTab.tsx` の変更:
1. フィルタ行（113-133 行の chips）の右に `<PseudoCommentRunControl onCompleted={reloadAnnotations} />` を配置。
2. chips 列に「除外」トグルを追加（`Filter` 型は変えず、別 state）:

```tsx
const [showDismissed, setShowDismissed] = useState(false);
// chips の後:
<button
  type="button"
  aria-pressed={showDismissed}
  onClick={() => setShowDismissed(!showDismissed)}
  className={cn("rounded px-2 py-0.5", showDismissed ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
>
  {t("kouetsu.filter.dismissed")}
</button>
// 本文: showDismissed のとき
{showDismissed ? (
  <DismissedAnnotationsView category="pseudo_comment" emptyLabel={t("kouetsu.pseudoComment.emptyIgnored")} />
) : ( /* 既存のグループ描画 */ )}
```

3. `CurrentScenePseudoCommentView.tsx` を削除（参照ゼロを `grep -rn "CurrentScenePseudoCommentView" src/` で確認）。`kouetsuStore.panelActive` を読む唯一の消費者だったため、`panelActive` の他参照が無ければ**残す**（KouetsuPanel が書き込むため store からは消さない — 将来の hidden-bail 用に保持、コメントで明記）。

- [ ] **Step 4: green 確認** — `pnpm test --run src/features/kouetsu/` → PASS

- [ ] **Step 5: Commit** — `git add src/features/kouetsu/PseudoCommentRunControl.tsx src/features/kouetsu/PseudoCommentRunControl.test.tsx src/features/kouetsu/CommentsTab.tsx && git rm src/features/kouetsu/views/CurrentScenePseudoCommentView.tsx && git commit -m "feat(kouetsu): 疑似コメントをコメントタブへ一本化（二重表示解消・実行導線ごと移設）"`

## Task 8: KouetsuPanel 3 タブ化 + PanelHeader 正本採用

**Files:**
- Modify: `src/features/kouetsu/KouetsuPanel.tsx`
- Modify: `src/features/kouetsu/KouetsuPanel.test.tsx`

- [ ] **Step 1: テストを新構造へ書き換え（失敗させる）**

`KouetsuPanel.test.tsx`: mock を `IssuesInbox` / `CommentsTab` / `BlockerTab` の 3 つに変更（EditorialTab mock 削除）、`expect(tabs).toHaveLength(3)` へ。追加ケース:

```tsx
it("persist 済みの旧タブ値 editorial は issues へ正規化される", () => {
  useKouetsuStore.setState({ activeTab: "editorial" as never });
  render(<KouetsuPanel />);
  expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
});
it("パネルヘッダは data-panel-header を持つ（PanelHeader 正本）", () => {
  const { container } = render(<KouetsuPanel />);
  expect(container.querySelector("[data-panel-header]")).not.toBeNull();
});
```

矢印キー循環テストは 3 タブ前提の index に更新。

- [ ] **Step 2: 失敗を確認** — `pnpm test --run src/features/kouetsu/KouetsuPanel.test.tsx` → FAIL

- [ ] **Step 3: 実装**

`KouetsuPanel.tsx`:
- `TABS` を 3 件に: `issues`（`kouetsu.tab.issues`）/ `comments` / `blocker`。
- 生 div ヘッダ（58-97 行）を `PanelHeader` へ置換。tablist は `children` として差し込む（APG キーボード処理・roving tabindex・id 配線は既存実装をそのまま移設）:

```tsx
<PanelHeader panelId="kouetsu">
  <div role="tablist" aria-label={t("layout.panel.kouetsu")} className="flex items-center gap-0.5">
    {TABS.map(({ id, labelKey }, index) => (
      /* 既存 71-95 行のタブ button をそのまま */
    ))}
  </div>
</PanelHeader>
```

- tabpanel 分岐: `issues` → `<IssuesInbox />`、`comments` → `<CommentsTab />`、`blocker` → `<BlockerTab />`。
- 既存の不正値正規化（26-28 行）は TABS が 3 件になることで旧 "editorial" を自動的に issues へ倒す — そのまま活きる。

- [ ] **Step 4: green 確認** — `pnpm test --run src/features/kouetsu/KouetsuPanel.test.tsx` → PASS

- [ ] **Step 5: Commit** — `git add src/features/kouetsu/KouetsuPanel.tsx src/features/kouetsu/KouetsuPanel.test.tsx && git commit -m "feat(kouetsu): トップタブを指摘/コメント/ブロッカーの3つへ再編 + PanelHeader 正本採用"`

## Task 9: i18n 整理

**Files:**
- Modify: `src/locales/ja.json` / `src/locales/en.json`

- [ ] **Step 1: 不要キー削除 + 参照確認**

- 削除: `kouetsu.tab.editorial`、`kouetsu.scope.ignored`、`kouetsu.pseudoComment.projectUnavailable`（PseudoCommentSection 削除で参照ゼロ）。
- 削除前に必ず `grep -rn "<key>" src/` で参照ゼロを確認する。
- `kouetsu.editorial.*` のセクションタイトル（review/intentDrift/metaStructure/timeline）は受信箱グループ名として**継続使用**（キー名は editorial のままで良い — キーの一斉リネームは翻訳 diff を汚すだけなので**やらない**。コメント不要）。

- [ ] **Step 2: 検証** — `pnpm test --run src/features/kouetsu/ && pnpm lint:fix` → PASS / エラーなし

- [ ] **Step 3: Commit** — `git add src/locales/ja.json src/locales/en.json && git commit -m "chore(kouetsu): リワークで参照が消えた i18n キーを削除"`

## Task 10: Phase 1 全体検証 + PR

- [ ] **Step 1: 全テスト** — `pnpm test` → PASS
- [ ] **Step 2: 型チェック** — `npx tsc --noEmit` → エラー 0
- [ ] **Step 3: Lint** — `pnpm lint:fix` → エラー 0（自動修正分があれば個別 add で追いコミット）
- [ ] **Step 4: ブラウザテスト** — `pnpm test:browser` → PASS（レイアウト invariant 回帰なし）
- [ ] **Step 5: 手動スモーク（可能なら）** — `pnpm tauri dev` で: タブ 3 つ / スコープピッカーでフォルダ選択 → 整合性の AI チェックがそのフォルダのみ対象 / 除外フィルタ → 各グループが dismissed リスト / 旧 persist からの移行（`kouetsu-store` の localStorage を旧形式にして起動）
- [ ] **Step 6: PR 作成** — /ship-branch 相当のフロー（push → PR）。PR タイトル: `feat(kouetsu): 校閲パネルを受信箱モデルへ再編 (Phase 1)`。本文に設計書パスと「指摘/批評統合・スコープ/フィルタ分離・疑似コメント一本化・バッジ正直化」の要約、Phase 2 が別 PR である旨を記載。

---

# Phase 2: 全体チェック + Rust 手当て

**前提: Phase 1 の PR がマージ済み。master から新ブランチ `feat/kouetsu-full-check` を切る。**

## Task 11: Rust — 中止フラグの per-run 化

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`（`PostEffectAbortFlag` → `PostEffectAbortRegistry`）
- Modify: `src-tauri/src/lib.rs`（manage 差し替え）
- Modify: `src-tauri/src/commands/post_effect.rs`（リセット削除・チェック・abort・終端 clear）

**Interfaces (Produces):**
```rust
pub(crate) struct PostEffectAbortRegistry {
    aborted: std::sync::Mutex<std::collections::HashSet<String>>,
}
impl PostEffectAbortRegistry {
    pub(crate) fn new() -> Self;
    pub(crate) fn request(&self, run_id: &str);
    pub(crate) fn is_aborted(&self, run_id: &str) -> bool;
    /// run 終端時に呼ぶ（累積によるメモリリーク防止）
    pub(crate) fn clear(&self, run_id: &str);
}
```

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/commands/post_effect.rs` のテスト mod（既存 `decide_multi_outcome` テスト群の隣）に追加:

```rust
#[test]
fn abort_registry_is_scoped_per_run() {
    let reg = super::PostEffectAbortRegistry::new();
    reg.request("run-a");
    assert!(reg.is_aborted("run-a"));
    assert!(!reg.is_aborted("run-b")); // 他 run に波及しない
    reg.clear("run-a");
    assert!(!reg.is_aborted("run-a")); // 終端後は解除され、後続の同名 run を汚さない
}
```

- [ ] **Step 2: 失敗を確認** — `cd src-tauri && cargo test --no-default-features abort_registry` → コンパイルエラー（型未定義）

- [ ] **Step 3: 実装**

1. `mod.rs:62-64` の `PostEffectAbortFlag` を置換:

```rust
/// PostEffect run の中止要求を run_id 単位で保持するレジストリ。
/// 旧実装はアプリ全体で単一の AtomicBool だったため、並走 run の一方を
/// 中止すると全 run に波及し、新 run 開始が中止要求を握り潰していた。
pub(crate) struct PostEffectAbortRegistry {
    aborted: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl PostEffectAbortRegistry {
    pub(crate) fn new() -> Self {
        Self { aborted: std::sync::Mutex::new(std::collections::HashSet::new()) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        // poison は前保持者の panic 痕。フラグ集合は整合性を要しないので回復して続行。
        self.aborted.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn request(&self, run_id: &str) {
        self.lock().insert(run_id.to_string());
    }
    pub(crate) fn is_aborted(&self, run_id: &str) -> bool {
        self.lock().contains(run_id)
    }
    pub(crate) fn clear(&self, run_id: &str) {
        self.lock().remove(run_id);
    }
}
```

2. `lib.rs:150-152`: `app.manage(PostEffectAbortFlag { ... })` → `app.manage(PostEffectAbortRegistry::new());`（import も更新）。
3. `post_effect.rs`:
   - `use super::PostEffectAbortFlag;`（18 行）→ `use super::PostEffectAbortRegistry;`
   - `start_post_effect_run`（5176 行の State 引数と 5180-5183 のリセット）: State 引数ごと削除（単発 run は abort を見ないため不要）。リセット行も削除。
   - `start_post_effect_run_multi`（5406 行 / 5409-5411）: State 引数を `State<'_, PostEffectAbortRegistry>` に…実際には `run_multi_task` 内で `app.state::<PostEffectAbortRegistry>()`（4779 行の書き換え）で取るため、コマンド側の State 引数とリセットは削除。
   - `run_multi_task` 4794 行: `abort_flag.flag.load(...)` → `abort_flag.is_aborted(&run_id)`（変数名は `abort_registry` へリネーム）。中止でループを抜ける分岐、および正常完了/失敗の**全終端パス**で `abort_registry.clear(&run_id);` を呼ぶ。
   - `abort_post_effect_run`（5508-5531）: `abort_flag.flag.store(true, ...)` → `registry.request(&run_id);`（State 型を差し替え）。DB の cancelled UPDATE はそのまま。
4. `grep -rn "PostEffectAbortFlag" src-tauri/src/` が 0 件になることを確認。

- [ ] **Step 4: 検証** — `cd src-tauri && cargo check && cargo clippy --all-targets && cargo test --no-default-features` → PASS

- [ ] **Step 5: Commit** — `git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/commands/post_effect.rs && git commit -m "fix(post-effect): 中止フラグを run_id 単位へ (並走 run への波及と新 run による握り潰しを解消)"`

## Task 12: FE — 実行ロジックの runners 抽出

**Files:**
- Create: `src/features/kouetsu/runners.ts`
- Create: `src/features/kouetsu/runners.test.ts`
- Modify: `src/features/kouetsu/views/ProjectTypoView.tsx` / `ProjectReviewView.tsx` / `ProjectAnnotationsView.tsx` / `ProjectTimelineConsistencyView.tsx` / `MetaStructureView.tsx`（runner 委譲）

**Interfaces (Produces):**
```ts
export type KouetsuRunScope =
  | { type: "scene"; sceneId: string }
  | { type: "folder"; anchorId: string }
  | { type: "project" };
export type KouetsuRunOutcome =
  | { ok: true; fromCache: boolean; count: number; summary?: string }
  | { ok: false; error: string }
  | { ok: true; skipped: true }; // 対象シーン 0 件
export async function runTypoCheck(scope: KouetsuRunScope): Promise<KouetsuRunOutcome>;
export async function runReviewCheck(scope: KouetsuRunScope): Promise<KouetsuRunOutcome>;
export async function runConsistencyCheck(scope: KouetsuRunScope): Promise<{ codex: KouetsuRunOutcome; intra: KouetsuRunOutcome }>;
export async function runMetaStructureCheck(scope: KouetsuRunScope): Promise<KouetsuRunOutcome>;
export async function runTimelineCheck(): Promise<KouetsuRunOutcome>; // 常に project
```

各 runner は「ガード(policy/license) → flush → payload build → runPostEffect(Multi) → outcome へ正規化」までを担い、**トースト表示と一覧再取得は呼び出し側**（ビュー/オーケストレータ）に残す。ビューの `run`/`runAll`/`runMulti` 内のガード+payload+起動コード（例: `ProjectTypoView.tsx:122-184`、`ProjectReviewView.tsx:100-133`、`ProjectAnnotationsView.tsx:151-225` の `startOneMulti`、`MetaStructureView.tsx` の runScene/runProject、`ProjectTimelineConsistencyView.tsx:152-180` 付近、`CurrentSceneTypoView.tsx:95-169`、`CurrentSceneReviewView.tsx:62-153` の起動部分）を**そのまま移設**する。scene スコープは単発 `runPostEffect`、folder/project は `buildMultiPayload(projectId, scope.type, anchorId, ...)` + `runPostEffectMulti`。

- [ ] **Step 1: 失敗するテストを書く**

`runners.test.ts`（`runPostEffect`/`runPostEffectMulti`/payload builder を vi.mock）:

```ts
it("runTypoCheck(project) は multi を project スコープで起動し outcome を正規化する", async () => {
  runPostEffectMultiMock.mockImplementation((_req, cb) => {
    cb.onDone?.({ run_id: "r1", annotation_count: 3, from_cache: false });
    return Promise.resolve({ runId: "r1", cleanup: () => {} });
  });
  const out = await runTypoCheck({ type: "project" });
  expect(out).toEqual({ ok: true, fromCache: false, count: 3 });
});
it("runTypoCheck(scene) は単発 run を起動する", async () => { /* runPostEffectMock 検証 */ });
it("対象シーン 0 件は skipped を返し invoke しない", async () => {
  buildMultiPayloadMock.mockResolvedValue({ scenes: [], inputHash: "h" });
  const out = await runTypoCheck({ type: "project" });
  expect(out).toEqual({ ok: true, skipped: true });
  expect(runPostEffectMultiMock).not.toHaveBeenCalled();
});
it("onError は ok:false へ正規化される", async () => { /* ... */ });
```

- [ ] **Step 2: 失敗を確認** — FAIL

- [ ] **Step 3: runners.ts を実装し、5 ビューを委譲へ書き換え**

ビュー側は `launching` 管理・runner 呼び出し・結果トースト・`afterRunAll`/`reload` だけになる。ビューの既存テストが green のままであることが移設の正しさの検証になる。

- [ ] **Step 4: green 確認** — `pnpm test --run src/features/kouetsu/` → PASS

- [ ] **Step 5: Commit** — `git add src/features/kouetsu/runners.ts src/features/kouetsu/runners.test.ts src/features/kouetsu/views/ && git commit -m "refactor(kouetsu): チェック起動ロジックを runners へ抽出（ビュー間重複の解消・オーケストレータ準備）"`

## Task 13: intent_drift の複数シーン直列 runner + 実行ボタン

**Files:**
- Modify: `src/features/kouetsu/runners.ts`（`runIntentDriftCheck` 追加）
- Modify: `src/features/kouetsu/runners.test.ts`
- Modify: `src/features/kouetsu/views/ProjectIntentDriftView.tsx`（実行ボタン追加）

**設計判断（設計書からの確定逸脱）:** intent_drift はシーン毎の `intent` が system_prompt / input_hash に畳み込まれるため multi 化しない。**単発 run をシーン毎に直列実行**する。per-scene キャッシュ（input_hash）が効くため、intent と本文が未変更のシーンは from_cache で即終わる。intent 未設定シーンはスキップ。

**Interfaces (Produces):**
```ts
export async function runIntentDriftCheck(
  scope: KouetsuRunScope,
  opts?: { onSceneProgress?: (done: number, total: number) => void; isCancelled?: () => boolean },
): Promise<KouetsuRunOutcome>; // count は全シーン合算、途中キャンセルは summary に反映
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
it("intent 未設定のシーンはスキップし、intent ありだけ直列に単発 run する", async () => {
  // nodes: s1(intent="緊張感"), s2(intent="")、scope=project
  const out = await runIntentDriftCheck({ type: "project" });
  expect(runPostEffectMock).toHaveBeenCalledTimes(1);
  expect(runPostEffectMock.mock.calls[0][0].scope_target_id).toBe("s1");
});
it("isCancelled が true を返したら残りシーンを起動しない", async () => {
  let calls = 0;
  const out = await runIntentDriftCheck({ type: "project" }, { isCancelled: () => calls++ >= 1 });
  expect(runPostEffectMock.mock.calls.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: 失敗を確認** — FAIL

- [ ] **Step 3: 実装**

`runIntentDriftCheck`: `getSceneIdsForScope`（scene スコープは `[sceneId]`）→ 各シーンの `intent` を treeStore ノードから取得（`CurrentSceneIntentDriftView` が読んでいるフィールドを確認して同じ経路で）→ intent 非空のみ、`buildIntentDriftPayload` + `appendIntentGuidance`（`CurrentSceneIntentDriftView.tsx:64-110` の起動部分を per-scene 化して移設）→ `runPostEffect` を await で直列 → 合算。`ProjectIntentDriftView` に Sparkles 実行ボタン（他 Project ビューと同じ見た目・`useIsPostEffectRunning("intent_drift", "scene")` で spinner、完了後 `reload()`）。ビュー先頭の「表示のみ」コメント（`ProjectIntentDriftView.tsx:9`）を削除。

- [ ] **Step 4: green 確認** — PASS
- [ ] **Step 5: Commit** — `git add src/features/kouetsu/runners.ts src/features/kouetsu/runners.test.ts src/features/kouetsu/views/ProjectIntentDriftView.tsx && git commit -m "feat(kouetsu): 狙いズレ診断の複数シーン直列実行（per-scene キャッシュ活用・intent 未設定はスキップ）"`

## Task 14: 全体チェック オーケストレータ + UI

**Files:**
- Create: `src/features/kouetsu/fullCheck.ts`（オーケストレータ、Zustand store 含む）
- Create: `src/features/kouetsu/fullCheck.test.ts`
- Create: `src/features/kouetsu/FullCheckControl.tsx`（ボタン + 観点選択ポップオーバー + 進捗/中止）
- Create: `src/features/kouetsu/FullCheckControl.test.tsx`
- Modify: `src/features/kouetsu/kouetsuStore.ts`（`fullCheckEffects` persist 追加）
- Modify: `src/features/kouetsu/IssuesInbox.tsx`（KouetsuScopeBar の行に FullCheckControl 配置）
- Modify: `src/locales/ja.json` / `en.json`

**Interfaces (Produces):**
```ts
// fullCheck.ts
export type FullCheckStepId =
  | "lint" | "typo" | "consistency" | "review" | "meta" | "timeline" | "intent";
export interface FullCheckState {
  running: boolean;
  currentStep: FullCheckStepId | null;
  done: number;   // 完了観点数
  total: number;  // 対象観点数
  failures: Array<{ step: FullCheckStepId; error: string }>;
  cancelRequested: boolean;
}
export const useFullCheckStore: UseBoundStore<StoreApi<FullCheckState & { requestCancel(): void }>>;
export async function runFullCheck(scope: KouetsuScope, enabled: Record<FullCheckStepId, boolean>): Promise<void>;
// kouetsuStore 追加分
fullCheckEffects: Record<FullCheckStepId, boolean>; // persist 対象。既定: 全 true / pseudo・impact はそもそも選択肢に無い
setFullCheckEffect: (id: FullCheckStepId, on: boolean) => void;
```

**実行仕様:**
- 観点を固定順（lint → typo → consistency → review → meta → timeline → intent）で**1つずつ直列**に await。各 run は既存 runStore/進捗トースト/OS通知にそのまま乗る。
- lint: scope が folder/project のときのみ `useLintProjectStore.getState().start(projectId)` を await（scene のときはライブ lint 済みなのでスキップ、done にはカウントしない = total から除外）。
- timeline: scope に関わらず `runTimelineCheck()`（常に project 全域）。
- consistency は codex+intra の 2 run を `Promise.all`（既存 "both" と同じ並走、これは 1 観点として数える）。
- 中止: `requestCancel()` → 次の観点へ進まない + 実行中の run があれば `abortPostEffectRun(runId, projectId)`（runner の戻りに runId を含めるか、`usePostEffectRunStore.getState().runs` から outcome 未確定の run を引いて abort する。後者が既存構造に素直）。
- 失敗した観点は failures に積んで**続行**（continue-on-error、run_multi_task と同じ思想）。
- 完了時: failures 空なら `toast.success`、あれば `postEffectPartialToast` 相当の warning 永続トースト（観点名の列挙）。
- 疑似コメント・影響レビューは対象外（設計決定。ポップオーバーの選択肢にも出さない）。

- [ ] **Step 1: 失敗するテストを書く**

`fullCheck.test.ts`（runners を全部 vi.mock）:

```ts
it("有効な観点だけを固定順で直列実行する", async () => {
  const order: string[] = [];
  runTypoCheckMock.mockImplementation(async () => { order.push("typo"); return { ok: true, fromCache: false, count: 0 }; });
  runReviewCheckMock.mockImplementation(async () => { order.push("review"); return { ok: true, fromCache: false, count: 0 }; });
  await runFullCheck({ type: "project" }, { lint: false, typo: true, consistency: false, review: true, meta: false, timeline: false, intent: false });
  expect(order).toEqual(["typo", "review"]);
});
it("scene スコープでは lint ステップが total に入らない", async () => { /* ... */ });
it("観点の失敗は failures に積んで続行する", async () => {
  runTypoCheckMock.mockResolvedValue({ ok: false, error: "boom" });
  runReviewCheckMock.mockResolvedValue({ ok: true, fromCache: false, count: 1 });
  await runFullCheck({ type: "project" }, onlyTypoAndReview);
  expect(useFullCheckStore.getState().failures).toHaveLength(1);
  expect(runReviewCheckMock).toHaveBeenCalled(); // 続行された
});
it("requestCancel 後は残り観点を実行しない", async () => { /* typo 実行中に cancel → review 未呼び出し */ });
it("二重起動は無視される (running 中の再入)", async () => { /* ... */ });
```

- [ ] **Step 2: 失敗を確認** — FAIL

- [ ] **Step 3: fullCheck.ts + kouetsuStore 追加 + FullCheckControl.tsx を実装**

FullCheckControl: Sparkles ボタン「全体チェック」+ 歯車ポップオーバー（`useAnchoredPopover`、観点チェックボックス列 = `fullCheckEffects`）。実行中は `useFullCheckStore` から `n/m 観点` + 現在の観点名（`kouetsu.progressToast.effect.*` の既存キーを流用）+ 中止ボタン。`useAiGate("analysis")` / `blockIfPolicyOff` / `blockIfUnlicensed` ガードは runFullCheck 冒頭で 1 回。i18n 追加キー:

```json
"fullCheck": {
  "run": "全体チェック",
  "configure": "チェックする観点",
  "progress": "{{done}}/{{total}} 観点",
  "cancel": "中止",
  "completed": "全体チェック完了 — 指摘 {{count}} 件",
  "completedWithFailures": "全体チェック完了（{{failed}} 観点失敗）",
  "alreadyRunning": "実行中です"
}
```
（en: "Full check" / "Checks to run" / "{{done}}/{{total}} checks" / "Cancel" / "Full check done — {{count}} findings" / "Done with {{failed}} failed checks" / "Already running"）

- [ ] **Step 4: IssuesInbox へ配置** — `KouetsuScopeBar` の右側（フィルタ chips の左）に `<FullCheckControl />`。ScopeBar の行が窮屈なら ScopeBar に `actions?: ReactNode` prop を足して差し込む。

- [ ] **Step 5: green 確認** — `pnpm test --run src/features/kouetsu/` → PASS

- [ ] **Step 6: Commit** — `git add src/features/kouetsu/fullCheck.ts src/features/kouetsu/fullCheck.test.ts src/features/kouetsu/FullCheckControl.tsx src/features/kouetsu/FullCheckControl.test.tsx src/features/kouetsu/kouetsuStore.ts src/features/kouetsu/IssuesInbox.tsx src/locales/ja.json src/locales/en.json && git commit -m "feat(kouetsu): 全体チェック（観点直列オーケストレータ + 対象選択 + 中止）"`

## Task 15: Phase 2 全体検証 + PR

- [ ] **Step 1:** `pnpm test` → PASS
- [ ] **Step 2:** `npx tsc --noEmit` → エラー 0
- [ ] **Step 3:** `pnpm lint:fix` → エラー 0
- [ ] **Step 4:** `cd src-tauri && cargo check && cargo clippy --all-targets && cargo test --no-default-features` → PASS
- [ ] **Step 5:** `pnpm test:browser` → PASS
- [ ] **Step 6: 手動スモーク（可能なら）** — 全体チェック実行 → 観点が順に runStore トーストへ流れる / 中止で実行中 run だけ止まり他 run が影響を受けない / 2 回目実行はキャッシュで高速
- [ ] **Step 7: PR 作成** — タイトル: `feat(kouetsu): 全体チェック + 中止フラグ per-run 化 (Phase 2)`。本文に intent_drift を multi にしなかった理由（per-scene intent が prompt/hash に畳み込まれるため直列単発が正しい）を明記。

---

## 自己レビュー結果（spec カバレッジ / 型整合）

- 設計書の全要求に対応タスクあり: 3タブ再編=T8 / 受信箱8グループ=T5 / スコープピッカー流用=T2,T3 / folder スコープ=T4 / ステータスフィルタ=T3,T5 / 疑似一本化=T7 / バッジ正直化+LocalTypoList=T6 / persist migration=T1 / PanelHeader 正本=T8 / i18n=T3,T9,T14 / 全体チェック=T14 / per-run abort=T11 / intent_drift 実行=T13 / テスト・検証=各タスク+T10,T15。
- **設計書からの逸脱（承認事項として PR に明記）:**
  1. intent_drift は Rust multi allowlist 追加ではなく FE 直列単発ループ（根拠: per-scene intent が system_prompt / input_hash に畳み込まれる実装事実）。
  2. バッジは「scene スコープ + open フィルタで実数、それ以外は非表示(null)」— folder/project の実数集計は全ビューのフェッチ統合が必要で blast radius が大きく、嘘バッジの根治（非表示は嘘ではない）を優先。将来 annotation フェッチをタブレベルへ統合する際に実数化する。
  3. 校正の全章スキャンは folder 絞り込み非対応のまま project 全域（lintProjectStore.start が project 単位のため。folder 対応は将来課題）。
- 型整合: `KouetsuScope`/`KouetsuStatusFilter`(T1) を T3/T4/T5/T6/T14 が消費、`KouetsuRunScope`/`KouetsuRunOutcome`(T12) を T13/T14 が消費、`TreeScopeSelection`(T2) を T3 が消費 — 名称・シグネチャは本文内で一致していることを確認済み。
