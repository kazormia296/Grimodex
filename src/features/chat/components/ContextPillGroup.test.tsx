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
    icon: null,
  };
}

const entries: CodexEntry[] = [
  makeEntry("1", "Elara"),
  makeEntry("2", "Taro"),
  makeEntry("3", "Lira"),
];

describe("ContextPillGroup", () => {
  it("折りたたみ時にラベルと件数を表示する", () => {
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={false}
        onToggle={vi.fn()}
        entries={entries}
        onUnpin={vi.fn()}
      />,
    );
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    // 折りたたみ時は個別エントリ名を表示しない
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
    expect(screen.queryByText("Taro")).not.toBeInTheDocument();
  });

  it("展開時に個別エントリピルを表示する", () => {
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={true}
        onToggle={vi.fn()}
        entries={entries}
        onUnpin={vi.fn()}
      />,
    );
    expect(screen.getByText("Elara")).toBeInTheDocument();
    expect(screen.getByText("Taro")).toBeInTheDocument();
    expect(screen.getByText("Lira")).toBeInTheDocument();
  });

  it("グループピルクリック時に onToggle を呼び出す", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={false}
        onToggle={onToggle}
        entries={entries}
        onUnpin={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("展開時にXボタンクリックで onUnpin(id) を呼び出す", async () => {
    const onUnpin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={true}
        onToggle={vi.fn()}
        entries={entries}
        onUnpin={onUnpin}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Elaraのピン留め解除/ }),
    );
    expect(onUnpin).toHaveBeenCalledWith("1");
  });

  it("展開時はヘッダーピルに▴を表示する", () => {
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={true}
        onToggle={vi.fn()}
        entries={entries}
        onUnpin={vi.fn()}
      />,
    );
    expect(screen.getByText("▴")).toBeInTheDocument();
  });

  it("折りたたみ時はグループピルに▾を表示する", () => {
    render(
      <ContextPillGroup
        type="character"
        label="キャラクター"
        count={3}
        expanded={false}
        onToggle={vi.fn()}
        entries={entries}
        onUnpin={vi.fn()}
      />,
    );
    expect(screen.getByText("▾")).toBeInTheDocument();
  });
});
