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
    expect(note.textContent).toContain("2種");
    expect(note.textContent).toContain("「姉ちゃん」「あいつ」");
  });

  it("dedupes surfaces and shows only the first ten with a remainder count", () => {
    const terms = [
      ...Array.from({ length: 12 }, (_, i) => ({
        surface: `呼び${i}`,
        kind: "kinship" as const,
      })),
      { surface: "呼び0", kind: "kinship" as const },
    ];
    render(
      <CodexStructureExtractionProgress
        coverage={null}
        taskCounts={null}
        entityCount={1}
        skippedRelationalTerms={terms}
      />,
    );
    const text = screen.getByTestId(
      "codex-structure-extraction-skipped-relational",
    ).textContent;
    expect(text).toContain("12種");
    expect(text).toContain("「呼び9」ほか2件");
    expect(text).not.toContain("呼び10");
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
