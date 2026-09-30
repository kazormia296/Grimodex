// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { switchWorkLayerFocus } from "./switchWorkLayerFocus";
import type { WorkLayerModel } from "./types";
import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

describe("Work Layer canonical identities", () => {
  it("resolves the Finding displayed by Batch Review", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="projection" />);

    const projection = await screen.findByRole("dialog", {
      name: "Resolve Projection",
    });
    await user.click(
      within(projection).getByRole("button", {
        name: "Chronicle『脱獄』のEvidenceが見つからない",
      }),
    );
    await user.click(
      within(projection).getByRole("button", {
        name: "安全なProposalを一括確認",
      }),
    );

    const batch = await screen.findByRole("dialog", { name: "Batch Review" });
    const selectedWork = within(batch)
      .getByText("Chronicle『脱獄』のEvidenceが見つからない")
      .closest("[aria-current='true']");
    expect(selectedWork).not.toBeNull();

    await user.click(
      within(batch).getByRole("button", {
        name: "一括承認をプレビュー",
      }),
    );

    const receipt = await screen.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    expect(
      within(receipt).getByRole("button", {
        name: "次: 『アリス』の参照先が曖昧をResolve Lensで開く",
      }),
    ).toBeInTheDocument();
  });

  it("activates only the canonical target when Work titles are duplicated", () => {
    const model: WorkLayerModel = {
      scopeId: "duplicate-title-preview",
      focus: {
        id: "work-current",
        title: "現在の作業",
        authorTasks: [],
        later: [
          { id: "work-target", title: "同名の作業" },
          { id: "work-duplicate", title: "同名の作業" },
        ],
      },
      attention: [],
      disposedAttention: [],
      allWork: [
        { id: "work-current", title: "現在の作業", status: "active" },
        { id: "work-duplicate", title: "同名の作業", status: "waiting" },
        { id: "work-target", title: "同名の作業", status: "waiting" },
      ],
      system: { state: "idle", label: "idle" },
    };

    const switched = switchWorkLayerFocus(model, "work-target");

    expect(switched.focus?.id).toBe("work-target");
    expect(
      switched.allWork?.filter((item) => item.status === "active"),
    ).toEqual([expect.objectContaining({ id: "work-target", tag: "NOW" })]);
    expect(
      switched.allWork?.find((item) => item.id === "work-duplicate"),
    ).toMatchObject({ status: "waiting" });
  });
});
