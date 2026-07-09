// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  beforeEach(() => {
    document.documentElement.classList.add("dark");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("ui-switch クラスと専用 thumb を使う", () => {
    render(<Switch checked aria-label="test" onCheckedChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "test" });
    expect(toggle.classList.contains("ui-switch")).toBe(true);
    expect(toggle.getAttribute("data-state")).toBe("checked");
    const thumb = toggle.querySelector(".ui-switch-thumb");
    expect(thumb).toBeTruthy();
  });

  it("OFF 時は data-state=unchecked", () => {
    render(
      <Switch
        checked={false}
        aria-label="off"
        onCheckedChange={() => {}}
      />,
    );
    expect(screen.getByRole("switch").getAttribute("data-state")).toBe(
      "unchecked",
    );
  });
});
