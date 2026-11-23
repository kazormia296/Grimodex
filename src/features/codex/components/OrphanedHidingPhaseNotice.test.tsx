// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { OrphanedHidingPhaseNotice } from "./OrphanedHidingPhaseNotice";
import type { OrphanedHidingPhase } from "../orphanedHidingPhase";

const phase = (id: string, label: string): OrphanedHidingPhase => ({
  id,
  label,
  mode: "hidden",
  cause: "anchor-null",
});

afterEach(async () => {
  await i18n.changeLanguage("ja");
});

describe("OrphanedHidingPhaseNotice", () => {
  it("renders nothing without a Phase", () => {
    const { container } = render(
      <OrphanedHidingPhaseNotice phases={[]} variant="timeline" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names an unnamed Phase and adds no button in the timeline variant", () => {
    render(
      <OrphanedHidingPhaseNotice
        phases={[phase("a", "")]}
        variant="timeline"
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("「名称なし」");
    expect(notice.querySelector("button")).toBeNull();
  });

  it("details variant: a short summary and a button that opens the Timeline tab", () => {
    const onOpenTimeline = vi.fn();
    render(
      <OrphanedHidingPhaseNotice
        phases={[phase("a", "正体")]}
        variant="details"
        onOpenTimeline={onOpenTimeline}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "『タイムライン』タブで起点の場面を選び直すか、Phase を削除してください。",
    );
    fireEvent.click(screen.getByRole("button", { name: "タイムラインを開く" }));
    expect(onOpenTimeline).toHaveBeenCalledOnce();
  });

  it("English: singular and plural wording, up to 3 names, then 'and n more'", async () => {
    await i18n.changeLanguage("en");
    const { rerender } = render(
      <OrphanedHidingPhaseNotice
        phases={[phase("a", "Reveal")]}
        variant="timeline"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      'The Phase "Reveal" is set to hide it from the AI, but its anchor scene can\'t be found.',
    );
    rerender(
      <OrphanedHidingPhaseNotice
        phases={["A", "B", "C", "D", "E"].map((l) => phase(l, l))}
        variant="timeline"
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain(
      'The Phases "A", "B", "C" and 2 more are set to hide it from the AI',
    );
    expect(text).toContain(
      "This Codex entry is not sent to the in-app AI (chat, agents, beats, etc.).",
    );
  });
});
