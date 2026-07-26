// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CodexApprovalCard } from "./CodexApprovalCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CodexApprovalCard", () => {
  it("shows bounded approval details and sends the chosen decision", async () => {
    const onDecision = vi.fn(async () => {});
    render(
      <CodexApprovalCard
        request={{
          type: "approval-requested",
          requestId: "request-1",
          kind: "file-change",
          title: "Change scene",
          summary: "Update the scene",
          command: ["echo", "hello"],
          affectedPaths: ["scenes/one.md"],
          diff: "+ hello",
        }}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByTestId("codex-approval-card")).toBeInTheDocument();
    expect(screen.getByText("scenes/one.md")).toBeInTheDocument();
    expect(screen.getByText("+ hello")).toBeInTheDocument();
    fireEvent.click(screen.getByText("chat.codexApprovalDecline"));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith("decline"));
  });
});
