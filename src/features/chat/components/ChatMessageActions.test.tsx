// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMessageActions } from "./ChatMessageActions";

// i18n はキーをそのまま返す薄いスタブ。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("ChatMessageActions - view prompt", () => {
  it("ユーザーメッセージのドロップダウンに『プロンプトを表示』を出し、クリックで onViewPrompt を呼ぶ", () => {
    const onViewPrompt = vi.fn();
    render(
      <ChatMessageActions
        messageId="msg-1"
        messageRole="user"
        onEdit={() => {}}
        onDelete={() => {}}
        onViewPrompt={onViewPrompt}
      />,
    );

    // ドロップダウンを開く
    fireEvent.click(screen.getByTestId("message-actions-msg-1"));

    const item = screen.getByTestId("view-prompt-msg-1");
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(onViewPrompt).toHaveBeenCalledWith("msg-1");
  });

  it("onViewPrompt 未指定ならメニュー項目を出さない", () => {
    render(
      <ChatMessageActions
        messageId="msg-2"
        messageRole="user"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("message-actions-msg-2"));
    expect(screen.queryByTestId("view-prompt-msg-2")).not.toBeInTheDocument();
  });

  it("アシスタントメッセージには出さない（ユーザー専用）", () => {
    const onViewPrompt = vi.fn();
    render(
      <ChatMessageActions
        messageId="msg-3"
        messageRole="assistant"
        onRegenerate={() => {}}
        onDelete={() => {}}
        onViewPrompt={onViewPrompt}
      />,
    );
    fireEvent.click(screen.getByTestId("message-actions-msg-3"));
    expect(screen.queryByTestId("view-prompt-msg-3")).not.toBeInTheDocument();
  });

  it("メニューは body へ portal される（仮想化行の stacking context を脱出）", () => {
    render(
      <ChatMessageActions
        messageId="msg-5"
        messageRole="user"
        onViewPrompt={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("message-actions-msg-5"));
    const menu = screen.getByTestId("message-actions-menu-msg-5");
    const wrapper = screen.getByTestId("message-actions-wrapper-msg-5");
    // portal 先は body 直下で、行内 wrapper の子孫ではないこと（z-index の罠回避）。
    expect(wrapper.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("⋮ ボタンが accessible name (aria-label) と aria-expanded を持つ", () => {
    render(
      <ChatMessageActions
        messageId="msg-6"
        messageRole="user"
        onViewPrompt={() => {}}
      />,
    );
    const trigger = screen.getByTestId("message-actions-msg-6");
    expect(trigger.getAttribute("aria-label")).toBe("chat.actions.moreOptions");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("onViewPrompt のみでもドロップダウンを表示する", () => {
    const onViewPrompt = vi.fn();
    render(
      <ChatMessageActions
        messageId="msg-4"
        messageRole="user"
        onViewPrompt={onViewPrompt}
      />,
    );
    // ⋮ ボタン自体が出ること（hasDropdownItems が true）
    expect(screen.getByTestId("message-actions-msg-4")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("message-actions-msg-4"));
    expect(screen.getByTestId("view-prompt-msg-4")).toBeInTheDocument();
  });
});
