// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "@/features/workspace/store";
import { EULA_VERSION } from "./constants";
import { EulaConsentGate } from "./EulaConsentGate";

const dialogModuleLoaded = vi.hoisted(() => vi.fn());

vi.mock("./EulaConsentDialog", () => {
  dialogModuleLoaded();
  return { EulaConsentDialog: () => <div data-testid="eula-dialog" /> };
});

function setAcceptedVersion(acceptedEulaVersion: string | null) {
  useWorkspaceStore.setState({
    globalSettings: {
      ...(useWorkspaceStore.getState().globalSettings ?? {}),
      acceptedEulaVersion,
    },
  } as never);
}

describe("EulaConsentGate", () => {
  beforeEach(() => {
    dialogModuleLoaded.mockClear();
  });

  it("同意済みなら何も描かず、ダイアログの module も読まない", () => {
    setAcceptedVersion(EULA_VERSION);
    const { container } = render(<EulaConsentGate />);
    expect(container.innerHTML).toBe("");
    expect(dialogModuleLoaded).not.toHaveBeenCalled();
  });

  it("設定を読み終えるまでは何も描かない", () => {
    useWorkspaceStore.setState({ globalSettings: null } as never);
    const { container } = render(<EulaConsentGate />);
    expect(container.innerHTML).toBe("");
    expect(dialogModuleLoaded).not.toHaveBeenCalled();
  });

  it("同意が要るときは、読み込みの間も画面を覆い、読み終えたらダイアログを出す", async () => {
    setAcceptedVersion(null);
    render(<EulaConsentGate />);
    expect(screen.getByTestId("eula-consent-loading")).toBeTruthy();
    expect(await screen.findByTestId("eula-dialog")).toBeTruthy();
    expect(screen.queryByTestId("eula-consent-loading")).toBeNull();
  });
});
