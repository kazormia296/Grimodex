// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UserQuestionCard } from "./UserQuestionCard";
import type { AskUserContent, AskUserSpec } from "../agent/agentTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}));
// Framer Motion を安定した素の div に（毎 render で新関数を返すと subtree が
// remount され state 更新が反映されないため、forwardRef で固定する）。
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const Div = forwardRef(
    (
      { children, ...props }: React.HTMLAttributes<HTMLDivElement>,
      ref: React.Ref<HTMLDivElement>,
    ) => {
      const rest = props as Record<string, unknown>;
      delete rest.variants;
      delete rest.initial;
      delete rest.animate;
      delete rest.exit;
      delete rest.transition;
      return createElement("div", { ...rest, ref }, children);
    },
  );
  return { motion: { div: Div } };
});
vi.mock("@/lib/animation", () => ({
  DURATIONS: { normal: 0 },
  EASINGS: { easeOut: [0, 0, 1, 1] },
  VARIANTS: { slideUp: {} },
  useReducedMotion: () => true,
}));

function single(): AskUserSpec {
  return {
    questions: [
      {
        question: "復讐の動機は？",
        kind: "single",
        options: ["家族を殺された", "友に裏切られた"],
        allowFreeText: false,
      },
    ],
  };
}

describe("UserQuestionCard", () => {
  it("submits the picked option for a single-choice question", () => {
    const onSubmit = vi.fn<(a: AskUserContent) => void>();
    render(
      <UserQuestionCard spec={single()} onSubmit={onSubmit} onSkip={vi.fn()} />,
    );

    const submit = screen.getByTestId("user-question-submit");
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText("家族を殺された"));
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const answer = onSubmit.mock.calls[0][0];
    expect(answer.answers[0].selected).toEqual(["家族を殺された"]);
  });

  it("collects multiple selections for a multi question", () => {
    const onSubmit = vi.fn<(a: AskUserContent) => void>();
    const spec: AskUserSpec = {
      questions: [
        {
          question: "含めるテーマ",
          kind: "multi",
          options: ["復讐", "贖罪", "成長"],
          allowFreeText: false,
        },
      ],
    };
    render(
      <UserQuestionCard spec={spec} onSubmit={onSubmit} onSkip={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("復讐"));
    fireEvent.click(screen.getByText("成長"));
    fireEvent.click(screen.getByTestId("user-question-submit"));
    expect(onSubmit.mock.calls[0][0].answers[0].selected).toEqual([
      "復讐",
      "成長",
    ]);
  });

  it("requires non-empty text for a text question", () => {
    const onSubmit = vi.fn<(a: AskUserContent) => void>();
    const spec: AskUserSpec = {
      questions: [
        {
          question: "自由記述",
          kind: "text",
          options: [],
          allowFreeText: false,
        },
      ],
    };
    render(
      <UserQuestionCard spec={spec} onSubmit={onSubmit} onSkip={vi.fn()} />,
    );
    const submit = screen.getByTestId("user-question-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(
      screen.getByPlaceholderText("chat.userQuestion.textPlaceholder"),
      {
        target: { value: "私の回答" },
      },
    );
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit.mock.calls[0][0].answers[0].text).toBe("私の回答");
  });

  it("walks a multi-question wizard with Next then submit", () => {
    const onSubmit = vi.fn<(a: AskUserContent) => void>();
    const spec: AskUserSpec = {
      questions: [
        {
          question: "Q1",
          kind: "single",
          options: ["a", "b"],
          allowFreeText: false,
        },
        { question: "Q2", kind: "text", options: [], allowFreeText: false },
      ],
    };
    render(
      <UserQuestionCard spec={spec} onSubmit={onSubmit} onSkip={vi.fn()} />,
    );

    // 最初は Next が出る（submit ではない）。
    const next = screen.getByText("chat.userQuestion.next");
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByText("a"));
    fireEvent.click(next);

    // 2問目: text。回答すると submit 可能。
    fireEvent.change(
      screen.getByPlaceholderText("chat.userQuestion.textPlaceholder"),
      {
        target: { value: "答え" },
      },
    );
    fireEvent.click(screen.getByTestId("user-question-submit"));

    const answer = onSubmit.mock.calls[0][0];
    expect(answer.answers[0].selected).toEqual(["a"]);
    expect(answer.answers[1].text).toBe("答え");
  });

  it("calls onSkip when the skip button is pressed", () => {
    const onSkip = vi.fn();
    render(
      <UserQuestionCard spec={single()} onSubmit={vi.fn()} onSkip={onSkip} />,
    );
    fireEvent.click(screen.getByText("chat.userQuestion.skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
