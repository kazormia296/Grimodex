// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { HostedEditorHandoffDialog } from "./HostedEditorHandoffDialog";

afterEach(async () => {
  await i18n.changeLanguage("ja");
});

describe("Web Editor handoff dialog", () => {
  it("uses the phone visual viewport and 44px actions", async () => {
    await i18n.changeLanguage("ja");
    render(
      <WorkspaceViewportProvider profile="phone">
        <HostedEditorHandoffDialog
          open
          onClose={vi.fn()}
          downloadHandoff={vi.fn(async () => "handoff.grimodex-handoff")}
        />
      </WorkspaceViewportProvider>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(dialog.className).toContain("w-screen");
    expect(dialog.className).toContain(
      "pl-[max(1rem,env(safe-area-inset-left))]",
    );
    expect(screen.getByRole("button", { name: "閉じる" }).className).toContain(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", {
        name: /引き継ぎファイルをダウンロード/,
      }).className,
    ).toContain("min-h-11");
  });

  it("downloads the lossless handoff before offering the payload-free desktop launch", async () => {
    await i18n.changeLanguage("ja");
    const download = vi.fn(async () => "白い灯台.grimodex-handoff");

    const { container } = render(
      <HostedEditorHandoffDialog
        open
        onClose={vi.fn()}
        downloadHandoff={download}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Grimodexで続きを書く",
    );
    expect(container).not.toHaveTextContent(/Scan|アップロード|Hosted AI/i);
    expect(screen.queryByRole("link", { name: /Grimodexを開く/ })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /引き継ぎファイルをダウンロード/ }),
    );

    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(/白い灯台\.grimodex-handoff/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Grimodexを開く/ }),
    ).toHaveAttribute("href", "grimodex://handoff");
  });

  it("keeps the dialog recoverable when handoff generation fails", async () => {
    await i18n.changeLanguage("en");
    const download = vi.fn(async () => {
      throw new Error("snapshot failed");
    });

    render(
      <HostedEditorHandoffDialog
        open
        onClose={vi.fn()}
        downloadHandoff={download}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Download handoff file/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not create.*handoff/i,
    );
    expect(
      screen.getByRole("button", { name: /Download handoff file/i }),
    ).toBeEnabled();
  });
});
