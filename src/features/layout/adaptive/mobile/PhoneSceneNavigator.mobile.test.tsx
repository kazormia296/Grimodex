// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { PhoneSceneNavigator } from "./PhoneSceneNavigator";

describe("PhoneSceneNavigator mobile actions", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ja");
  });

  afterEach(cleanup);

  it("creates scenes and confirms destructive actions before dispatching them", () => {
    const onCreateScene = vi.fn();
    const onSceneAction = vi.fn();
    render(
      <PhoneSceneNavigator
        scenes={[{ id: "s1", title: "導入" }]}
        onOpenScene={vi.fn()}
        onCreateScene={onCreateScene}
        onSceneAction={onSceneAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "シーンを追加" }));
    expect(onCreateScene).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "導入の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));

    expect(onSceneAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(onSceneAction).toHaveBeenCalledWith("s1", "delete");
  });
});
