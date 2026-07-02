// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  MentionPopup,
  MENTION_LISTBOX_ID,
  mentionOptionId,
} from "./MentionPopup";
import type { MentionItem } from "@/features/codex/CodexMentionExtension";

// i18n はキーをそのまま返す薄いスタブ。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// i18next 実体（@/lib/i18n）を初期化させないための薄いスタブ。
vi.mock("../utils/typeLabels", () => ({
  getTypeLabel: (type: string) => type,
}));

const items: MentionItem[] = [
  { kind: "scene", id: "s1", name: "シーン1", typeLabel: "scene" },
  { kind: "scene", id: "s2", name: "シーン2", typeLabel: "scene" },
];

describe("MentionPopup — listbox の a11y 配線", () => {
  it("listbox が入力欄の aria-controls から参照できる id を持つ", () => {
    render(
      <MentionPopup
        items={items}
        selectedIndex={0}
        onSelect={() => {}}
        onChangeIndex={() => {}}
        clientRect={() => null}
      />,
    );
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe(MENTION_LISTBOX_ID);
  });

  it("各 option に aria-activedescendant 用の id と aria-selected が付く", () => {
    render(
      <MentionPopup
        items={items}
        selectedIndex={1}
        onSelect={() => {}}
        onChangeIndex={() => {}}
        clientRect={() => null}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.id)).toEqual([
      mentionOptionId(0),
      mentionOptionId(1),
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });
});
