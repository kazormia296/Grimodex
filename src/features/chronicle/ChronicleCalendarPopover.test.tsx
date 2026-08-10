// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { ChronicleCalendarPopover } from "./ChronicleCalendarPopover";

vi.mock("./ChronicleCalendarEditor", () => ({
  ChronicleCalendarEditor: ({
    onClose,
    onSavingChange,
  }: {
    onClose: () => void;
    onSavingChange?: (saving: boolean) => void;
  }) => (
    <div data-testid="calendar-editor-body">
      <button
        type="button"
        data-testid="mock-start-save"
        onClick={() => onSavingChange?.(true)}
      >
        start save
      </button>
      <button
        type="button"
        data-testid="mock-save-success"
        onClick={() => {
          onSavingChange?.(false);
          onClose();
        }}
      >
        save success
      </button>
      <button
        type="button"
        data-testid="mock-save-failure"
        onClick={() => onSavingChange?.(false)}
      >
        save failure
      </button>
    </div>
  ),
}));

function Harness({
  open,
  onClose = () => {},
}: {
  open: boolean;
  onClose?: () => void;
}) {
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
        onClose={onClose}
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

  it("suppresses outside-click and Escape close while a save is pending", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open onClose={onClose} />);
    fireEvent.click(getByTestId("mock-start-save"));

    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("mock-save-failure"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows the editor to close after a pending save succeeds", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open onClose={onClose} />);
    fireEvent.click(getByTestId("mock-start-save"));
    fireEvent.click(getByTestId("mock-save-success"));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
