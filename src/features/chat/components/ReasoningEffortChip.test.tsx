// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReasoningEffortChip } from "./ReasoningEffortChip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// motion/react: テストではアニメーションを無効化し即時に開閉させる。
// 実機では入場/退場とも dropdown アニメするが、AnimatePresence の exit を待つと
// 「閉じた直後に listbox が消える」前提が非同期化するため、ここでは即時描画にする
// (退場アニメ自体は手動 QA で確認)。CodexQuickSection.test.tsx と同じ方針。
vi.mock("motion/react", async () => {
  const { forwardRef, createElement } = await import("react");
  const MOTION_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "variants",
    "transition",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileInView",
    "layout",
    "layoutId",
  ]);
  const make = (tag: string) =>
    forwardRef(function MotionStub(
      props: Record<string, unknown>,
      ref: React.Ref<unknown>,
    ) {
      const dom: Record<string, unknown> = {};
      for (const k in props) if (!MOTION_PROPS.has(k)) dom[k] = props[k];
      return createElement(tag, { ...dom, ref });
    });
  return {
    motion: { div: make("div"), span: make("span") },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

type Props = React.ComponentProps<typeof ReasoningEffortChip>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    value: null,
    options: ["low", "medium", "high"],
    thinkingEnabled: true,
    onChange: vi.fn(),
    ...over,
  };
}

describe("ReasoningEffortChip", () => {
  it("shows the Auto label when no override is set", () => {
    render(<ReasoningEffortChip {...baseProps()} />);
    expect(screen.getByText("chat.reasoningEffortAuto")).toBeInTheDocument();
  });

  it("shows the current effort value when an override is set", () => {
    render(<ReasoningEffortChip {...baseProps({ value: "high" })} />);
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("opens a menu listing Auto plus all allowed values", () => {
    render(<ReasoningEffortChip {...baseProps()} />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "chat.reasoningEffortAuto",
      "low",
      "medium",
      "high",
    ]);
  });

  it("calls onChange with the selected value and closes the menu", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("option", { name: "medium" }));
    expect(onChange).toHaveBeenCalledWith("medium");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("calls onChange with null when Auto is selected", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ value: "high", onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("option", { name: "chat.reasoningEffortAuto" }),
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("marks the active option with aria-selected", () => {
    render(<ReasoningEffortChip {...baseProps({ value: "medium" })} />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(
      options.map((o) => [o.textContent, o.getAttribute("aria-selected")]),
    ).toEqual([
      ["chat.reasoningEffortAuto", "false"],
      ["low", "false"],
      ["medium", "true"],
      ["high", "false"],
    ]);
  });

  it("is disabled while thinking is off and does not open the menu", () => {
    render(<ReasoningEffortChip {...baseProps({ thinkingEnabled: false })} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is disabled when only one effort value is allowed", () => {
    render(<ReasoningEffortChip {...baseProps({ options: ["high"] })} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("closes the menu on outside click without calling onChange", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
