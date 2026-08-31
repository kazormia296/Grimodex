// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  WorkLayerProvider,
  WorkLayerSurface,
  WorkPulse,
} from "./WorkLayer";
import type { WorkLayerModel, WorkLayerPort } from "./types";

const MODEL: WorkLayerModel = {
  scopeId: "preview-project",
  focus: {
    id: "focus-dungeon",
    title: "地下牢の改稿",
    authorTasks: [
      {
        id: "task-east-west",
        title: "東西分断後の時系列を確認",
        completed: false,
      },
    ],
    later: [{ id: "focus-sword", title: "伏線『青い剣』" }],
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
  system: { state: "idle", label: "idle" },
};

function renderWorkLayer(
  options: {
    active?: boolean;
    initialModel?: WorkLayerModel | null;
    port?: WorkLayerPort | null;
    onPreviewDecision?: (findingId: string, candidateId: string) => void;
  } = {},
) {
  return render(
    <WorkLayerProvider
      active={options.active}
      initialModel={options.initialModel ?? MODEL}
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
    </WorkLayerProvider>,
  );
}

describe("Work Layer UI", () => {
  it("shows only active Attention in the ambient Pulse", () => {
    renderWorkLayer();

    expect(
      screen.getByRole("button", { name: "Attention 2件" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("処分済みのFinding")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });

  it("uses separate FOCUS and ATTN doors and reserves checkboxes for Author Tasks", async () => {
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

    await user.click(screen.getByRole("button", { name: "Focus 地下牢の改稿" }));
    const focusTray = screen.getByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    expect(within(focusTray).getAllByRole("checkbox")).toHaveLength(1);
    expect(
      within(focusTray).queryByText("『アリス』の参照先が曖昧"),
    ).not.toBeInTheDocument();
  });

  it("opens one Finding in the Lens and multiple Findings in Projection", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
    );
    const lens = screen.getByRole("dialog", { name: "Resolve Lens" });
    expect(within(lens).getByText("REVIEW")).toBeInTheDocument();
    expect(within(lens).getByText("FRESHNESS")).toBeInTheDocument();
    expect(within(lens).getByText("PROJECTION")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Resolve Projection" }),
    ).toBeInTheDocument();
  });

  it("returns from Inspect to its opener and consumes Escape before outer workspace shortcuts", async () => {
    const user = userEvent.setup();
    renderWorkLayer();

    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );
    await user.click(screen.getByRole("button", { name: "詳細を検査" }));
    expect(
      screen.getByRole("dialog", { name: "Deep Inspection" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Resolve Projection" }),
    ).toBeInTheDocument();
  });

  it("ignores composing/default-prevented Escape and restores focus when returning to ambient", async () => {
    const user = userEvent.setup();
    renderWorkLayer();
    const attentionButton = screen.getByRole("button", { name: "Attention 2件" });
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
  });

  it("does not load or render the Work Layer outside the primary desktop workspace", async () => {
    const port: WorkLayerPort = { load: vi.fn().mockResolvedValue(MODEL) };
    renderWorkLayer({ active: false, initialModel: null, port });

    expect(port.load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("work-pulse")).not.toBeInTheDocument();
  });
});
