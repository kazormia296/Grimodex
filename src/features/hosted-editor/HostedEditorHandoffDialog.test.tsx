// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { HostedEditorHandoffDialog } from "./HostedEditorHandoffDialog";

afterEach(async () => {
  await i18n.changeLanguage("ja");
});

describe("HostedEditorHandoffDialog", () => {
  it("downloads the lossless handoff before offering the payload-free desktop launch", async () => {
    await i18n.changeLanguage("ja");
    const download = vi.fn(async () => "白い灯台.grimodex-handoff");

    render(
      <HostedEditorHandoffDialog
        open
        entryMode="scan"
        onClose={vi.fn()}
        downloadHandoff={download}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Grimodexで続きを書く");
    expect(screen.getByRole("dialog")).toHaveTextContent("Scan");
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
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /開かない場合.*Web Editorから続ける/,
    );
  });

  it("keeps the dialog recoverable when handoff generation fails", async () => {
    await i18n.changeLanguage("en");
    const download = vi.fn(async () => {
      throw new Error("snapshot failed");
    });

    render(
      <HostedEditorHandoffDialog
        open
        entryMode="standalone"
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
