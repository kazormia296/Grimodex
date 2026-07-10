/**
 * 実 Chromium で ContextBar の「幅ベース」グルーピング判定を gate する。
 *
 * coverage inversion の是正: checkGrouping (ContextBar.tsx:188-202) は
 *   col.clientWidth === 0 のとき count 閾値 (GROUP_THRESHOLD=6) にフォールバックし、
 *   それ以外は measure.offsetWidth > col.clientWidth で判定する。
 * happy-dom は clientWidth=0 を返すので **既存 ContextBar.test.tsx は count fallback
 * しか踏めていない**（= prod が実際に通る width path は完全未カバー）。
 * ここでは count fallback と結論が「反転」する 2 ケースを実幅で検証する:
 *   (A) 中幅 × 6件以下 → count なら個別、実幅では overflow → group ON
 *   (B) 広い幅 × 7件以上 → count なら group、実幅では収まる → 個別
 * 差分検証済み: checkGrouping の width 判定を count 判定に差し替えると両方落ちる。
 *
 * 幅の取り方の注意: pillsColumnRef は `flex-1 min-w-0` なので、wrapper を狭くし過ぎると
 * 右端ボタン群(shrink-0)に押されて clientWidth=0 に潰れ、happy-dom と同じ count
 * フォールバックに落ちてしまう。clientWidth>0 かつ measure(全ピル自然幅) 未満になる
 * 中間幅(実測で ~400px)を選ぶ。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { ContextBar } from "./ContextBar";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import { useCodexStore } from "@/features/codex/codexStore";

// DB/Tauri に触れる依存だけ mock（store は実物）。motion/react は実物のまま。
vi.mock("../chatStore", () => ({ useChatStore: vi.fn(() => "") }));
vi.mock("../contextCreatorApi", () => ({
  runContextCreator: vi.fn(() => Promise.resolve([])),
}));

function makeEntry(id: string, name: string, type = "character"): CodexEntry {
  return {
    id,
    name,
    type,
    summary: "",
    content: "{}",
    contextMode: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: "p1",
    parentId: null,
    childrenBudget: "medium",
    tagsCache: null,
    aliases: null,
    excludedAliases: null,
    readings: null,
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    icon: null,
  };
}

function makePinnedEntry(
  id: string,
  name: string,
  type = "character",
): PinnedCodexEntryWithData {
  return {
    ...makeEntry(id, name, type),
    withChildren: false,
    pinnedType: "codex",
    pinSource: "manual",
  };
}

const defaultProps = {
  onReturnToAuto: vi.fn(),
  onRemove: vi.fn(),
  onRemoveAuto: vi.fn(),
  onPin: vi.fn(),
  pinnedSnippetIds: new Set<string>(),
  onPinEntry: vi.fn(),
  onUnpinEntry: vi.fn(),
  onTogglePinChildren: vi.fn(),
  contextTokenCount: 0,
  contextLayers: [],
  systemPrompt: "",
  model: "",
};

afterEach(() => {
  useCodexStore.setState({ entries: [] });
});

describe("ContextBar width-based grouping (real Chromium)", () => {
  it("(A) 中幅では 6件以下でも overflow で group 化する (count fallback の反転)", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
    );
    render(
      <div style={{ width: 400 }}>
        <ContextBar {...defaultProps} pinnedEntries={entries} />
      </div>,
    );
    const pills = await screen.findByTestId("pills-visible");

    // width path 由来で group 化（count fallback なら 6件は個別のはず → 反転を証明）
    await waitFor(() => {
      expect(
        within(pills).getByRole("button", { name: /キャラクター/ }),
      ).toBeInTheDocument();
    });
    expect(within(pills).queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("(B) 広い幅では 8件でも収まれば個別表示する (count fallback の反転)", async () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
    );
    render(
      <div style={{ width: 2000 }}>
        <ContextBar {...defaultProps} pinnedEntries={entries} />
      </div>,
    );
    const pills = await screen.findByTestId("pills-visible");

    // width path 由来で個別（count fallback なら 8件は group のはず → 反転を証明）
    await waitFor(() => {
      expect(within(pills).getByText("キャラ0")).toBeInTheDocument();
    });
    expect(
      within(pills).queryByRole("button", { name: /キャラクター/ }),
    ).not.toBeInTheDocument();
  });
});
