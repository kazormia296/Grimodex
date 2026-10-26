// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DD-1c (DR-DD1C-1, -2): the four hosts of the closed local generation UI.
// While the constant is false they create no element and never request the
// lazy modules (so no `nir1_local_*` call can happen); with the constant
// replaced by true each host mounts its placement once.

const flags = vi.hoisted(() => ({
  enabled: false,
  imported: { disclosure: 0, panel: 0 },
}));

vi.mock("./nir1LocalGenerationAvailability", () => ({
  get NIR1_LOCAL_GENERATION_UI_ENABLED() {
    return flags.enabled;
  },
}));
vi.mock("@/features/chat/nir1/nir1LocalGenerationAvailability", () => ({
  get NIR1_LOCAL_GENERATION_UI_ENABLED() {
    return flags.enabled;
  },
}));
vi.mock("@/features/chat/nir1/Nir1LocalDisclosure", () => {
  flags.imported.disclosure += 1;
  return {
    default: ({ placement }: { placement: number }) => (
      <div data-testid="stub-disclosure" data-placement={placement} />
    ),
  };
});
vi.mock("./Nir1LocalGenerationPanel", () => {
  flags.imported.panel += 1;
  return {
    default: () => <div data-testid="stub-panel" />,
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));
vi.mock("@/features/settings/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    project: {
      language: "ja",
      aiPolicy: null,
      outline: null,
      targetReaders: null,
      styleGuide: null,
      aiInstructions: null,
    },
    isLoading: false,
    updateField: vi.fn(),
  }),
}));
vi.mock("@/features/chat/api", () => ({
  hasApiKey: vi.fn().mockResolvedValue(false),
  deleteApiKey: vi.fn(),
  saveApiKey: vi.fn(),
  testAiConnection: vi.fn(),
  listAiModels: vi.fn().mockResolvedValue([]),
}));
const status = vi.hoisted(() => ({
  view: { state: "restricted" } as { state: string },
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: async () => status.view,
  onProfileEgressStatus: () => () => undefined,
  requestProfileActivation: vi.fn(),
}));

import { RuntimeCapabilitiesProvider } from "@/runtime/runtimeCapabilitiesContext";
import { AiProjectSettings } from "@/features/settings/categories/AiProjectSettings";
import { OpenaiCompatibleEndpointsManager } from "@/features/settings/categories/OpenaiCompatibleEndpointsManager";
import ProfileEgressStatusIndicator from "@/features/profile-egress/ProfileEgressStatusIndicator";
import { Nir1LocalGenerationSlot } from "./Nir1LocalGenerationSlot";
import type { Nir1LocalAcceptedHandler } from "./Nir1LocalGenerationPanel";

function renderHosts() {
  const acceptedRef = createRef<Nir1LocalAcceptedHandler | null>() as {
    current: Nir1LocalAcceptedHandler | null;
  };
  return render(
    <RuntimeCapabilitiesProvider target="electron">
      <OpenaiCompatibleEndpointsManager
        endpoints={[]}
        activeId={null}
        onChange={() => {}}
      />
      <AiProjectSettings />
      <ProfileEgressStatusIndicator />
      <Nir1LocalGenerationSlot
        conversationId={null}
        sceneId={null}
        acceptedRef={acceptedRef}
        onOpenConversation={() => {}}
      />
    </RuntimeCapabilitiesProvider>,
  );
}

beforeEach(() => {
  flags.enabled = false;
  status.view = { state: "restricted" };
});

afterEach(() => {
  cleanup();
});

describe("the hosts of the closed local generation UI", () => {
  it("while the constant is false: no element and no lazy module request", async () => {
    renderHosts();
    // Let the status display read its state (restricted) and settle.
    await screen.findByTestId("profile-egress-status");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByTestId("stub-disclosure")).toBeNull();
    expect(screen.queryByTestId("stub-panel")).toBeNull();
    expect(flags.imported).toEqual({ disclosure: 0, panel: 0 });
  });

  it("with the constant replaced: placements 1, 2 and 5 and the panel, once each", async () => {
    flags.enabled = true;
    renderHosts();
    await screen.findByTestId("stub-panel");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const placements = (await screen.findAllByTestId("stub-disclosure")).map(
      (element) => element.getAttribute("data-placement"),
    );
    expect(placements.sort()).toEqual(["1", "2", "5"]);
    expect(screen.getAllByTestId("stub-panel")).toHaveLength(1);
  });

  it("shows placement 5 only while restricted", async () => {
    flags.enabled = true;
    status.view = { state: "activating" };
    render(<ProfileEgressStatusIndicator />);
    await screen.findByTestId("profile-egress-status");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByTestId("stub-disclosure")).toBeNull();
  });
});
