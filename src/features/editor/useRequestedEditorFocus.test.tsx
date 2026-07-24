// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorSessionStore } from "./editorSessionStore";
import { useRequestedEditorFocus } from "./useRequestedEditorFocus";

function Harness({ ready, focus }: { ready: boolean; focus: () => void }) {
  useRequestedEditorFocus({ groupIndex: 1, ready, focus });
  return null;
}

describe("useRequestedEditorFocus", () => {
  beforeEach(() => {
    useEditorSessionStore.getState().resetForProject();
  });

  it("fulfills a request that existed before an already-loaded pane mounted", async () => {
    const focus = vi.fn();
    useEditorSessionStore.getState().requestEditorFocus(1);

    render(<Harness ready focus={focus} />);

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(useEditorSessionStore.getState().focusRequests[1]).toBe(false);
  });

  it("waits for loading to finish without dropping the request", async () => {
    const focus = vi.fn();
    useEditorSessionStore.getState().requestEditorFocus(1);
    const { rerender } = render(<Harness ready={false} focus={focus} />);

    expect(useEditorSessionStore.getState().focusRequests[1]).toBe(true);
    rerender(<Harness ready focus={focus} />);

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(useEditorSessionStore.getState().focusRequests[1]).toBe(false);
  });

  it("reacts to a request made after the pane is ready", async () => {
    const focus = vi.fn();
    render(<Harness ready focus={focus} />);

    useEditorSessionStore.getState().requestEditorFocus(1);

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(focus).toHaveBeenCalledOnce();
  });
});
