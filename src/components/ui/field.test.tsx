// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Field } from "./field";
import { Input } from "./input";
import { expectNoA11yViolations } from "@/test-utils/axe";

describe("Field", () => {
  it("associates the label with the control (getByLabelText works)", () => {
    render(
      <Field label="タイトル">
        <Input defaultValue="x" />
      </Field>,
    );
    const input = screen.getByLabelText("タイトル");
    expect(input.tagName).toBe("INPUT");
  });

  it("respects an explicit id on the control", () => {
    render(
      <Field label="名前">
        <Input id="custom-id" />
      </Field>,
    );
    expect(screen.getByLabelText("名前").id).toBe("custom-id");
  });

  it("wires help text via aria-describedby", () => {
    render(
      <Field label="メール" help="社内ドメインのみ">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("メール");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy!.split(" ").at(-1)!);
    expect(help?.textContent).toBe("社内ドメインのみ");
  });

  it("marks invalid + required", () => {
    render(
      <Field label="件名" required error="入力してください">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/件名/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <Field label="タイトル" help="補足">
        <Input />
      </Field>,
    );
    await expectNoA11yViolations(container);
  });
});
