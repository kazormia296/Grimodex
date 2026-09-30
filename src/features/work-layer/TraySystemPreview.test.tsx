// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { WorkLayerProvider, WorkLayerSurface, WorkPulse } from "./WorkLayer";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";

function renderPreview(systemState: "idle" | "blocked" = "idle") {
  return render(
    <WorkLayerProvider
      initialModel={{
        ...WORK_LAYER_FIXTURE,
        system: {
          ...WORK_LAYER_FIXTURE.system,
          state: systemState,
          label: systemState === "blocked" ? "contract" : "idle",
        },
      }}
    >
      <WorkPulse />
      <WorkLayerSurface />
    </WorkLayerProvider>,
  );
}

describe("Work Layer tray and system preview", () => {
  it.each([
    ["Focus", "Focusの作業トレイ"],
    ["Attention", "Attentionの作業トレイ"],
  ])(
    "switches a LATER row from the %s tray with the keyboard",
    async (pulseName, trayName) => {
      const user = userEvent.setup();
      renderPreview();

      const opener = screen.getByRole("button", {
        name: new RegExp(`^${pulseName}`),
      });
      await user.click(opener);
      const tray = screen.getByRole("dialog", { name: trayName });
      const later = within(tray).getByRole("button", {
        name: "伏線『青い剣』の回収位置を再確認へFocusを切り替える",
      });

      later.focus();
      await user.keyboard("{Enter}");

      const focusTray = screen.getByRole("dialog", {
        name: "Focusの作業トレイ",
      });
      expect(within(focusTray).getByRole("heading")).toHaveTextContent(
        "伏線『青い剣』の回収位置を再確認",
      );
      expect(
        within(focusTray).getByRole("button", {
          name: "地下牢の改稿へFocusを切り替える",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "Focus 伏線『青い剣』の回収位置を再確認",
        }),
      ).toBeInTheDocument();
    },
  );

  it("offers an explicitly non-persistent inline Author Task draft", async () => {
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: /^Focus/ }));
    const tray = screen.getByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    await user.click(
      within(tray).getByRole("button", {
        name: "この作業にタスクを追加 · PREVIEW ONLY",
      }),
    );
    await user.type(
      within(tray).getByRole("textbox", { name: "タスクの下書き" }),
      "扉の鍵を確認",
    );
    await user.click(
      within(tray).getByRole("button", { name: "下書きを追加" }),
    );

    expect(within(tray).getByText("扉の鍵を確認")).toBeInTheDocument();
    expect(within(tray).getByText("NOT SAVED")).toBeInTheDocument();

    await user.click(within(tray).getByRole("button", { name: "閉じる" }));
    await user.click(screen.getByRole("button", { name: /^Focus/ }));
    expect(screen.queryByText("扉の鍵を確認")).not.toBeInTheDocument();
  });

  it("expands disposed variants inside the Attention tray", async () => {
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: /^Attention/ }));
    const tray = screen.getByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    const toggle = within(tray).getByRole("button", {
      name: /処分済みの判断 4件を開く/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const disposed = within(tray).getByRole("region", {
      name: "処分済みの判断",
    });
    for (const variant of ["SNOOZE", "HOLD", "DISMISSED", "LEGACY"]) {
      expect(within(disposed).getByText(variant)).toBeInTheDocument();
    }
    expect(
      within(tray).getByRole("button", { name: "すべての作業を開く" }),
    ).toBeInTheDocument();
  });

  it("opens a read-only run inspection from BLOCKED and returns with Escape", async () => {
    const user = userEvent.setup();
    renderPreview("blocked");

    await user.click(screen.getByRole("button", { name: "System contract" }));
    const blocked = screen.getByRole("dialog", { name: "System Blocked" });
    await user.click(
      within(blocked).getByRole("button", {
        name: "System runを検査",
      }),
    );

    const inspection = screen.getByRole("dialog", {
      name: "System Run Inspection",
    });
    expect(inspection).toHaveTextContent("READ ONLY");
    expect(inspection).toHaveTextContent("RUN / TASK / ATTEMPT");

    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "System Blocked" }),
    ).toBeInTheDocument();
  });
});
