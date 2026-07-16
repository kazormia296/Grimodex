// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneSceneNavigator } from "./PhoneSceneNavigator";
import { PhoneCodexNavigator } from "./PhoneCodexNavigator";
import { PhoneChatSurface } from "./PhoneChatSurface";

afterEach(cleanup);

describe("phone surfaces", () => {
  it("searches scenes and exposes non-drag context actions", () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    render(
      <PhoneSceneNavigator
        scenes={[
          { id: "s1", title: "Opening" },
          { id: "s2", title: "Climax" },
        ]}
        onOpenScene={onOpen}
        onSceneAction={onAction}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search scenes"), {
      target: { value: "climax" },
    });
    expect(screen.getByText("Climax")).toBeTruthy();
    expect(screen.queryByText("Opening")).toBeNull();
    fireEvent.click(screen.getByLabelText("Climax actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(onAction).toHaveBeenCalledWith("s2", "move-up");
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Move to chapter" }),
    ).toBeNull();
  });

  it("navigates Codex detail and phase anchor", () => {
    const onOpenAnchor = vi.fn();
    const onSelectEntry = vi.fn();
    render(
      <PhoneCodexNavigator
        entries={[
          {
            id: "e1",
            name: "葵",
            type: "character",
            phases: [{ id: "p1", label: "手紙", anchorSceneId: "s1" }],
          },
        ]}
        onOpenAnchor={onOpenAnchor}
        onSelectEntry={onSelectEntry}
      />,
    );
    fireEvent.click(screen.getByText("葵"));
    expect(onSelectEntry).toHaveBeenCalledWith("e1");
    fireEvent.click(screen.getByRole("button", { name: "Open anchor scene" }));
    expect(onOpenAnchor).toHaveBeenCalledWith("s1");
  });

  it("keeps the composer visible and sends a trimmed message", () => {
    const onSend = vi.fn();
    const { container } = render(
      <PhoneChatSurface messages={[]} onSend={onSend} />,
    );
    expect(container.querySelector("form")?.className).not.toContain(
      "keyboard-inset",
    );
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "  hello  " },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});
