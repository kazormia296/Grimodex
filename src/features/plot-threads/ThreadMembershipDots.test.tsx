// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ThreadMembershipDots } from "./ThreadMembershipDots";
import type { PlotThreadRow } from "./api";

function thread(over: Partial<PlotThreadRow> & { id: string }): PlotThreadRow {
  return {
    projectId: "p1",
    name: over.id,
    color: null,
    description: null,
    sortOrder: "a0",
    startNodeId: null,
    endNodeId: null,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

afterEach(cleanup);

function map(threads: PlotThreadRow[]): Map<string, PlotThreadRow> {
  return new Map(threads.map((t) => [t.id, t]));
}

describe("ThreadMembershipDots", () => {
  it("renders one dot per thread with the thread name as title", () => {
    const threads = [
      thread({ id: "t1", name: "Romance", color: "#ff0000" }),
      thread({ id: "t2", name: "Mystery", color: "#00ff00" }),
    ];
    const { getByTitle, container } = render(
      <ThreadMembershipDots
        threadIds={["t1", "t2"]}
        threadsById={map(threads)}
      />,
    );
    expect(getByTitle("Romance")).toBeTruthy();
    expect(getByTitle("Mystery")).toBeTruthy();
    expect(container.querySelectorAll("span[title]").length).toBe(2);
  });

  it("falls back to var(--primary) when a thread has no color", () => {
    const threads = [thread({ id: "t1", name: "NoColor", color: null })];
    const { getByTitle } = render(
      <ThreadMembershipDots threadIds={["t1"]} threadsById={map(threads)} />,
    );
    const dot = getByTitle("NoColor") as HTMLElement;
    expect(dot.style.backgroundColor).toContain("--primary");
  });

  it("renders nothing for empty or undefined threadIds", () => {
    const { container, rerender } = render(
      <ThreadMembershipDots threadIds={[]} threadsById={map([])} />,
    );
    expect(container.querySelector("span")).toBeNull();
    rerender(
      <ThreadMembershipDots threadIds={undefined} threadsById={map([])} />,
    );
    expect(container.querySelector("span")).toBeNull();
  });

  it("skips ids missing from the map", () => {
    const threads = [thread({ id: "t1", name: "Only" })];
    const { container, getByTitle } = render(
      <ThreadMembershipDots
        threadIds={["t1", "ghost"]}
        threadsById={map(threads)}
      />,
    );
    expect(getByTitle("Only")).toBeTruthy();
    expect(container.querySelectorAll("span[title]").length).toBe(1);
  });

  it("dedupes repeated ids (defense-in-depth)", () => {
    const threads = [thread({ id: "t1", name: "Once" })];
    const { container } = render(
      <ThreadMembershipDots
        threadIds={["t1", "t1", "t1"]}
        threadsById={map(threads)}
      />,
    );
    expect(container.querySelectorAll("span[title]").length).toBe(1);
  });

  it("caps visible dots at 4 and shows a +N overflow", () => {
    const threads = Array.from({ length: 6 }, (_, i) =>
      thread({ id: `t${i}`, name: `T${i}` }),
    );
    const { container } = render(
      <ThreadMembershipDots
        threadIds={threads.map((t) => t.id)}
        threadsById={map(threads)}
      />,
    );
    expect(container.querySelectorAll("span[title]").length).toBe(4);
    expect(container.textContent).toContain("+2");
  });
});
