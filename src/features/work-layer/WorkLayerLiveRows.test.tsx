// @vitest-environment happy-dom

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkLayerProvider, WorkLayerSurface, WorkPulse } from "./WorkLayer";
import type {
  WorkLayerLiveEntry,
  WorkLayerModel,
  WorkLayerPort,
} from "./types";

const REVIEW = { surface: "structure-extract-review" } as const;

function liveModel(liveEntries: readonly WorkLayerLiveEntry[]): WorkLayerModel {
  return {
    scopeId: "example-work",
    liveEntries,
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
  };
}

function renderLive(
  liveEntries: readonly WorkLayerLiveEntry[],
  openSurface: WorkLayerPort["openSurface"] = vi.fn(),
) {
  const model = liveModel(liveEntries);
  const port: WorkLayerPort = {
    kind: "live",
    scopeKey: model.scopeId,
    load: vi.fn().mockResolvedValue(model),
    openSurface,
  };
  render(
    <WorkLayerProvider port={port}>
      <WorkPulse />
      <WorkLayerSurface />
    </WorkLayerProvider>,
  );
  return { port };
}

async function openTray(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name }));
  return {
    user,
    tray: screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
  };
}

describe("Work Layer live Pulse", () => {
  it("shows only ATTN and SYS, without the Focus segment", async () => {
    renderLive([{ id: "codex-candidates", status: "ready", count: 2 }]);

    await screen.findByRole("button", { name: "Attention 2件" });
    const pulse = screen.getByTestId("work-pulse");
    expect(within(pulse).queryByText("FOCUS")).not.toBeInTheDocument();
    expect(within(pulse).queryByRole("button", { name: /^Focus/ })).toBeNull();
    expect(within(pulse).getByText("ATTN")).toBeInTheDocument();
    expect(within(pulse).getByText("SYS")).toBeInTheDocument();
  });

  it("shows no Pulse when there is no kind to count, instead of claiming a zero", async () => {
    const { port } = renderLive([]);

    await vi.waitFor(() => expect(port.load).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("work-pulse")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Attention/ })).toBeNull();
  });

  it("appends a plus to a partial sum and drops it once every kind is counted", async () => {
    renderLive([
      { id: "codex-candidates", status: "not-counted", count: null },
      { id: "stale-proposals", status: "ready", count: 3 },
    ]);

    const partial = await screen.findByRole("button", {
      name: "Attention 3件以上（数え終えていない種類があります）",
    });
    expect(partial).toHaveTextContent("3＋");
  });

  it("shows a complete sum without a plus", async () => {
    renderLive([
      { id: "codex-candidates", status: "ready", count: 1 },
      { id: "stale-proposals", status: "ready", count: 2 },
    ]);

    const pulse = await screen.findByRole("button", { name: "Attention 3件" });
    expect(pulse).not.toHaveTextContent("＋");
  });
});

describe("Work Layer live Attention tray rows", () => {
  it("shows one row per kind with its count, and the entry only where there is one", async () => {
    renderLive([
      { id: "codex-candidates", status: "ready", count: 3, open: REVIEW },
      { id: "stale-proposals", status: "ready", count: 2 },
    ]);
    const { tray } = await openTray("Attention 5件");

    const candidates = within(tray)
      .getByText("未登録の固有名詞の候補")
      .closest("li");
    const stale = within(tray).getByText("根拠が古くなった提案").closest("li");
    expect(candidates).toHaveTextContent("3 件");
    expect(
      within(candidates as HTMLElement).getByRole("button", {
        name: "未登録の固有名詞の候補を確認する",
      }),
    ).toHaveTextContent("確認する");
    expect(stale).toHaveTextContent("2 件");
    expect(within(stale as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("keeps a row at zero and never writes that nothing is wrong", async () => {
    renderLive([
      { id: "codex-candidates", status: "ready", count: 0 },
      { id: "stale-proposals", status: "ready", count: 0 },
    ]);
    const { tray } = await openTray("Attention 0件");

    expect(within(tray).getAllByText("0 件")).toHaveLength(2);
    expect(within(tray).getByText("ATTENTION")).toBeInTheDocument();
    expect(within(tray).getByRole("button", { name: "閉じる" })).toBeVisible();
    expect(tray.textContent).not.toMatch(/問題なし|解決済み/);
  });

  it.each([
    [{ status: "not-counted", count: null }, "数えています…"],
    [
      { status: "unavailable", count: null, reason: "failed" },
      "数えられません",
    ],
    [
      { status: "unavailable", count: null, reason: "timed-out" },
      "数えるのに時間がかかっています（終わったら更新します）",
    ],
  ] as const)(
    "says what happened to a row that has no count: %j",
    async (entry, text) => {
      renderLive([{ id: "codex-candidates", ...entry }]);
      const { tray } = await openTray(
        "Attention 0件以上（数え終えていない種類があります）",
      );

      expect(within(tray).getByText(text)).toBeInTheDocument();
    },
  );

  it("closes the tray and opens the review screen from the entry", async () => {
    const openSurface = vi.fn();
    renderLive(
      [{ id: "codex-candidates", status: "ready", count: 3, open: REVIEW }],
      openSurface,
    );
    const { user, tray } = await openTray("Attention 3件");

    await user.click(
      within(tray).getByRole("button", {
        name: "未登録の固有名詞の候補を確認する",
      }),
    );

    expect(openSurface).toHaveBeenCalledWith(REVIEW);
    expect(
      screen.queryByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).not.toBeInTheDocument();
  });

  it("leaves focus on the Pulse's Attention button, so closing the review lands on a button that still exists", async () => {
    const openSurface = vi.fn();
    renderLive(
      [{ id: "codex-candidates", status: "ready", count: 3, open: REVIEW }],
      openSurface,
    );
    const { user, tray } = await openTray("Attention 3件");

    await user.click(
      within(tray).getByRole("button", {
        name: "未登録の固有名詞の候補を確認する",
      }),
    );

    // The tray's own button is gone; the navigation hands focus back to the opener.
    expect(openSurface).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Attention 3件" }),
    );
  });

  it("offers no Focus, ledger, capture, disposed or preview faces", async () => {
    renderLive([{ id: "codex-candidates", status: "ready", count: 1 }]);
    const { tray } = await openTray("Attention 1件");

    for (const text of [
      "NOW",
      "LATER",
      "UI PREVIEW",
      "すべての作業 →",
      "作業を捕捉",
      "Focus なし",
    ]) {
      expect(within(tray).queryByText(text)).not.toBeInTheDocument();
    }
    expect(within(tray).queryByText(/処分済み/)).toBeNull();
    expect(
      within(tray).queryByRole("button", { name: /Focusを展開/ }),
    ).toBeNull();
    expect(within(tray).getByText("ESC")).toBeInTheDocument();
  });
});
