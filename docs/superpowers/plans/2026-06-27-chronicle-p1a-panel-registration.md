# Chronicle P1a（パネル登録＋移行＋基本パネル）Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development / executing-plans。P0(データ基盤)の後続。browser test 無し＝CI 低リスクの増分。

**Goal:** `chronicle` を tool-window パネルとして安全に登録し（既存ユーザーのレイアウトを壊さない自動注入移行つき）、Event を一覧・手動 CRUD できる最小パネルを出す。SVG 年表ビューポート（幾何）は P1b に分離。

**Architecture:** レイアウト6点レジストリ＋5プリセットに `chronicle` を追加。`validateLayoutState` は全登録を必須とし、`stripUnknownPanels` は未知除去のみで新パネルを注入しないため、`ensureLayoutStateV3` に**汎用の自動注入関数 `ensureRegisteredPanels` を追加**（既存保存レイアウト/カスタムプリセットに未登録パネルを既定リージョンへ挿入）。基本パネルは `chronicle/api.ts`(P0) を使い Event 一覧＋CRUD。store は timelineStore パターン。

## Global Constraints

- ES modules・2スペース・TS strict。1ファイル1責務200行。
- レイアウト幾何変更は browser test 必須だが、本 P1a は SVG を持たない（リスト UI のみ）ため happy-dom 単体で足りる。
- `Record<PanelId,...>` は exhaustive＝埋め忘れは型エラーで CI が弾く。
- 検証: `npx tsc --noEmit` / `pnpm lint` / `pnpm test --run <path>`。

---

### Task 1: 汎用 自動注入移行 `ensureRegisteredPanels`（先に入れる）

**Files:**
- Modify: `src/features/layout/layoutStateUtils.ts`（`ensureLayoutStateV3` と `stripUnknownPanels` の間）
- Test: `src/features/layout/layoutStateUtils.test.ts`

**Interfaces:**
- Consumes: `TOOL_WINDOW_PANEL_IDS`, `DEFAULT_REGION_MAP`, `DEFAULT_INDEX_MAP`, `ALL_REGIONS`, `normalizeSlotRatios`。
- Produces: `ensureLayoutStateV3` が「全登録パネルがどこかの slot に存在する」ことを保証（`validateLayoutState` を必ず通す）。

設計: `ensureRegisteredPanels(state)` は、どの slot/segment にも現れない `TOOL_WINDOW_PANEL_IDS` を、その `DEFAULT_REGION_MAP` の slot（`DEFAULT_INDEX_MAP` 優先、無ければ region 先頭 slot、slot 無ければ新規作成）へ append する。`activePanel` は変えない（折りたたみのまま）。`ensureLayoutStateV3` 内で `stripUnknownPanels` の後に呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**（`layoutStateUtils.test.ts` に追記）

```typescript
import { ensureLayoutStateV3, validateLayoutState } from "./layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "./toolWindowDefaults";

it("ensureLayoutStateV3: 未登録パネルを注入し validateLayoutState を通す", () => {
  // 全パネル登録済みの既定レイアウトから、最後のパネルだけ全 slot/segment から除去する
  const base = buildDefaultLayoutState();
  const victim = TOOL_WINDOW_PANEL_IDS[TOOL_WINDOW_PANEL_IDS.length - 1];
  for (const region of Object.values(base.regions)) {
    for (const slot of region.slots) {
      slot.panels = slot.panels.filter((p) => p !== victim);
      if (slot.activePanel === victim) slot.activePanel = slot.panels[0] ?? null;
    }
    region.slots = region.slots.filter((s) => s.panels.length > 0);
  }
  // この時点では victim 不在 → invalid のはず
  expect(validateLayoutState(base).valid).toBe(false);
  // ensureLayoutStateV3 が注入して valid 化する
  const fixed = ensureLayoutStateV3(base);
  const seen = new Set<string>();
  for (const region of Object.values(fixed.regions))
    for (const slot of region.slots) for (const p of slot.panels) seen.add(p);
  expect(seen.has(victim)).toBe(true);
  expect(validateLayoutState(fixed).valid).toBe(true);
});
```
（`buildDefaultLayoutState` は同ファイル export 済み。import に追加。）

- [ ] **Step 2: 失敗確認** `pnpm test --run src/features/layout/layoutStateUtils.test.ts`（victim 注入されず FAIL）

- [ ] **Step 3: 実装**

```typescript
// layoutStateUtils.ts: ensureLayoutStateV3 を書き換え
export function ensureLayoutStateV3(
  state: LayoutState | LayoutStateV2,
): LayoutState {
  const v3 = isLayoutStateV2(state)
    ? stripUnknownPanels(migrateLayoutStateV2toV3(state))
    : stripUnknownPanels(cloneLayoutState(state));
  return ensureRegisteredPanels(v3);
}

/**
 * 新規登録されたが保存済みレイアウトに含まれないパネルを、既定リージョンの slot へ
 * 注入する（validateLayoutState は全 TOOL_WINDOW_PANEL_IDS の登録を必須とするため、
 * これが無いと新パネル追加で既存レイアウトが invalid → builtin:default リセットになる）。
 * 汎用＝将来の新パネルにも効く。冪等。
 */
function ensureRegisteredPanels(state: LayoutState): LayoutState {
  const seen = new Set<string>();
  for (const regionId of ALL_REGIONS)
    for (const slot of state.regions[regionId]?.slots ?? [])
      for (const p of slot.panels) seen.add(p);
  for (const seg of state.center.segments)
    if (seg.kind === "tool") for (const p of seg.panels) seen.add(p);

  for (const panelId of TOOL_WINDOW_PANEL_IDS) {
    if (seen.has(panelId)) continue;
    const regionId = DEFAULT_REGION_MAP[panelId];
    const region = state.regions[regionId];
    if (!region) continue;
    const idx = DEFAULT_INDEX_MAP[panelId];
    let target = region.slots[idx] ?? region.slots[0];
    if (!target) {
      target = { id: `auto-${panelId}`, sizeRatio: 1, panels: [], activePanel: null };
      region.slots.push(target);
    }
    target.panels.push(panelId);
    region.slots = normalizeSlotRatios(region.slots);
    seen.add(panelId);
  }
  return state;
}
```

- [ ] **Step 4: 通過確認** 同上コマンド → PASS。既存 layoutStateUtils テストも回帰なし。

- [ ] **Step 5: コミット** `git commit -m "feat(layout): 新規登録パネルを既存レイアウトへ自動注入する移行を追加"`

---

### Task 2: `chronicle` を6点レジストリ＋5プリセットへ登録

**Files:**
- Modify: `src/features/layout/panelIds.ts`（ユニオンに `"chronicle"`、timeline と map の間）
- Modify: `src/features/layout/panelIcons.ts`（`CalendarRange` import＋`chronicle: CalendarRange`）
- Modify: `src/features/layout/panelRegions.ts`（`PANEL_REGION_MAP` chronicle:"center-bottom"・`KEYBOARD_SHORTCUT_MAP` chronicle:"Ctrl+Alt+K"・`TOGGLEABLE_PANELS` に追加）
- Modify: `src/features/layout/toolWindowDefaults.ts`（`DEFAULT_SLOT_MAP` chronicle:"BL"）
- Modify: `src/features/layout/panelComponents.tsx`（`ChroniclePanel` import＋map に `chronicle: ChroniclePanel`）→ Task 3 でパネル実体を作るので、Task 3 とまとめて1コミットでも可
- Modify: `src/features/layout/layoutPresets.ts`（builtin 5プリセットの bottom 内 `["map","grid","matrix"]` slot に `"chronicle"` を追加。`hiddenStripePanels` には**含めない**＝既定表示で発見性を確保）
- Modify: 期待値テスト `layoutStateUtils.test.ts`/`layoutStore.test.ts`/`layoutPresets.test.ts`（パネル数 15→16 等の assertion を更新）

注: `DEFAULT_REGION_MAP`/`DEFAULT_INDEX_MAP`/`TOOL_WINDOW_PANEL_IDS` は `DEFAULT_SLOT_MAP` から自動導出のため編集不要。`PANEL_COMPONENT_MAP` への登録は ChroniclePanel が無いと型エラーなので Task 3 と同時に通す。

- [ ] Step 1: 上記レジストリ編集（panelComponents 以外）
- [ ] Step 2: 5プリセットへ `"chronicle"` 追加（各 bottom の map/grid/matrix slot へ）
- [ ] Step 3: `npx tsc --noEmit`（PANEL_COMPONENT_MAP 未登録で chronicle が `Record<PanelId>` に欠ける→ Task 3 とまとめて解消）
- [ ] Step 4: 期待値テスト更新後 `pnpm test --run src/features/layout/`
- [ ] Step 5: Task 3 とまとめてコミット

---

### Task 3: `chronicleStore.ts` ＋ 基本 `ChroniclePanel.tsx`

**Files:**
- Create: `src/features/chronicle/chronicleStore.ts`（Zustand＋global_settings 永続化。timelineStore パターン。state: zoom/scrollOffset/selectedEventId/showOffpage）
- Create: `src/features/chronicle/chronicleStore.test.ts`（save IPC 発火テスト・timelineStore.test パターン）
- Create: `src/features/chronicle/ChroniclePanel.tsx`（projectStore から projectId、`listEvents` でロード、codexStore でレーン名、Event 一覧＋「追加/編集/削除」最小 UI）
- Modify: `src/features/layout/panelComponents.tsx`（import＋map 登録）
- Modify: `src/features/workspace/store.ts`（`GlobalSettings` に `chronicle?` フィールド追加＝永続化キー）
- Modify: i18n（`src/locales/*` の chronicle ラベル）

注: GlobalSettings 型の現状は実装時に読んで確認。永続化は `settings.chronicle = snapshot`。

- [ ] Step 1: chronicleStore（+test）→ 失敗→実装→PASS
- [ ] Step 2: GlobalSettings に chronicle 追加（型のみ）
- [ ] Step 3: ChroniclePanel（リスト＋CRUD ボタン。SVG なし）
- [ ] Step 4: panelComponents へ登録 → `npx tsc --noEmit` 全解決
- [ ] Step 5: i18n キー追加
- [ ] Step 6: `pnpm test --run src/features/chronicle/ src/features/layout/` → green
- [ ] Step 7: コミット（Task 2 と合わせて「chronicle パネル登録＋基本パネル」）

---

### Task 4: 全体検証

- [ ] `npx tsc --noEmit` / `pnpm lint` / `pnpm test --run src/features/chronicle/ src/features/layout/` / `cargo check --no-default-features`
- [ ] パネルが各プリセットで invalid 化しないこと（layout テスト）

## 後続
- P1b: `ChronicleViewport`（SVG 人物レーン・連続ordinal軸・point/interval・オフページ中空）＋ browser geometry test。
- P2/P3/P4: 季節整合 / Timeline 連動 / 拡張。
