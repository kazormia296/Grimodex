# テンション波形 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** meta_structure の plot_structure lens の tension(0-1) を読了順の折れ線で可視化し、中だるみ帯と章末フックマーカーを校閲 MetaStructure の project view に表示する（read-only）。

**Architecture:** フロントエンドのみ。①meta_structure prompt(ja/en) で tension を必須化し PROMPT_VERSION を bump（Rust は metrics を verbatim 保存済みのため無改修）。②純関数で系列構築＋中だるみ検出。③SVG 自前描画。④MetaStructureView へ配線。⑤i18n。

**Tech Stack:** React + TypeScript, Zustand(lensStore/treeStore), Vitest + @testing-library/react(happy-dom), SVG 手描き（chart lib 不使用）。

**作業ディレクトリ:** `/workspace/.claude/worktrees/feat+tension-curve`（branch `feat/tension-curve`）。全コマンドはこの worktree で実行。

参照 spec: `docs/superpowers/specs/2026-06-18-tension-curve-design.md`

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/prompts/ja/postEffect.ts` / `en/postEffect.ts`（改修） | metaStructureSystem に tension 必須を明記 |
| `src/features/post-effect/metaStructurePayloadBuilder.ts`（改修） | PROMPT_VERSION を v1.1 へ |
| `src/features/post-effect/metaStructurePromptContract.test.ts`（新規） | prompt 契約のリグレッションガード |
| `src/features/post-effect/tensionSeries.ts`（新規） | 純関数: 系列構築/中だるみ検出 |
| `src/features/post-effect/tensionSeries.test.ts`（新規） | ②のテスト |
| `src/features/post-effect/TensionCurve.tsx`（新規） | SVG 折れ線コンポーネント |
| `src/features/post-effect/TensionCurve.test.tsx`（新規） | ③のテスト |
| `src/features/kouetsu/views/MetaStructureView.tsx`（改修） | project view へ配線 |
| `src/features/kouetsu/views/MetaStructureView.test.tsx`（新規 or 追記） | ④のテスト |
| `src/locales/ja.json` / `en.json`（改修） | kouetsu.tension.* |

---

## Task 1: prompt 契約強化 + PROMPT_VERSION bump

**Files:**
- Modify: `src/prompts/ja/postEffect.ts`, `src/prompts/en/postEffect.ts`
- Modify: `src/features/post-effect/metaStructurePayloadBuilder.ts`
- Test: `src/features/post-effect/metaStructurePromptContract.test.ts`（新規）

- [ ] **Step 1: Write the failing test**

```ts
// src/features/post-effect/metaStructurePromptContract.test.ts
import { describe, it, expect } from "vitest";
import { META_STRUCTURE_PROMPT_VERSION } from "./metaStructurePayloadBuilder";
import { getPromptCatalog } from "@/prompts/index";

describe("meta_structure prompt contract", () => {
  it("version は v1.1 以降", () => {
    expect(META_STRUCTURE_PROMPT_VERSION).toBe("meta_structure_v1.1");
  });
  for (const lang of ["ja", "en"] as const) {
    it(`${lang}: plot_structure に tension 0-1 必須を明記`, () => {
      const sys = getPromptCatalog(lang).postEffect.metaStructureSystem;
      expect(sys).toMatch(/tension/);
      expect(sys).toMatch(/0\.0.*1\.0|0-1|0–1/);
      // 「必須」を表す語が含まれる（MUST / 必ず）
      expect(sys).toMatch(/MUST|must|必ず/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/post-effect/metaStructurePromptContract.test.ts`
Expected: FAIL（version がまだ v1.0 / prompt に MUST 表記なし）

- [ ] **Step 3: Edit prompts (both ja and en — identical text)**

両ファイル `src/prompts/ja/postEffect.ts` と `src/prompts/en/postEffect.ts` で、metaStructureSystem 内の次の行:

```
- metrics is a small JSON object of lens-specific signals (e.g. {"role":"rising_action","tension":0.6} for plot_structure, {"pace":"slow","drag_points":2} for pacing). Keep keys simple.
```

を、以下に置き換える（両ファイル同一）:

```
- metrics is a small JSON object of lens-specific signals. For "plot_structure" you MUST include "tension": a number from 0.0 to 1.0 (0.0 = calm/low stakes, 1.0 = peak dramatic tension), plus "role" (e.g. {"role":"rising_action","tension":0.6}). For "pacing" use e.g. {"pace":"slow","drag_points":2}. Keep keys simple.
```

- [ ] **Step 4: Bump PROMPT_VERSION**

`src/features/post-effect/metaStructurePayloadBuilder.ts`:

```ts
export const META_STRUCTURE_PROMPT_VERSION = "meta_structure_v1.1";
```
（`"meta_structure_v1.0"` から変更）

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/post-effect/metaStructurePromptContract.test.ts`
Expected: PASS（3 件）

- [ ] **Step 6: Commit**

```bash
git add src/prompts/ja/postEffect.ts src/prompts/en/postEffect.ts src/features/post-effect/metaStructurePayloadBuilder.ts src/features/post-effect/metaStructurePromptContract.test.ts
git commit -m "feat(meta-structure): plot_structure に tension(0-1) を必須化＋PROMPT_VERSION v1.1

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 純関数 `tensionSeries.ts`

**Files:**
- Create: `src/features/post-effect/tensionSeries.ts`
- Test: `src/features/post-effect/tensionSeries.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/post-effect/tensionSeries.test.ts
import { describe, it, expect } from "vitest";
import { buildTensionSeries, detectSaggyRuns } from "./tensionSeries";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { SceneLensRecord } from "./types";

function scene(id: string, parentId: string | null, sortOrder: string, title = id): TreeNodeData {
  return {
    id, projectId: "p1", parentId, nodeType: "scene", title,
    synopsis: null, intent: null, sortOrder, status: null,
    storyTimeOrder: null, storyTimeLabel: null, povCharacterId: null,
    locationId: null, charCount: 0,
  } as TreeNodeData;
}
function lens(sceneId: string, lensType: string, tension: unknown): SceneLensRecord {
  return {
    id: `${sceneId}-${lensType}`, projectId: "p1", runId: "r1", targetId: sceneId,
    lensType: lensType as SceneLensRecord["lensType"],
    metrics: tension === undefined ? {} : { tension },
    finding: "x", severity: "info", createdAt: "2024-01-01T00:00:00Z", runCompletedAt: null,
  };
}

describe("buildTensionSeries", () => {
  it("読了順で plot_structure の tension を引き、isChapterEnd を立てる", () => {
    const nodes = [
      scene("s2", "f1", "b"),
      scene("s1", "f1", "a"),
      scene("s3", "f2", "c"),
    ];
    const by = new Map<string, SceneLensRecord[]>([
      ["s1", [lens("s1", "plot_structure", 0.6), lens("s1", "pacing", undefined)]],
      ["s2", [lens("s2", "plot_structure", 0.2)]],
      ["s3", [lens("s3", "pacing", 0.9)]], // plot_structure 無し → null
    ]);
    const out = buildTensionSeries(nodes, by);
    expect(out.map((p) => p.sceneId)).toEqual(["s1", "s2", "s3"]); // sortOrder 順
    expect(out.map((p) => p.tension)).toEqual([0.6, 0.2, null]);
    expect(out.map((p) => p.isChapterEnd)).toEqual([false, true, true]); // s2→s3 で parent 変化, s3 末尾
  });
  it("metrics.tension が数値でない/範囲外は null/クランプ", () => {
    const nodes = [scene("s1", null, "a"), scene("s2", null, "b")];
    const by = new Map<string, SceneLensRecord[]>([
      ["s1", [lens("s1", "plot_structure", "high")]], // 非数値 → null
      ["s2", [lens("s2", "plot_structure", 1.5)]], // 範囲外 → 1 にクランプ
    ]);
    const out = buildTensionSeries(nodes, by);
    expect(out[0].tension).toBeNull();
    expect(out[1].tension).toBe(1);
  });
});

describe("detectSaggyRuns", () => {
  const mk = (tensions: (number | null)[]) =>
    tensions.map((t, i) => ({ sceneId: `s${i}`, title: `s${i}`, tension: t, parentId: null, isChapterEnd: false }));
  it("閾値以下が連続2以上で検出、単発は無視", () => {
    const runs = detectSaggyRuns(mk([0.8, 0.2, 0.3, 0.7, 0.1]), 0.35);
    expect(runs).toEqual([{ startIdx: 1, endIdx: 2 }]); // 0.1 単発は無視
  });
  it("null は区間を分断する", () => {
    const runs = detectSaggyRuns(mk([0.2, null, 0.2, 0.2]), 0.35);
    expect(runs).toEqual([{ startIdx: 2, endIdx: 3 }]);
  });
  it("末尾までの連続区間も検出", () => {
    const runs = detectSaggyRuns(mk([0.9, 0.3, 0.3]), 0.35);
    expect(runs).toEqual([{ startIdx: 1, endIdx: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/post-effect/tensionSeries.test.ts`
Expected: FAIL（モジュール未定義）

- [ ] **Step 3: Write implementation**

```ts
// src/features/post-effect/tensionSeries.ts
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { SceneLensRecord } from "./types";

export interface TensionPoint {
  sceneId: string;
  title: string;
  tension: number | null; // plot_structure lens の metrics.tension（0-1）。無ければ null
  parentId: string | null;
  isChapterEnd: boolean; // 次シーンの parentId が異なる or 末尾
}

export interface SaggyRun {
  startIdx: number;
  endIdx: number;
}

const SAG_THRESHOLD = 0.35;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 読了順に、各シーンの plot_structure lens の tension を引いた系列を返す。 */
export function buildTensionSeries(
  nodes: TreeNodeData[],
  bySceneId: Map<string, SceneLensRecord[]>,
): TensionPoint[] {
  const order = computeGlobalSceneOrder(nodes);
  const scenes = nodes
    .filter((n) => n.nodeType === "scene" && order.has(n.id))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  const points: TensionPoint[] = scenes.map((n) => {
    const lenses = bySceneId.get(n.id) ?? [];
    const ps = lenses.find((l) => l.lensType === "plot_structure");
    const raw = ps?.metrics?.tension;
    const tension =
      typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : null;
    return {
      sceneId: n.id,
      title: n.title,
      tension,
      parentId: n.parentId,
      isChapterEnd: false,
    };
  });

  for (let i = 0; i < points.length; i++) {
    points[i].isChapterEnd =
      i === points.length - 1 || points[i + 1].parentId !== points[i].parentId;
  }
  return points;
}

/** tension <= threshold が連続 2 点以上の極大区間（両端含む）を返す。null は区間を分断。 */
export function detectSaggyRuns(
  series: TensionPoint[],
  threshold: number = SAG_THRESHOLD,
): SaggyRun[] {
  const runs: SaggyRun[] = [];
  let start = -1;
  const flush = (endExclusive: number) => {
    if (start !== -1) {
      const endIdx = endExclusive - 1;
      if (endIdx - start >= 1) runs.push({ startIdx: start, endIdx });
      start = -1;
    }
  };
  for (let i = 0; i < series.length; i++) {
    const t = series[i].tension;
    const low = t !== null && t <= threshold;
    if (low) {
      if (start === -1) start = i;
    } else {
      flush(i);
    }
  }
  flush(series.length);
  return runs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/post-effect/tensionSeries.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: Commit**

```bash
git add src/features/post-effect/tensionSeries.ts src/features/post-effect/tensionSeries.test.ts
git commit -m "feat(tension): 読了順テンション系列＋中だるみ検出の純関数を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SVG コンポーネント `TensionCurve.tsx`

**Files:**
- Create: `src/features/post-effect/TensionCurve.tsx`
- Test: `src/features/post-effect/TensionCurve.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TensionCurve } from "./TensionCurve";
import type { TensionPoint } from "./tensionSeries";

const series: TensionPoint[] = [
  { sceneId: "s1", title: "出会い", tension: 0.6, parentId: "f1", isChapterEnd: false },
  { sceneId: "s2", title: "停滞", tension: 0.2, parentId: "f1", isChapterEnd: true },
  { sceneId: "s3", title: "急転", tension: 0.9, parentId: "f2", isChapterEnd: true },
];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe("TensionCurve", () => {
  it("tension を持つ点を描画する（null 以外）", () => {
    render(<TensionCurve series={series} saggy={[]} onSelectScene={vi.fn()} />);
    expect(screen.getAllByTestId(/^tension-point-/)).toHaveLength(3);
  });
  it("点クリックで onSelectScene を呼ぶ", () => {
    const onSelect = vi.fn();
    render(<TensionCurve series={series} saggy={[]} onSelectScene={onSelect} />);
    fireEvent.click(screen.getByTestId("tension-point-s3"));
    expect(onSelect).toHaveBeenCalledWith("s3");
  });
  it("中だるみ帯を描画する", () => {
    render(
      <TensionCurve series={series} saggy={[{ startIdx: 0, endIdx: 1 }]} onSelectScene={vi.fn()} />,
    );
    expect(screen.getByTestId("tension-saggy-0")).toBeInTheDocument();
  });
  it("章末マーカーを描画する", () => {
    render(<TensionCurve series={series} saggy={[]} onSelectScene={vi.fn()} />);
    // s2, s3 が isChapterEnd
    expect(screen.getByTestId("tension-chapterend-s2")).toBeInTheDocument();
    expect(screen.getByTestId("tension-chapterend-s3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/post-effect/TensionCurve.test.tsx`
Expected: FAIL（コンポーネント未定義）

- [ ] **Step 3: Write implementation**

```tsx
// src/features/post-effect/TensionCurve.tsx
import { useTranslation } from "react-i18next";
import type { TensionPoint, SaggyRun } from "./tensionSeries";

interface Props {
  series: TensionPoint[];
  saggy: SaggyRun[];
  onSelectScene: (sceneId: string) => void;
}

const W = 100; // viewBox 幅（%スケール）
const H = 40; // viewBox 高さ
const PAD = 2;

function xFor(i: number, n: number): number {
  if (n <= 1) return W / 2;
  return PAD + (i * (W - 2 * PAD)) / (n - 1);
}
function yFor(t: number): number {
  // tension 0 → 下(H-PAD)、1 → 上(PAD)
  return H - PAD - t * (H - 2 * PAD);
}

export function TensionCurve({ series, saggy, onSelectScene }: Props) {
  const { t } = useTranslation();
  const n = series.length;

  // null で分断した連続セグメントごとに polyline points を作る
  const segments: string[] = [];
  let cur: string[] = [];
  series.forEach((p, i) => {
    if (p.tension === null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
    } else {
      cur.push(`${xFor(i, n).toFixed(2)},${yFor(p.tension).toFixed(2)}`);
    }
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  return (
    <div className="rounded border border-border p-2">
      <div className="mb-1 text-[10px] font-medium text-muted-foreground">
        {t("kouetsu.tension.title")}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={t("kouetsu.tension.title")}
      >
        {/* 中だるみ帯 */}
        {saggy.map((run, idx) => {
          const x0 = xFor(run.startIdx, n);
          const x1 = xFor(run.endIdx, n);
          return (
            <rect
              key={`sag-${idx}`}
              data-testid={`tension-saggy-${idx}`}
              x={x0}
              y={PAD}
              width={Math.max(0.5, x1 - x0)}
              height={H - 2 * PAD}
              className="fill-yellow-500/10"
            />
          );
        })}
        {/* 章境界線（章末の直後） */}
        {series.map((p, i) =>
          p.isChapterEnd && i < n - 1 ? (
            <line
              key={`div-${p.sceneId}`}
              x1={(xFor(i, n) + xFor(i + 1, n)) / 2}
              x2={(xFor(i, n) + xFor(i + 1, n)) / 2}
              y1={PAD}
              y2={H - PAD}
              className="stroke-border"
              strokeWidth={0.3}
              strokeDasharray="1 1"
            />
          ) : null,
        )}
        {/* 折れ線（セグメント分断） */}
        {segments.map((pts, i) => (
          <polyline
            key={`seg-${i}`}
            points={pts}
            className="fill-none stroke-primary"
            strokeWidth={0.6}
          />
        ))}
        {/* 点 + 章末マーカー */}
        {series.map((p, i) =>
          p.tension === null ? null : (
            <g key={p.sceneId}>
              {p.isChapterEnd && (
                <circle
                  data-testid={`tension-chapterend-${p.sceneId}`}
                  cx={xFor(i, n)}
                  cy={yFor(p.tension)}
                  r={1.6}
                  // フック強度: tension 高=暖色, 低=寒色
                  className={p.tension >= 0.6 ? "fill-orange-500" : "fill-sky-500"}
                />
              )}
              <circle
                data-testid={`tension-point-${p.sceneId}`}
                cx={xFor(i, n)}
                cy={yFor(p.tension)}
                r={1}
                className="cursor-pointer fill-primary hover:fill-primary/70"
                onClick={() => onSelectScene(p.sceneId)}
              >
                <title>{`${p.title}: ${p.tension.toFixed(2)}`}</title>
              </circle>
            </g>
          ),
        )}
      </svg>
      {/* 凡例 */}
      <div className="mt-0.5 flex gap-2 text-[9px] text-muted-foreground">
        <span>{t("kouetsu.tension.saggy")}</span>
        <span>{t("kouetsu.tension.chapterHook")}</span>
      </div>
    </div>
  );
}
```

> reduced-motion: アニメーションを入れないため追加ガード不要。read-only（描画のみ）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/post-effect/TensionCurve.test.tsx`
Expected: PASS（4 件）

- [ ] **Step 5: Commit**

```bash
git add src/features/post-effect/TensionCurve.tsx src/features/post-effect/TensionCurve.test.tsx
git commit -m "feat(tension): SVG テンション波形コンポーネント（中だるみ帯/章末マーカー/クリック遷移）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: i18n キー追加

**Files:**
- Modify: `src/locales/ja.json`, `src/locales/en.json`

- [ ] **Step 1: ja.json の `kouetsu` セクションに追加**

`"kouetsu": {` 直下（既存キーとマージ・重複なし）に:

```json
"tension": {
  "title": "テンション波形",
  "saggy": "■ 中だるみ",
  "chapterHook": "● 章末フック"
}
```

- [ ] **Step 2: en.json の `kouetsu` セクションに追加**

```json
"tension": {
  "title": "Tension curve",
  "saggy": "■ Saggy stretch",
  "chapterHook": "● Chapter hook"
}
```

- [ ] **Step 3: Verify JSON valid**

Run: `node -e "for(const l of['ja','en']){const j=require('fs').readFileSync('src/locales/'+l+'.json','utf8');const o=JSON.parse(j);if(!o.kouetsu.tension.title)throw new Error(l+' missing');}console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add src/locales/ja.json src/locales/en.json
git commit -m "i18n(tension): テンション波形の文言を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MetaStructureView へ配線

**Files:**
- Modify: `src/features/kouetsu/views/MetaStructureView.tsx`
- Test: `src/features/kouetsu/views/MetaStructureView.test.tsx`（新規）

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaStructureView } from "./MetaStructureView";

const nodes = [
  { id: "s1", projectId: "p1", parentId: "f1", nodeType: "scene", title: "A", sortOrder: "a", charCount: 0,
    synopsis: null, intent: null, status: null, storyTimeOrder: null, storyTimeLabel: null, povCharacterId: null, locationId: null },
  { id: "s2", projectId: "p1", parentId: "f1", nodeType: "scene", title: "B", sortOrder: "b", charCount: 0,
    synopsis: null, intent: null, status: null, storyTimeOrder: null, storyTimeLabel: null, povCharacterId: null, locationId: null },
];
const treeState = {
  projectId: "p1",
  scenes: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }],
  nodes,
  setActiveScene: vi.fn(),
};
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (sel: (s: typeof treeState) => unknown) => sel(treeState),
    { getState: () => treeState },
  ),
}));
const lensState = {
  bySceneId: new Map([
    ["s1", [{ id: "s1-ps", projectId: "p1", runId: "r", targetId: "s1", lensType: "plot_structure", metrics: { tension: 0.6 }, finding: "x", severity: "info", createdAt: "2024", runCompletedAt: null }]],
    ["s2", [{ id: "s2-ps", projectId: "p1", runId: "r", targetId: "s2", lensType: "plot_structure", metrics: { tension: 0.2 }, finding: "y", severity: "info", createdAt: "2024", runCompletedAt: null }]],
  ]),
  load: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/features/post-effect/lensStore", () => ({
  useLensStore: (sel: (s: typeof lensState) => unknown) => sel(lensState),
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: Object.assign(() => undefined, { getState: () => ({ settings: { model: "m" }, loadSettings: vi.fn() }) }),
}));
vi.mock("@/features/ai-policy/useAiGate", () => ({ useAiGate: () => ({ presentation: "enabled", tooltip: null }) }));
vi.mock("@/features/ai-policy/policyGuard", () => ({ blockIfPolicyOff: () => false }));
vi.mock("@/features/license/gate", () => ({ blockIfUnlicensed: () => false }));
vi.mock("@/features/settings/settingsStore", () => ({ useSettingsStore: Object.assign(() => undefined, { getState: () => ({ get: () => "" }) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe("MetaStructureView tension curve", () => {
  beforeEach(() => vi.clearAllMocks());
  it("project スコープ＋tension あり → 波形を表示", () => {
    render(<MetaStructureView scope="project" />);
    expect(screen.getByLabelText("kouetsu.tension.title")).toBeInTheDocument();
  });
  it("current スコープでは波形を出さない", () => {
    render(<MetaStructureView scope="current" sceneId="s1" />);
    expect(screen.queryByLabelText("kouetsu.tension.title")).toBeNull();
  });
});
```

> 注: 上記 mock は MetaStructureView が import する store/helper を網羅する。実装時、`MetaStructureView.tsx` の import を確認し、happy-dom で評価されて落ちる依存（`getPromptCatalog` 等）があれば最小 mock を追加。`buildTensionSeries`/`detectSaggyRuns`/`TensionCurve` は **mock しない**（実物を通す）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/kouetsu/views/MetaStructureView.test.tsx`
Expected: FAIL（波形未配線）

- [ ] **Step 3: Implement wiring**

`src/features/kouetsu/views/MetaStructureView.tsx`:

1. import 追加:
```tsx
import { TensionCurve } from "@/features/post-effect/TensionCurve";
import { buildTensionSeries, detectSaggyRuns } from "@/features/post-effect/tensionSeries";
```

2. コンポーネント本体、既存フックの並びに追加（`bySceneId` は既に購読済み）:
```tsx
  const nodes = useTreeStore((s) => s.nodes);
  const tensionSeries = useMemo(
    () => buildTensionSeries(nodes, bySceneId),
    [nodes, bySceneId],
  );
  const saggy = useMemo(() => detectSaggyRuns(tensionSeries), [tensionSeries]);
  const hasTension = tensionSeries.some((p) => p.tension !== null);
```

3. project スコープの描画ブロックで、`projectGroups.length === 0 ? <EmptyState/> : (...)` の **中身の先頭**（`<div className="flex flex-col gap-3">` の直後）に波形を差し込む。波形は projectGroups が空でも tension があれば出したいので、project 分岐の冒頭で出す方が良い。具体的には `scope === "project"` ブロックを次の構造に変更:

```tsx
        {scope === "project" ? (
          <div className="flex flex-col gap-3">
            {hasTension && (
              <TensionCurve
                series={tensionSeries}
                saggy={saggy}
                onSelectScene={(id) => useTreeStore.getState().setActiveScene(id)}
              />
            )}
            {projectGroups.length === 0 ? (
              <EmptyState />
            ) : (
              projectGroups.map((g) => (
                <div key={g.sceneId} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => useTreeStore.getState().setActiveScene(g.sceneId)}
                    className="self-start truncate text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {g.label}
                  </button>
                  {g.lenses.map((l) => (
                    <LensRow key={l.id} lens={l} />
                  ))}
                </div>
              ))
            )}
          </div>
        ) : currentLenses.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-1.5">
            {currentLenses.map((l) => (
              <LensRow key={l.id} lens={l} />
            ))}
          </div>
        )}
```

   既存の current スコープ分岐は変更しない（波形は project のみ）。`useMemo` は既に import 済み（ファイル冒頭で `useMemo` を使用中）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/kouetsu/views/MetaStructureView.test.tsx`
Expected: PASS（2 件）

- [ ] **Step 5: Commit**

```bash
git add src/features/kouetsu/views/MetaStructureView.tsx src/features/kouetsu/views/MetaStructureView.test.tsx
git commit -m "feat(tension): MetaStructure project view 上部にテンション波形を配線

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 最終検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 型チェック**

Run: `npx tsc --noEmit`
Expected: 本機能由来の新規エラー 0

- [ ] **Step 2: 関連テスト一括**

Run: `npx vitest run src/features/post-effect/metaStructurePromptContract.test.ts src/features/post-effect/tensionSeries.test.ts src/features/post-effect/TensionCurve.test.tsx src/features/kouetsu/views/MetaStructureView.test.tsx`
Expected: 全 PASS

- [ ] **Step 3: lint**

Run: `npx eslint src/features/post-effect/tensionSeries.ts src/features/post-effect/TensionCurve.tsx src/features/kouetsu/views/MetaStructureView.tsx src/features/post-effect/metaStructurePayloadBuilder.ts src/features/post-effect/tensionSeries.test.ts src/features/post-effect/TensionCurve.test.tsx src/features/post-effect/metaStructurePromptContract.test.ts src/features/kouetsu/views/MetaStructureView.test.tsx`
Expected: エラー 0

- [ ] **Step 4: 実機 QA（手動・任意）**

1. プロジェクトを開き校閲→メタ構造→project スコープで「診断」を実行（全シーン）。
2. 上部にテンション波形が出る／低テンション連続区間に帯／章末に色付きマーカー。
3. 点クリックで該当シーンへ遷移。
4. 診断未実行の新規プロジェクトでは波形が出ない（EmptyState のみ）。
5. current スコープでは波形が出ない。

---

## Self-Review（記入済み）

**1. Spec coverage:**
- prompt 契約強化＋version bump → Task 1 ✓
- 純関数 buildTensionSeries/detectSaggyRuns → Task 2 ✓
- SVG TensionCurve（折れ線/中だるみ帯/章境界線/章末マーカー/クリック/null 分断） → Task 3 ✓
- i18n kouetsu.tension.* → Task 4 ✓
- MetaStructure project view 配線・current 非表示・空非表示 → Task 5 ✓
- Rust/schema 無改修 → 全タスクで保持 ✓
- エッジ（null 分断・全欠落非表示・フラット構成・範囲外クランプ・0/1件） → Task 2/3 テストで被覆 ✓

**2. Placeholder scan:** 改修箇所はすべて完全コードを提示。Task 5 の mock 補足は「実 import を確認し最小 mock 追加」という明示的指示で、対象（実物を通すモジュール）も特定済み。TODO/TBD なし。

**3. Type consistency:**
- `TensionPoint { sceneId,title,tension,parentId,isChapterEnd }` / `SaggyRun { startIdx,endIdx }` を Task 2 で定義 → Task 3（props）・Task 5（series/saggy）で一致使用。
- `buildTensionSeries(nodes, bySceneId)` / `detectSaggyRuns(series, threshold?)` のシグネチャは Task 2 定義と Task 5 呼び出しで一致。
- `META_STRUCTURE_PROMPT_VERSION = "meta_structure_v1.1"` は Task 1 定義と Task 1 テストで一致。
- i18n キー `kouetsu.tension.{title,saggy,chapterHook}` は Task 4 定義と Task 3 使用で一致。空状態は既存 `EmptyState`＋`hasTension` 非表示で担うため tension 専用の noData キーは作らない（YAGNI）。
