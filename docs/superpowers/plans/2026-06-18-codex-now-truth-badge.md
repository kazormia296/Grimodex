# Codex「今の真実」バッジ ＋ 未開示警告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 執筆中シーン時点の Codex phase 解決済み状態（「今の真実」）を CodexQuick セクションに常時表示し、そのシーン時点で未開示の秘匿伏線を ⚠ で示す（read-only）。

**Architecture:** 共有フック `useResolvedCodexStates`（CodexPopover のインライン解決を統一）＋純関数 `computeUnrevealedSecretForeshadows`（scene-aware な秘匿伏線判定）＋UI 配線（CodexQuickSection 行チップ＋⚠、CodexEntryPopoverContent の `spoilerNote`、CodexQuickPopover 中継）。DB・本文への書き込みは一切なし。

**Tech Stack:** React + TypeScript, Zustand stores（phaseStore/treeStore/codexStore/foreshadow api）, Vitest + @testing-library/react（happy-dom）, lucide-react。

参照 spec: `docs/superpowers/specs/2026-06-18-codex-now-truth-badge-design.md`

---

## 設計メモ（spec からの精緻化・実装者は必読）

- **scene order の出所**: `phaseStore.globalSceneOrder`（`Map<sceneId, number>`）は treeStore がノード変更のたび `recomputeSceneOrder` で維持しており常に最新。フックはこれを読む（`computeSceneTimeIndex` を再計算しない）。参照実装 `src/features/codex/components/PhaseIndicator.tsx:50-71`。
- **使わない既存機構**: `phaseStore.resolveForScene` / `getResolvedState` / `resolvedStates` はどこからも呼ばれていない死にコードで、`resolvedStates` 全体を上書きする clobber 仕様。複数 consumer に不向きなので**使わない**。
- **伏線データ源**: 既存・テスト済みの `listForeshadowsByCodexEntry(codexEntryId): Promise<ForeshadowWithLabel[]>`（`src/features/foreshadow/api.ts:1188`）をエントリ単位で呼び、フック側で1度だけキャッシュ。foreshadowStore/api への新規追加はしない。
- **read-only**: 本計画のどのタスクも DB 書き込み・本文変更・スキーマ変更を含まない。

## File Structure

| ファイル | 役割 |
|---|---|
| `src/features/codex/resolveCodexStatesFor.ts`（新規） | 純関数①: entries → phase 解決済み `{phaseLabel, resolvedSummary}` の Map |
| `src/features/codex/resolveCodexStatesFor.test.ts`（新規） | ①のテスト |
| `src/features/codex/useResolvedCodexStates.ts`（新規） | フック①: store 読み出し＋phase ロード＋①純関数を memo 呼び |
| `src/features/codex/codexSpoilerFlags.ts`（新規） | 純関数② `computeUnrevealedSecretForeshadows` ＋ フック `useUnrevealedSecretForeshadows` |
| `src/features/codex/codexSpoilerFlags.test.ts`（新規） | ②純関数のテスト |
| `src/features/codex/components/CodexEntryPopoverContent.tsx`（改修） | `spoilerNote?` prop 追加 |
| `src/features/codex/components/CodexEntryPopoverContent.test.tsx`（改修） | spoilerNote のテスト追加 |
| `src/features/editor/CodexPopover.tsx`（改修） | インライン解決をフック①に置換＋spoilerNote 配線 |
| `src/features/tree/CodexQuickPopover.tsx`（改修） | phaseLabel/resolvedSummary/spoilerNote を中継 |
| `src/features/tree/CodexQuickSection.tsx`（改修） | 行に phase チップ＋⚠、フック配線、popover へ中継 |
| `src/features/tree/CodexQuickSection.test.tsx`（新規） | 行チップ＋⚠のテスト |
| `src/locales/ja.json` / `src/locales/en.json`（改修） | tooltip 文言キー |

---

## Task 1: 純関数 `resolveCodexStatesFor`（①のコア）

**Files:**
- Create: `src/features/codex/resolveCodexStatesFor.ts`
- Test: `src/features/codex/resolveCodexStatesFor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/codex/resolveCodexStatesFor.test.ts
import { describe, it, expect } from "vitest";
import { resolveCodexStatesFor } from "./resolveCodexStatesFor";
import type { CodexEntryPhase } from "./phaseApi";

type EntryInput = Parameters<typeof resolveCodexStatesFor>[0][number];

function makeEntry(over: Partial<EntryInput> = {}): EntryInput {
  return {
    id: "e1",
    summary: "ベース要約",
    content: "{}",
    contextMode: "mentioned",
    ...over,
  };
}

function makePhase(over: Partial<CodexEntryPhase> = {}): CodexEntryPhase {
  return {
    id: "p1",
    entryId: "e1",
    label: "第2幕",
    anchorNodeId: "s2",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as CodexEntryPhase;
}

describe("resolveCodexStatesFor", () => {
  const order = new Map<string, number>([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]);

  it("フェーズなし → base summary・phaseLabel なし", () => {
    const out = resolveCodexStatesFor([makeEntry()], {}, {}, order, "s3");
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });

  it("現在シーン以下のフェーズで summary を上書きし phaseLabel を返す", () => {
    const phases = {
      e1: [makePhase({ summaryOverride: "第2幕の姿" })],
    };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, "s3");
    expect(out.get("e1")).toEqual({
      phaseLabel: "第2幕",
      resolvedSummary: "第2幕の姿",
    });
  });

  it("現在シーンがフェーズ anchor より前なら base のまま", () => {
    const phases = {
      e1: [makePhase({ summaryOverride: "第2幕の姿" })],
    };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, "s1");
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });

  it("currentSceneId が null なら base のみ", () => {
    const phases = {
      e1: [makePhase({ summaryOverride: "第2幕の姿" })],
    };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, null);
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/codex/resolveCodexStatesFor.test.ts`
Expected: FAIL（`resolveCodexStatesFor` が未定義 / モジュール解決エラー）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/features/codex/resolveCodexStatesFor.ts
import type { CodexEntry } from "./api";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import { resolveCodexState } from "./phaseResolver";

export interface ResolvedCodexBadge {
  /** 現在シーン時点で適用された最後のフェーズのラベル（base なら undefined） */
  phaseLabel?: string;
  /** 現在シーン時点の解決済み summary */
  resolvedSummary: string | null;
}

type EntryLike = Pick<CodexEntry, "id" | "summary" | "content" | "contextMode">;

/**
 * 表示対象の Codex 群を、currentSceneId 時点の phase 解決済み状態に変換する純関数。
 * scene order は呼び出し側が phaseStore.globalSceneOrder を渡す（再計算しない）。
 */
export function resolveCodexStatesFor(
  entries: EntryLike[],
  phasesByEntry: Record<string, CodexEntryPhase[]>,
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>,
  globalSceneOrder: Map<string, number>,
  currentSceneId: string | null,
): Map<string, ResolvedCodexBadge> {
  const out = new Map<string, ResolvedCodexBadge>();
  for (const entry of entries) {
    const phases = phasesByEntry[entry.id] ?? [];
    if (phases.length === 0) {
      out.set(entry.id, { resolvedSummary: entry.summary ?? null });
      continue;
    }
    const phaseDetailsMap = new Map<string, CodexPhaseDetailOverride[]>();
    for (const phase of phases) {
      phaseDetailsMap.set(phase.id, detailOverrides[phase.id] ?? []);
    }
    const resolved = resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content,
        contextMode: entry.contextMode ?? "mentioned",
      },
      phases,
      phaseDetailsMap,
      new Map(),
      currentSceneId,
      globalSceneOrder,
    );
    const lastPhaseId =
      resolved.appliedPhaseIds[resolved.appliedPhaseIds.length - 1];
    const phaseLabel = lastPhaseId
      ? phases.find((p) => p.id === lastPhaseId)?.label
      : undefined;
    out.set(entry.id, { phaseLabel, resolvedSummary: resolved.summary });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/codex/resolveCodexStatesFor.test.ts`
Expected: PASS（4 件）

- [ ] **Step 5: Commit**

```bash
git add src/features/codex/resolveCodexStatesFor.ts src/features/codex/resolveCodexStatesFor.test.ts
git commit -m "feat(codex): phase解決済み状態を返す純関数 resolveCodexStatesFor を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 純関数 `computeUnrevealedSecretForeshadows`（②のコア）

**Files:**
- Create: `src/features/codex/codexSpoilerFlags.ts`
- Test: `src/features/codex/codexSpoilerFlags.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/codex/codexSpoilerFlags.test.ts
import { describe, it, expect } from "vitest";
import { computeUnrevealedSecretForeshadows } from "./codexSpoilerFlags";
import type { ForeshadowRow } from "@/features/foreshadow/types";

function makeF(over: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f1",
    projectId: "p1",
    title: "王の正体",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: true,
    loadBearing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const order = new Map<string, number>([
  ["s1", 0],
  ["s2", 1],
  ["s3", 2],
]);

describe("computeUnrevealedSecretForeshadows", () => {
  it("payoff 未設定の秘匿伏線は未開示として返す", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      order,
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });

  it("payoff が現在シーンより後なら未開示", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s3" })]]]),
      order,
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });

  it("payoff が現在シーン以前なら警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s1" })]]]),
      order,
      "s2",
    );
    expect(out.has("e1")).toBe(false);
  });

  it("secret=false / abandoned=true は警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([
        ["e1", [makeF({ secret: false })]],
        ["e2", [makeF({ id: "f2", abandoned: true })]],
      ]),
      order,
      "s2",
    );
    expect(out.size).toBe(0);
  });

  it("currentSceneId が null なら空", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      order,
      null,
    );
    expect(out.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/codex/codexSpoilerFlags.test.ts`
Expected: FAIL（`computeUnrevealedSecretForeshadows` 未定義）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/features/codex/codexSpoilerFlags.ts
import type { ForeshadowRow } from "@/features/foreshadow/types";

export interface UnrevealedForeshadow {
  id: string;
  title: string;
}

/**
 * entry にリンクされた伏線のうち、currentSceneId 時点でまだ明かされていない
 * 秘匿伏線を返す純関数。secret && !abandoned && payoff 未到達 が条件。
 */
export function computeUnrevealedSecretForeshadows(
  linkedByEntry: Map<string, ForeshadowRow[]>,
  sceneOrder: Map<string, number>,
  currentSceneId: string | null,
): Map<string, UnrevealedForeshadow[]> {
  const out = new Map<string, UnrevealedForeshadow[]>();
  if (!currentSceneId) return out;
  const currentOrder = sceneOrder.get(currentSceneId);
  if (currentOrder === undefined) return out;

  for (const [entryId, foreshadows] of linkedByEntry) {
    const unrevealed: UnrevealedForeshadow[] = [];
    for (const f of foreshadows) {
      if (!f.secret || f.abandoned) continue;
      if (f.payoffSceneId == null) {
        unrevealed.push({ id: f.id, title: f.title });
        continue;
      }
      const payoffOrder = sceneOrder.get(f.payoffSceneId);
      // payoff シーンが順序にない（削除等）→ 未到達扱い
      if (payoffOrder === undefined || payoffOrder > currentOrder) {
        unrevealed.push({ id: f.id, title: f.title });
      }
    }
    if (unrevealed.length > 0) out.set(entryId, unrevealed);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/codex/codexSpoilerFlags.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: Commit**

```bash
git add src/features/codex/codexSpoilerFlags.ts src/features/codex/codexSpoilerFlags.test.ts
git commit -m "feat(codex): 未開示の秘匿伏線を判定する純関数を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: フック `useResolvedCodexStates`（①の IO ラッパ）

**Files:**
- Modify: `src/features/codex/useResolvedCodexStates.ts`（Task 1 のファイルに追記、または新規作成）

> このフックは store の async/effect を含むため単体テストはしない（ロジックは Task 1 の純関数で検証済み）。Task 7 のコンポーネントテストで間接的に被覆される。

- [ ] **Step 1: Implement the hook**

新規ファイル `src/features/codex/useResolvedCodexStates.ts`:

```ts
// src/features/codex/useResolvedCodexStates.ts
import { useEffect, useMemo } from "react";
import { useCodexStore } from "./codexStore";
import { usePhaseStore } from "./phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  resolveCodexStatesFor,
  type ResolvedCodexBadge,
} from "./resolveCodexStatesFor";

/**
 * 表示対象 entryIds を、現在の執筆シーン時点の phase 解決済み状態に変換するフック。
 * scene order は phaseStore.globalSceneOrder（treeStore が維持・常に最新）を読む。
 */
export function useResolvedCodexStates(
  entryIds: string[],
): Map<string, ResolvedCodexBadge> {
  const idsKey = entryIds.join("|");
  const entries = useCodexStore((s) => s.entries);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  // 未ロードの entry の phase をロード（loadPhasesForEntry は冪等・キャッシュ済みは即 return 設計だが二重発火回避のため getState で最新を見る）
  useEffect(() => {
    const { phasesByEntry: loaded, loadPhasesForEntry } =
      usePhaseStore.getState();
    for (const id of idsKey ? idsKey.split("|") : []) {
      if (!loaded[id]) void loadPhasesForEntry(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return useMemo(() => {
    const idSet = new Set(idsKey ? idsKey.split("|") : []);
    const selected = entries.filter((e) => idSet.has(e.id));
    return resolveCodexStatesFor(
      selected,
      phasesByEntry,
      detailOverrides,
      globalSceneOrder,
      activeSceneId || null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    idsKey,
    entries,
    phasesByEntry,
    detailOverrides,
    globalSceneOrder,
    activeSceneId,
  ]);
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: エラーなし（既存エラーがある場合は本ファイル起因の新規エラーが無いことを確認）

- [ ] **Step 3: Commit**

```bash
git add src/features/codex/useResolvedCodexStates.ts
git commit -m "feat(codex): useResolvedCodexStates フック（globalSceneOrder基準で解決）を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: フック `useUnrevealedSecretForeshadows`（②の IO ラッパ）

**Files:**
- Modify: `src/features/codex/codexSpoilerFlags.ts`（Task 2 のファイルに追記）

> 純関数は Task 2 でテスト済み。本フックの IO（fetch/cache）は薄いため単体テストせず、Task 7 で mock 被覆。

- [ ] **Step 1: Append the hook to codexSpoilerFlags.ts**

`src/features/codex/codexSpoilerFlags.ts` の末尾に追記:

```ts
import { useEffect, useMemo, useState } from "react";
import { usePhaseStore } from "./phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { listForeshadowsByCodexEntry } from "@/features/foreshadow/api";
import type { ForeshadowWithLabel } from "@/features/foreshadow/types";

/**
 * entryIds ごとにリンク済み伏線を取得（1度だけキャッシュ）し、現在シーン時点で
 * 未開示の秘匿伏線を返すフック。伏線リンクの編集後の更新は v1 では再ロード待ち。
 */
export function useUnrevealedSecretForeshadows(
  entryIds: string[],
): Map<string, UnrevealedForeshadow[]> {
  const idsKey = entryIds.join("|");
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const [linkedByEntry, setLinkedByEntry] = useState<
    Record<string, ForeshadowWithLabel[]>
  >({});

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey ? idsKey.split("|") : [];
    const missing = ids.filter((id) => !(id in linkedByEntry));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const fs = await listForeshadowsByCodexEntry(id);
          return [id, fs] as const;
        } catch {
          return [id, [] as ForeshadowWithLabel[]] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setLinkedByEntry((prev) => {
        const next = { ...prev };
        for (const [id, fs] of pairs) next[id] = fs;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return useMemo(() => {
    const idSet = new Set(idsKey ? idsKey.split("|") : []);
    const map = new Map<string, ForeshadowWithLabel[]>();
    for (const id of idSet) map.set(id, linkedByEntry[id] ?? []);
    return computeUnrevealedSecretForeshadows(
      map,
      globalSceneOrder,
      activeSceneId || null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, linkedByEntry, globalSceneOrder, activeSceneId]);
}
```

> 注: `import` 文はファイル先頭にまとめること（上記は追記内容を示すための便宜的配置）。`ForeshadowWithLabel` は `ForeshadowRow` を継承するため純関数の引数型と互換。

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: 本ファイル起因の新規エラーなし

- [ ] **Step 3: Commit**

```bash
git add src/features/codex/codexSpoilerFlags.ts
git commit -m "feat(codex): useUnrevealedSecretForeshadows フックを追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `CodexEntryPopoverContent` に `spoilerNote` を追加

**Files:**
- Modify: `src/features/codex/components/CodexEntryPopoverContent.tsx`
- Test: `src/features/codex/components/CodexEntryPopoverContent.test.tsx`

- [ ] **Step 1: Write the failing test（既存テストファイルに追記）**

`CodexEntryPopoverContent.test.tsx` の `describe` 内に追加:

```ts
it("spoilerNote を渡すと警告行を表示する", () => {
  render(
    <CodexEntryPopoverContent
      entry={mockEntry}
      dotColor="#888"
      typeLabel="人物"
      spoilerNote="このシーン時点で未開示: 王の正体"
    />,
  );
  expect(
    screen.getByText("このシーン時点で未開示: 王の正体"),
  ).toBeInTheDocument();
});

it("spoilerNote が無ければ警告行を表示しない", () => {
  const { container } = render(
    <CodexEntryPopoverContent entry={mockEntry} dotColor="#888" typeLabel="人物" />,
  );
  expect(container.querySelector('[data-testid="codex-spoiler-note"]')).toBeNull();
});
```

> `mockEntry` が既存テストに無い場合は、`PhaseIndicator.test.tsx:8-26` の `mockEntry` 定義を流用して追加すること。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/codex/components/CodexEntryPopoverContent.test.tsx`
Expected: FAIL（`spoilerNote` prop 未定義 / テキストが見つからない）

- [ ] **Step 3: Implement**

`CodexEntryPopoverContent.tsx` を改修:

```tsx
import { ExternalLink, EyeOff } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import { iconToDataUrl } from "../iconUtils";

interface CodexEntryPopoverContentProps {
  entry: CodexEntry;
  dotColor: string;
  typeLabel: string;
  onOpenInCodex?: () => void;
  phaseLabel?: string;
  resolvedSummary?: string | null;
  /** 未開示の秘匿伏線がある場合の警告文（read-only の視覚フラグ） */
  spoilerNote?: string;
}

export function CodexEntryPopoverContent({
  entry,
  dotColor,
  typeLabel,
  onOpenInCodex,
  phaseLabel,
  resolvedSummary,
  spoilerNote,
}: CodexEntryPopoverContentProps) {
  const safeIcon = iconToDataUrl(entry.icon);
  return (
    <>
      {/* …既存のヘッダー / phaseLabel / summary はそのまま… */}
      {phaseLabel && (
        <span className="mb-1.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          {phaseLabel}
        </span>
      )}
      {(resolvedSummary ?? entry.summary) && (
        <p className="mb-2 line-clamp-3 text-xs text-muted-foreground">
          {resolvedSummary ?? entry.summary}
        </p>
      )}
      {spoilerNote && (
        <p
          data-testid="codex-spoiler-note"
          className="mb-2 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <EyeOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{spoilerNote}</span>
        </p>
      )}
      {onOpenInCodex && (
        /* …既存の Open in Codex ボタンはそのまま… */
        <button
          type="button"
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 active:bg-primary/30"
          onClick={onOpenInCodex}
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          Open in Codex
        </button>
      )}
    </>
  );
}
```

> 既存の JSX 構造（ヘッダー部 `mb-1.5 flex items-center gap-2 …`）は変更しない。追加するのは `EyeOff` の import と `spoilerNote` prop / 警告 `<p>` のみ。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/codex/components/CodexEntryPopoverContent.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/codex/components/CodexEntryPopoverContent.tsx src/features/codex/components/CodexEntryPopoverContent.test.tsx
git commit -m "feat(codex): popover content に spoilerNote 警告行を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: ロケール文言キーを追加

**Files:**
- Modify: `src/locales/ja.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: ja.json に追加**

`codex` セクション（無ければ作成）に以下を追加。`{{titles}}` は伏線タイトルのカンマ区切り。

```json
"codex": {
  "spoiler": {
    "unrevealedTooltip": "このシーン時点で未開示: {{titles}}"
  }
}
```

- [ ] **Step 2: en.json に追加**

```json
"codex": {
  "spoiler": {
    "unrevealedTooltip": "Not yet revealed as of this scene: {{titles}}"
  }
}
```

> 既存に `codex` キーがある場合はマージし、JSON の妥当性（カンマ・重複キー無し）を保つこと。

- [ ] **Step 3: Verify JSON valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/locales/ja.json','utf8'));JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'));console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add src/locales/ja.json src/locales/en.json
git commit -m "i18n(codex): 未開示伏線 tooltip 文言を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `CodexQuickSection` 行に phase チップ＋⚠を配線

**Files:**
- Modify: `src/features/tree/CodexQuickSection.tsx`
- Modify: `src/features/tree/CodexQuickPopover.tsx`
- Test: `src/features/tree/CodexQuickSection.test.tsx`（新規）

- [ ] **Step 1: CodexQuickPopover に中継 props を追加**

`src/features/tree/CodexQuickPopover.tsx`:

```tsx
import { createPortal } from "react-dom";
import type { CodexEntry } from "@/features/codex/api";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";

interface CodexQuickPopoverProps {
  entry: CodexEntry;
  rect: DOMRect;
  dotColor: string;
  typeLabel: string;
  onClose: () => void;
  phaseLabel?: string;
  resolvedSummary?: string | null;
  spoilerNote?: string;
}

export function CodexQuickPopover({
  entry,
  rect,
  dotColor,
  typeLabel,
  onClose,
  phaseLabel,
  resolvedSummary,
  spoilerNote,
}: CodexQuickPopoverProps) {
  return createPortal(
    <div
      className="fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
      style={{ left: rect.left, top: rect.bottom + 4 }}
      onMouseEnter={() => {}}
      onMouseLeave={onClose}
    >
      <CodexEntryPopoverContent
        entry={entry}
        dotColor={dotColor}
        typeLabel={typeLabel}
        phaseLabel={phaseLabel}
        resolvedSummary={resolvedSummary}
        spoilerNote={spoilerNote}
      />
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Write the failing test for CodexQuickSection**

`src/features/tree/CodexQuickSection.test.tsx`（新規）。store と foreshadow api を mock し、phase チップと ⚠ を検証する。

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodexQuickSection } from "./CodexQuickSection";

const entryAlice = {
  id: "e1",
  type: "character",
  name: "アリス",
  summary: "主人公",
  content: "{}",
  contextMode: "mentioned",
};

// --- store mocks ---
vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: (sel: (s: unknown) => unknown) =>
    sel({ matchedEntryIds: ["e1"], typeColorMap: { character: { fg: "#6B7ADB" } } }),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: Object.assign(
    (sel: (s: unknown) => unknown) =>
      sel({ entries: [entryAlice], sortOrder: "manual" }),
    {
      getState: () => ({
        requestSelectEntry: vi.fn(),
      }),
    },
  ),
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(() => undefined, {
    getState: () => ({ showPanel: vi.fn() }),
  }),
}));
const treeState = {
  pinnedCodexIds: [] as string[],
  togglePinnedCodex: vi.fn(),
  activeSceneId: "s2",
};
vi.mock("./treeStore", () => ({
  useTreeStore: Object.assign(
    (sel: (s: typeof treeState) => unknown) => sel(treeState),
    { getState: () => treeState },
  ),
}));
const phaseState = {
  phasesByEntry: {
    e1: [
      {
        id: "p1",
        entryId: "e1",
        label: "第2幕",
        anchorNodeId: "s2",
        summaryOverride: "第2幕の姿",
        contentOverride: null,
        contextModeOverride: null,
      },
    ],
  },
  detailOverrides: {},
  globalSceneOrder: new Map([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]),
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: Object.assign(
    (sel: (s: typeof phaseState) => unknown) => sel(phaseState),
    { getState: () => phaseState },
  ),
}));
vi.mock("@/features/foreshadow/api", () => ({
  listForeshadowsByCodexEntry: vi.fn().mockResolvedValue([
    {
      id: "f1",
      title: "王の正体",
      secret: true,
      abandoned: false,
      payoffSceneId: "s3", // 現在 s2 より後 → 未開示
    },
  ]),
}));
vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn().mockResolvedValue([]),
  ensureBuiltinTypes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { titles?: string; defaultValue?: string }) =>
      opts?.titles ? `このシーン時点で未開示: ${opts.titles}` : (_k as string),
  }),
}));

describe("CodexQuickSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("phase チップ（第2幕）を行に常時表示する", async () => {
    render(<CodexQuickSection />);
    expect(await screen.findByText("第2幕")).toBeInTheDocument();
  });

  it("未開示の秘匿伏線がある行に ⚠（未開示）インジケータを表示する", async () => {
    render(<CodexQuickSection />);
    expect(
      await screen.findByTestId("codex-quick-spoiler-e1"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/tree/CodexQuickSection.test.tsx`
Expected: FAIL（チップ・⚠ がまだ描画されていない）

- [ ] **Step 4: Implement CodexQuickSection wiring**

`src/features/tree/CodexQuickSection.tsx` を改修。要点:
1. 上部で hooks を呼ぶ（`displayed` 確定後に id 配列を作る）
2. 各行に phase チップ（`resolved.get(entry.id)?.phaseLabel`）と ⚠（`spoilers.get(entry.id)`）
3. hover popover に `phaseLabel`/`resolvedSummary`/`spoilerNote` を渡す

import 追加:

```tsx
import { Pin, PinOff, Plus, EyeOff } from "lucide-react";
import { useResolvedCodexStates } from "@/features/codex/useResolvedCodexStates";
import { useUnrevealedSecretForeshadows } from "@/features/codex/codexSpoilerFlags";
```

`displayed` を計算した直後に追加:

```tsx
  const displayedIds = displayed.map((e) => e.id);
  const resolved = useResolvedCodexStates(displayedIds);
  const spoilers = useUnrevealedSecretForeshadows(displayedIds);

  function spoilerNoteFor(entryId: string): string | undefined {
    const list = spoilers.get(entryId);
    if (!list || list.length === 0) return undefined;
    return t("codex.spoiler.unrevealedTooltip", {
      titles: list.map((f) => f.title).join(", "),
    });
  }
```

行 JSX 内、Name `<span>` と Type label `<span>` の間に phase チップと ⚠ を挿入:

```tsx
              {/* Name */}
              <span className="flex-1 truncate text-xs text-foreground">
                {entry.name}
              </span>
              {/* Phase チップ（今の真実） */}
              {resolved.get(entry.id)?.phaseLabel && (
                <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
                  {resolved.get(entry.id)!.phaseLabel}
                </span>
              )}
              {/* 未開示秘匿伏線の警告 */}
              {spoilerNoteFor(entry.id) && (
                <EyeOff
                  data-testid={`codex-quick-spoiler-${entry.id}`}
                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-500"
                  aria-label={spoilerNoteFor(entry.id)}
                />
              )}
              {/* Type label */}
              <span className="text-[10px] text-muted-foreground">
                {entry.type}
              </span>
```

hover popover 呼び出しに props を追加:

```tsx
      {hoveredEntry && (
        <CodexQuickPopover
          entry={hoveredEntry.entry}
          rect={hoveredEntry.rect}
          dotColor={typeColorMap[hoveredEntry.entry.type]?.fg ?? "#888888"}
          typeLabel={getTypeLabel(hoveredEntry.entry.type)}
          onClose={() => setHoveredEntry(null)}
          phaseLabel={resolved.get(hoveredEntry.entry.id)?.phaseLabel}
          resolvedSummary={resolved.get(hoveredEntry.entry.id)?.resolvedSummary}
          spoilerNote={spoilerNoteFor(hoveredEntry.entry.id)}
        />
      )}
```

> `t` は既存の `useTranslation()` から取得済み（`CodexQuickSection` 冒頭の `const { t } = useTranslation();`）。

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/tree/CodexQuickSection.test.tsx`
Expected: PASS（2 件）

- [ ] **Step 6: Commit**

```bash
git add src/features/tree/CodexQuickSection.tsx src/features/tree/CodexQuickPopover.tsx src/features/tree/CodexQuickSection.test.tsx
git commit -m "feat(codex): CodexQuick行に今の真実バッジ＋未開示伏線警告を表示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `CodexPopover`（エディタ）をフックに統一＋spoilerNote 配線

**Files:**
- Modify: `src/features/editor/CodexPopover.tsx`

- [ ] **Step 1: インライン解決をフックに置換**

`CodexPopover.tsx` の `resolvedPhase` を計算する `useMemo`（lines 116-155 付近）と関連 import（`resolveCodexState` / `computeSceneTimeIndex` / `CodexPhaseDetailOverride`）を撤去し、フックに置換する。

import を整理:

```tsx
import { useResolvedCodexStates } from "@/features/codex/useResolvedCodexStates";
import { useUnrevealedSecretForeshadows } from "@/features/codex/codexSpoilerFlags";
import { useTranslation } from "react-i18next";
```

`handleMouseOver`/`handleMouseOut`/`useEffect` 群はそのまま。`resolvedPhase` の useMemo を削除し、代わりに:

```tsx
  const { t } = useTranslation();
  const activeIds = popover.entryId ? [popover.entryId] : [];
  const resolved = useResolvedCodexStates(activeIds);
  const spoilers = useUnrevealedSecretForeshadows(activeIds);
```

> phase の遅延ロード（既存 `useEffect` lines 109-114 の `loadPhasesForEntry`）はフック側 `useResolvedCodexStates` が担うため**削除**してよい（二重発火回避）。残しても冪等で害はないが、DRY のため削除を推奨。

`return createPortal(...)` 内の `CodexEntryPopoverContent` 呼び出しを更新:

```tsx
      <CodexEntryPopoverContent
        entry={entry}
        dotColor={dotColor}
        typeLabel={getTypeLabel(entry.type)}
        onOpenInCodex={handleOpenInCodex}
        phaseLabel={resolved.get(entry.id)?.phaseLabel}
        resolvedSummary={resolved.get(entry.id)?.resolvedSummary}
        spoilerNote={
          (spoilers.get(entry.id)?.length ?? 0) > 0
            ? t("codex.spoiler.unrevealedTooltip", {
                titles: spoilers
                  .get(entry.id)!
                  .map((f) => f.title)
                  .join(", "),
              })
            : undefined
        }
      />
```

- [ ] **Step 2: Verify types compile and existing tests pass**

Run: `npx tsc --noEmit && npx vitest run src/features/editor/CodexPopover`
Expected: 型エラーなし。CodexPopover の既存テストがあれば PASS（無ければ vitest は "no test files" を返す＝可）

- [ ] **Step 3: Commit**

```bash
git add src/features/editor/CodexPopover.tsx
git commit -m "refactor(codex): CodexPopover の phase 解決を共有フックに統一＋未開示警告を表示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 最終検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 型チェック**

Run: `npx tsc --noEmit`
Expected: 本機能で新規に持ち込んだ型エラーが 0

- [ ] **Step 2: 関連テスト一括実行**

Run: `npx vitest run src/features/codex/resolveCodexStatesFor.test.ts src/features/codex/codexSpoilerFlags.test.ts src/features/codex/components/CodexEntryPopoverContent.test.tsx src/features/tree/CodexQuickSection.test.tsx`
Expected: 全 PASS

- [ ] **Step 3: lint**

Run: `npx eslint src/features/codex/resolveCodexStatesFor.ts src/features/codex/useResolvedCodexStates.ts src/features/codex/codexSpoilerFlags.ts src/features/codex/components/CodexEntryPopoverContent.tsx src/features/editor/CodexPopover.tsx src/features/tree/CodexQuickSection.tsx src/features/tree/CodexQuickPopover.tsx`
Expected: エラー 0（warning は既存方針に従う）

- [ ] **Step 4: 実機 QA（手動・任意）**

1. プロジェクトを開き、phase を持つ Codex エントリが登場するシーンを開く
2. CodexQuick セクションの該当行に phase チップが常時表示される
3. 秘匿（secret）かつ payoff 未到達の伏線をリンクした Codex の行に ⚠ が出る／payoff 済みシーンに移動すると消える
4. 行 hover で popover に解決済み summary ＋ ⚠ 行が出る
5. 本文・DB が変化していないこと（read-only）

---

## Self-Review（記入済み）

**1. Spec coverage:**
- 「今の真実」常時バッジ → Task 1/3/7 ✓
- 未開示警告（foreshadow.secret + payoff 未到達） → Task 2/4/7 ✓
- CodexQuickPopover に phaseLabel/resolvedSummary 配線 → Task 7 ✓
- CodexEntryPopoverContent の spoilerNote（両 popover に反映） → Task 5 + Task 7/8 ✓
- CodexPopover の二重実装解消 → Task 8 ✓
- read-only / スキーマ変更なし → 全タスクで保持 ✓
- i18n → Task 6 ✓
- エッジ（activeSceneId=null / payoff 済み / abandoned / 非 secret / phase 無し） → Task 1・2 のテストで被覆 ✓

**2. Placeholder scan:** 「既存のまま」と記す箇所はいずれも改修不要部分の明示であり、変更するコードはすべて完全形で提示済み。TODO/TBD なし。

**3. Type consistency:**
- `ResolvedCodexBadge { phaseLabel?, resolvedSummary }` を Task 1 で定義 → Task 3/7/8 で `resolved.get(id)?.phaseLabel` / `?.resolvedSummary` と一致
- `UnrevealedForeshadow { id, title }` を Task 2 で定義 → Task 4/7/8 で `.map((f) => f.title)` と一致
- `useResolvedCodexStates(entryIds: string[])` / `useUnrevealedSecretForeshadows(entryIds: string[])` のシグネチャは Task 3/4 定義と Task 7/8 呼び出しで一致
- i18n キー `codex.spoiler.unrevealedTooltip` は Task 6 定義と Task 7/8 使用で一致
