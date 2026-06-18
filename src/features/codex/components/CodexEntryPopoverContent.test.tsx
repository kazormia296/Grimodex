// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexEntryPopoverContent } from "./CodexEntryPopoverContent";
import type { CodexEntry } from "@/features/codex/api";

const mockEntry: CodexEntry = {
  id: "entry-1",
  projectId: "proj-1",
  parentId: null,
  type: "character",
  name: "アリス",
  summary: "主人公の少女",
  content: "{}",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("CodexEntryPopoverContent", () => {
  it("名前とタイプバッジを表示する", () => {
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    expect(screen.getByText("アリス")).toBeInTheDocument();
    expect(screen.getByText("キャラクター")).toBeInTheDocument();
  });

  it("summaryを表示する", () => {
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    expect(screen.getByText("主人公の少女")).toBeInTheDocument();
  });

  it("summaryがない場合は表示しない", () => {
    const entryNoSummary = { ...mockEntry, summary: null };
    render(
      <CodexEntryPopoverContent
        entry={entryNoSummary}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    expect(screen.queryByRole("paragraph")).not.toBeInTheDocument();
  });

  it("iconがない場合はカラードットを表示する", () => {
    const { container } = render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    const dot = container.querySelector("[data-testid='entry-dot']");
    expect(dot).toBeInTheDocument();
    // happy-domはhex→rgb変換しないためhex値で比較
    expect((dot as HTMLElement).style.backgroundColor).toBe("#6B7ADB");
  });

  it("iconがある場合はimg要素を表示する", () => {
    const entryWithIcon = { ...mockEntry, icon: "data:image/webp;base64,abc" };
    const { container } = render(
      <CodexEntryPopoverContent
        entry={entryWithIcon}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    // alt=""の装飾画像はARIA上role="presentation"になるためquerySelectorで確認
    expect(container.querySelector("img")).toBeInTheDocument();
  });

  it("onOpenInCodexが渡された場合はOpen in Codexボタンを表示する", () => {
    const onOpenInCodex = vi.fn();
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
        onOpenInCodex={onOpenInCodex}
      />,
    );
    expect(
      screen.getByRole("button", { name: /open in codex/i }),
    ).toBeInTheDocument();
  });

  it("onOpenInCodexが渡されない場合はボタンを表示しない", () => {
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("Open in CodexボタンをクリックするとonOpenInCodexが呼ばれる", async () => {
    const onOpenInCodex = vi.fn();
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#6B7ADB"
        typeLabel="キャラクター"
        onOpenInCodex={onOpenInCodex}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /open in codex/i }),
    );
    expect(onOpenInCodex).toHaveBeenCalledOnce();
  });

  it("spoilerNote を渡すと警告行を表示する", () => {
    render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#888"
        typeLabel="人物"
        spoilerNote="このシーン時点で未開示: 王の正体"
      />,
    );
    expect(
      screen.getByText("このシーン時点で未開示: 王の正体"),
    ).toBeInTheDocument();
  });

  it("spoilerNote が無ければ警告行を表示しない", () => {
    const { container } = render(
      <CodexEntryPopoverContent
        entry={mockEntry}
        dotColor="#888"
        typeLabel="人物"
      />,
    );
    expect(
      container.querySelector('[data-testid="codex-spoiler-note"]'),
    ).toBeNull();
  });
});
