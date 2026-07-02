// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ChatCommandPopup,
  CHAT_COMMAND_LISTBOX_ID,
  chatCommandOptionId,
} from "./ChatCommandPopup";
import type { ChatCommand } from "../extensions/chatCommands";

// i18n はキーをそのまま返す薄いスタブ。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const items: ChatCommand[] = [
  { id: "cmd-a", label: "/alpha", description: "desc a" },
  { id: "cmd-b", label: "/beta", description: "desc b" },
];

describe("ChatCommandPopup — listbox の a11y 配線", () => {
  it("listbox が入力欄の aria-controls から参照できる id を持つ", () => {
    render(
      <ChatCommandPopup
        items={items}
        selectedIndex={0}
        onSelect={() => {}}
        onChangeIndex={() => {}}
        clientRect={() => null}
      />,
    );
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe(CHAT_COMMAND_LISTBOX_ID);
  });

  it("各 option に aria-activedescendant 用の id と aria-selected が付く", () => {
    render(
      <ChatCommandPopup
        items={items}
        selectedIndex={1}
        onSelect={() => {}}
        onChangeIndex={() => {}}
        clientRect={() => null}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.id)).toEqual([
      chatCommandOptionId(0),
      chatCommandOptionId(1),
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });
});
