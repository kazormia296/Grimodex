// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CollapsibleSection } from "./CollapsibleSection";

afterEach(() => {
  cleanup();
});

describe("CollapsibleSection", () => {
  it("open のとき children を描画する", () => {
    render(
      <CollapsibleSection title="Codex" open onToggle={() => {}}>
        <div>body</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("closed のとき children を描画しない", () => {
    render(
      <CollapsibleSection title="Codex" open={false} onToggle={() => {}}>
        <div>body</div>
      </CollapsibleSection>,
    );
    expect(screen.queryByText("body")).toBeNull();
  });

  it("見出しクリックで onToggle が呼ばれる", () => {
    const onToggle = vi.fn();
    render(
      <CollapsibleSection title="Codex" open onToggle={onToggle}>
        <div>body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByText("Codex"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("actions のクリックは onToggle に伝播しない", () => {
    const onToggle = vi.fn();
    const onAction = vi.fn();
    render(
      <CollapsibleSection
        title="Codex"
        open
        onToggle={onToggle}
        actions={
          <button type="button" onClick={onAction}>
            act
          </button>
        }
      >
        <div>body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByText("act"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
