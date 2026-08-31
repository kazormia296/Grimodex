// @vitest-environment happy-dom

import { type ReactNode, useLayoutEffect } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { useReducedMotion } from "@/lib/animation";

import { WorkLayerProvider, WorkLayerSurface, WorkPulse } from "./WorkLayer";
import type { WorkLayerModel, WorkLayerPort } from "./types";

vi.mock("@/lib/animation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation")>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const MODEL: WorkLayerModel = {
  scopeId: "preview-project",
  codexPanelAvailable: false,
  focus: {
    id: "work-active",
    title: "地下牢の改稿",
    authorTasks: [
      {
        id: "task-east-west",
        title: "東西分断後の時系列を確認",
        completed: false,
      },
    ],
    later: [{ id: "work-waiting", title: "伏線『青い剣』" }],
  },
  attention: [
    {
      id: "finding-binding",
      groupLabel: "Scene 12 改稿",
      kind: "ambiguous-identity",
      title: "『アリス』の参照先が曖昧",
      summary: "本文の表記が2件のCodex候補に一致しています。",
      source: {
        label: "Scene 12 · ¶2",
        excerpt: "アリスは鍵を拾い、地下牢を出た。",
      },
      reason: "Surface『アリス』が2件の候補に一致",
      previousValue: "Binding なし",
      candidates: [
        { id: "alice-rain", label: "アリス・レイン", meta: "登場 12 Scene" },
        { id: "alice-hague", label: "アリス・ハーグ", meta: "登場 3 Scene" },
      ],
      impact: ["Chronicle Event『脱獄』", "Related Scenes · 4件"],
      states: {
        review: "未判断",
        freshness: "曖昧",
        projection: "未適用",
      },
      materialChain: [
        "Source · Scene 12 v48",
        "Anchor · ¶2",
        "Assertion · entity-binding@1",
        "Edge · source-evidence",
        "Freshness · ambiguous",
        "Finding · ambiguous-identity",
      ],
      systemWork: {
        runId: "run-8f31",
        taskLabel: "recheck",
        attemptLabel: "attempt 1",
        authority: "Workspace authority",
        epoch: "42",
      },
    },
    {
      id: "finding-evidence",
      groupLabel: "Scene 12 改稿",
      kind: "source-missing",
      title: "Chronicle『脱獄』のEvidenceが見つからない",
      summary: "承認済みの構造は保持され、根拠だけが古くなっています。",
      source: { label: "Scene 12 · 旧¶2", excerpt: null },
      reason: "以前のAnchorが現在の本文に存在しない",
      previousValue: "Evidence · Scene 12 v47 ¶2",
      candidates: [],
      impact: ["Chronicle Event『脱獄』", "Timeline 再評価"],
      states: {
        review: "承認済み · V1",
        freshness: "根拠消失",
        projection: "適用済み · V1",
      },
      materialChain: [
        "Source · Scene 12 v48",
        "Anchor · missing",
        "Assertion · scene-event@1",
        "Edge · evidence",
        "Freshness · source-missing",
        "Finding · evidence-stale",
      ],
      systemWork: {
        runId: "run-8f31",
        taskLabel: "verify",
        attemptLabel: "attempt 1",
        authority: "Workspace authority",
        epoch: "42",
      },
    },
  ],
  disposedAttention: [
    {
      id: "finding-dismissed",
      title: "処分済みのFinding",
      disposition: "dismissed",
    },
  ],
  batchProposals: [
    {
      id: "proposal-safe",
      title: "scene-event 追加『鍵の入手』",
      detail: "¶2",
      eligible: true,
      reason: "新規追加 · Evidence anchored",
    },
    {
      id: "proposal-individual",
      title: "entity binding『アリス』",
      detail: "Scene 12",
      eligible: false,
      reason: "候補2件",
    },
  ],
  allWork: [
    {
      id: "work-active",
      title: "地下牢の改稿",
      status: "active",
      tag: "NOW",
    },
    {
      id: "work-waiting",
      title: "伏線『青い剣』",
      status: "waiting",
    },
    {
      id: "work-held",
      title: "処分済みのFinding",
      status: "held",
      tag: "DISMISSED",
    },
    {
      id: "work-completed",
      title: "完了した作業",
      status: "completed",
    },
  ],
  system: { state: "idle", label: "idle" },
};

function renderWorkLayer(
  options: {
    active?: boolean;
    initialModel?: WorkLayerModel | null;
    port?: WorkLayerPort | null;
    onPreviewDecision?: (findingId: string, candidateId: string) => void;
    children?: ReactNode;
  } = {},
) {
  return render(
    <WorkLayerProvider
      active={options.active}
      initialModel={
        options.initialModel === undefined ? MODEL : options.initialModel
      }
      port={options.port}
      onPreviewDecision={options.onPreviewDecision}
    >
      <div data-testid="header">
        <WorkPulse />
      </div>
      <main>
        <div data-testid="workspace">workspace</div>
        <WorkLayerSurface />
      </main>
      {options.children}
    </WorkLayerProvider>,
  );
}

function ScopePreview({ model }: { readonly model: WorkLayerModel }) {
  return (
    <WorkLayerProvider initialModel={model}>
      <WorkPulse />
      <WorkLayerSurface />
    </WorkLayerProvider>
  );
}

describe("Work Layer UI", () => {
  it("shows only active Attention in the ambient Pulse", () => {
    renderWorkLayer();

    const attention = screen.getByRole("button", { name: "Attention 2件" });
    const liveRegion = screen.getByTestId("work-pulse-live-region");
    expect(attention).toBeInTheDocument();
    expect(attention).not.toHaveClass("bg-foreground");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(attention).not.toContainElement(liveRegion);
    expect(screen.queryByText("処分済みのFinding")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });

  it("uses two doors into one tray while reserving checkboxes for Author Tasks", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    const attentionTray = screen.getByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    expect(within(attentionTray).queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(attentionTray).getByText("『アリス』の参照先が曖昧"),
    ).toBeInTheDocument();
    expect(
      within(attentionTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    ).toBeInTheDocument();
    expect(within(attentionTray).getByText("地下牢の改稿")).toBeInTheDocument();
    expect(
      within(attentionTray).getByText("伏線『青い剣』"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Focus 地下牢の改稿" }),
    );
    const focusTray = screen.getByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    expect(within(focusTray).getAllByRole("checkbox")).toHaveLength(1);
    expect(
      within(focusTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    ).toBeInTheDocument();
    const attentionDoor = within(focusTray).getByRole("button", {
      name: "Attention 2件を展開",
    });
    expect(attentionDoor).toHaveTextContent("『アリス』の参照先が曖昧");
    await user.click(attentionDoor);
    expect(
      screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "閉じる" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attention 2件" }),
      ).toHaveFocus(),
    );
  });

  it("opens one Finding in the Lens and multiple Findings in Projection", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    const findingButton = screen.getByRole("button", {
      name: "『アリス』の参照先が曖昧を開く",
    });
    await user.click(findingButton);
    const lens = screen.getByRole("dialog", { name: "Resolve Lens" });
    expect(within(lens).getByText("REVIEW")).toBeInTheDocument();
    expect(within(lens).getByText("FRESHNESS")).toBeInTheDocument();
    expect(within(lens).getByText("PROJECTION")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "『アリス』の参照先が曖昧を開く",
        }),
      ).toHaveFocus(),
    );
    expect(findingButton.isConnected).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Resolve Projection" }),
    ).toBeInTheDocument();
  });

  it("returns from Inspect to its opener and consumes Escape before outer workspace shortcuts", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    const projection = screen.getByRole("dialog", {
      name: "Resolve Projection",
    });
    expect(projection).toHaveAttribute("aria-modal", "true");
    expect(container).toHaveAttribute("inert");
    const projectionButtons = within(projection).getAllByRole("button");
    const firstProjectionButton = projectionButtons[0];
    const lastProjectionButton = projectionButtons.at(-1);
    expect(firstProjectionButton).toBeDefined();
    expect(lastProjectionButton).toBeDefined();
    lastProjectionButton?.focus();
    fireEvent.keyDown(lastProjectionButton as HTMLButtonElement, {
      key: "Tab",
    });
    expect(firstProjectionButton).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "詳細を検査" }));
    expect(
      screen.getByRole("dialog", { name: "Deep Inspection" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Resolve Projection" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "詳細を検査" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Attention 2件" }),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute("inert");
  });

  it("isolates app-root and body-level siblings during a modal and restores their attributes exactly", async () => {
    const user = userEvent.setup();
    const cleanPortal = document.createElement("div");
    cleanPortal.dataset.testPortal = "clean";
    cleanPortal.innerHTML = "<button type='button'>outside portal</button>";
    const attributedPortal = document.createElement("div");
    attributedPortal.dataset.testPortal = "attributed";
    attributedPortal.setAttribute("inert", "preserve-inert");
    attributedPortal.setAttribute("aria-hidden", "false");
    document.body.append(cleanPortal, attributedPortal);

    try {
      const { container } = renderWorkLayer();
      container.id = "root";
      const appShell = container.querySelector("main");
      const appRootSibling = document.createElement("aside");
      appRootSibling.dataset.testPortal = "app-root-sibling";
      appRootSibling.setAttribute("inert", "preserve-root-inert");
      appRootSibling.setAttribute("aria-hidden", "false");
      container.appendChild(appRootSibling);
      expect(appShell).not.toBeNull();
      appShell?.classList.add("app-shell");

      await user.click(screen.getByRole("button", { name: "Attention 2件" }));
      await user.click(
        screen.getByRole("button", {
          name: "2件をResolve Projectionで開く",
        }),
      );

      expect(appShell).toHaveAttribute("inert");
      expect(appShell).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByTestId("header")).toHaveAttribute("inert");
      expect(screen.getByTestId("header")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(appRootSibling).toHaveAttribute("inert", "");
      expect(appRootSibling).toHaveAttribute("aria-hidden", "true");
      expect(cleanPortal).toHaveAttribute("inert");
      expect(cleanPortal).toHaveAttribute("aria-hidden", "true");
      expect(attributedPortal).toHaveAttribute("inert", "");
      expect(attributedPortal).toHaveAttribute("aria-hidden", "true");

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Resolve Projection" }),
        ).not.toBeInTheDocument(),
      );

      expect(appShell).not.toHaveAttribute("inert");
      expect(appShell).not.toHaveAttribute("aria-hidden");
      expect(screen.getByTestId("header")).not.toHaveAttribute("inert");
      expect(screen.getByTestId("header")).not.toHaveAttribute("aria-hidden");
      expect(appRootSibling).toHaveAttribute("inert", "preserve-root-inert");
      expect(appRootSibling).toHaveAttribute("aria-hidden", "false");
      expect(cleanPortal).not.toHaveAttribute("inert");
      expect(cleanPortal).not.toHaveAttribute("aria-hidden");
      expect(attributedPortal).toHaveAttribute("inert", "preserve-inert");
      expect(attributedPortal).toHaveAttribute("aria-hidden", "false");
    } finally {
      cleanPortal.remove();
      attributedPortal.remove();
    }
  });

  it("ignores composing/default-prevented Escape and restores focus when returning to ambient", async () => {
    const user = userEvent.setup();
    renderWorkLayer();
    const attentionButton = screen.getByRole("button", {
      name: "Attention 2件",
    });
    attentionButton.focus();
    await user.click(attentionButton);

    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(
      screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).toBeInTheDocument();

    const prevented = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    document.dispatchEvent(prevented);
    expect(
      screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(attentionButton).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Attentionの作業トレイ" }),
    ).not.toBeInTheDocument();
  });

  it("lets an actual AnimatedOverlay own Escape before the underlying Work Layer", async () => {
    const user = userEvent.setup();
    const onOverlayClose = vi.fn();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    const overlay = render(
      <AnimatedOverlay open onClose={onOverlayClose}>
        <button type="button">Settings overlay action</button>
      </AnimatedOverlay>,
    );

    try {
      const overlayAction = screen.getByRole("button", {
        name: "Settings overlay action",
      });
      expect(screen.getByTestId("animated-overlay-backdrop")).toHaveAttribute(
        "data-animated-overlay-root",
        "true",
      );
      overlayAction.focus();
      fireEvent.keyDown(overlayAction, { key: "Escape" });

      expect(onOverlayClose).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
      ).toBeInTheDocument();
    } finally {
      overlay.unmount();
    }
  });

  it("yields Escape to an AnimatedOverlay even while focus is still on the Work Layer opener", async () => {
    const user = userEvent.setup();
    const onOverlayClose = vi.fn();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    const trayClose = screen.getByRole("button", { name: "閉じる" });
    const overlay = render(
      <AnimatedOverlay open onClose={onOverlayClose}>
        <button type="button">Settings overlay action</button>
      </AnimatedOverlay>,
    );

    try {
      trayClose.focus();
      fireEvent.keyDown(trayClose, { key: "Escape" });

      expect(onOverlayClose).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
      ).toBeInTheDocument();
    } finally {
      overlay.unmount();
    }
  });

  it("labels a local Binding choice as an unpersisted UI preview", async () => {
    const user = userEvent.setup();
    const onPreviewDecision = vi.fn();
    renderWorkLayer({ onPreviewDecision });

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "アリス・レインへBindingをプレビュー",
      }),
    );

    expect(onPreviewDecision).toHaveBeenCalledWith(
      "finding-binding",
      "alice-rain",
    );
    expect(
      screen.getByRole("status", { name: "プレビュー判断の受領証" }),
    ).toHaveTextContent("まだ保存されていません");
    expect(
      screen.getByRole("button", { name: "Attention 1件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attention 1件" }),
    ).toHaveAttribute("data-work-layer-resolution-beat", "true");
    expect(screen.getByText("✓ −1")).toBeInTheDocument();
    expect(
      screen.getByRole("status", {
        name: "Attentionが1件解消されました（UIプレビュー）",
      }),
    ).toBeInTheDocument();
  });

  it("clears a preview receipt when the model scope changes", async () => {
    const user = userEvent.setup();
    const preview = render(<ScopePreview model={MODEL} />);

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "アリス・レインへBindingをプレビュー",
      }),
    );
    expect(
      screen.getByRole("status", { name: "プレビュー判断の受領証" }),
    ).toBeInTheDocument();

    preview.rerender(
      <ScopePreview model={{ ...MODEL, scopeId: "other-preview-project" }} />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "プレビュー判断の受領証" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Attention 2件" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("previews the candidate selected by the author", async () => {
    const user = userEvent.setup();
    const onPreviewDecision = vi.fn();
    renderWorkLayer({ onPreviewDecision });

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
    );
    const candidate = screen.getByRole("radio", { name: "アリス・ハーグ" });
    candidate.focus();
    expect(candidate.closest("label")).toHaveClass(
      "focus-within:ring-2",
      "focus-within:ring-ring",
    );
    await user.click(candidate);
    await user.click(
      screen.getByRole("button", {
        name: "アリス・ハーグへBindingをプレビュー",
      }),
    );

    expect(onPreviewDecision).toHaveBeenCalledWith(
      "finding-binding",
      "alice-hague",
    );
  });

  it("does not load or render the Work Layer outside the primary desktop workspace", async () => {
    const port: WorkLayerPort = { load: vi.fn().mockResolvedValue(MODEL) };
    renderWorkLayer({ active: false, initialModel: null, port });

    expect(port.load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("work-pulse")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("work-pulse-live-region"),
    ).not.toBeInTheDocument();
  });

  it("leaves no Work Layer DOM when the explicit preview port is absent", () => {
    renderWorkLayer({ initialModel: null, port: null });

    expect(screen.queryByTestId("work-pulse")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("work-pulse-live-region"),
    ).not.toBeInTheDocument();
  });

  it("opens running system work from SYS without adding it to Attention", async () => {
    const user = userEvent.setup();
    renderWorkLayer({
      initialModel: {
        ...MODEL,
        system: { state: "running", label: "verify" },
      },
    });

    expect(
      screen.getByRole("button", { name: "System verify" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attention 2件" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "System verify" }));
    const activity = screen.getByRole("dialog", { name: "System Activity" });
    expect(within(activity).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("opens blocked system work as a SYS event with non-persistent actions", async () => {
    const user = userEvent.setup();
    renderWorkLayer({
      initialModel: {
        ...MODEL,
        system: { state: "blocked", label: "contract" },
      },
    });

    await user.click(screen.getByRole("button", { name: "System contract" }));
    expect(
      screen.getByRole("dialog", { name: "System Blocked" }),
    ).toHaveTextContent("UI PREVIEW");
  });

  it("keeps empty Attention quiet and exposes disposed records separately", async () => {
    const user = userEvent.setup();
    renderWorkLayer({
      initialModel: { ...MODEL, focus: null, attention: [] },
    });

    await user.click(screen.getByRole("button", { name: "Attention 0件" }));
    const emptyTray = screen.getByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    expect(
      within(emptyTray).queryByText(/^ATTENTION$/),
    ).not.toBeInTheDocument();
    expect(within(emptyTray).queryByText(/^0$/)).not.toBeInTheDocument();
    expect(
      within(emptyTray).queryByText(/ATTENTION · 0/),
    ).not.toBeInTheDocument();
    expect(
      within(emptyTray).queryByText(
        "作者の判断で解消します。チェックで完了にはしません。",
      ),
    ).not.toBeInTheDocument();
    expect(within(emptyTray).getByText("Focus なし")).toBeInTheDocument();
    expect(
      within(emptyTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    ).toBeInTheDocument();

    await user.click(
      within(emptyTray).getByRole("button", {
        name: "処分済みの判断 1件を開く",
      }),
    );
    const disposed = within(emptyTray).getByRole("region", {
      name: "処分済みの判断",
    });
    expect(disposed).toHaveTextContent("処分済みのFinding");
    expect(within(disposed).queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(emptyTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    ).toBeInTheDocument();
  });

  it("opens a temporary Context Portal and returns to its Lens opener", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Context Portalを開く" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Context Portal" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Resolve Lens" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Context Portalを開く" }),
      ).toHaveFocus(),
    );
  });

  it("opens Change Review and Batch as children of Projection", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Chronicle『脱獄』のEvidenceが見つからない",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Change Reviewを開く" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Change Review" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await user.click(
      screen.getByRole("button", { name: "安全なProposalを一括確認" }),
    );
    const batch = screen.getByRole("dialog", { name: "Batch Review" });
    expect(within(batch).queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(batch).getByRole("button", {
        name: /entity binding『アリス』/,
      }),
    ).toBeDisabled();
    expect(
      within(batch).getByRole("button", {
        name: /scene-event 追加『鍵の入手』/,
        pressed: true,
      }),
    ).toBeEnabled();
  });

  it("focuses the first eligible Batch proposal when an ineligible proposal comes first", async () => {
    const user = userEvent.setup();
    renderWorkLayer({
      initialModel: {
        ...MODEL,
        batchProposals: [MODEL.batchProposals![1], MODEL.batchProposals![0]],
      },
    });

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    await user.click(
      screen.getByRole("button", { name: "安全なProposalを一括確認" }),
    );

    const batch = screen.getByRole("dialog", { name: "Batch Review" });
    const firstEligible = within(batch).getByRole("button", {
      name: /scene-event 追加『鍵の入手』/,
    });
    await waitFor(() => expect(firstEligible).toHaveFocus());
  });

  it("shows a restrained arrival beat without opening the Work Layer", () => {
    const arrivalModel: WorkLayerModel & { readonly attentionDelta: number } = {
      ...MODEL,
      attentionDelta: 1,
      attentionAnchorVisible: true,
      attentionAnchorPosition: { xPercent: 43, yPercent: 33, heightPx: 96 },
    };
    renderWorkLayer({ initialModel: arrivalModel });

    expect(screen.getByRole("status")).toHaveTextContent(
      "新しいAttentionが1件あります",
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByRole("button", { name: "Attention 2件" }),
    ).not.toContainElement(screen.getByRole("status"));
    expect(screen.getByTestId("work-layer-arrival-charge")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByTestId("work-layer-arrival-gutter")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not show an arrival gutter when the anchor is outside the viewport", () => {
    renderWorkLayer({
      initialModel: {
        ...MODEL,
        attentionDelta: 1,
        attentionAnchorVisible: false,
      },
    });

    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("work-layer-arrival-gutter"),
    ).not.toBeInTheDocument();
  });

  it("keeps the Attention arrival announcement when motion is reduced", () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const arrivalModel: WorkLayerModel & { readonly attentionDelta: number } = {
      ...MODEL,
      attentionDelta: 1,
      attentionAnchorVisible: true,
      attentionAnchorPosition: { xPercent: 43, yPercent: 33, heightPx: 96 },
    };

    try {
      renderWorkLayer({ initialModel: arrivalModel });

      expect(screen.getByRole("status")).toHaveTextContent(
        "新しいAttentionが1件あります",
      );
      expect(
        screen.queryByTestId("work-layer-arrival-charge"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("+1")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("work-layer-arrival-gutter"),
      ).not.toBeInTheDocument();
    } finally {
      vi.mocked(useReducedMotion).mockReturnValue(false);
    }
  });

  it("mounts an empty live region before async model arrival, then announces the update with reduced motion", async () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    let resolveModel: ((model: WorkLayerModel) => void) | undefined;
    const port: WorkLayerPort = {
      load: vi.fn(
        () =>
          new Promise<WorkLayerModel>((resolve) => {
            resolveModel = resolve;
          }),
      ),
    };

    try {
      renderWorkLayer({ initialModel: null, port });
      const liveRegion = screen.getByTestId("work-pulse-live-region");
      expect(liveRegion).toBeEmptyDOMElement();
      expect(screen.queryByTestId("work-pulse")).not.toBeInTheDocument();

      resolveModel?.({
        ...MODEL,
        attentionDelta: 1,
        attentionAnchorVisible: true,
      });

      await waitFor(() =>
        expect(liveRegion).toHaveTextContent("新しいAttentionが1件あります"),
      );
      expect(screen.getByTestId("work-pulse")).toBeInTheDocument();
      expect(screen.queryByText("+1")).not.toBeInTheDocument();
    } finally {
      vi.mocked(useReducedMotion).mockReturnValue(false);
    }
  });

  it("mounts an empty live region before announcing an initial fixture arrival", async () => {
    let layoutEffectText: string | null = null;
    const InitialAnnouncementProbe = () => {
      useLayoutEffect(() => {
        layoutEffectText =
          document.querySelector('[data-testid="work-pulse-live-region"]')
            ?.textContent ?? null;
      }, []);
      return null;
    };

    renderWorkLayer({
      initialModel: {
        ...MODEL,
        attentionDelta: 1,
        attentionAnchorVisible: true,
      },
      children: <InitialAnnouncementProbe />,
    });

    expect(layoutEffectText).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("work-pulse-live-region")).toHaveTextContent(
        "新しいAttentionが1件あります",
      ),
    );
  });

  it("consumes an arrival delta before showing the resolution beat", async () => {
    const user = userEvent.setup();
    renderWorkLayer({
      initialModel: {
        ...MODEL,
        attentionDelta: 1,
        attentionAnchorVisible: true,
        attentionAnchorPosition: { xPercent: 43, yPercent: 33, heightPx: 96 },
      },
    });

    expect(screen.getByText("+1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", {
        name: "『アリス』の参照先が曖昧を開く",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "アリス・レインへBindingをプレビュー",
      }),
    );

    expect(screen.queryByText("+1")).not.toBeInTheDocument();
    expect(screen.getByText("✓ −1")).toBeInTheDocument();
    expect(screen.getByTestId("work-pulse-live-region")).toHaveTextContent(
      "Attentionが1件解消されました",
    );
    expect(screen.getByTestId("work-pulse-live-region")).not.toHaveTextContent(
      "新しいAttention",
    );
  });

  it("announces a reduced-motion resolution outside the ATTN button without a visual beat", async () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const user = userEvent.setup();

    try {
      renderWorkLayer();
      await user.click(screen.getByRole("button", { name: "Attention 2件" }));
      await user.click(
        screen.getByRole("button", {
          name: "『アリス』の参照先が曖昧を開く",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "アリス・レインへBindingをプレビュー",
        }),
      );

      const attention = screen.getByRole("button", { name: "Attention 1件" });
      const announcement = screen.getByRole("status", {
        name: "Attentionが1件解消されました（UIプレビュー）",
      });
      expect(attention).not.toContainElement(announcement);
      expect(attention).not.toHaveAttribute("data-work-layer-resolution-beat");
      expect(screen.queryByText("✓ −1")).not.toBeInTheDocument();
    } finally {
      vi.mocked(useReducedMotion).mockReturnValue(false);
    }
  });

  it("opens ALL WORK from tray variants and returns through the active work or Escape", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(
      screen.getByRole("button", { name: "Focus 地下牢の改稿" }),
    );
    await user.click(
      screen.getByRole("button", { name: "すべての作業を開く" }),
    );
    const ledger = screen.getByRole("dialog", { name: "すべての作業" });
    await user.click(within(ledger).getByRole("button", { name: "保留 1" }));
    expect(within(ledger).getByText("処分済みのFinding")).toBeInTheDocument();
    expect(
      within(ledger).queryByRole("button", {
        name: "進行中の地下牢の改稿をトレイで開く",
      }),
    ).not.toBeInTheDocument();
    await user.click(within(ledger).getByRole("button", { name: "待機 1" }));
    expect(within(ledger).getByText("伏線『青い剣』")).toBeInTheDocument();
    expect(
      within(ledger).queryByText("処分済みのFinding"),
    ).not.toBeInTheDocument();

    await user.click(within(ledger).getByRole("button", { name: "完了 1" }));
    expect(within(ledger).getByText("完了した作業")).toBeInTheDocument();

    await user.click(within(ledger).getByRole("button", { name: "進行中 1" }));

    await user.click(
      within(ledger).getByRole("button", {
        name: "進行中の地下牢の改稿をトレイで開く",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Focusの作業トレイ" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "すべての作業を開く" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Focusの作業トレイ" }),
    ).toBeInTheDocument();
  });
});
