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
  expanded: false,
  onToggle: vi.fn(),
  pinnedEntries,
  autoEntries: [] as CodexEntry[],
  onUnpin: vi.fn(),
  onPin: vi.fn(),
};

describe("ContextPillGroup", () => {
  it("折りたたみ時にラベルと合計件数を表示する", () => {
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    // count = pinned(2) + auto(1) = 3
    expect(screen.getByText("(3)")).toBeInTheDocument();
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
  });

  it("展開時に pinnedEntries → autoEntries の順で表示する", () => {
    render(
      <ContextPillGroup
        {...defaultProps}
        expanded={true}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    const items = screen.getAllByText(/Elara|Taro|Lira/);
    expect(items[0]).toHaveTextContent("Elara");
    expect(items[1]).toHaveTextContent("Taro");
    expect(items[2]).toHaveTextContent("Lira");
  });

  it("グループピルクリック時に onToggle を呼び出す", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ContextPillGroup {...defaultProps} onToggle={onToggle} />);
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("展開時にピン済みエントリは×ボタンで onUnpin を呼び出す", async () => {
    const onUnpin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        expanded={true}
        pinnedEntries={pinnedEntries}
        autoEntries={[]}
        onUnpin={onUnpin}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Elaraのピン留め解除/ }),
    );
    expect(onUnpin).toHaveBeenCalledWith("1");
  });

  it("展開時にautoエントリはPinボタンで onPin を呼び出す", async () => {
    const onPin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        expanded={true}
        pinnedEntries={[]}
        autoEntries={autoEntries}
        onPin={onPin}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Liraをピン留め/ }));
    expect(onPin).toHaveBeenCalledWith("3");
  });

  it("展開時はヘッダーピルに▴を表示する", () => {
    render(<ContextPillGroup {...defaultProps} expanded={true} />);
    expect(screen.getByText("▴")).toBeInTheDocument();
  });

  it("折りたたみ時はグループピルに▾を表示する", () => {
    render(<ContextPillGroup {...defaultProps} expanded={false} />);
    expect(screen.getByText("▾")).toBeInTheDocument();
  });
});
