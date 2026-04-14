// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPillGroup } from "./ContextPillGroup";
import type { CodexEntry } from "@/features/codex/api";

function makeEntry(id: string, name: string, type = "character"): CodexEntry {
  return {
    id,
    name,
    type,
    summary: "テスト用サマリー",
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
    sourceChatMessageId: null,
    notes: null,
    icon: null,
  };
}

const pinnedEntries: CodexEntry[] = [
  makeEntry("1", "Elara"),
  makeEntry("2", "Taro"),
];
const autoEntries: CodexEntry[] = [makeEntry("3", "Lira")];

const defaultProps = {
  type: "character",
  label: "キャラクター",
  pinnedEntries,
  autoEntries: [] as CodexEntry[],
  onUnpin: vi.fn(),
  onPin: vi.fn(),
};

describe("ContextPillGroup", () => {
  it("閉じているときはラベルと合計件数を表示し、個別ピルは非表示", () => {
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    expect(screen.getByText("(3)")).toBeInTheDocument();
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
  });

  it("グループピルをクリックするとポップオーバーが開き個別ピルが表示される", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("Elara")).toBeInTheDocument();
    expect(screen.getByText("Taro")).toBeInTheDocument();
    expect(screen.getByText("Lira")).toBeInTheDocument();
  });

  it("ポップオーバー内で pinnedEntries → autoEntries の順で表示する", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    const items = screen.getAllByText(/Elara|Taro|Lira/);
    expect(items[0]).toHaveTextContent("Elara");
    expect(items[1]).toHaveTextContent("Taro");
    expect(items[2]).toHaveTextContent("Lira");
  });

  it("再クリックでポップオーバーが閉じる", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("Elara")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
  });

  it("ポップオーバー表示中はヘッダーピルに▴を表示する", async () => {
    const user = userEvent.setup();
    render(<ContextPillGroup {...defaultProps} />);
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("▴")).toBeInTheDocument();
  });

  it("ポップオーバー非表示時はグループピルに▾を表示する", () => {
    render(<ContextPillGroup {...defaultProps} />);
    expect(screen.getByText("▾")).toBeInTheDocument();
  });

  it("ポップオーバー内のピン済みエントリは×ボタンで onUnpin を呼び出す", async () => {
    const onUnpin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={[]}
        onUnpin={onUnpin}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(
      screen.getByRole("button", { name: /Elaraのピン留め解除/ }),
    );
    expect(onUnpin).toHaveBeenCalledWith("1");
  });

  it("ポップオーバー内のautoエントリはPinボタンで onPin を呼び出す", async () => {
    const onPin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[]}
        autoEntries={autoEntries}
        onPin={onPin}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(screen.getByRole("button", { name: /Liraをピン留め/ }));
    expect(onPin).toHaveBeenCalledWith("3");
  });
});
