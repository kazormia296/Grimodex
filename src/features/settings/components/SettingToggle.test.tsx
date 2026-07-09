// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";

describe("SettingToggle", () => {
  beforeEach(() => {
    document.documentElement.classList.add("dark");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("共通 Switch (ui-switch) を使う", () => {
    render(
      <SettingRow label="テスト">
        <SettingToggle settingKey="test.toggle.on" defaultValue={true} />
      </SettingRow>,
    );
    const toggle = screen.getByRole("switch", { name: "テスト" });
    expect(toggle.classList.contains("ui-switch")).toBe(true);
  });
});
