// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CodexStructureExtractionProgress } from "./CodexStructureExtractionProgress";

afterEach(() => cleanup());

describe("CodexStructureExtractionProgress skipped relational terms", () => {
  it("shows the count and the surfaces of skipped relational terms", () => {
    render(
      <CodexStructureExtractionProgress
        coverage={null}
        taskCounts={null}
        entityCount={1}
        skippedRelationalTerms={[
          { surface: "姉ちゃん", kind: "kinship" },
          { surface: "あいつ", kind: "third-person" },
        ]}
      />,
    );
    const note = screen.getByTestId(
      "codex-structure-extraction-skipped-relational",
    );
    expect(note.textContent).toContain("2件");
    expect(note.textContent).toContain("「姉ちゃん」「あいつ」");
  });

  it("renders nothing extra when no term was skipped", () => {
    render(
      <CodexStructureExtractionProgress
        coverage={null}
        taskCounts={null}
        entityCount={1}
      />,
    );
    expect(
      screen.queryByTestId("codex-structure-extraction-skipped-relational"),
    ).toBeNull();
  });
});
