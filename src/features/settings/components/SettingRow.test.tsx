// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { SettingRow } from "./SettingRow";
import { SettingTextInput } from "./SettingTextInput";
import { SettingNumberInput } from "./SettingNumberInput";
import { SettingToggle, ControlledToggle } from "./SettingToggle";
import { SettingDropdown } from "./SettingDropdown";
import { expectNoA11yViolations } from "@/test-utils/axe";

const OPTIONS = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
];

describe("SettingRow label ↔ control 結合", () => {
  it("SettingTextInput が行ラベルで引ける", () => {
    render(
      <SettingRow label="テキスト設定">
        <SettingTextInput settingKey="test.text" />
      </SettingRow>,
    );
    const input = screen.getByLabelText("テキスト設定");
    expect(input.tagName).toBe("INPUT");
  });

  it("SettingNumberInput が行ラベルで引ける", () => {
    render(
      <SettingRow label="数値設定">
        <SettingNumberInput settingKey="test.number" unit="字" />
      </SettingRow>,
    );
    const input = screen.getByLabelText("数値設定");
    expect(input.getAttribute("type")).toBe("number");
  });

  it("SettingToggle (role=switch) が行ラベルを accessible name に持つ", () => {
    render(
      <SettingRow label="トグル設定">
        <SettingToggle settingKey="test.toggle" />
      </SettingRow>,
    );
    const toggle = screen.getByRole("switch", { name: "トグル設定" });
    expect(toggle.tagName).toBe("BUTTON");
  });

  it("ControlledToggle も行ラベルを accessible name に持つ", () => {
    render(
      <SettingRow label="制御トグル">
        <ControlledToggle value={false} onChange={() => {}} />
      </SettingRow>,
    );
    expect(
      screen.getByRole("switch", { name: "制御トグル" }),
    ).toBeInTheDocument();
  });

  it("SettingDropdown (select) が行ラベルで引ける", () => {
    render(
      <SettingRow label="選択設定">
        <SettingDropdown settingKey="test.dropdown" options={OPTIONS} />
      </SettingRow>,
    );
    const select = screen.getByLabelText("選択設定");
    expect(select.tagName).toBe("SELECT");
  });

  it("中間要素でネストされた control にも context が届く", () => {
    render(
      <SettingRow label="ネスト設定">
        <div className="flex gap-2">
          <SettingDropdown settingKey="test.nested" options={OPTIONS} />
        </div>
      </SettingRow>,
    );
    expect(screen.getByLabelText("ネスト設定").tagName).toBe("SELECT");
  });

  it("description が aria-describedby で control に結びつく", () => {
    render(
      <SettingRow label="説明つき" description="補足の説明文">
        <SettingToggle settingKey="test.described" />
      </SettingRow>,
    );
    const toggle = screen.getByRole("switch", { name: "説明つき" });
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "補足の説明文",
    );
  });

  it("description なしでは aria-describedby を付けない", () => {
    render(
      <SettingRow label="説明なし">
        <SettingToggle settingKey="test.plain" />
      </SettingRow>,
    );
    const toggle = screen.getByRole("switch", { name: "説明なし" });
    expect(toggle.hasAttribute("aria-describedby")).toBe(false);
  });

  it("label が ReactNode でも accessible name が計算される", () => {
    render(
      <SettingRow
        label={
          <span>
            複合<strong>ラベル</strong>
          </span>
        }
      >
        <SettingTextInput settingKey="test.node" />
      </SettingRow>,
    );
    expect(screen.getByLabelText("複合ラベル").tagName).toBe("INPUT");
  });

  it("SettingRow 外の control には aria-labelledby を付けない (後方互換)", () => {
    render(<ControlledToggle value={false} onChange={() => {}} />);
    const toggle = screen.getByRole("switch");
    expect(toggle.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("axe 違反がない", async () => {
    const { container } = render(
      <>
        <SettingRow label="トグル" description="説明">
          <SettingToggle settingKey="test.axe.toggle" />
        </SettingRow>
        <SettingRow label="選択">
          <SettingDropdown settingKey="test.axe.dropdown" options={OPTIONS} />
        </SettingRow>
        <SettingRow label="数値">
          <SettingNumberInput settingKey="test.axe.number" />
        </SettingRow>
      </>,
    );
    await expectNoA11yViolations(container);
  });
});
