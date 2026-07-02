// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { ChronicleCalendarPopover } from "./ChronicleCalendarPopover";

vi.mock("./ChronicleCalendarEditor", () => ({
  ChronicleCalendarEditor: () => <div data-testid="calendar-editor-body" />,
}));

function Harness({ open }: { open: boolean }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        暦
      </button>
      <ChronicleCalendarPopover
        triggerRef={triggerRef}
        open={open}
        initial={null}
        onSave={() => {}}
        onClose={() => {}}
      />
    </>
  );
}

describe("ChronicleCalendarPopover (dialog semantics)", () => {
  it("開くと role=dialog + aria-modal + アクセシブル名（暦の設定）で portal される", () => {
    render(<Harness open />);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("暦の設定");
    expect(
      dialog.querySelector('[data-testid="calendar-editor-body"]'),
    ).toBeTruthy();
  });

  it("閉じているときは何も描かない", () => {
    render(<Harness open={false} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
