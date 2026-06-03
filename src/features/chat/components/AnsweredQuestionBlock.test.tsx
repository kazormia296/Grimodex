// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnsweredQuestionBlock } from "./AnsweredQuestionBlock";
import type { ToolCallRecord } from "../agent/agentTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function record(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    name: "ask_user",
    params: { questions: [{ question: "復讐の動機は？", kind: "single" }] },
    resultSummary: "{}",
    tokensUsed: 3,
    ...over,
  };
}

describe("AnsweredQuestionBlock", () => {
  it("renders the question and the chosen answer", () => {
    render(
      <AnsweredQuestionBlock
        record={record({
          resultSummary: JSON.stringify({
            answers: [
              {
                questionIndex: 0,
                question: "復讐の動機は？",
                selected: ["家族を殺された"],
              },
            ],
          }),
        })}
      />,
    );
    expect(screen.getByText("復讐の動機は？")).toBeInTheDocument();
    expect(screen.getByText(/家族を殺された/)).toBeInTheDocument();
    expect(screen.getByText("chat.userQuestion.answered")).toBeInTheDocument();
  });

  it("shows a dismissed marker and the original question when skipped", () => {
    render(
      <AnsweredQuestionBlock
        record={record({ resultSummary: JSON.stringify({ dismissed: true }) })}
      />,
    );
    expect(screen.getByText("chat.userQuestion.dismissed")).toBeInTheDocument();
    expect(screen.getByText(/復讐の動機は？/)).toBeInTheDocument();
  });

  it("falls back to raw summary when it is not valid JSON", () => {
    render(
      <AnsweredQuestionBlock record={record({ resultSummary: "broken" })} />,
    );
    expect(screen.getByText(/broken/)).toBeInTheDocument();
  });
});
